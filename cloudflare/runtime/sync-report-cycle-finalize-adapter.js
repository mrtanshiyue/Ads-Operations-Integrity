import { loadAndDecideReportCycle } from './sync-report-cycle-snapshot.js';
import { finalizeReportPlanRunOnce } from './sync-run-completion.js';

const COMPLETION_STATUSES = new Set(['succeeded', 'partial', 'failed']);

export class ReportCycleFinalizeAdapterError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'ReportCycleFinalizeAdapterError';
    this.code = code;
    this.cause = cause;
  }
}

// Re-read frozen plan authority immediately before terminalization. A FINALIZE_RUN
// decision is not a durable lease: if any job becomes nonterminal/blocked before this
// adapter runs, no completion receipt may be written from the stale directive.
export function createReportCycleFinalizeAdapter({
  snapshotRepository,
  completionRepository,
  completedAt,
}) {
  if (!snapshotRepository || typeof snapshotRepository.loadSnapshot !== 'function') {
    throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_SNAPSHOT_REPOSITORY_INVALID');
  }
  if (!completionRepository
      || typeof completionRepository.loadRun !== 'function'
      || typeof completionRepository.listJobs !== 'function'
      || typeof completionRepository.persistTerminalReceipt !== 'function') {
    throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_COMPLETION_REPOSITORY_INVALID');
  }
  const canonicalCompletedAt = requiredText(
    completedAt,
    'REPORT_CYCLE_FINALIZE_COMPLETED_AT_REQUIRED',
  );

  return async function finalizeRun(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_INPUT_INVALID');
    }
    const runId = requiredText(input.runId, 'REPORT_CYCLE_FINALIZE_RUN_ID_REQUIRED');

    let fresh;
    try {
      fresh = await loadAndDecideReportCycle({ repository:snapshotRepository, runId });
    } catch (error) {
      throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_SNAPSHOT_INVALID', error);
    }

    if (fresh.decision.directive === 'RUN_TERMINAL') {
      if (fresh.decision.status === 'cancelled') {
        return Object.freeze({
          reused:true,
          finalized:true,
          run:fresh.run,
          terminalDecision:fresh.decision,
        });
      }
      if (!COMPLETION_STATUSES.has(fresh.decision.status)) {
        throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_TERMINAL_STATUS_INVALID');
      }
      return runFinalizer({
        completionRepository,
        completedAt:canonicalCompletedAt,
        fresh,
        runId,
      });
    }

    if (fresh.decision.directive !== 'FINALIZE_RUN') {
      throw new ReportCycleFinalizeAdapterError(
        `REPORT_CYCLE_FINALIZE_DIRECTIVE_STALE:${fresh.decision.directive}`,
      );
    }

    return runFinalizer({
      completionRepository,
      completedAt:canonicalCompletedAt,
      fresh,
      runId,
    });
  };
}

async function runFinalizer({ completionRepository, completedAt, fresh, runId }) {
  let result;
  try {
    result = await finalizeReportPlanRunOnce({
      repository:completionRepository,
      runId,
      completedAt,
    });
  } catch (error) {
    throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_EXECUTION_FAILED', error);
  }

  if (!result || result.finalized !== true || !result.run) {
    throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_RECEIPT_UNVERIFIED');
  }
  if (result.run.run_id !== fresh.run.run_id) {
    throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_RECEIPT_CONFLICT:run_id');
  }
  if (result.run.profile_id !== fresh.run.profile_id) {
    throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_RECEIPT_CONFLICT:profile_id');
  }
  if (result.run.report_plan_fingerprint !== fresh.run.report_plan_fingerprint) {
    throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_RECEIPT_CONFLICT:plan_fingerprint');
  }
  if (result.run.report_plan_job_count !== fresh.run.report_plan_job_count) {
    throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_RECEIPT_CONFLICT:job_count');
  }
  if (!COMPLETION_STATUSES.has(result.run.status)) {
    throw new ReportCycleFinalizeAdapterError('REPORT_CYCLE_FINALIZE_RECEIPT_CONFLICT:status');
  }
  return result;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ReportCycleFinalizeAdapterError(code);
  return text;
}
