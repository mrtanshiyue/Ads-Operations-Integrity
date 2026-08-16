import { createAmazonReportOnce } from './amazon-report-producer.js';
import { rawObjectDecision } from './amazon-producer-state.js';
import {
  buildRawObjectKey,
  validateDownloadedRawArtifact,
  buildCreateOnlyR2PutOptions,
  verifyInitialR2PutReceipt,
} from './amazon-raw-object-contract.js';

export class ReportAcquisitionError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'ReportAcquisitionError';
    this.code = code;
    this.cause = cause;
  }
}

// Advance at most one durable external boundary per call:
// queued -> Amazon create receipt; processing -> one status poll; ready -> raw materialization.
// This module is intentionally adapter-injected and is not wired into sync-worker yet.
export async function advanceReportAcquisitionOnce({
  repository,
  jobId,
  storeCode,
  adapters,
  maxCompressedBytes,
  now,
}) {
  requireRepository(repository);
  const canonicalJobId = requiredText(jobId, 'REPORT_JOB_ID_REQUIRED');
  let job = await repository.loadByJobId(canonicalJobId);
  if (!job) throw new ReportAcquisitionError('REPORT_JOB_NOT_FOUND');

  if (job.status === 'queued') {
    const createReport = requiredAdapter(adapters?.createReport, 'AMAZON_CREATE_REPORT_ADAPTER_REQUIRED');
    job = await createAmazonReportOnce({ repository, jobId: canonicalJobId, createReport });
    return Object.freeze({ action: 'amazon_report_created', waiting: true, reused: false, job });
  }

  if (job.status === 'requested') {
    // Preserve the one-POST fail-closed rule. createAmazonReportOnce will throw
    // AMAZON_REPORT_CREATE_AMBIGUOUS without invoking the supplied function.
    await createAmazonReportOnce({
      repository,
      jobId: canonicalJobId,
      async createReport() {
        throw new ReportAcquisitionError('AMAZON_CREATE_REPORT_RETRY_FORBIDDEN');
      },
    });
    throw new ReportAcquisitionError('AMAZON_REPORT_REQUESTED_STATE_UNEXPECTED');
  }

  if (job.status === 'processing') {
    const pollReport = requiredAdapter(adapters?.pollReport, 'AMAZON_REPORT_POLL_ADAPTER_REQUIRED');
    const poll = normalizeReportPollResult(await pollReport(Object.freeze({
      reportId: requiredText(job.amazon_report_id, 'AMAZON_REPORT_ID_RECEIPT_MISSING'),
      jobId: job.job_id,
    })));

    if (poll.state === 'processing') {
      return Object.freeze({ action: 'amazon_report_polled', waiting: true, reused: false, job });
    }
    if (poll.state === 'failed') {
      await repository.markFailed(job.job_id, poll.failureCode, poll.failureMessage);
      job = await repository.loadByJobId(job.job_id);
      if (!job || job.status !== 'failed') throw new ReportAcquisitionError('AMAZON_REPORT_FAILURE_RECEIPT_MISSING');
      return Object.freeze({ action: 'amazon_report_failed', waiting: false, reused: false, job });
    }

    await repository.markReady(job.job_id);
    job = await repository.loadByJobId(job.job_id);
    if (!job) throw new ReportAcquisitionError('REPORT_JOB_NOT_FOUND_AFTER_READY');
    if (job.status === 'ready') {
      return Object.freeze({ action: 'amazon_report_ready', waiting: false, reused: false, job });
    }
    if (job.status === 'downloaded' || job.status === 'ingested') {
      assertDownloadedRawReceipt(job);
      return Object.freeze({ action: 'raw_receipt_reused_after_ready_race', waiting: false, reused: true, job });
    }
    throw new ReportAcquisitionError('AMAZON_REPORT_READY_RECEIPT_MISSING');
  }

  if (job.status === 'ready') {
    return materializeRawReportOnce({
      repository,
      job,
      storeCode,
      downloadReport: requiredAdapter(adapters?.downloadReport, 'AMAZON_REPORT_DOWNLOAD_ADAPTER_REQUIRED'),
      putRawObject: requiredAdapter(adapters?.putRawObject, 'R2_CREATE_ONLY_PUT_ADAPTER_REQUIRED'),
      maxCompressedBytes,
      now,
    });
  }

  if (job.status === 'downloaded' || job.status === 'ingested') {
    assertDownloadedRawReceipt(job);
    return Object.freeze({ action: 'raw_receipt_reused', waiting: false, reused: true, job });
  }

  if (job.status === 'failed' || job.status === 'cancelled') {
    return Object.freeze({ action: 'report_job_terminal', waiting: false, reused: true, job });
  }

  throw new ReportAcquisitionError('REPORT_JOB_STATUS_UNSUPPORTED');
}

