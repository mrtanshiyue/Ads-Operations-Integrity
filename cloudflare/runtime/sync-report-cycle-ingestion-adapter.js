import { loadAndDecideReportCycle } from './sync-report-cycle-snapshot.js';

export class ReportCycleIngestionAdapterError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'ReportCycleIngestionAdapterError';
    this.code = code;
    this.cause = cause;
  }
}

// Execute a previously selected ingestion intent only after a fresh frozen-plan snapshot
// still selects the same downloaded job. This remains separate from the main report-cycle
// executor so AWAIT_INGESTION keeps its no-side-effect scheduler semantics.
export function createReportCycleIngestionAdapter({ snapshotRepository, ingestionRuntime }) {
  if (!snapshotRepository || typeof snapshotRepository.loadSnapshot !== 'function') {
    throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_SNAPSHOT_REPOSITORY_INVALID');
  }
  if (!ingestionRuntime || typeof ingestionRuntime.advance !== 'function') {
    throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_RUNTIME_INVALID');
  }

  return async function advanceIngestion(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_INPUT_INVALID');
    }
    const runId = requiredText(input.runId, 'REPORT_CYCLE_INGESTION_RUN_ID_REQUIRED');
    const jobId = requiredText(input.jobId, 'REPORT_CYCLE_INGESTION_JOB_ID_REQUIRED');

    let fresh;
    try {
      fresh = await loadAndDecideReportCycle({ repository:snapshotRepository, runId });
    } catch (error) {
      throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_SNAPSHOT_INVALID', error);
    }

    if (fresh.decision.directive !== 'AWAIT_INGESTION') {
      throw new ReportCycleIngestionAdapterError(
        `REPORT_CYCLE_INGESTION_DIRECTIVE_STALE:${fresh.decision.directive}`,
      );
    }
    if (fresh.decision.jobId !== jobId) {
      throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_JOB_STALE');
    }

    const selected = fresh.jobs.find((job) => job.job_id === jobId);
    if (!selected) throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_JOB_MISSING');
    if (selected.run_id !== runId) throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_RUN_CONFLICT');
    if (selected.status !== 'downloaded') {
      throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_STATUS_CONFLICT');
    }

    let result;
    try {
      // The ingestion runtime performs its own fresh durable job load before staging/publishing.
      // If a second race advances the job after this snapshot, that lower boundary fails closed
      // or verifies an already-ingested receipt without introducing a new mutation.
      result = await ingestionRuntime.advance(jobId);
    } catch (error) {
      throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_EXECUTION_FAILED', error);
    }
    assertIngestionResult(result, runId, jobId);

    return Object.freeze({
      directive:'AWAIT_INGESTION',
      executed:true,
      waiting:Boolean(result.waiting),
      jobId,
      result,
    });
  };
}

function assertIngestionResult(result, runId, jobId) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !result.job) {
    throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_RESULT_INVALID');
  }
  if (result.job.job_id !== jobId) {
    throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_RESULT_JOB_CONFLICT');
  }
  if (result.job.run_id != null && result.job.run_id !== runId) {
    throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_RESULT_RUN_CONFLICT');
  }
  if (result.waiting === true) {
    if (result.job.status !== 'downloaded' || !Number.isSafeInteger(result.job.raw_row_count) || result.job.raw_row_count < 0) {
      throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_WAITING_RECEIPT_INVALID');
    }
    return true;
  }
  if (result.waiting !== false || result.job.status !== 'ingested') {
    throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_COMPLETION_RECEIPT_INVALID');
  }
  if (!Number.isSafeInteger(result.job.raw_row_count) || result.job.raw_row_count < 0
      || !Number.isSafeInteger(result.job.row_count) || result.job.row_count < 0
      || !String(result.job.ingested_at ?? '').trim()) {
    throw new ReportCycleIngestionAdapterError('REPORT_CYCLE_INGESTION_COMPLETION_RECEIPT_INVALID');
  }
  return true;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ReportCycleIngestionAdapterError(code);
  return text;
}
