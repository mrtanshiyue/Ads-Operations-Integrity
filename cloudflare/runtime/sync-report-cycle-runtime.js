import { loadAndDecideReportCycle } from './sync-report-cycle-snapshot.js';
import { executeReportCycleDirectiveOnce } from './sync-report-cycle-executor.js';

export class ReportCycleRuntimeError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'ReportCycleRuntimeError';
    this.code = code;
    this.cause = cause;
  }
}

// Route exactly one fresh frozen-plan decision per invocation. This boundary owns no
// Amazon/R2/D1 mutation implementation. AWAIT_INGESTION is intentionally handled by
// its dedicated double-freshness adapter; all other directives remain under the
// existing executor and its acquisition/finalization guards.
export function createReportCycleRuntime({
  snapshotRepository,
  acquisitionAdapters = {},
  ingestionAdapter,
  finalizeRun,
}) {
  if (!snapshotRepository || typeof snapshotRepository.loadSnapshot !== 'function') {
    throw new ReportCycleRuntimeError('REPORT_CYCLE_RUNTIME_SNAPSHOT_REPOSITORY_INVALID');
  }
  if (!acquisitionAdapters || typeof acquisitionAdapters !== 'object' || Array.isArray(acquisitionAdapters)) {
    throw new ReportCycleRuntimeError('REPORT_CYCLE_RUNTIME_ACQUISITION_ADAPTERS_INVALID');
  }
  if (ingestionAdapter != null && typeof ingestionAdapter !== 'function') {
    throw new ReportCycleRuntimeError('REPORT_CYCLE_RUNTIME_INGESTION_ADAPTER_INVALID');
  }
  if (finalizeRun != null && typeof finalizeRun !== 'function') {
    throw new ReportCycleRuntimeError('REPORT_CYCLE_RUNTIME_FINALIZE_ADAPTER_INVALID');
  }

  return Object.freeze({
    async advance(runId) {
      const canonicalRunId = requiredText(runId, 'REPORT_CYCLE_RUNTIME_RUN_ID_REQUIRED');
      let cycle;
      try {
        cycle = await loadAndDecideReportCycle({ repository:snapshotRepository, runId:canonicalRunId });
      } catch (error) {
        throw new ReportCycleRuntimeError('REPORT_CYCLE_RUNTIME_SNAPSHOT_FAILED', error);
      }

      if (cycle.decision.directive === 'AWAIT_INGESTION') {
        if (typeof ingestionAdapter !== 'function') {
          throw new ReportCycleRuntimeError('REPORT_CYCLE_RUNTIME_INGESTION_ADAPTER_REQUIRED');
        }
        let result;
        try {
          result = await ingestionAdapter(Object.freeze({
            runId:canonicalRunId,
            jobId:cycle.decision.jobId,
          }));
        } catch (error) {
          throw new ReportCycleRuntimeError('REPORT_CYCLE_RUNTIME_INGESTION_FAILED', error);
        }
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new ReportCycleRuntimeError('REPORT_CYCLE_RUNTIME_INGESTION_RECEIPT_INVALID');
        }
        return Object.freeze({
          directive:'AWAIT_INGESTION',
          executed:true,
          waiting:Boolean(result.waiting),
          jobId:cycle.decision.jobId,
          result,
        });
      }

      try {
        return await executeReportCycleDirectiveOnce({
          cycle,
          adapters:{
            ...acquisitionAdapters,
            ...(finalizeRun ? { finalizeRun } : {}),
          },
        });
      } catch (error) {
        throw new ReportCycleRuntimeError(
          `REPORT_CYCLE_RUNTIME_EXECUTION_FAILED:${cycle.decision.directive}`,
          error,
        );
      }
    },
  });
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ReportCycleRuntimeError(code);
  return text;
}
