import { stageDownloadedSearchTermReportOnce } from './search-term-fact-stage-producer.js';
import { publishSearchTermPartition } from './search-term-fact-publisher.js';

export class SearchTermIngestionError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'SearchTermIngestionError';
    this.code = code;
    this.cause = cause;
  }
}

// Advance at most one intended durable mutation boundary per call:
// downloaded without raw_row_count -> stage only;
// downloaded with a proven stage receipt -> publish only;
// ingested -> read-only committed-lineage verification.
export async function advanceSearchTermIngestionOnce({
  jobId,
  loadJob,
  stageReport,
  publishPartition,
}) {
  const canonicalJobId = requiredText(jobId, 'SEARCH_TERM_INGESTION_JOB_ID_REQUIRED');
  const load = requiredAdapter(loadJob, 'SEARCH_TERM_INGESTION_LOAD_JOB_ADAPTER_REQUIRED');
  const stage = requiredAdapter(stageReport, 'SEARCH_TERM_INGESTION_STAGE_ADAPTER_REQUIRED');
  const publish = requiredAdapter(publishPartition, 'SEARCH_TERM_INGESTION_PUBLISH_ADAPTER_REQUIRED');

  let preflight;
  try {
    preflight = await load(canonicalJobId);
  } catch (error) {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_PREFLIGHT_FAILED', error);
  }
  if (!preflight) throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_JOB_NOT_FOUND');

  if (preflight.status === 'ingested') {
    return verifyPublishedReceipt({ publish, jobId:canonicalJobId, action:'search_term_ingestion_reused' });
  }
  if (preflight.status !== 'downloaded') {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_JOB_NOT_READY');
  }

  if (preflight.raw_row_count == null) {
    let staged;
    try {
      staged = await stage(canonicalJobId);
    } catch (error) {
      throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_STAGE_FAILED', error);
    }
    assertStageResult(staged);

    // A concurrent publisher may win immediately after the stage commit. Verification of an
    // already-ingested receipt is read-only and therefore does not cross a second write boundary.
    if (staged.job.status === 'ingested') {
      return verifyPublishedReceipt({
        publish,
        jobId:canonicalJobId,
        action:'search_term_ingestion_completed_by_race',
      });
    }
    if (staged.job.status !== 'downloaded') {
      throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_STAGE_STATUS_INVALID');
    }
    assertNonNegativeSafeInteger(
      staged.job.raw_row_count,
      'SEARCH_TERM_INGESTION_STAGE_RECEIPT_MISSING',
    );
    return Object.freeze({
      action:'search_term_stage_ready',
      reused:Boolean(staged.reused),
      waiting:true,
      job:staged.job,
      stage:staged,
    });
  }

  assertNonNegativeSafeInteger(
    preflight.raw_row_count,
    'SEARCH_TERM_INGESTION_PREFLIGHT_RAW_ROW_COUNT_INVALID',
  );

  // Reuse the stage producer as a read-only durable stage verifier. Receipt-first semantics mean
  // it neither requires nor reads R2 when raw_row_count already exists.
  let staged;
  try {
    staged = await stage(canonicalJobId);
  } catch (error) {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_STAGE_RECEIPT_INVALID', error);
  }
  assertStageResult(staged);
  if (staged.job.status === 'ingested') {
    return verifyPublishedReceipt({ publish, jobId:canonicalJobId, action:'search_term_ingestion_reused' });
  }
  if (staged.job.status !== 'downloaded') {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_STAGE_STATUS_INVALID');
  }
  if (staged.job.raw_row_count !== preflight.raw_row_count) {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_STAGE_RECEIPT_CONFLICT');
  }

  return verifyPublishedReceipt({
    publish,
    jobId:canonicalJobId,
    action:'search_term_ingested',
    requireFreshPublish:true,
  });
}

export function createSearchTermIngestionRuntime({
  stageRepository,
  db,
  readRawObject,
  maxCompressedBytes,
  maxDecompressedBytes,
  now,
}) {
  if (!stageRepository || typeof stageRepository.loadJob !== 'function') {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_STAGE_REPOSITORY_INVALID');
  }
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_DB_INVALID');
  }

  return Object.freeze({
    async advance(jobId) {
      return advanceSearchTermIngestionOnce({
        jobId,
        loadJob:(id) => stageRepository.loadJob(id),
        stageReport:(id) => stageDownloadedSearchTermReportOnce({
          repository:stageRepository,
          jobId:id,
          readRawObject,
          maxCompressedBytes,
          maxDecompressedBytes,
        }),
        publishPartition:(id) => publishSearchTermPartition({
          db,
          jobId:id,
          now:resolveNow(now),
        }),
      });
    },
  });
}

async function verifyPublishedReceipt({ publish, jobId, action, requireFreshPublish = false }) {
  let result;
  try {
    result = await publish(jobId);
  } catch (error) {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_PUBLISH_FAILED', error);
  }
  if (!result || !result.job || result.job.status !== 'ingested') {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_PUBLISH_RECEIPT_INVALID');
  }
  if (requireFreshPublish && result.reused === true) {
    // A concurrent winner is acceptable: the publisher's ingested replay path verifies committed
    // lineage before returning reused=true, so the durable receipt remains authoritative.
    action = 'search_term_ingestion_reused_after_publish_race';
  }
  return Object.freeze({
    action,
    reused:Boolean(result.reused),
    waiting:false,
    job:result.job,
    publish:result,
  });
}

function assertStageResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !result.job) {
    throw new SearchTermIngestionError('SEARCH_TERM_INGESTION_STAGE_RESULT_INVALID');
  }
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return requiredText(value, 'SEARCH_TERM_INGESTION_NOW_REQUIRED');
}

function requiredAdapter(value, code) {
  if (typeof value !== 'function') throw new SearchTermIngestionError(code);
  return value;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new SearchTermIngestionError(code);
  return text;
}

function assertNonNegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new SearchTermIngestionError(code);
}
