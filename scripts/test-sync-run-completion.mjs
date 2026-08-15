import assert from 'node:assert/strict';
import {
  evaluateReportPlanCompletion,
  finalizeReportPlanRunOnce,
} from '../cloudflare/runtime/sync-run-completion.js';

const FP = 'a'.repeat(64);

function runningRun(overrides = {}) {
  return {
    run_id:'run-complete',
    profile_id:'profile-1',
    status:'running',
    report_plan_fingerprint:FP,
    report_plan_job_count:2,
    stats_json:null,
    error_summary:null,
    completed_at:null,
    ...overrides,
  };
}

function job(jobId, status, overrides = {}) {
  return {
    job_id:jobId,
    run_id:'run-complete',
    profile_id:'profile-1',
    status,
    ...overrides,
  };
}

for (const statuses of [
  ['ingested','downloaded'],
  ['ingested','requested'],
  ['processing','ready'],
]) {
  const result = evaluateReportPlanCompletion(
    runningRun(),
    statuses.map((status, index) => job(`j${index + 1}`, status)),
  );
  assert.equal(result.decision, 'WAITING');
  assert.equal(result.status, undefined);
}

{
  const result = evaluateReportPlanCompletion(runningRun(), [job('j1','ingested'), job('j2','ingested')]);
  assert.equal(result.decision, 'FINALIZE');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.errorSummary, null);
  assert.equal(result.stats.ingestedCount, 2);
  assert.equal(result.stats.failedCount, 0);
  assert.equal(result.stats.cancelledCount, 0);
}

{
  const result = evaluateReportPlanCompletion(runningRun(), [job('j1','ingested'), job('j2','failed')]);
  assert.equal(result.status, 'partial');
  assert.equal(result.errorSummary, 'REPORT_PLAN_PARTIAL_FAILURE');
  assert.equal(result.stats.ingestedCount, 1);
  assert.equal(result.stats.failedCount, 1);
}

{
  const result = evaluateReportPlanCompletion(runningRun(), [job('j1','failed'), job('j2','cancelled')]);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorSummary, 'REPORT_PLAN_FAILED');
  assert.equal(result.stats.ingestedCount, 0);
  assert.equal(result.stats.failedCount, 1);
  assert.equal(result.stats.cancelledCount, 1);
}

assert.throws(
  () => evaluateReportPlanCompletion(runningRun(), [job('j1','ingested')]),
  (error) => error.code === 'SYNC_COMPLETION_JOB_COUNT_MISMATCH',
);
assert.throws(
  () => evaluateReportPlanCompletion(runningRun(), [job('j1','ingested'), job('j2','ingested',{run_id:'other'})]),
  (error) => error.code === 'SYNC_COMPLETION_JOB_RUN_MISMATCH',
);
assert.throws(
  () => evaluateReportPlanCompletion(runningRun(), [job('j1','ingested'), job('j2','ingested',{profile_id:'other'})]),
  (error) => error.code === 'SYNC_COMPLETION_JOB_PROFILE_MISMATCH',
);
assert.throws(
  () => evaluateReportPlanCompletion(runningRun(), [job('j1','ingested'), job('j2','mystery')]),
  (error) => error.code === 'SYNC_COMPLETION_JOB_STATUS_INVALID:mystery',
);

class FakeRepository {
  constructor({ run = runningRun(), jobs = [], concurrentWinner = false } = {}) {
    this.run = { ...run };
    this.jobs = jobs.map((item) => ({ ...item }));
    this.persistCalls = 0;
    this.concurrentWinner = concurrentWinner;
  }
  async loadRun() { return { ...this.run }; }
  async listJobs() { return this.jobs.map((item) => ({ ...item })); }
  async persistTerminalReceipt(receipt) {
    this.persistCalls += 1;
    const canWrite = this.run.status === 'running';
    if (canWrite || this.concurrentWinner) {
      this.run.status = receipt.status;
      this.run.stats_json = receipt.statsJson;
      this.run.error_summary = receipt.errorSummary;
      this.run.completed_at = receipt.completedAt;
    }
    return canWrite && !this.concurrentWinner;
  }
}

{
  const repository = new FakeRepository({ jobs:[job('j1','ingested'), job('j2','downloaded')] });
  const result = await finalizeReportPlanRunOnce({ repository, runId:'run-complete', completedAt:'t-final' });
  assert.equal(result.finalized, false);
  assert.equal(repository.persistCalls, 0);
  assert.equal(repository.run.status, 'running');
}

{
  const repository = new FakeRepository({ jobs:[job('j1','ingested'), job('j2','ingested')] });
  const first = await finalizeReportPlanRunOnce({ repository, runId:'run-complete', completedAt:'t-final' });
  assert.equal(first.finalized, true);
  assert.equal(first.reused, false);
  assert.equal(first.run.status, 'succeeded');
  assert.equal(repository.persistCalls, 1);

  const replay = await finalizeReportPlanRunOnce({ repository, runId:'run-complete', completedAt:'ignored' });
  assert.equal(replay.finalized, true);
  assert.equal(replay.reused, true);
  assert.equal(repository.persistCalls, 1);
}

// Lost CAS response / concurrent winner: reload of the same durable terminal receipt is accepted.
{
  const repository = new FakeRepository({
    jobs:[job('j1','ingested'), job('j2','failed')],
    concurrentWinner:true,
  });
  const result = await finalizeReportPlanRunOnce({ repository, runId:'run-complete', completedAt:'t-race' });
  assert.equal(result.finalized, true);
  assert.equal(result.run.status, 'partial');
  assert.equal(result.run.error_summary, 'REPORT_PLAN_PARTIAL_FAILURE');
  assert.equal(repository.persistCalls, 1);
}

// A conflicting terminal receipt is never normalized or rewritten.
{
  const repository = new FakeRepository({
    run:runningRun({
      status:'partial',
      completed_at:'t-old',
      stats_json:JSON.stringify({
        schemaVersion:'sync-report-plan-completion-v1',
        reportPlanFingerprint:FP,
        jobCount:2,
        ingestedCount:1,
        failedCount:1,
        cancelledCount:0,
      }),
      error_summary:'wrong-error',
    }),
    jobs:[job('j1','ingested'), job('j2','failed')],
  });
  await assert.rejects(
    () => finalizeReportPlanRunOnce({ repository, runId:'run-complete', completedAt:'new-time' }),
    (error) => error.code === 'SYNC_COMPLETION_RECEIPT_CONFLICT:error_summary',
  );
  assert.equal(repository.persistCalls, 0);
}

console.log(JSON.stringify({
  ok:true,
  requestedAmbiguityNeverFinalizes:true,
  downloadedBeforeIngestNeverFinalizes:true,
  succeededPartialFailedAggregation:true,
  waitingHasZeroWrites:true,
  terminalReplayIdempotent:true,
  concurrentWinnerRecoveredFromDurableReceipt:true,
  conflictingTerminalReceiptFailsClosed:true,
}, null, 2));