export async function materializeRawReportOnce({
  repository,
  job,
  storeCode,
  downloadReport,
  putRawObject,
  maxCompressedBytes,
  now,
}) {
  if (!job || job.status !== 'ready') throw new ReportAcquisitionError('REPORT_JOB_NOT_READY_FOR_RAW_MATERIALIZATION');
  const expectedKey = buildRawObjectKey({
    storeCode: requiredText(storeCode, 'STORE_CODE_REQUIRED'),
    profileId: job.profile_id,
    adProduct: job.ad_product,
    reportType: job.report_type,
    startDate: job.start_date,
    amazonReportId: requiredText(job.amazon_report_id, 'AMAZON_REPORT_ID_RECEIPT_MISSING'),
  });

  // Download is read-only and may be repeated after a crash. The bytes must always
  // match any previously persisted expected authority before a create-only PUT is attempted.
  const download = await downloadReport(Object.freeze({
    reportId: job.amazon_report_id,
    jobId: job.job_id,
  }));
  const bytes = download?.bytes;
  const artifact = await validateDownloadedRawArtifact({
    bytes,
    contentEncoding: download?.contentEncoding,
    maxCompressedBytes,
  });
  const expected = Object.freeze({
    r2ObjectKey: expectedKey,
    contentSha256: artifact.contentSha256,
    contentBytes: artifact.contentBytes,
  });

  const expectedState = inspectExpectedRawAuthority(job);
  if (expectedState === 'absent') {
    await repository.persistRawExpectedAuthority(job.job_id, expected);
    job = await repository.loadByJobId(job.job_id);
    if (!job) throw new ReportAcquisitionError('REPORT_JOB_NOT_FOUND_AFTER_RAW_AUTHORITY');
  }

  if (job.status === 'downloaded' || job.status === 'ingested') {
    assertDownloadedRawReceipt(job, expected);
    return Object.freeze({ action: 'raw_receipt_reused_after_authority_race', waiting: false, reused: true, job });
  }
  if (job.status !== 'ready') throw new ReportAcquisitionError('RAW_EXPECTED_AUTHORITY_STATUS_CONFLICT');
  assertExpectedRawAuthority(job, expected);

  const decision = rawObjectDecision(job);
  if (decision !== 'PUT_CREATE_ONLY') throw new ReportAcquisitionError('RAW_OBJECT_DECISION_INVALID');

  let putObject;
  try {
    putObject = await putRawObject(Object.freeze({
      key: expected.r2ObjectKey,
      bytes,
      options: buildCreateOnlyR2PutOptions(expected.contentSha256),
    }));
  } catch (error) {
    // Never HEAD/backfill an ambiguous create-only PUT. Only a durable Store D1
    // initial receipt written by a concurrent winner can disambiguate this callback.
    const raced = await repository.loadByJobId(job.job_id);
    if (raced && (raced.status === 'downloaded' || raced.status === 'ingested')) {
      assertDownloadedRawReceipt(raced, expected);
      return Object.freeze({ action: 'raw_receipt_reused_after_put_race', waiting: false, reused: true, job: raced });
    }
    throw new ReportAcquisitionError('R2_UPLOAD_AMBIGUOUS', error);
  }

  const initial = verifyInitialR2PutReceipt({
    expectedKey: expected.r2ObjectKey,
    expectedSha256: expected.contentSha256,
    expectedBytes: expected.contentBytes,
    object: putObject,
  });
  await repository.persistInitialR2Receipt(job.job_id, {
    ...initial,
    downloadedAt: requiredText(now, 'RAW_DOWNLOADED_AT_REQUIRED'),
  });

  const committed = await repository.loadByJobId(job.job_id);
  if (!committed) throw new ReportAcquisitionError('REPORT_JOB_NOT_FOUND_AFTER_R2_RECEIPT');
  assertDownloadedRawReceipt(committed, expected, initial);
  return Object.freeze({ action: 'raw_object_materialized', waiting: false, reused: false, job: committed });
}

