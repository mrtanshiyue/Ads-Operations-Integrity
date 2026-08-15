import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  decodeGzipJsonRows,
  stageDownloadedSearchTermReportOnce,
  SearchTermFactStageError,
} from '../cloudflare/runtime/search-term-fact-stage-producer.js';

const MAX_COMPRESSED = 1024 * 1024;
const MAX_DECOMPRESSED = 4 * 1024 * 1024;

async function sha256Hex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', view));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

function sourceRow(overrides = {}) {
  return {
    date:'2026-08-12',
    campaignId:'campaign-1',
    adGroupId:'adgroup-1',
    keywordType:'BROAD',
    keywordId:'keyword-1',
    searchTerm:'Reading Glasses',
    matchType:'BROAD',
    impressions:100,
    clicks:10,
    cost:'1.250000',
    purchases1d:1,
    purchases7d:2,
    purchases14d:3,
    purchases30d:4,
    unitsSoldClicks1d:1,
    unitsSoldClicks7d:2,
    unitsSoldClicks14d:3,
    unitsSoldClicks30d:4,
    sales1d:'5.000000',
    sales7d:'10.000000',
    sales14d:'15.000000',
    sales30d:'20.000000',
    campaignBudgetCurrencyCode:'USD',
    keyword:'reading glasses',
    targeting:null,
    ...overrides,
  };
}

async function rawArtifact(rowsOrText, { rawText = false } = {}) {
  const text = rawText ? String(rowsOrText) : JSON.stringify(rowsOrText);
  const bytes = new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));
  return { bytes, sha256:await sha256Hex(bytes) };
}

function baseJob(overrides = {}) {
  return {
    job_id:'job-1',
    run_id:'run-1',
    profile_id:'profile-1',
    account_type:'seller',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    status:'downloaded',
    r2_object_key:'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-1.json.gz',
    content_sha256:null,
    content_bytes:null,
    r2_initial_version:'version-1',
    r2_initial_etag:'etag-1',
    downloaded_at:'2026-08-15T14:30:00Z',
    raw_row_count:null,
    row_count:null,
    ingested_at:null,
    ...overrides,
  };
}

function dbStageRows(rows) {
  return rows.map((row) => ({
    dataset_key:row.datasetKey,
    source_row_ordinal:row.sourceRowOrdinal,
    logical_row_key:row.logicalRowKey,
    canonical_row_json:row.canonicalRowJson,
  }));
}

class FakeRepository {
  constructor(job, { commitMode = 'success', initialStage = [] } = {}) {
    this.job = { ...job };
    this.stage = initialStage.map((row) => ({ ...row }));
    this.commitMode = commitMode;
    this.loadCalls = 0;
    this.inspectCalls = 0;
    this.commitCalls = 0;
  }

  async loadJob(jobId) {
    this.loadCalls += 1;
    assert.equal(jobId, this.job.job_id);
    return { ...this.job };
  }

  async inspectStage(jobId) {
    this.inspectCalls += 1;
    assert.equal(jobId, this.job.job_id);
    return this.stage.map((row) => ({ ...row }));
  }

  async replaceStageAndPersistReceipt({ job, rows, rawRowCount }) {
    this.commitCalls += 1;
    assert.equal(job.job_id, this.job.job_id);
    assert.equal(job.status, 'downloaded');
    assert.equal(job.raw_row_count, null);
    assert.equal(rawRowCount, rows.length);

    if (this.commitMode === 'throw_before') throw new Error('commit failed before receipt');

    this.stage = dbStageRows(rows);
    this.job.raw_row_count = rawRowCount;

    if (this.commitMode === 'throw_after_same') throw new Error('response lost after exact commit');
    if (this.commitMode === 'throw_after_conflict') {
      if (this.stage.length) {
        const parsed = JSON.parse(this.stage[0].canonical_row_json);
        parsed.normalizedSearchTerm = 'conflicting durable stage';
        this.stage[0].canonical_row_json = JSON.stringify(parsed);
      }
      throw new Error('response lost after conflicting commit');
    }
    if (this.commitMode === 'publish_after_commit') {
      this.job.status = 'ingested';
      this.job.row_count = rawRowCount;
      this.job.ingested_at = '2026-08-15T14:31:00Z';
      this.stage = [];
    }
    return true;
  }
}

