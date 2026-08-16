const ALLOWED_TRANSITIONS = Object.freeze({
  queued: new Set(['requested', 'failed', 'cancelled']),
  requested: new Set(['processing', 'failed']),
  processing: new Set(['ready', 'failed', 'cancelled']),
  ready: new Set(['downloaded', 'failed', 'cancelled']),
  downloaded: new Set(['ingested', 'failed']),
  ingested: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});

export class ProducerStateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProducerStateError';
    this.code = code;
  }
}

export function canTransitionReportJob(from, to) {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.has(to) === true;
}

export function assertReportTransition(from, to) {
  if (!canTransitionReportJob(from, to)) throw new ProducerStateError('REPORT_JOB_STATUS_TRANSITION_INVALID');
  return true;
}

export function amazonCreateDecision(job) {
  const status = String(job?.status ?? '');
  const reportId = job?.amazon_report_id ?? null;
  if (status === 'queued') {
    if (reportId != null) throw new ProducerStateError('REPORT_JOB_QUEUED_HAS_AMAZON_REPORT_ID');
    return 'ARM_AND_CREATE_ONCE';
  }
  if (status === 'requested') {
    if (reportId == null) throw new ProducerStateError('AMAZON_REPORT_CREATE_AMBIGUOUS');
    throw new ProducerStateError('REPORT_JOB_REQUESTED_RECEIPT_INVALID');
  }
  if (['processing', 'ready', 'downloaded', 'ingested'].includes(status)) {
    if (reportId == null) throw new ProducerStateError('AMAZON_REPORT_ID_RECEIPT_MISSING');
    return 'REUSE_AMAZON_REPORT';
  }
  if (['failed', 'cancelled'].includes(status)) return 'TERMINAL';
  throw new ProducerStateError('REPORT_JOB_STATUS_UNKNOWN');
}

export function rawObjectDecision(job) {
  const expected = [job?.r2_object_key, job?.content_sha256, job?.content_bytes];
  const initial = [job?.r2_initial_version, job?.r2_initial_etag];
  const expectedPresent = expected.every((value) => value !== null && value !== undefined && value !== '');
  const initialPresent = initial.every((value) => value !== null && value !== undefined && value !== '');
  const initialAny = initial.some((value) => value !== null && value !== undefined && value !== '');

  if (initialAny && !initialPresent) throw new ProducerStateError('R2_INITIAL_RECEIPT_INCOMPLETE');
  if (initialPresent) {
    if (!expectedPresent) throw new ProducerStateError('R2_INITIAL_RECEIPT_WITHOUT_EXPECTED_AUTHORITY');
    return 'REUSE_INITIAL_R2_RECEIPT';
  }
  if (!expectedPresent) throw new ProducerStateError('R2_EXPECTED_AUTHORITY_INCOMPLETE');
  return 'PUT_CREATE_ONLY';
}

export function canonicalProfileReceiptDecision(run, canonicalProfileId) {
  const status = String(run?.status ?? '');
  const existingProfileId = run?.profile_id ?? null;
  if (status === 'queued') {
    if (existingProfileId != null) throw new ProducerStateError('SYNC_QUEUED_PROFILE_RECEIPT_INVALID');
    if (!canonicalProfileId) throw new ProducerStateError('CANONICAL_PROFILE_ID_REQUIRED');
    return 'ASSIGN_PROFILE_AND_START';
  }
  if (status === 'running') {
    if (!existingProfileId) throw new ProducerStateError('SYNC_RUNNING_PROFILE_RECEIPT_MISSING');
    if (existingProfileId !== canonicalProfileId) throw new ProducerStateError('CANONICAL_PROFILE_RECEIPT_CONFLICT');
    return 'REUSE_PROFILE_RECEIPT';
  }
  if (['succeeded','partial','failed','cancelled'].includes(status)) return 'TERMINAL';
  throw new ProducerStateError('SYNC_RUN_STATUS_INVALID');
}
