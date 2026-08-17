import assert from 'node:assert/strict';
import {
  planReportJobs,
  reserveReportJob,
  createAmazonReportOnce,
} from '../cloudflare/runtime/amazon-report-producer.js';
import { resolveReportContract } from '../cloudflare/runtime/amazon-report-contract.js';

function expectCodeAsync(fn, code) {
  return fn().then(
    () => assert.fail(`expected ${code}`),
    (error) => assert.equal(error.code, code),
  );
}

const sellerContract = resolveReportContract('search_term_daily', 'seller');
const vendorContract = resolveReportContract('search_term_daily', 'vendor');
assert.equal(sellerContract.reportTypeId, 'spSearchTerm');
assert.equal(sellerContract.timeUnit, 'DAILY');
assert.equal(sellerContract.retentionDays, 65);
assert.equal(sellerContract.attribution.windowDays, 7);
assert.equal(vendorContract.retentionDays, 65);
assert.equal(vendorContract.attribution.windowDays, 14);

const intent = {
  storeId: 'store-dev-01',
  startDate: '2026-08-01',
  endDate: '2026-09-05',
  datasets: ['search_term_daily'],
  triggerType: 'manual',
};
const profile = { profileId: 'profile-1', accountType: 'seller' };
const jobsA = await planReportJobs({ workflowInstanceId: 'sync-instance-1', intent, profile });
const jobsB = await planReportJobs({ workflowInstanceId: 'sync-instance-1', intent, profile });
assert.equal(jobsA.length, 2);
assert.deepEqual(jobsA, jobsB);
assert.equal(jobsA[0].startDate, '2026-08-01');
assert.equal(jobsA[0].endDate, '2026-08-31');
assert.equal(jobsA[1].startDate, '2026-09-01');
assert.equal(jobsA[1].endDate, '2026-09-05');
assert.match(jobsA[0].idempotencyKey, /^amazon-ads:[0-9a-f]{64}$/);
assert.match(jobsA[0].jobId, /^amazon-report-[0-9a-f]{64}$/);
assert.equal(JSON.parse(jobsA[0].requestJson).configuration.reportTypeId, 'spSearchTerm');

await expectCodeAsync(
  () => planReportJobs({
    workflowInstanceId: 'sync-instance-1',
    intent: { ...intent, datasets: ['campaign_daily'] },
    profile,
  }),
  'REPORT_DATASET_NOT_IMPLEMENTED',
);

{
  const rows = new Map();
  const repository = {
    async insertQueued(plan) {
      if (!rows.has(plan.idempotencyKey)) {
        rows.set(plan.idempotencyKey, {
          job_id: plan.jobId,
          run_id: plan.runId,
          profile_id: plan.profileId,
          ad_product: plan.adProduct,
          report_type: plan.reportType,
          start_date: plan.startDate,
          end_date: plan.endDate,
          status: 'queued',
          idempotency_key: plan.idempotencyKey,
          request_fingerprint: plan.requestFingerprint,
          request_json: plan.requestJson,
        });
      }
    },
    async loadByIdempotencyKey(key) { return rows.get(key) || null; },
  };
  const first = await reserveReportJob(repository, jobsA[0]);
  const replay = await reserveReportJob(repository, jobsA[0]);
  assert.equal(first.job_id, replay.job_id);
  rows.get(jobsA[0].idempotencyKey).profile_id = 'wrong-profile';
  await expectCodeAsync(() => reserveReportJob(repository, jobsA[0]), 'REPORT_JOB_RESERVATION_CONFLICT:profile_id');
}

class FakeCreateRepository {
  constructor(state, { loseArmRaceTo = null } = {}) {
    this.state = { ...state };
    this.loseArmRaceTo = loseArmRaceTo;
  }
  async loadByJobId() { return { ...this.state }; }
  async armCreate() {
    if (this.loseArmRaceTo) {
      this.state = { ...this.state, ...this.loseArmRaceTo };
      return false;
    }
    if (this.state.status !== 'queued' || this.state.amazon_report_id != null) return false;
    this.state.status = 'requested';
    return true;
  }
  async persistAmazonReportReceipt(jobId, reportId, createdAt) {
    assert.equal(jobId, this.state.job_id);
    if (this.state.status === 'requested' && this.state.amazon_report_id == null) {
      this.state.amazon_report_id = reportId;
      this.state.amazon_created_at = createdAt;
      this.state.status = 'processing';
    }
  }
}

