import { canonicalizeSearchTermFact } from './amazon-search-term-parser.js';
import {
  validateDownloadedRawArtifact,
  verifyRawObjectBeforeIngest,
} from './amazon-raw-object-contract.js';

const DATASET_KEY = 'search_term_daily';

export class SearchTermFactStageError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'SearchTermFactStageError';
    this.code = code;
    this.cause = cause;
  }
}

// Convert one immutable downloaded SP search-term raw object into deterministic stage rows.
// The R2 body is read-only and may be reread after a crash. Durable stage authority exists only
// after the repository atomically persists the exact rows plus raw_row_count completion receipt.
export async function stageDownloadedSearchTermReportOnce({
  repository,
  jobId,
  readRawObject,
  maxCompressedBytes,
  maxDecompressedBytes,
}) {
  requireRepository(repository);
  const canonicalJobId = requiredText(jobId, 'SEARCH_TERM_STAGE_JOB_ID_REQUIRED');

  let job = await repository.loadJob(canonicalJobId);
  if (!job) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_JOB_NOT_FOUND');

  if (job.status === 'ingested') {
    assertNonNegativeSafeInteger(job.raw_row_count, 'SEARCH_TERM_STAGE_INGESTED_RAW_ROW_COUNT_INVALID');
    return Object.freeze({ action:'stage_receipt_reused_after_ingest', reused:true, job });
  }
  assertDownloadedJob(job);

  if (job.raw_row_count != null) {
    const staged = await repository.inspectStage(job.job_id);
    assertStageReceipt(job, staged);
    return Object.freeze({ action:'stage_receipt_reused', reused:true, job, stagedRowCount:job.raw_row_count });
  }

  const readObject = requiredAdapter(readRawObject, 'SEARCH_TERM_STAGE_R2_READ_ADAPTER_REQUIRED');
  let raw;
  try {
    raw = await readObject(Object.freeze({ key:job.r2_object_key, jobId:job.job_id }));
  } catch (error) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_R2_READ_FAILED', error);
  }
  const bytes = assertRawObjectRead(job, raw);

  let artifact;
  try {
    verifyRawObjectBeforeIngest({ job, observation:{ observed:true, object:raw } });
    artifact = await validateDownloadedRawArtifact({
      bytes,
      contentEncoding:'identity',
      maxCompressedBytes,
    });
  } catch (error) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RAW_OBJECT_INVALID', error);
  }
  if (artifact.contentBytes !== job.content_bytes) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RAW_BODY_SIZE_MISMATCH');
  }
  if (artifact.contentSha256 !== String(job.content_sha256).toLowerCase()) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RAW_BODY_SHA256_MISMATCH');
  }

  const sourceRows = await decodeGzipJsonRows({ bytes, maxDecompressedBytes });
  const stageRows = await canonicalizeRows(job, sourceRows);

  try {
    await repository.replaceStageAndPersistReceipt(Object.freeze({
      job:Object.freeze({ ...job }),
      rows:Object.freeze(stageRows.slice()),
      rawRowCount:stageRows.length,
    }));
  } catch (error) {
    // A concurrent winner may have committed the same immutable stage receipt. Never treat the
    // failed write as success by itself; reload and prove exact durable stage identity first.
    const raced = await repository.loadJob(job.job_id);
    if (raced?.status === 'ingested' && raced.raw_row_count === stageRows.length) {
      return Object.freeze({ action:'stage_receipt_reused_after_publish_race', reused:true, job:raced });
    }
    if (raced?.status === 'downloaded' && raced.raw_row_count != null) {
      const staged = await repository.inspectStage(job.job_id);
      assertStageReceipt(raced, staged, stageRows);
      return Object.freeze({
        action:'stage_receipt_reused_after_commit_race',
        reused:true,
        job:raced,
        stagedRowCount:raced.raw_row_count,
      });
    }
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_COMMIT_FAILED', error);
  }

  job = await repository.loadJob(job.job_id);
  if (!job) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_JOB_MISSING_AFTER_COMMIT');
  if (job.status === 'ingested' && job.raw_row_count === stageRows.length) {
    return Object.freeze({ action:'stage_committed_then_published', reused:false, job, stagedRowCount:stageRows.length });
  }
  if (job.status !== 'downloaded') throw new SearchTermFactStageError('SEARCH_TERM_STAGE_STATUS_CONFLICT_AFTER_COMMIT');
  const staged = await repository.inspectStage(job.job_id);
  assertStageReceipt(job, staged, stageRows);
  return Object.freeze({
    action:'search_term_stage_committed',
    reused:false,
    job,
    stagedRowCount:stageRows.length,
  });
}

