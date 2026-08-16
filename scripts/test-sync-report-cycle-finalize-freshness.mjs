import assert from 'node:assert/strict';
import { decideReportCycle } from '../cloudflare/runtime/sync-report-cycle.js';
import { executeReportCycleDirectiveOnce } from '../cloudflare/runtime/sync-report-cycle-executor.js';
import {
  createReportCycleFinalizeAdapter,
  ReportCycleFinalizeAdapterError,
} from '../cloudflare/runtime/sync-report-cycle-finalize-adapter.js';

const FP = 'a'.repeat(64);
const OTHER_FP = 'c'.repeat(64);
const COMPLETED_AT = '2026-08-15T14:20:00Z';

function run(status = 'running', overrides = {}) {
  return {
    run_id:'run-finalize',
    profile_id:'profile-1',
    status,
    report_plan_fingerprint:FP,
    report_plan_job_count:1,
    stats_json:null,
    error_summary:null,
    completed_at:null,
    ...overrides,
  };
}

function membership(overrides = {}) {
  return {
    run_id:'run-finalize',
    job_id:'job-1',
    profile_id:'profile-1',
    report_plan_fingerprint:FP,
    dataset_key:'search_term_daily',
    contract_id:'search-term-sp-v1',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    idempotency_key:'idem-job-1',
    request_fingerprint:'request-job-1',
    request_json:'{"job":"job-1"}',
    ...overrides,
  };
}

function job(status = 'failed', overrides = {}) {
  const member = membership();
  return {
    job_id:member.job_id,
    run_id:member.run_id,
    profile_id:member.profile_id,
    ad_product:member.ad_product,
    report_type:member.report_type,
    start_date:member.start_date,
    end_date:member.end_date,
    status,
    idempotency_key:member.idempotency_key,
    request_fingerprint:member.request_fingerprint,
    request_json:member.request_json,
    amazon_report_id:null,
    amazon_created_at:null,
    r2_object_key:null,
    content_sha256:null,
    content_bytes:null,
    r2_initial_version:null,
    r2_initial_etag:null,
    downloaded_at:null,
    raw_row_count:null,
    row_count:null,
    ingested_at:null,
    ...overrides,
  };
}

function snapshotRepository(runRow, jobRow, memberRow = membership()) {
  return {
    loads:0,
    async loadSnapshot(runId) {
      this.loads += 1;
      assert.equal(runId, 'run-finalize');
      return {
        run:{ ...runRow },
        membership:[{ ...memberRow }],
        jobs:[{ ...jobRow }],
      };
    },
  };
}

function failedStatsJson() {
  return JSON.stringify({
    schemaVersion:'sync-report-plan-completion-v1',
    reportPlanFingerprint:FP,
    jobCount:1,
    ingestedCount:0,
    failedCount:1,
    cancelledCount:0,
  });
}

class CompletionRepository {
  constructor({ runRow = run(), jobStatus = 'failed', corruptPlanAfterPersist = false } = {}) {
    this.run = { ...runRow };
    this.jobs = [{ job_id:'job-1', run_id:'run-finalize', profile_id:'profile-1', status:jobStatus }];
    this.corruptPlanAfterPersist = corruptPlanAfterPersist;
    this.loadRunCalls = 0;
    this.listJobsCalls = 0;
    this.persistCalls = 0;
  }

  async loadRun(runId) {
    this.loadRunCalls += 1;
    assert.equal(runId, 'run-finalize');
    return { ...this.run };
  }

  async listJobs(runId) {
    this.listJobsCalls += 1;
    assert.equal(runId, 'run-finalize');
    return this.jobs.map((row) => ({ ...row }));
  }

  async persistTerminalReceipt({
    runId, reportPlanFingerprint, reportPlanJobCount, status, statsJson, errorSummary, completedAt,
  }) {
    this.persistCalls += 1;
    assert.equal(runId, 'run-finalize');
    assert.equal(reportPlanFingerprint, FP);
    assert.equal(reportPlanJobCount, 1);
    this.run.status = status;
    this.run.stats_json = statsJson;
    this.run.error_summary = errorSummary;
    this.run.completed_at = completedAt;
    if (this.corruptPlanAfterPersist) this.run.report_plan_fingerprint = OTHER_FP;
    return true;
  }
}

async function expectCode(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ReportCycleFinalizeAdapterError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function makeAdapter(snapshotRepo, completionRepo) {
  return createReportCycleFinalizeAdapter({
    snapshotRepository:snapshotRepo,
    completionRepository:completionRepo,
    completedAt:COMPLETED_AT,
  });
}

// Fresh all-terminal authority allows exactly one completion receipt.
{
  const snapshotRepo = snapshotRepository(run(), job('failed'));
  const completionRepo = new CompletionRepository();
  const finalizeRun = makeAdapter(snapshotRepo, completionRepo);
  const result = await finalizeRun({ runId:'run-finalize' });
  assert.equal(result.finalized, true);
  assert.equal(result.reused, false);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.error_summary, 'REPORT_PLAN_FAILED');
  assert.equal(result.run.completed_at, COMPLETED_AT);
  assert.equal(completionRepo.persistCalls, 1);
}

