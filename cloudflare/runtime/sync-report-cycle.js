const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const TERMINAL_JOB_STATUSES = new Set(['ingested', 'failed', 'cancelled']);
const KNOWN_JOB_STATUSES = new Set(['queued', 'requested', 'processing', 'ready', 'downloaded', ...TERMINAL_JOB_STATUSES]);

export class ReportCycleSchedulerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReportCycleSchedulerError';
    this.code = code;
  }
}

export function decideReportCycle(run, jobs) {
  assertFrozenRun(run);
  if (!Array.isArray(jobs)) throw new ReportCycleSchedulerError('REPORT_CYCLE_JOBS_INVALID');
  if (jobs.length !== run.report_plan_job_count) {
    throw new ReportCycleSchedulerError('REPORT_CYCLE_JOB_COUNT_MISMATCH');
  }

  const seenJobIds = new Set();
  const sorted = jobs.map((job) => {
    assertJobIdentity(run, job, seenJobIds);
    assertJobReceiptShape(job);
    return job;
  }).sort(compareJobId);

  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return Object.freeze({ directive: 'RUN_TERMINAL', status: run.status });
  }
  if (run.status !== 'running') throw new ReportCycleSchedulerError('REPORT_CYCLE_RUN_STATUS_INVALID');

  // A lost/ambiguous Create Report response is a plan-wide safety barrier. Do not let
  // any other queued/processing/ready job create a new Amazon/R2 side effect first.
  const ambiguousCreate = sorted.find((job) => job.status === 'requested');
  if (ambiguousCreate) {
    return Object.freeze({
      directive: 'BLOCKED',
      reason: 'AMAZON_REPORT_CREATE_AMBIGUOUS',
      jobId: ambiguousCreate.job_id,
    });
  }

  if (sorted.every((job) => TERMINAL_JOB_STATUSES.has(job.status))) {
    return Object.freeze({ directive: 'FINALIZE_RUN' });
  }

  // Exactly one external-action directive per evaluation, selected by stable job_id.
  for (const job of sorted) {
    if (job.status === 'queued') {
      return Object.freeze({ directive: 'CREATE_AMAZON_REPORT', jobId: job.job_id });
    }
    if (job.status === 'processing') {
      return Object.freeze({ directive: 'POLL_AMAZON_REPORT', jobId: job.job_id });
    }
    if (job.status === 'ready') {
      return Object.freeze({ directive: 'MATERIALIZE_RAW_OBJECT', jobId: job.job_id });
    }
  }

  const downloaded = sorted.find((job) => job.status === 'downloaded');
  if (downloaded) {
    return Object.freeze({ directive: 'AWAIT_INGESTION', jobId: downloaded.job_id });
  }

  throw new ReportCycleSchedulerError('REPORT_CYCLE_NO_DIRECTIVE');
}

function assertFrozenRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new ReportCycleSchedulerError('REPORT_CYCLE_RUN_INVALID');
  }
  requiredText(run.run_id, 'REPORT_CYCLE_RUN_ID_REQUIRED');
  requiredText(run.profile_id, 'REPORT_CYCLE_PROFILE_ID_REQUIRED');
  if (!/^[0-9a-f]{64}$/.test(String(run.report_plan_fingerprint || ''))) {
    throw new ReportCycleSchedulerError('REPORT_CYCLE_PLAN_FINGERPRINT_INVALID');
  }
  if (!Number.isSafeInteger(run.report_plan_job_count) || run.report_plan_job_count < 1) {
    throw new ReportCycleSchedulerError('REPORT_CYCLE_PLAN_JOB_COUNT_INVALID');
  }
  if (run.status !== 'running' && !TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new ReportCycleSchedulerError('REPORT_CYCLE_RUN_STATUS_INVALID');
  }
}

function assertJobIdentity(run, job, seenJobIds) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new ReportCycleSchedulerError('REPORT_CYCLE_JOB_INVALID');
  }
  const jobId = requiredText(job.job_id, 'REPORT_CYCLE_JOB_ID_REQUIRED');
  if (seenJobIds.has(jobId)) throw new ReportCycleSchedulerError('REPORT_CYCLE_DUPLICATE_JOB_ID');
  seenJobIds.add(jobId);
  if (job.run_id !== run.run_id) throw new ReportCycleSchedulerError('REPORT_CYCLE_JOB_RUN_MISMATCH');
  if (job.profile_id !== run.profile_id) throw new ReportCycleSchedulerError('REPORT_CYCLE_JOB_PROFILE_MISMATCH');
  if (!KNOWN_JOB_STATUSES.has(job.status)) {
    throw new ReportCycleSchedulerError(`REPORT_CYCLE_JOB_STATUS_INVALID:${String(job.status || 'empty')}`);
  }
}