export async function decodeGzipJsonRows({ bytes, maxDecompressedBytes }) {
  const data = asUint8Array(bytes, 'SEARCH_TERM_STAGE_GZIP_BYTES_INVALID');
  if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes <= 0) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_DECOMPRESSED_SIZE_POLICY_INVALID');
  }
  if (typeof DecompressionStream !== 'function') {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_GZIP_RUNTIME_UNAVAILABLE');
  }

  let reader;
  try {
    reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  } catch (error) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_GZIP_STREAM_INVALID', error);
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = asUint8Array(value, 'SEARCH_TERM_STAGE_GZIP_CHUNK_INVALID');
      total += chunk.byteLength;
      if (total > maxDecompressedBytes) {
        try { await reader.cancel('decompressed limit exceeded'); } catch {}
        throw new SearchTermFactStageError('SEARCH_TERM_STAGE_DECOMPRESSED_LIMIT_EXCEEDED');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof SearchTermFactStageError) throw error;
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_GZIP_DECOMPRESSION_FAILED', error);
  }

  const decoded = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal:true }).decode(decoded);
  } catch (error) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_UTF8_INVALID', error);
  }

  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_JSON_INVALID', error);
  }
  if (!Array.isArray(rows)) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_JSON_ARRAY_REQUIRED');
  return rows;
}

export function assertStageReceipt(job, stagedRows, expectedRows = null) {
  assertNonNegativeSafeInteger(job?.raw_row_count, 'SEARCH_TERM_STAGE_RAW_ROW_COUNT_RECEIPT_INVALID');
  if (!Array.isArray(stagedRows)) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_INSPECTION_INVALID');
  if (stagedRows.length !== job.raw_row_count) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_COUNT_MISMATCH');
  if (expectedRows != null && (!Array.isArray(expectedRows) || expectedRows.length !== stagedRows.length)) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_EXPECTED_ROWS_INVALID');
  }

  for (let index = 0; index < stagedRows.length; index += 1) {
    const row = stagedRows[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_ROW_INVALID');
    }
    if (row.dataset_key !== DATASET_KEY) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_DATASET_MISMATCH');
    if (row.source_row_ordinal !== index) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_ORDINAL_MISMATCH');
    requiredText(row.logical_row_key, 'SEARCH_TERM_STAGE_RECEIPT_LOGICAL_KEY_INVALID');
    requiredText(row.canonical_row_json, 'SEARCH_TERM_STAGE_RECEIPT_CANONICAL_JSON_INVALID');

    let canonical;
    try { canonical = JSON.parse(row.canonical_row_json); }
    catch { throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_CANONICAL_JSON_INVALID'); }
    if (canonical?.rowKey !== row.logical_row_key) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_ROW_KEY_MISMATCH');
    if (canonical?.sourceReportJobId !== job.job_id) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_SOURCE_JOB_MISMATCH');
    if (canonical?.profileId !== job.profile_id) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_PROFILE_MISMATCH');
    if (canonical?.adProduct !== job.ad_product) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_AD_PRODUCT_MISMATCH');
    if (typeof canonical?.reportDate !== 'string'
        || canonical.reportDate < job.start_date
        || canonical.reportDate > job.end_date) {
      throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_DATE_MISMATCH');
    }

    if (expectedRows) {
      const expected = expectedRows[index];
      if (row.dataset_key !== expected.datasetKey
          || row.source_row_ordinal !== expected.sourceRowOrdinal
          || row.logical_row_key !== expected.logicalRowKey
          || row.canonical_row_json !== expected.canonicalRowJson) {
        throw new SearchTermFactStageError('SEARCH_TERM_STAGE_RECEIPT_CONFLICT');
      }
    }
  }
  return true;
}

