import assert from 'node:assert/strict';
import {
  planReportJobs,
  computeReportPlanReceipt,
  buildReportPlanMembershipRows,
  assertRunReportPlanReceipt,
  assertCompatibleReportPlanMembershipSubset,
  assertExactReportPlanMembership,
  assertCompatibleReportJobSubset,
  assertExactReportJobSet,
} from '../cloudflare/runtime/amazon-report-producer.js';

const intent = {
  storeId:'store-1', startDate:'2026-08-01', endDate:'2026-09-05',
  datasets:['search_term_daily'], triggerType:'manual',
};
const profile = { profileId:'profile-1', accountType:'seller' };
const plans = await planReportJobs({ workflowInstanceId:'run-plan', intent, profile });
assert.equal(plans.length, 2);

const receiptA = await computeReportPlanReceipt(plans);
const receiptB = await computeReportPlanReceipt([...plans].reverse());
assert.deepEqual(receiptA, receiptB, 'plan fingerprint must be order-independent');
assert.match(receiptA.fingerprint, /^[0-9a-f]{64}$/);
assert.equal(receiptA.jobCount, 2);

const changed = plans.map((plan, index) => index === 0 ? { ...plan, requestJson:'{"changed":true}' } : plan);
const changedReceipt = await computeReportPlanReceipt(changed);
assert.notEqual(changedReceipt.fingerprint, receiptA.fingerprint);

assert.throws(
  () => assertRunReportPlanReceipt({
    run_id:'run-plan', profile_id:'profile-1', status:'running',
    report_plan_fingerprint:'f'.repeat(64), report_plan_job_count:2,
  }, { runId:'run-plan', profileId:'profile-1', fingerprint:receiptA.fingerprint, jobCount:2 }),
  (error) => error.code === 'REPORT_PLAN_RECEIPT_CONFLICT:fingerprint',
);
assert.equal(assertRunReportPlanReceipt({
  run_id:'run-plan', profile_id:'profile-1', status:'running',
  report_plan_fingerprint:receiptA.fingerprint, report_plan_job_count:2,
}, { runId:'run-plan', profileId:'profile-1', fingerprint:receiptA.fingerprint, jobCount:2 }), true);

const membership = buildReportPlanMembershipRows(plans, receiptA.fingerprint).map((item) => ({
  run_id:item.runId, job_id:item.jobId, profile_id:item.profileId,
  report_plan_fingerprint:item.reportPlanFingerprint, dataset_key:item.datasetKey,
  contract_id:item.contractId, ad_product:item.adProduct, report_type:item.reportType,
  start_date:item.startDate, end_date:item.endDate, idempotency_key:item.idempotencyKey,
  request_fingerprint:item.requestFingerprint, request_json:item.requestJson,
}));
assert.equal(assertCompatibleReportPlanMembershipSubset([membership[0]], plans, receiptA.fingerprint), true);
assert.equal(assertExactReportPlanMembership([...membership].reverse(), plans, receiptA.fingerprint), true);
assert.throws(
  () => assertCompatibleReportPlanMembershipSubset([{ ...membership[0], dataset_key:'wrong' }], plans, receiptA.fingerprint),
  (error) => error.code === 'REPORT_PLAN_MEMBERSHIP_CONFLICT:dataset_key',
);

function row(plan) {
  return {
    job_id:plan.jobId, run_id:plan.runId, profile_id:plan.profileId, ad_product:plan.adProduct,
    report_type:plan.reportType, start_date:plan.startDate, end_date:plan.endDate,
    idempotency_key:plan.idempotencyKey, request_fingerprint:plan.requestFingerprint,
    request_json:plan.requestJson, status:'queued',
  };
}
const rows = plans.map(row);
assert.equal(assertCompatibleReportJobSubset([rows[0]], plans), true);
const ordered = assertExactReportJobSet([...rows].reverse(), plans);
assert.deepEqual(ordered.map((item) => item.idempotency_key), plans.map((plan) => plan.idempotencyKey));
assert.throws(
  () => assertCompatibleReportJobSubset([...rows, { ...rows[0], idempotency_key:'extra' }], plans),
  (error) => error.code === 'REPORT_PLAN_JOB_SET_CONFLICT:count',
);
assert.throws(
  () => assertCompatibleReportJobSubset([{ ...rows[0], idempotency_key:'not-in-plan' }], plans),
  (error) => error.code === 'REPORT_PLAN_JOB_SET_CONFLICT:extra_job',
);

console.log(JSON.stringify({
  ok:true,
  wholePlanFingerprintDeterministic:true,
  planOrderIndependent:true,
  contractDriftChangesFingerprint:true,
  immutableMembershipAttested:true,
  compatibleSubsetAllowedForCrashRecovery:true,
  exactCommittedJobSetAttested:true,
}, null, 2));