const queued = {
  job_id: 'job-create-1',
  status: 'queued',
  amazon_report_id: null,
  amazon_created_at: null,
  request_json: JSON.stringify({ name: 'report request' }),
};

{
  const repository = new FakeCreateRepository(queued);
  let postCount = 0;
  const created = await createAmazonReportOnce({
    repository,
    jobId: queued.job_id,
    async createReport(request) {
      postCount += 1;
      assert.equal(request.name, 'report request');
      return { reportId: 'amazon-report-1', createdAt: '2026-08-15T11:00:01Z' };
    },
  });
  assert.equal(postCount, 1);
  assert.equal(created.status, 'processing');
  assert.equal(created.amazon_report_id, 'amazon-report-1');
  assert.equal(created.amazon_created_at, '2026-08-15T11:00:01Z');

  const replay = await createAmazonReportOnce({
    repository,
    jobId: queued.job_id,
    async createReport() { postCount += 1; throw new Error('must not call'); },
  });
  assert.equal(replay.amazon_report_id, 'amazon-report-1');
  assert.equal(postCount, 1);
}

// Amazon createdAt is source provenance. Missing source timestamp must never be replaced with local time.
{
  const repository = new FakeCreateRepository(queued);
  let postCount = 0;
  await expectCodeAsync(() => createAmazonReportOnce({
    repository,
    jobId: queued.job_id,
    async createReport() { postCount += 1; return { reportId:'amazon-report-no-time' }; },
  }), 'AMAZON_REPORT_CREATED_AT_REQUIRED');
  assert.equal(postCount, 1);
  assert.equal(repository.state.status, 'requested');
  assert.equal(repository.state.amazon_report_id, null);
  assert.equal(repository.state.amazon_created_at, null);
}

{
  const repository = new FakeCreateRepository({ ...queued, status: 'requested' });
  let postCount = 0;
  await expectCodeAsync(() => createAmazonReportOnce({
    repository,
    jobId: queued.job_id,
    async createReport() { postCount += 1; return { reportId: 'must-not-happen', createdAt:'t' }; },
  }), 'AMAZON_REPORT_CREATE_AMBIGUOUS');
  assert.equal(postCount, 0);
}

{
  const repository = new FakeCreateRepository(queued);
  let postCount = 0;
  await expectCodeAsync(() => createAmazonReportOnce({
    repository,
    jobId: queued.job_id,
    async createReport() { postCount += 1; throw new Error('response lost'); },
  }), 'AMAZON_REPORT_CREATE_OUTCOME_UNKNOWN');
  assert.equal(postCount, 1);
  assert.equal(repository.state.status, 'requested');
  assert.equal(repository.state.amazon_report_id, null);

  await expectCodeAsync(() => createAmazonReportOnce({
    repository,
    jobId: queued.job_id,
    async createReport() { postCount += 1; return { reportId: 'second-post-forbidden', createdAt:'t' }; },
  }), 'AMAZON_REPORT_CREATE_AMBIGUOUS');
  assert.equal(postCount, 1);
}

{
  const repository = new FakeCreateRepository(queued, {
    loseArmRaceTo: { status: 'requested', amazon_report_id: null },
  });
  let postCount = 0;
  await expectCodeAsync(() => createAmazonReportOnce({
    repository,
    jobId: queued.job_id,
    async createReport() { postCount += 1; return { reportId: 'double-post', createdAt:'t' }; },
  }), 'AMAZON_REPORT_CREATE_AMBIGUOUS');
  assert.equal(postCount, 0, 'loser of queued->requested CAS must never POST');
}

{
  const repository = new FakeCreateRepository(queued, {
    loseArmRaceTo: { status: 'processing', amazon_report_id: 'amazon-report-race', amazon_created_at: 't' },
  });
  let postCount = 0;
  const row = await createAmazonReportOnce({
    repository,
    jobId: queued.job_id,
    async createReport() { postCount += 1; return { reportId: 'double-post', createdAt:'t' }; },
  });
  assert.equal(row.amazon_report_id, 'amazon-report-race');
  assert.equal(postCount, 0);
}

console.log(JSON.stringify({
  ok: true,
  searchTermReportType: 'spSearchTerm',
  searchTermTimeUnit: 'DAILY',
  searchTermLookbackDays: 65,
  sellerAttributionDays: 7,
  vendorAttributionDays: 14,
  deterministicPlanning: true,
  reservationReplay: true,
  createReportExactlyOnce: true,
  amazonCreatedAtNeverSynthesized: true,
  ambiguousCreateFailsClosed: true,
  concurrentArmLoserNeverPosts: true,
}, null, 2));