// The adapter composes directly with the directive executor contract.
{
  const cycleRun = run();
  const cycleJobs = [job('failed')];
  const cycle = {
    run:cycleRun,
    membership:[membership()],
    jobs:cycleJobs,
    decision:decideReportCycle(cycleRun, cycleJobs),
  };
  assert.deepEqual(cycle.decision, { directive:'FINALIZE_RUN' });
  const completionRepo = new CompletionRepository();
  const finalizeRun = makeAdapter(snapshotRepository(run(), job('failed')), completionRepo);
  const result = await executeReportCycleDirectiveOnce({ cycle, adapters:{ finalizeRun } });
  assert.equal(result.directive, 'FINALIZE_RUN');
  assert.equal(result.executed, true);
  assert.equal(result.result.run.status, 'failed');
  assert.equal(completionRepo.persistCalls, 1);
}

// A stale finalize decision cannot write after a job becomes queued again in fresh durable authority.
{
  const snapshotRepo = snapshotRepository(run(), job('queued'));
  const completionRepo = new CompletionRepository();
  const finalizeRun = makeAdapter(snapshotRepo, completionRepo);
  await expectCode('REPORT_CYCLE_FINALIZE_DIRECTIVE_STALE:CREATE_AMAZON_REPORT', () =>
    finalizeRun({ runId:'run-finalize' }),
  );
  assert.equal(completionRepo.loadRunCalls, 0);
  assert.equal(completionRepo.listJobsCalls, 0);
  assert.equal(completionRepo.persistCalls, 0);
}

// Ambiguous Create Report remains a plan-wide barrier even on the finalization path.
{
  const snapshotRepo = snapshotRepository(run(), job('requested'));
  const completionRepo = new CompletionRepository();
  const finalizeRun = makeAdapter(snapshotRepo, completionRepo);
  await expectCode('REPORT_CYCLE_FINALIZE_DIRECTIVE_STALE:BLOCKED', () =>
    finalizeRun({ runId:'run-finalize' }),
  );
  assert.equal(completionRepo.persistCalls, 0);
}

// A race after the fresh snapshot is still caught by the completion module's own fresh load.
{
  const snapshotRepo = snapshotRepository(run(), job('failed'));
  const completionRepo = new CompletionRepository({ jobStatus:'queued' });
  const finalizeRun = makeAdapter(snapshotRepo, completionRepo);
  await expectCode('REPORT_CYCLE_FINALIZE_RECEIPT_UNVERIFIED', () =>
    finalizeRun({ runId:'run-finalize' }),
  );
  assert.equal(completionRepo.persistCalls, 0);
}

// Concurrent valid completion is reused and its existing immutable receipt is validated.
{
  const terminalRun = run('failed', {
    stats_json:failedStatsJson(),
    error_summary:'REPORT_PLAN_FAILED',
    completed_at:'2026-08-15T14:19:00Z',
  });
  const snapshotRepo = snapshotRepository(terminalRun, job('failed'));
  const completionRepo = new CompletionRepository({ runRow:terminalRun });
  const finalizeRun = makeAdapter(snapshotRepo, completionRepo);
  const result = await finalizeRun({ runId:'run-finalize' });
  assert.equal(result.finalized, true);
  assert.equal(result.reused, true);
  assert.equal(result.run.status, 'failed');
  assert.equal(completionRepo.listJobsCalls, 0);
  assert.equal(completionRepo.persistCalls, 0);
}

// Concurrent cancellation is terminal but is not misrepresented as a completion receipt write.
{
  const cancelledRun = run('cancelled');
  const snapshotRepo = snapshotRepository(cancelledRun, job('cancelled'));
  const completionRepo = new CompletionRepository({ runRow:cancelledRun });
  const finalizeRun = makeAdapter(snapshotRepo, completionRepo);
  const result = await finalizeRun({ runId:'run-finalize' });
  assert.equal(result.finalized, true);
  assert.equal(result.reused, true);
  assert.equal(result.run.status, 'cancelled');
  assert.equal(result.terminalDecision.directive, 'RUN_TERMINAL');
  assert.equal(completionRepo.loadRunCalls, 0);
  assert.equal(completionRepo.persistCalls, 0);
}

// A malformed frozen snapshot is rejected before the completion repository is touched.
{
  const snapshotRepo = snapshotRepository(run(), job('failed'), membership({ request_json:'{"changed":true}' }));
  const completionRepo = new CompletionRepository();
  const finalizeRun = makeAdapter(snapshotRepo, completionRepo);
  const error = await expectCode('REPORT_CYCLE_FINALIZE_SNAPSHOT_INVALID', () =>
    finalizeRun({ runId:'run-finalize' }),
  );
  assert.equal(error.cause.code, 'REPORT_CYCLE_SNAPSHOT_JOB_CONFLICT:request_json');
  assert.equal(completionRepo.loadRunCalls, 0);
  assert.equal(completionRepo.persistCalls, 0);
}

// Even a completion repository that returns a conflicting plan receipt cannot pass adapter verification.
{
  const snapshotRepo = snapshotRepository(run(), job('failed'));
  const completionRepo = new CompletionRepository({ corruptPlanAfterPersist:true });
  const finalizeRun = makeAdapter(snapshotRepo, completionRepo);
  await expectCode('REPORT_CYCLE_FINALIZE_RECEIPT_CONFLICT:plan_fingerprint', () =>
    finalizeRun({ runId:'run-finalize' }),
  );
  assert.equal(completionRepo.persistCalls, 1);
}

console.log('report cycle finalize fresh snapshot adapter: PASS');
