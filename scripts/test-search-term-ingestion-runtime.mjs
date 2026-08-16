import assert from 'node:assert/strict';
import {
  createCloudflareSearchTermIngestionRuntime,
  CloudflareSearchTermIngestionRuntimeError,
  SEARCH_TERM_INGESTION_BINDINGS,
} from '../cloudflare/runtime/search-term-ingestion-runtime.js';

const MAX_COMPRESSED = 1024 * 1024;
const MAX_DECOMPRESSED = 4 * 1024 * 1024;

function fullJob(status = 'ingested', overrides = {}) {
  const ingested = status === 'ingested';
  return {
    job_id:'job-1',
    run_id:'run-1',
    profile_id:'profile-1',
    account_type:'seller',
    amazon_report_id:'amazon-1',
    amazon_created_at:'2026-08-15T14:00:00Z',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    status,
    r2_object_key:'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-1.json.gz',
    content_sha256:'a'.repeat(64),
    content_bytes:128,
    r2_initial_version:'version-1',
    r2_initial_etag:'etag-1',
    downloaded_at:'2026-08-15T14:30:00Z',
    raw_row_count:ingested ? 2 : null,
    row_count:ingested ? 2 : null,
    ingested_at:ingested ? '2026-08-15T14:31:00Z' : null,
    ...overrides,
  };
}

function publisherJob(job) {
  return {
    job_id:job.job_id,
    profile_id:job.profile_id,
    ad_product:job.ad_product,
    report_type:job.report_type,
    start_date:job.start_date,
    end_date:job.end_date,
    status:job.status,
    raw_row_count:job.raw_row_count,
    row_count:job.row_count,
    ingested_at:job.ingested_at,
  };
}

function createDb(job) {
  const calls = { prepare:0, batch:0 };
  class Statement {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async first() {
      if (this.sql.includes('JOIN amazon_profiles')) return { ...job };
      if (this.sql.includes('FROM search_term_daily')) {
        return { total_rows:job.row_count, lineage_rows:job.row_count };
      }
      if (this.sql.includes('FROM report_jobs')) return { ...publisherJob(job) };
      throw new Error(`unexpected first query: ${this.sql}`);
    }
    async all() { throw new Error('stage inspection is not expected in this fixture'); }
  }
  return {
    calls,
    prepare(sql) {
      calls.prepare += 1;
      return new Statement(sql);
    },
    async batch() {
      calls.batch += 1;
      throw new Error('no D1 batch should execute in this fixture');
    },
  };
}

function createBucket({ getError = null } = {}) {
  const calls = { get:0, head:0, put:0, list:0, delete:0 };
  return {
    calls,
    async get(key) {
      calls.get += 1;
      assert.ok(key.includes('amazon-1.json.gz'));
      if (getError) throw getError;
      throw new Error('fixture does not provide a successful raw body');
    },
    async head() { calls.head += 1; throw new Error('HEAD forbidden'); },
    async put() { calls.put += 1; throw new Error('PUT forbidden'); },
    async list() { calls.list += 1; throw new Error('LIST forbidden'); },
    async delete() { calls.delete += 1; throw new Error('DELETE forbidden'); },
  };
}

function expectFactoryCode(code, fn) {
  assert.throws(fn, (error) => error instanceof CloudflareSearchTermIngestionRuntimeError
    && error.code === code);
}

assert.deepEqual(SEARCH_TERM_INGESTION_BINDINGS, {
  storeDb:'STORE_01_DB',
  dataBucket:'DATA_BUCKET',
});

// Factory refuses missing or malformed Cloudflare Native bindings and size policies.
expectFactoryCode('SEARCH_TERM_INGESTION_ENV_INVALID', () =>
  createCloudflareSearchTermIngestionRuntime(),
);
expectFactoryCode('SEARCH_TERM_INGESTION_STORE_DB_BINDING_INVALID', () =>
  createCloudflareSearchTermIngestionRuntime({ env:{}, maxCompressedBytes:1, maxDecompressedBytes:1 }),
);
{
  const db = createDb(fullJob());
  expectFactoryCode('SEARCH_TERM_INGESTION_DATA_BUCKET_BINDING_INVALID', () =>
    createCloudflareSearchTermIngestionRuntime({
      env:{ STORE_01_DB:db },
      maxCompressedBytes:1,
      maxDecompressedBytes:1,
    }),
  );
}
{
  const db = createDb(fullJob());
  const bucket = createBucket();
  expectFactoryCode('SEARCH_TERM_INGESTION_COMPRESSED_SIZE_POLICY_INVALID', () =>
    createCloudflareSearchTermIngestionRuntime({
      env:{ STORE_01_DB:db, DATA_BUCKET:bucket },
      maxCompressedBytes:0,
      maxDecompressedBytes:1,
    }),
  );
  expectFactoryCode('SEARCH_TERM_INGESTION_DECOMPRESSED_SIZE_POLICY_INVALID', () =>
    createCloudflareSearchTermIngestionRuntime({
      env:{ STORE_01_DB:db, DATA_BUCKET:bucket },
      maxCompressedBytes:1,
      maxDecompressedBytes:0,
    }),
  );
}

// Already-ingested replay is Store D1 only: the concrete R2 binding remains completely untouched.
{
  const job = fullJob('ingested');
  const db = createDb(job);
  const bucket = createBucket({ getError:new Error('R2 must not be read') });
  const runtime = createCloudflareSearchTermIngestionRuntime({
    env:{ STORE_01_DB:db, DATA_BUCKET:bucket },
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
    now:'2026-08-16T02:50:00+08:00',
  });
  const result = await runtime.advance(job.job_id);
  assert.equal(result.action, 'search_term_ingestion_reused');
  assert.equal(result.reused, true);
  assert.equal(result.job.status, 'ingested');
  assert.equal(db.calls.batch, 0);
  assert.deepEqual(bucket.calls, { get:0, head:0, put:0, list:0, delete:0 });
}

// A downloaded, unstaged report reaches the concrete DATA_BUCKET GET-only reader.
// Transport failure must stop before any stage/publish D1 batch mutation.
{
  const job = fullJob('downloaded');
  const db = createDb(job);
  const bucket = createBucket({ getError:new Error('simulated R2 transport failure') });
  const runtime = createCloudflareSearchTermIngestionRuntime({
    env:{ STORE_01_DB:db, DATA_BUCKET:bucket },
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
    now:'2026-08-16T02:50:00+08:00',
  });

  let caught = null;
  try {
    await runtime.advance(job.job_id);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected downloaded raw read failure');
  assert.equal(caught.code, 'SEARCH_TERM_INGESTION_STAGE_FAILED');
  assert.equal(caught.cause?.code, 'SEARCH_TERM_STAGE_R2_READ_FAILED');
  assert.equal(caught.cause?.cause?.code, 'R2_RAW_READER_GET_FAILED');
  assert.equal(caught.cause?.cause?.cause?.message, 'simulated R2 transport failure');
  assert.equal(db.calls.batch, 0);
  assert.deepEqual(bucket.calls, { get:1, head:0, put:0, list:0, delete:0 });
}

console.log('concrete Cloudflare search term ingestion runtime factory: PASS');
