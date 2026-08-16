import assert from 'node:assert/strict';
import { computeSyncIntentFingerprint, normalizeWorkflowIntent } from '../cloudflare/runtime/sync-intent-contract.js';
import { prepareWorkflowExecution } from '../cloudflare/runtime/sync-workflow-orchestration.js';

const payload = { storeId:'store-dev-01', startDate:'2026-08-01', endDate:'2026-08-12', datasets:['search_term_daily'], triggerType:'manual' };
const intent = normalizeWorkflowIntent(payload);
const fp = await computeSyncIntentFingerprint(intent);
const id = 'sync-test';

async function runWith(row) {
  return prepareWorkflowExecution({ eventInstanceId:id, payload, repository:{ async loadRun(){ return row; } } });
}

assert.equal((await runWith({ run_id:id, profile_id:null, trigger_type:'manual', status:'queued', intent_fingerprint:fp })).profileStage, 'RESOLVE_CANONICAL_PROFILE');
assert.equal((await runWith({ run_id:id, profile_id:'p1', trigger_type:'manual', status:'running', intent_fingerprint:fp })).profileStage, 'REUSE_CANONICAL_PROFILE');
assert.equal((await runWith({ run_id:id, profile_id:'p1', trigger_type:'manual', status:'succeeded', intent_fingerprint:fp })).profileStage, 'REUSE_TERMINAL');

for (const [row, code] of [
  [{ run_id:id, profile_id:'p1', trigger_type:'manual', status:'queued', intent_fingerprint:fp }, 'SYNC_QUEUED_PROFILE_RECEIPT_INVALID'],
  [{ run_id:id, profile_id:null, trigger_type:'manual', status:'running', intent_fingerprint:fp }, 'SYNC_RUNNING_PROFILE_RECEIPT_MISSING'],
  [{ run_id:id, profile_id:null, trigger_type:'manual', status:'queued', intent_fingerprint:'wrong' }, 'IDEMPOTENCY_KEY_REUSE_CONFLICT'],
]) {
  try { await runWith(row); assert.fail(`expected ${code}`); } catch (e) { assert.equal(e.code, code); }
}

const {
  assertFrozenReportCycleSnapshot,
  loadAndDecideReportCycle,
  ReportCycleSnapshotError,
} = await import('../cloudflare/runtime/sync-report-cycle-snapshot.js');

const SNAP_FP = 'a'.repeat(64);

function snapshotRun(count = 1) {
  return {
    run_id:'run-cycle', profile_id:'profile-1', status:'running',
    report_plan_fingerprint:SNAP_FP, report_plan_job_count:count,
  };
}

function snapshotMembership(jobId = 'job-1', overrides = {}) {
  return {
    run_id:'run-cycle', job_id:jobId, profile_id:'profile-1', report_plan_fingerprint:SNAP_FP,
    dataset_key:'search_term_daily', contract_id:'search-term-sp-v1',
    ad_product:'SPONSORED_PRODUCTS', report_type:'spSearchTerm',
    start_date:'2026-08-12', end_date:'2026-08-12',
    idempotency_key:`idem-${jobId}`, request_fingerprint:`request-${jobId}`,
    request_json:`{"job":"${jobId}"}`,
    ...overrides,
  };
}

function snapshotJob(jobId = 'job-1', overrides = {}) {
  const member = snapshotMembership(jobId);
  return {
    job_id:member.job_id, run_id:member.run_id, profile_id:member.profile_id,
    ad_product:member.ad_product, report_type:member.report_type,
    start_date:member.start_date, end_date:member.end_date,
    status:'queued', idempotency_key:member.idempotency_key,
    request_fingerprint:member.request_fingerprint, request_json:member.request_json,
    amazon_report_id:null, amazon_created_at:null,
    r2_object_key:null, content_sha256:null, content_bytes:null,
    r2_initial_version:null, r2_initial_etag:null, downloaded_at:null,
    raw_row_count:null, row_count:null, ingested_at:null,
    ...overrides,
  };
}

assert.equal(
  assertFrozenReportCycleSnapshot(snapshotRun(), [snapshotMembership()], [snapshotJob()]),
  true,
);

const cycle = await loadAndDecideReportCycle({
  runId:'run-cycle',
  repository:{
    async loadSnapshot(runId) {
      assert.equal(runId, 'run-cycle');
      return { run:snapshotRun(), membership:[snapshotMembership()], jobs:[snapshotJob()] };
    },
  },
});
assert.deepEqual(cycle.decision, { directive:'CREATE_AMAZON_REPORT', jobId:'job-1' });

for (const [membershipRows, jobs, code] of [
  [[snapshotMembership('job-1', { report_plan_fingerprint:'c'.repeat(64) })], [snapshotJob()], 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_FINGERPRINT_MISMATCH'],
  [[snapshotMembership()], [snapshotJob('job-1', { request_json:'{"changed":true}' })], 'REPORT_CYCLE_SNAPSHOT_JOB_CONFLICT:request_json'],
]) {
  assert.throws(
    () => assertFrozenReportCycleSnapshot(snapshotRun(), membershipRows, jobs),
    (error) => error instanceof ReportCycleSnapshotError && error.code === code,
  );
}

assert.throws(
  () => assertFrozenReportCycleSnapshot(
    snapshotRun(2),
    [snapshotMembership('job-a'), snapshotMembership('job-b', { idempotency_key:'idem-job-a' })],
    [snapshotJob('job-a'), snapshotJob('job-b')],
  ),
  (error) => error instanceof ReportCycleSnapshotError
    && error.code === 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_DUPLICATE_IDEMPOTENCY_KEY',
);

console.log(JSON.stringify({
  ok:true,
  durableReceiptFirst:true,
  canonicalProfileRecovery:true,
  frozenReportCycleSnapshotAuthority:true,
}, null, 2));
