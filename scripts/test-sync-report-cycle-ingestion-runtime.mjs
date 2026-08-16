import assert from 'node:assert/strict';
import {
  createCloudflareReportCycleIngestionAdapter,
  CloudflareReportCycleIngestionFactoryError,
} from '../cloudflare/runtime/sync-report-cycle-ingestion-runtime.js';

const MAX_COMPRESSED = 1024 * 1024;
const MAX_DECOMPRESSED = 4 * 1024 * 1024;
const PLAN_FINGERPRINT = 'b'.repeat(64);

function run(status = 'running') {
  return {
    run_id:'run-1',
    profile_id:'profile-1',
    status,
    report_plan_fingerprint:PLAN_FINGERPRINT,
    report_plan_job_count:1,
  };
}

function membership(overrides = {}) {
  return {
    run_id:'run-1',
    job_id:'job-1',
    profile_id:'profile-1',
    report_plan_fingerprint:PLAN_FINGERPRINT,
    dataset_key:'search_term_daily',
    contract_id:'sp-search-term-v1',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    idempotency_key:'idem-1',
    request_fingerprint:'request-fingerprint-1',
    request_json:'{"reportType":"spSearchTerm"}',
    ...overrides,
  };
}

function job(status = 'downloaded', overrides = {}) {
  const downloaded = status === 'downloaded';
  const amazonComplete = ['processing','ready','downloaded','ingested'].includes(status);
  return {
    job_id:'job-1',
    run_id:'run-1',
    profile_id:'profile-1',
    account_type:'seller',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    status,
    idempotency_key:'idem-1',
    request_fingerprint:'request-fingerprint-1',
    request_json:'{"reportType":"spSearchTerm"}',
    amazon_report_id:amazonComplete ? 'amazon-1' : null,
    amazon_created_at:amazonComplete ? '2026-08-15T14:00:00Z' : null,
    r2_object_key:downloaded ? 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-1.json.gz' : null,
    content_sha256:downloaded ? 'a'.repeat(64) : null,
    content_bytes:downloaded ? 128 : null,
    r2_initial_version:downloaded ? 'version-1' : null,
    r2_initial_etag:downloaded ? 'etag-1' : null,
    downloaded_at:downloaded ? '2026-08-15T14:30:00Z' : null,
    raw_row_count:null,
    row_count:null,
    ingested_at:null,
    ...overrides,
  };
}

function createDb({ snapshotJob, freshJob = snapshotJob }) {
  const calls = { snapshotBatch:0, mutationBatch:0, first:0 };
  class Statement {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async first() {
      calls.first += 1;
      if (this.sql.includes('JOIN amazon_profiles')) return { ...freshJob };
      throw new Error(`unexpected first query: ${this.sql}`);
    }
    async all() { throw new Error('unexpected all()'); }
  }
  return {
    calls,
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      const sql = statements.map((statement) => statement.sql || '').join('\n');
      if (statements.length === 3
          && sql.includes('FROM sync_runs')
          && sql.includes('FROM sync_report_plan_jobs')
          && sql.includes('FROM report_jobs')) {
        calls.snapshotBatch += 1;
        return [
          { results:[run()] },
          { results:[membership()] },
          { results:[{ ...snapshotJob }] },
        ];
      }
      calls.mutationBatch += 1;
      throw new Error('mutation batch forbidden in factory boundary fixture');
    },
  };
}

function createBucket() {
  const calls = { get:0, head:0, put:0, list:0, delete:0 };
  return {
    calls,
    async get(key) {
      calls.get += 1;
      assert.ok(key.includes('amazon-1.json.gz'));
      throw new Error('simulated concrete R2 transport failure');
    },
    async head() { calls.head += 1; throw new Error('HEAD forbidden'); },
    async put() { calls.put += 1; throw new Error('PUT forbidden'); },
    async list() { calls.list += 1; throw new Error('LIST forbidden'); },
    async delete() { calls.delete += 1; throw new Error('DELETE forbidden'); },
  };
}

function build({ snapshotJob, freshJob = snapshotJob }) {
  const db = createDb({ snapshotJob, freshJob });
  const bucket = createBucket();
  const advance = createCloudflareReportCycleIngestionAdapter({
    env:{ STORE_01_DB:db, DATA_BUCKET:bucket },
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
    now:'2026-08-16T02:55:00+08:00',
  });
  return { db, bucket, advance };
}

assert.throws(
  () => createCloudflareReportCycleIngestionAdapter(),
  (error) => error instanceof CloudflareReportCycleIngestionFactoryError
    && error.code === 'REPORT_CYCLE_INGESTION_ENV_INVALID',
);
assert.throws(
  () => createCloudflareReportCycleIngestionAdapter({ env:{} }),
  (error) => error instanceof CloudflareReportCycleIngestionFactoryError
    && error.code === 'REPORT_CYCLE_INGESTION_STORE_DB_BINDING_INVALID',
);

// Fresh snapshot still selects the same downloaded job: execution reaches the concrete
// DATA_BUCKET GET-only reader. The R2 failure occurs before any ingestion mutation batch.
{
  const h = build({ snapshotJob:job('downloaded') });
  let caught = null;
  try {
    await h.advance({ runId:'run-1', jobId:'job-1' });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected concrete ingestion execution failure');
  assert.equal(caught.code, 'REPORT_CYCLE_INGESTION_EXECUTION_FAILED');
  assert.equal(caught.cause?.code, 'SEARCH_TERM_INGESTION_STAGE_FAILED');
  assert.equal(caught.cause?.cause?.code, 'SEARCH_TERM_STAGE_R2_READ_FAILED');
  assert.equal(caught.cause?.cause?.cause?.code, 'R2_RAW_READER_GET_FAILED');
  assert.equal(h.db.calls.snapshotBatch, 1);
  assert.equal(h.db.calls.mutationBatch, 0);
  assert.deepEqual(h.bucket.calls, { get:1, head:0, put:0, list:0, delete:0 });
}

// If fresh authority now selects a different directive, execution stops at the cycle boundary.
// Neither the lower ingestion runtime nor R2 is touched.
{
  const h = build({ snapshotJob:job('queued') });
  let caught = null;
  try {
    await h.advance({ runId:'run-1', jobId:'job-1' });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected stale directive rejection');
  assert.equal(caught.code, 'REPORT_CYCLE_INGESTION_DIRECTIVE_STALE:CREATE_AMAZON_REPORT');
  assert.equal(h.db.calls.snapshotBatch, 1);
  assert.equal(h.db.calls.first, 0);
  assert.equal(h.db.calls.mutationBatch, 0);
  assert.deepEqual(h.bucket.calls, { get:0, head:0, put:0, list:0, delete:0 });
}

console.log('concrete report cycle ingestion adapter factory: PASS');