function makeRawReader(job, artifact, calls, overrides = {}) {
  return async ({ key, jobId }) => {
    calls.read += 1;
    assert.equal(key, job.r2_object_key);
    assert.equal(jobId, job.job_id);
    return {
      key:job.r2_object_key,
      size:artifact.bytes.byteLength,
      version:job.r2_initial_version,
      etag:job.r2_initial_etag,
      checksums:{ sha256:hexBuffer(artifact.sha256) },
      bytes:artifact.bytes,
      ...overrides,
    };
  };
}

async function expectCode(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof SearchTermFactStageError, error);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

async function buildFixture(rows, jobOverrides = {}, repositoryOptions = {}) {
  const artifact = await rawArtifact(rows);
  const job = baseJob({
    content_sha256:artifact.sha256,
    content_bytes:artifact.bytes.byteLength,
    ...jobOverrides,
  });
  const repository = new FakeRepository(job, repositoryOptions);
  const calls = { read:0 };
  const readRawObject = makeRawReader(job, artifact, calls);
  return { artifact, job, repository, calls, readRawObject };
}

// Real gzip JSON decoding is exercised in Node 22, matching the runtime contract.
{
  const artifact = await rawArtifact([sourceRow()]);
  const decoded = await decodeGzipJsonRows({ bytes:artifact.bytes, maxDecompressedBytes:MAX_DECOMPRESSED });
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].searchTerm, 'Reading Glasses');
}

// Two valid rows become deterministic stage rows and an immutable raw_row_count receipt.
{
  const fixture = await buildFixture([
    sourceRow(),
    sourceRow({ searchTerm:'Computer Readers', keywordId:'keyword-2' }),
  ]);
  const result = await stageDownloadedSearchTermReportOnce({
    repository:fixture.repository,
    jobId:fixture.job.job_id,
    readRawObject:fixture.readRawObject,
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
  });
  assert.equal(result.action, 'search_term_stage_committed');
  assert.equal(result.reused, false);
  assert.equal(result.stagedRowCount, 2);
  assert.equal(fixture.repository.job.raw_row_count, 2);
  assert.equal(fixture.repository.stage.length, 2);
  assert.deepEqual(fixture.repository.stage.map((row) => row.source_row_ordinal), [0, 1]);
  assert.equal(new Set(fixture.repository.stage.map((row) => row.logical_row_key)).size, 2);
  assert.equal(fixture.calls.read, 1);
  assert.equal(fixture.repository.commitCalls, 1);
}

// Empty Amazon report is a valid deterministic stage with raw_row_count=0.
{
  const fixture = await buildFixture([]);
  const result = await stageDownloadedSearchTermReportOnce({
    repository:fixture.repository,
    jobId:fixture.job.job_id,
    readRawObject:fixture.readRawObject,
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
  });
  assert.equal(result.stagedRowCount, 0);
  assert.equal(fixture.repository.job.raw_row_count, 0);
  assert.deepEqual(fixture.repository.stage, []);
}

// Receipt-first recovery requires neither an R2 read nor even an R2 adapter after stage commit.
{
  const fixture = await buildFixture([sourceRow()]);
  await stageDownloadedSearchTermReportOnce({
    repository:fixture.repository,
    jobId:fixture.job.job_id,
    readRawObject:fixture.readRawObject,
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
  });
  const readsBeforeRetry = fixture.calls.read;
  const result = await stageDownloadedSearchTermReportOnce({
    repository:fixture.repository,
    jobId:fixture.job.job_id,
  });
  assert.equal(result.action, 'stage_receipt_reused');
  assert.equal(result.reused, true);
  assert.equal(fixture.calls.read, readsBeforeRetry);
  assert.equal(fixture.repository.commitCalls, 1);
}