function assertJobReceiptShape(job) {
  const amazon = groupState(
    [job.amazon_report_id, job.amazon_created_at],
    'REPORT_CYCLE_AMAZON_IDENTITY_PARTIAL',
  );
  const expected = groupState(
    [job.r2_object_key, job.content_sha256, job.content_bytes],
    'REPORT_CYCLE_R2_EXPECTED_AUTHORITY_PARTIAL',
  );
  const initial = groupState(
    [job.r2_initial_version, job.r2_initial_etag, job.downloaded_at],
    'REPORT_CYCLE_R2_INITIAL_RECEIPT_PARTIAL',
  );
  const ingestion = groupState(
    [job.row_count, job.ingested_at],
    'REPORT_CYCLE_INGESTION_RECEIPT_PARTIAL',
  );

  if (amazon === 'complete') {
    requiredText(job.amazon_report_id, 'REPORT_CYCLE_AMAZON_REPORT_ID_INVALID');
    requiredText(job.amazon_created_at, 'REPORT_CYCLE_AMAZON_CREATED_AT_INVALID');
  }
  if (expected === 'complete') {
    requiredText(job.r2_object_key, 'REPORT_CYCLE_R2_OBJECT_KEY_INVALID');
    if (!/^[0-9a-f]{64}$/.test(String(job.content_sha256 || ''))) {
      throw new ReportCycleSchedulerError('REPORT_CYCLE_CONTENT_SHA256_INVALID');
    }
    assertNonNegativeSafeInteger(job.content_bytes, 'REPORT_CYCLE_CONTENT_BYTES_INVALID');
  }
  if (initial === 'complete') {
    requiredText(job.r2_initial_version, 'REPORT_CYCLE_R2_INITIAL_VERSION_INVALID');
    requiredText(job.r2_initial_etag, 'REPORT_CYCLE_R2_INITIAL_ETAG_INVALID');
    requiredText(job.downloaded_at, 'REPORT_CYCLE_DOWNLOADED_AT_INVALID');
    if (expected !== 'complete') throw new ReportCycleSchedulerError('REPORT_CYCLE_R2_INITIAL_WITHOUT_EXPECTED_AUTHORITY');
  }
  if (ingestion === 'complete') {
    assertNonNegativeSafeInteger(job.row_count, 'REPORT_CYCLE_ROW_COUNT_INVALID');
    requiredText(job.ingested_at, 'REPORT_CYCLE_INGESTED_AT_INVALID');
  }
  if (job.raw_row_count != null) {
    assertNonNegativeSafeInteger(job.raw_row_count, 'REPORT_CYCLE_RAW_ROW_COUNT_INVALID');
  }
  if ((expected === 'complete' || initial === 'complete') && amazon !== 'complete') {
    throw new ReportCycleSchedulerError('REPORT_CYCLE_R2_WITHOUT_AMAZON_IDENTITY');
  }

  switch (job.status) {
    case 'queued':
      requireReceiptStates(job, { amazon:'absent', expected:'absent', initial:'absent', ingestion:'absent', raw:'absent' }, { amazon, expected, initial, ingestion });
      return;
    case 'requested':
      requireReceiptStates(job, { amazon:'absent', expected:'absent', initial:'absent', ingestion:'absent', raw:'absent' }, { amazon, expected, initial, ingestion });
      return;
    case 'processing':
      requireReceiptStates(job, { amazon:'complete', expected:'absent', initial:'absent', ingestion:'absent', raw:'absent' }, { amazon, expected, initial, ingestion });
      return;
    case 'ready':
      if (amazon !== 'complete') throw new ReportCycleSchedulerError('REPORT_CYCLE_READY_AMAZON_IDENTITY_REQUIRED');
      if (initial !== 'absent') throw new ReportCycleSchedulerError('REPORT_CYCLE_READY_INITIAL_R2_RECEIPT_FORBIDDEN');
      if (ingestion !== 'absent' || job.raw_row_count != null) throw new ReportCycleSchedulerError('REPORT_CYCLE_READY_INGESTION_RECEIPT_FORBIDDEN');
      return;
    case 'downloaded':
      if (amazon !== 'complete') throw new ReportCycleSchedulerError('REPORT_CYCLE_DOWNLOADED_AMAZON_IDENTITY_REQUIRED');
      if (expected !== 'complete') throw new ReportCycleSchedulerError('REPORT_CYCLE_DOWNLOADED_EXPECTED_AUTHORITY_REQUIRED');
      if (initial !== 'complete') throw new ReportCycleSchedulerError('REPORT_CYCLE_DOWNLOADED_INITIAL_R2_RECEIPT_REQUIRED');
      if (ingestion !== 'absent') throw new ReportCycleSchedulerError('REPORT_CYCLE_DOWNLOADED_INGESTION_RECEIPT_FORBIDDEN');
      return;
    case 'ingested':
      if (amazon !== 'complete') throw new ReportCycleSchedulerError('REPORT_CYCLE_INGESTED_AMAZON_IDENTITY_REQUIRED');
      if (expected !== 'complete') throw new ReportCycleSchedulerError('REPORT_CYCLE_INGESTED_EXPECTED_AUTHORITY_REQUIRED');
      if (initial !== 'complete') throw new ReportCycleSchedulerError('REPORT_CYCLE_INGESTED_INITIAL_R2_RECEIPT_REQUIRED');
      if (job.raw_row_count == null) throw new ReportCycleSchedulerError('REPORT_CYCLE_INGESTED_RAW_ROW_COUNT_REQUIRED');
      if (ingestion !== 'complete') throw new ReportCycleSchedulerError('REPORT_CYCLE_INGESTION_RECEIPT_REQUIRED');
      return;
    case 'failed':
      if (ingestion !== 'absent') throw new ReportCycleSchedulerError('REPORT_CYCLE_FAILED_INGESTION_RECEIPT_FORBIDDEN');
      return;
    case 'cancelled':
      if (initial !== 'absent') throw new ReportCycleSchedulerError('REPORT_CYCLE_CANCELLED_INITIAL_R2_RECEIPT_FORBIDDEN');
      if (ingestion !== 'absent' || job.raw_row_count != null) throw new ReportCycleSchedulerError('REPORT_CYCLE_CANCELLED_INGESTION_RECEIPT_FORBIDDEN');
      return;
    default:
      throw new ReportCycleSchedulerError('REPORT_CYCLE_JOB_STATUS_INVALID');
  }
}

