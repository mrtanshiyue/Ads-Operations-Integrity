import { decideReportCycle } from './sync-report-cycle.js';
import { assertFrozenReportCycleSnapshot } from './sync-report-cycle-snapshot.js';

const SIDE_EFFECT_DIRECTIVES = new Map([
  ['CREATE_AMAZON_REPORT', ['createAmazonReport', 'queued']],
  ['POLL_AMAZON_REPORT', ['pollAmazonReport', 'processing']],
  ['MATERIALIZE_RAW_OBJECT', ['materializeRawObject', 'ready']],
]);

export class ReportCycleExecutionError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'ReportCycleExecutionError';
    this.code = code;
    this.cause = cause;
  }
}

// Execute at most one directive selected by the deterministic scheduler. This boundary
// intentionally owns no Amazon/R2/D1 implementation; all mutating work is adapter-injected.
// Snapshot authority and decision freshness are re-verified before any adapter can run.
export async function executeReportCycleDirectiveOnce({ cycle, adapters = {} }) {
  assertCycleEnvelope(cycle);

  try {
    assertFrozenReportCycleSnapshot(
      cycle.run,
      cycle.membership,
      cycle.jobs,
      cycle.run.run_id,
    );
  } catch (error) {
    throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_SNAPSHOT_INVALID', error);
  }

  let expectedDecision;
  try {
    expectedDecision = decideReportCycle(cycle.run, cycle.jobs);
  } catch (error) {
    throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_DECISION_UNAVAILABLE', error);
  }
  if (!sameDecision(cycle.decision, expectedDecision)) {
    throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_DECISION_CONFLICT');
  }

  const decision = expectedDecision;
  if (decision.directive === 'RUN_TERMINAL') {
    return Object.freeze({
      directive:decision.directive,
      executed:false,
      waiting:false,
      status:decision.status,
    });
  }
  if (decision.directive === 'BLOCKED') {
    return Object.freeze({
      directive:decision.directive,
      executed:false,
      waiting:true,
      reason:decision.reason,
      jobId:decision.jobId,
    });
  }
  if (decision.directive === 'AWAIT_INGESTION') {
    return Object.freeze({
      directive:decision.directive,
      executed:false,
      waiting:true,
      jobId:decision.jobId,
    });
  }
  if (decision.directive === 'FINALIZE_RUN') {
    const finalizeRun = requiredAdapter(adapters.finalizeRun, 'REPORT_CYCLE_FINALIZE_ADAPTER_REQUIRED');
    let result;
    try {
      result = await finalizeRun(Object.freeze({ runId:cycle.run.run_id }));
    } catch (error) {
      throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_FAILED:FINALIZE_RUN', error);
    }
    if (!result || result.finalized !== true) {
      throw new ReportCycleExecutionError('REPORT_CYCLE_FINALIZE_RECEIPT_UNVERIFIED');
    }
    return Object.freeze({
      directive:decision.directive,
      executed:true,
      waiting:false,
      result,
    });
  }

  const action = SIDE_EFFECT_DIRECTIVES.get(decision.directive);
  if (!action) throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_DIRECTIVE_UNSUPPORTED');
  const [adapterName, expectedStatus] = action;
  const selected = cycle.jobs.find((job) => job.job_id === decision.jobId);
  if (!selected) throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_JOB_MISSING');
  if (selected.status !== expectedStatus) {
    throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_JOB_STATUS_CONFLICT');
  }

  const adapter = requiredAdapter(
    adapters[adapterName],
    `REPORT_CYCLE_${decision.directive}_ADAPTER_REQUIRED`,
  );
  let result;
  try {
    result = await adapter(Object.freeze({
      runId:cycle.run.run_id,
      jobId:selected.job_id,
      expectedStatus,
      directive:decision.directive,
    }));
  } catch (error) {
    throw new ReportCycleExecutionError(`REPORT_CYCLE_EXECUTION_FAILED:${decision.directive}`, error);
  }

  return Object.freeze({
    directive:decision.directive,
    executed:true,
    waiting:false,
    jobId:selected.job_id,
    result,
  });
}

function assertCycleEnvelope(cycle) {
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) {
    throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_CYCLE_INVALID');
  }
  if (!cycle.run || typeof cycle.run !== 'object' || Array.isArray(cycle.run)) {
    throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_RUN_INVALID');
  }
  if (!Array.isArray(cycle.membership)) {
    throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_MEMBERSHIP_INVALID');
  }
  if (!Array.isArray(cycle.jobs)) {
    throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_JOBS_INVALID');
  }
  if (!cycle.decision || typeof cycle.decision !== 'object' || Array.isArray(cycle.decision)) {
    throw new ReportCycleExecutionError('REPORT_CYCLE_EXECUTION_DECISION_INVALID');
  }
}

function sameDecision(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  for (let i = 0; i < expectedKeys.length; i += 1) {
    if (actualKeys[i] !== expectedKeys[i]) return false;
  }
  return expectedKeys.every((key) => actual[key] === expected[key]);
}

function requiredAdapter(value, code) {
  if (typeof value !== 'function') throw new ReportCycleExecutionError(code);
  return value;
}