// Once publication has made the job ingested, deleted stage rows do not force an R2 reread.
{
  const job = baseJob({ status:'ingested', raw_row_count:2, row_count:2, ingested_at:'done' });
  const repository = new FakeRepository(job);
  const result = await stageDownloadedSearchTermReportOnce({ repository, jobId:job.job_id });
  assert.equal(result.action, 'stage_receipt_reused_after_ingest');
  assert.equal(repository.inspectCalls, 0);
  assert.equal(repository.commitCalls, 0);
}

// Immutable R2 version/etag/native checksum identity is verified before body parsing or stage write.
{
  const fixture = await buildFixture([sourceRow()]);
  const badReader = makeRawReader(fixture.job, fixture.artifact, fixture.calls, { version:'different-version' });
  const error = await expectCode('SEARCH_TERM_STAGE_RAW_OBJECT_INVALID', () =>
    stageDownloadedSearchTermReportOnce({
      repository:fixture.repository,
      jobId:fixture.job.job_id,
      readRawObject:badReader,
      maxCompressedBytes:MAX_COMPRESSED,
      maxDecompressedBytes:MAX_DECOMPRESSED,
    }),
  );
  assert.equal(error.cause.code, 'RAW_OBJECT_MUTATED_BEFORE_INGEST');
  assert.equal(fixture.repository.commitCalls, 0);
}

// Native metadata alone is not trusted: actual returned bytes are hashed again before ingest.
{
  const fixture = await buildFixture([sourceRow()]);
  const mutated = new Uint8Array(fixture.artifact.bytes);
  mutated[mutated.length - 1] ^= 0x01;
  const readRawObject = async () => ({
    key:fixture.job.r2_object_key,
    size:fixture.job.content_bytes,
    version:fixture.job.r2_initial_version,
    etag:fixture.job.r2_initial_etag,
    checksums:{ sha256:hexBuffer(fixture.job.content_sha256) },
    bytes:mutated,
  });
  await expectCode('SEARCH_TERM_STAGE_RAW_BODY_SHA256_MISMATCH', () =>
    stageDownloadedSearchTermReportOnce({
      repository:fixture.repository,
      jobId:fixture.job.job_id,
      readRawObject,
      maxCompressedBytes:MAX_COMPRESSED,
      maxDecompressedBytes:MAX_DECOMPRESSED,
    }),
  );
  assert.equal(fixture.repository.commitCalls, 0);
}

// Invalid JSON and decompressed-size bombs fail before any durable stage commit.
{
  const artifact = await rawArtifact('{not-json', { rawText:true });
  const job = baseJob({ content_sha256:artifact.sha256, content_bytes:artifact.bytes.byteLength });
  const repository = new FakeRepository(job);
  const calls = { read:0 };
  await expectCode('SEARCH_TERM_STAGE_JSON_INVALID', () =>
    stageDownloadedSearchTermReportOnce({
      repository,
      jobId:job.job_id,
      readRawObject:makeRawReader(job, artifact, calls),
      maxCompressedBytes:MAX_COMPRESSED,
      maxDecompressedBytes:MAX_DECOMPRESSED,
    }),
  );
  assert.equal(repository.commitCalls, 0);
}
{
  const artifact = await rawArtifact([sourceRow({ searchTerm:'x'.repeat(4096) })]);
  await expectCode('SEARCH_TERM_STAGE_DECOMPRESSED_LIMIT_EXCEEDED', () =>
    decodeGzipJsonRows({ bytes:artifact.bytes, maxDecompressedBytes:64 }),
  );
}

