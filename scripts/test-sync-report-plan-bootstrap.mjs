import assert from 'node:assert/strict';
import {
  planReportJobs,
  computeReportPlanReceipt,
} from '../cloudflare/runtime/amazon-report-producer.js';
import { reserveProducerReportJobs } from '../cloudflare/runtime/sync-producer-bootstrap.js';

const profile = { profileId:'profile-1', accountType:'seller' };
const execution = {
  instanceId:'run-plan',
  intent:{
    storeId:'store-1', startDate:'2026-08-01', endDate:'2026-09-05',
    datasets:['search_term_daily'], triggerType:'manual',
  },
};
const plans = await planReportJobs({ workflowInstanceId:execution.instanceId, intent:execution.intent, profile });
const planReceipt = await computeReportPlanReceipt(plans);

function row(plan) {
  return {
    job_id:plan.jobId, run_id:plan.runId, profile_id:plan.profileId, ad_product:plan.adProduct,
    report_type:plan.reportType, start_date:plan.startDate, end_date:plan.endDate, status:'queued',
    idempotency_key:plan.idempotencyKey, request_fingerprint:plan.requestFingerprint, request_json:plan.requestJson,
  };
}

class FakeRepository {
  constructor({ run = null, rows = [] } = {}) {
    this.run = run || {
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:null, report_plan_job_count:null,
    };
    this.rows = new Map(rows.map((item) => [item.idempotency_key, { ...item }]));
    this.operations = [];
    this.insertCalls = 0;
  }
  async persistRunPlanReceipt(runId, profileId, fingerprint, jobCount) {
    this.operations.push('plan-receipt');
    if (this.run.run_id === runId && this.run.profile_id === profileId && this.run.status === 'running'
        && this.run.report_plan_fingerprint == null && this.run.report_plan_job_count == null) {
      this.run.report_plan_fingerprint = fingerprint;
      this.run.report_plan_job_count = jobCount;
      return true;
    }
    return false;
  }
  async loadRunPlanReceipt() { return { ...this.run }; }
  async listByRunId(runId) {
    return [...this.rows.values()].filter((item) => item.run_id === runId).map((item) => ({ ...item }));
  }
  async insertQueued(plan) {
    this.operations.push(`insert:${plan.jobId}`);
    this.insertCalls += 1;
    if (!this.rows.has(plan.idempotencyKey)) this.rows.set(plan.idempotencyKey, row(plan));
  }
  async loadByIdempotencyKey(key) {
    const value = this.rows.get(key);
    return value ? { ...value } : null;
  }
}

// First reservation: whole-plan receipt must be durable before the first job INSERT.
{
  const repository = new FakeRepository();
  const result = await reserveProducerReportJobs({ execution, profile, repository });
  assert.equal(result.length, 2);
  assert.equal(repository.operations[0], 'plan-receipt');
  assert.equal(repository.run.report_plan_fingerprint, planReceipt.fingerprint);
  assert.equal(repository.run.report_plan_job_count, 2);
  assert.equal(repository.rows.size, 2);
}

// Crash after plan receipt but before any job INSERT: same plan fills the missing jobs.
{
  const repository = new FakeRepository({
    run:{
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:planReceipt.fingerprint, report_plan_job_count:2,
    },
  });
  const result = await reserveProducerReportJobs({ execution, profile, repository });
  assert.equal(result.length, 2);
  assert.equal(repository.rows.size, 2);
}

// Crash halfway through reservation: compatible subset is preserved and only missing identity is added idempotently.
{
  const repository = new FakeRepository({
    run:{
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:planReceipt.fingerprint, report_plan_job_count:2,
    },
    rows:[row(plans[0])],
  });
  const result = await reserveProducerReportJobs({ execution, profile, repository });
  assert.equal(result.length, 2);
  assert.equal(repository.rows.size, 2);
}

// Different durable plan fingerprint after a deployment fails before any report job INSERT.
{
  const repository = new FakeRepository({
    run:{
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:'f'.repeat(64), report_plan_job_count:2,
    },
  });
  await assert.rejects(
    () => reserveProducerReportJobs({ execution, profile, repository }),
    (error) => error.code === 'REPORT_PLAN_RECEIPT_CONFLICT:fingerprint',
  );
  assert.equal(repository.insertCalls, 0);
}

// Existing extra/foreign job contaminates the run and must fail before adding missing planned jobs.
{
  const extra = { ...row(plans[0]), job_id:'extra-job', idempotency_key:'extra-key' };
  const repository = new FakeRepository({
    run:{
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:planReceipt.fingerprint, report_plan_job_count:2,
    },
    rows:[extra],
  });
  await assert.rejects(
    () => reserveProducerReportJobs({ execution, profile, repository }),
    (error) => error.code === 'REPORT_PLAN_JOB_SET_CONFLICT:extra_job',
  );
  assert.equal(repository.insertCalls, 0);
}

console.log(JSON.stringify({
  ok:true,
  planReceiptBeforeJobInsert:true,
  crashAfterPlanReceiptRecovers:true,
  partialJobReservationRecovers:true,
  deploymentPlanDriftFailsBeforeInsert:true,
  contaminatedLegacyJobSetFailsBeforeInsert:true,
}, null, 2));
