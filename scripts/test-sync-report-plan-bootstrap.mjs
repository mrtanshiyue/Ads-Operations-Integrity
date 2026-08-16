import assert from 'node:assert/strict';
import {
  planReportJobs,
  computeReportPlanReceipt,
  buildReportPlanMembershipRows,
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
function membershipRow(plan, fingerprint) {
  const item = buildReportPlanMembershipRows([plan], fingerprint)[0];
  return {
    run_id:item.runId, job_id:item.jobId, profile_id:item.profileId,
    report_plan_fingerprint:item.reportPlanFingerprint, dataset_key:item.datasetKey,
    contract_id:item.contractId, ad_product:item.adProduct, report_type:item.reportType,
    start_date:item.startDate, end_date:item.endDate, idempotency_key:item.idempotencyKey,
    request_fingerprint:item.requestFingerprint, request_json:item.requestJson,
  };
}

class FakeRepository {
  constructor({ run = null, rows = [], membership = [] } = {}) {
    this.run = run || {
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:null, report_plan_job_count:null,
    };
    this.rows = new Map(rows.map((item) => [item.idempotency_key, { ...item }]));
    this.membership = new Map(membership.map((item) => [item.job_id, { ...item }]));
    this.operations = [];
    this.insertCalls = 0;
    this.planPersistCalls = 0;
  }
  async loadRunPlanReceipt() { return { ...this.run }; }
  async listRunPlanMembership(runId) {
    return [...this.membership.values()].filter((item) => item.run_id === runId).map((item) => ({ ...item }));
  }
  async persistRunPlanReceipt(runId, profileId, receipt, incomingPlans) {
    this.operations.push('plan-receipt');
    this.planPersistCalls += 1;
    if (this.run.run_id === runId && this.run.profile_id === profileId && this.run.status === 'running'
        && this.run.report_plan_fingerprint == null && this.run.report_plan_job_count == null) {
      for (const plan of incomingPlans) {
        if (!this.membership.has(plan.jobId)) this.membership.set(plan.jobId, membershipRow(plan, receipt.fingerprint));
      }
      this.run.report_plan_fingerprint = receipt.fingerprint;
      this.run.report_plan_job_count = receipt.jobCount;
      return true;
    }
    return false;
  }
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

const exactMembership = plans.map((plan) => membershipRow(plan, planReceipt.fingerprint));

// First reservation: immutable membership + whole-plan receipt must precede first report_jobs INSERT.
{
  const repository = new FakeRepository();
  const result = await reserveProducerReportJobs({ execution, profile, repository });
  assert.equal(result.length, 2);
  assert.equal(repository.operations[0], 'plan-receipt');
  assert.equal(repository.run.report_plan_fingerprint, planReceipt.fingerprint);
  assert.equal(repository.run.report_plan_job_count, 2);
  assert.equal(repository.membership.size, 2);
  assert.equal(repository.rows.size, 2);
}

// Atomic membership+receipt survived, but zero report_jobs were inserted: retry fills all jobs.
{
  const repository = new FakeRepository({
    run:{
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:planReceipt.fingerprint, report_plan_job_count:2,
    },
    membership:exactMembership,
  });
  const result = await reserveProducerReportJobs({ execution, profile, repository });
  assert.equal(result.length, 2);
  assert.equal(repository.rows.size, 2);
  assert.equal(repository.planPersistCalls, 0);
}

// Crash halfway through report_jobs reservation: compatible subset is preserved and missing job is added.
{
  const repository = new FakeRepository({
    run:{
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:planReceipt.fingerprint, report_plan_job_count:2,
    },
    membership:exactMembership,
    rows:[row(plans[0])],
  });
  const result = await reserveProducerReportJobs({ execution, profile, repository });
  assert.equal(result.length, 2);
  assert.equal(repository.rows.size, 2);
}

// Different durable plan fingerprint after deployment fails before membership/job mutation.
{
  const repository = new FakeRepository({
    run:{
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:'f'.repeat(64), report_plan_job_count:2,
    },
    membership:exactMembership,
  });
  await assert.rejects(
    () => reserveProducerReportJobs({ execution, profile, repository }),
    (error) => error.code === 'REPORT_PLAN_RECEIPT_CONFLICT:fingerprint',
  );
  assert.equal(repository.planPersistCalls, 0);
  assert.equal(repository.insertCalls, 0);
}

// Contaminated staged membership before plan freeze fails before receipt assignment or report INSERT.
{
  const extraMembership = { ...membershipRow(plans[0], planReceipt.fingerprint), job_id:'extra-job' };
  const repository = new FakeRepository({ membership:[extraMembership] });
  await assert.rejects(
    () => reserveProducerReportJobs({ execution, profile, repository }),
    (error) => error.code === 'REPORT_PLAN_MEMBERSHIP_CONFLICT:extra_job',
  );
  assert.equal(repository.planPersistCalls, 0);
  assert.equal(repository.insertCalls, 0);
}

// Even with a correct frozen membership ledger, an extra legacy report job blocks further inserts.
{
  const extra = { ...row(plans[0]), job_id:'extra-job', idempotency_key:'extra-key' };
  const repository = new FakeRepository({
    run:{
      run_id:'run-plan', profile_id:'profile-1', status:'running',
      report_plan_fingerprint:planReceipt.fingerprint, report_plan_job_count:2,
    },
    membership:exactMembership,
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
  membershipAndReceiptBeforeJobInsert:true,
  crashAfterMembershipReceiptRecovers:true,
  partialJobReservationRecovers:true,
  deploymentPlanDriftFailsBeforeMutation:true,
  stagedMembershipContaminationFailsClosed:true,
  contaminatedLegacyJobSetFailsBeforeInsert:true,
}, null, 2));