export function normalizeReportPollResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReportAcquisitionError('AMAZON_REPORT_POLL_RESULT_INVALID');
  }
  const state = String(value.state ?? '').trim().toLowerCase();
  if (state === 'processing' || state === 'ready') return Object.freeze({ state });
  if (state === 'failed') {
    return Object.freeze({
      state,
      failureCode: requiredText(value.failureCode, 'AMAZON_REPORT_FAILURE_CODE_REQUIRED'),
      failureMessage: value.failureMessage == null ? null : String(value.failureMessage),
    });
  }
  throw new ReportAcquisitionError('AMAZON_REPORT_POLL_STATE_INVALID');
}

export function inspectExpectedRawAuthority(job) {
  const values = [job?.r2_object_key, job?.content_sha256, job?.content_bytes];
  const present = values.map((value) => value !== null && value !== undefined && value !== '');
  if (present.every(Boolean)) return 'complete';
  if (present.some(Boolean)) throw new ReportAcquisitionError('R2_EXPECTED_AUTHORITY_INCOMPLETE');
  return 'absent';
}

export function assertExpectedRawAuthority(job, expected) {
  if (inspectExpectedRawAuthority(job) !== 'complete') {
    throw new ReportAcquisitionError('R2_EXPECTED_AUTHORITY_MISSING');
  }
  if (job.r2_object_key !== expected.r2ObjectKey) throw new ReportAcquisitionError('R2_EXPECTED_AUTHORITY_CONFLICT:r2_object_key');
  if (String(job.content_sha256).toLowerCase() !== expected.contentSha256) throw new ReportAcquisitionError('R2_EXPECTED_AUTHORITY_CONFLICT:content_sha256');
  if (job.content_bytes !== expected.contentBytes) throw new ReportAcquisitionError('R2_EXPECTED_AUTHORITY_CONFLICT:content_bytes');
  return true;
}

export function assertDownloadedRawReceipt(job, expected = null, initial = null) {
  if (!job || (job.status !== 'downloaded' && job.status !== 'ingested')) {
    throw new ReportAcquisitionError('R2_INITIAL_RECEIPT_STATUS_INVALID');
  }
  if (!job.downloaded_at) throw new ReportAcquisitionError('R2_INITIAL_RECEIPT_DOWNLOADED_AT_MISSING');
  if (rawObjectDecision(job) !== 'REUSE_INITIAL_R2_RECEIPT') {
    throw new ReportAcquisitionError('R2_INITIAL_RECEIPT_INVALID');
  }
  if (expected) assertExpectedRawAuthority(job, expected);
  if (initial) {
    if (job.r2_initial_version !== initial.r2InitialVersion) throw new ReportAcquisitionError('R2_INITIAL_RECEIPT_CONFLICT:r2_initial_version');
    if (job.r2_initial_etag !== initial.r2InitialEtag) throw new ReportAcquisitionError('R2_INITIAL_RECEIPT_CONFLICT:r2_initial_etag');
  }
  return true;
}

function requireRepository(repository) {
  const methods = [
    'loadByJobId', 'armCreate', 'persistAmazonReportReceipt', 'markReady', 'markFailed',
    'persistRawExpectedAuthority', 'persistInitialR2Receipt',
  ];
  if (!repository || methods.some((method) => typeof repository[method] !== 'function')) {
    throw new ReportAcquisitionError('REPORT_ACQUISITION_REPOSITORY_INVALID');
  }
}

function requiredAdapter(value, code) {
  if (typeof value !== 'function') throw new ReportAcquisitionError(code);
  return value;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ReportAcquisitionError(code);
  return text;
}