function requireReceiptStates(job, expectedStates, actual) {
  if (actual.amazon !== expectedStates.amazon) throw new ReportCycleSchedulerError(`REPORT_CYCLE_${job.status.toUpperCase()}_AMAZON_IDENTITY_INVALID`);
  if (actual.expected !== expectedStates.expected) throw new ReportCycleSchedulerError(`REPORT_CYCLE_${job.status.toUpperCase()}_EXPECTED_AUTHORITY_INVALID`);
  if (actual.initial !== expectedStates.initial) throw new ReportCycleSchedulerError(`REPORT_CYCLE_${job.status.toUpperCase()}_INITIAL_R2_RECEIPT_INVALID`);
  if (actual.ingestion !== expectedStates.ingestion) throw new ReportCycleSchedulerError(`REPORT_CYCLE_${job.status.toUpperCase()}_INGESTION_RECEIPT_INVALID`);
  if (expectedStates.raw === 'absent' && job.raw_row_count != null) throw new ReportCycleSchedulerError(`REPORT_CYCLE_${job.status.toUpperCase()}_RAW_ROW_COUNT_INVALID`);
}

function groupState(values, partialCode) {
  const present = values.map(isPresent);
  if (present.every(Boolean)) return 'complete';
  if (present.some(Boolean)) throw new ReportCycleSchedulerError(partialCode);
  return 'absent';
}

function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

function assertNonNegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ReportCycleSchedulerError(code);
}

function compareJobId(a, b) {
  if (a.job_id < b.job_id) return -1;
  if (a.job_id > b.job_id) return 1;
  return 0;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ReportCycleSchedulerError(code);
  return text;
}