// Parser output must stay inside the frozen report date range.
{
  const fixture = await buildFixture([sourceRow({ date:'2026-08-13' })]);
  await expectCode('SEARCH_TERM_STAGE_ROW_DATE_OUT_OF_RANGE:0', () =>
    stageDownloadedSearchTermReportOnce({
      repository:fixture.repository,
      jobId:fixture.job.job_id,
      readRawObject:fixture.readRawObject,
      maxCompressedBytes:MAX_COMPRESSED,
      maxDecompressedBytes:MAX_DECOMPRESSED,
    }),
  );
  assert.equal(fixture.repository.commitCalls, 0);
}

// Duplicate logical facts in one raw report are rejected rather than hidden by stage PK conflicts.
{
  const row = sourceRow();
  const fixture = await buildFixture([row, { ...row }]);
  await expectCode('SEARCH_TERM_STAGE_DUPLICATE_LOGICAL_ROW:1', () =>
    stageDownloadedSearchTermReportOnce({
      repository:fixture.repository,
      jobId:fixture.job.job_id,
      readRawObject:fixture.readRawObject,
      maxCompressedBytes:MAX_COMPRESSED,
      maxDecompressedBytes:MAX_DECOMPRESSED,
    }),
  );
  assert.equal(fixture.repository.commitCalls, 0);
}

// Lost commit response is recoverable only when the durable stage is byte-for-byte canonical-identical.
{
  const fixture = await buildFixture([sourceRow()], {}, { commitMode:'throw_after_same' });
  const result = await stageDownloadedSearchTermReportOnce({
    repository:fixture.repository,
    jobId:fixture.job.job_id,
    readRawObject:fixture.readRawObject,
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
  });
  assert.equal(result.action, 'stage_receipt_reused_after_commit_race');
  assert.equal(result.reused, true);
  assert.equal(fixture.repository.job.raw_row_count, 1);
}

// A conflicting durable winner cannot be mistaken for an idempotent retry.
{
  const fixture = await buildFixture([sourceRow()], {}, { commitMode:'throw_after_conflict' });
  await expectCode('SEARCH_TERM_STAGE_RECEIPT_CONFLICT', () =>
    stageDownloadedSearchTermReportOnce({
      repository:fixture.repository,
      jobId:fixture.job.job_id,
      readRawObject:fixture.readRawObject,
      maxCompressedBytes:MAX_COMPRESSED,
      maxDecompressedBytes:MAX_DECOMPRESSED,
    }),
  );
}

// Publication racing immediately after stage commit is safely recognized from durable job receipt.
{
  const fixture = await buildFixture([sourceRow()], {}, { commitMode:'publish_after_commit' });
  const result = await stageDownloadedSearchTermReportOnce({
    repository:fixture.repository,
    jobId:fixture.job.job_id,
    readRawObject:fixture.readRawObject,
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
  });
  assert.equal(result.action, 'stage_committed_then_published');
  assert.equal(result.job.status, 'ingested');
  assert.equal(result.job.raw_row_count, 1);
}

// Unsupported durable job identity is rejected before R2 is touched.
{
  const fixture = await buildFixture([sourceRow()], { account_type:'agency' });
  await expectCode('SEARCH_TERM_STAGE_ACCOUNT_TYPE_UNSUPPORTED', () =>
    stageDownloadedSearchTermReportOnce({ repository:fixture.repository, jobId:fixture.job.job_id }),
  );
  assert.equal(fixture.calls.read, 0);
}
{
  const fixture = await buildFixture([sourceRow()], { report_type:'spCampaigns' });
  await expectCode('SEARCH_TERM_STAGE_REPORT_CONTRACT_MISMATCH', () =>
    stageDownloadedSearchTermReportOnce({ repository:fixture.repository, jobId:fixture.job.job_id }),
  );
  assert.equal(fixture.calls.read, 0);
}

console.log('downloaded search-term raw to durable stage receipt producer: PASS');