async function canonicalizeRows(job, sourceRows) {
  const staged = [];
  const logicalKeys = new Set();
  for (let index = 0; index < sourceRows.length; index += 1) {
    let parsed;
    try {
      parsed = await canonicalizeSearchTermFact({
        row:sourceRows[index],
        profileId:job.profile_id,
        accountType:job.account_type,
        sourceReportJobId:job.job_id,
      });
    } catch (error) {
      throw new SearchTermFactStageError(`SEARCH_TERM_STAGE_ROW_INVALID:${index}`, error);
    }
    if (parsed.fact.reportDate < job.start_date || parsed.fact.reportDate > job.end_date) {
      throw new SearchTermFactStageError(`SEARCH_TERM_STAGE_ROW_DATE_OUT_OF_RANGE:${index}`);
    }
    if (logicalKeys.has(parsed.fact.rowKey)) {
      throw new SearchTermFactStageError(`SEARCH_TERM_STAGE_DUPLICATE_LOGICAL_ROW:${index}`);
    }
    logicalKeys.add(parsed.fact.rowKey);
    staged.push(Object.freeze({
      datasetKey:DATASET_KEY,
      sourceRowOrdinal:index,
      logicalRowKey:parsed.fact.rowKey,
      canonicalRowJson:parsed.canonicalRowJson,
    }));
  }
  return Object.freeze(staged);
}

function assertDownloadedJob(job) {
  if (job.status !== 'downloaded') throw new SearchTermFactStageError('SEARCH_TERM_STAGE_JOB_NOT_DOWNLOADED');
  if (job.ad_product !== 'SPONSORED_PRODUCTS' || job.report_type !== 'spSearchTerm') {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_REPORT_CONTRACT_MISMATCH');
  }
  requiredText(job.profile_id, 'SEARCH_TERM_STAGE_PROFILE_ID_REQUIRED');
  const accountType = String(job.account_type ?? '').trim().toLowerCase();
  if (accountType !== 'seller' && accountType !== 'vendor') {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_ACCOUNT_TYPE_UNSUPPORTED');
  }
  requiredText(job.start_date, 'SEARCH_TERM_STAGE_START_DATE_REQUIRED');
  requiredText(job.end_date, 'SEARCH_TERM_STAGE_END_DATE_REQUIRED');
  requiredText(job.r2_object_key, 'SEARCH_TERM_STAGE_R2_KEY_REQUIRED');
  requiredText(job.r2_initial_version, 'SEARCH_TERM_STAGE_R2_VERSION_REQUIRED');
  requiredText(job.r2_initial_etag, 'SEARCH_TERM_STAGE_R2_ETAG_REQUIRED');
  requiredText(job.downloaded_at, 'SEARCH_TERM_STAGE_DOWNLOADED_AT_REQUIRED');
  if (!/^[0-9a-f]{64}$/.test(String(job.content_sha256 || ''))) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_CONTENT_SHA256_INVALID');
  }
  assertNonNegativeSafeInteger(job.content_bytes, 'SEARCH_TERM_STAGE_CONTENT_BYTES_INVALID');
}

function assertRawObjectRead(job, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_R2_OBJECT_MISSING');
  }
  if (raw.key !== job.r2_object_key) throw new SearchTermFactStageError('SEARCH_TERM_STAGE_R2_KEY_MISMATCH');
  return asUint8Array(raw.bytes, 'SEARCH_TERM_STAGE_R2_BODY_BYTES_INVALID');
}

function requireRepository(repository) {
  const methods = ['loadJob', 'inspectStage', 'replaceStageAndPersistReceipt'];
  if (!repository || methods.some((method) => typeof repository[method] !== 'function')) {
    throw new SearchTermFactStageError('SEARCH_TERM_STAGE_REPOSITORY_INVALID');
  }
}

function requiredAdapter(value, code) {
  if (typeof value !== 'function') throw new SearchTermFactStageError(code);
  return value;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new SearchTermFactStageError(code);
  return text;
}

function assertNonNegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new SearchTermFactStageError(code);
}

function asUint8Array(value, code) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new SearchTermFactStageError(code);
}
