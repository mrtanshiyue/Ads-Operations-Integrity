import assert from 'node:assert/strict';
import './test-sync-report-cycle-acquisition-capability.mjs';
import {
  createCloudflareReportCycleRuntime,
  CloudflareReportCycleRuntimeFactoryError,
} from '../cloudflare/runtime/sync-report-cycle-cloudflare-runtime.js';

const FP = 'e'.repeat(64);
const MAX_COMPRESSED = 1024 * 1024;
const MAX_DECOMPRESSED = 4 * 1024 * 1024;

function run(status = 'running') {
  return {
    run_id:'run-cloudflare',
    profile_id:'profile-1',
    status,
    report_plan_fingerprint:FP,
    report_plan_job_count:1,
  };
}

function membership() {
  return {
    run_id:'run-cloudflare',
    job_id:'job-1',
    profile_id:'profile-1',
    report_plan_fingerprint:FP,
    dataset_key:'search_term_daily',
    contract_id:'search-term-sp-v1',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    idempotency_key:'idem-1',
    request_fingerprint:'request-1',
    request_json:'{"reportType":"spSearchTerm"}',
  };
}

function job(status, overrides = {}) {
  const member = membership();
  const amazonReceipt = ['processing','ready','downloaded','ingested'].includes(status);
  const rawReceipt = ['downloaded','ingested'].includes(status);
  return {
    job_id:member.job_id,
    run_id:member.run_id,
    profile_id:member.profile_id,
    account_type:'seller',
    ad_product:member.ad_product,
    report_type:member.report_type,
    start_date:member.start_date,
    end_date:member.end_date,
    status,
    idempotency_key:member.idempotency_key,
    request_fingerprint:member.request_fingerprint,
    request_json:member.request_json,
    amazon_report_id:amazonReceipt ? 'amazon-1' : null,
    amazon_created_at:amazonReceipt ? '2026-08-15T14:00:00Z' : null,
    r2_object_key:rawReceipt ? 'raw/amazon-1.json.gz' : null,
    content_sha256:rawReceipt ? 'a'.repeat(64) : null,
    content_bytes:rawReceipt ? 128 : null,
    r2_initial_version:rawReceipt ? 'version-1' : null,
    r2_initial_etag:rawReceipt ? 'etag-1' : null,
    downloaded_at:rawReceipt ? '2026-08-15T14:30:00Z' : null,
    raw_row_count:status === 'ingested' ? 1 : null,
    row_count:status === 'ingested' ? 1 : null,
    ingested_at:status === 'ingested' ? '2026-08-15T14:31:00Z' : null,
    ...overrides,
  };
}

function createDb(status) {
  const currentJob = job(status);
  const calls = { snapshotBatch:0, mutationBatch:0, first:0 };
  class Statement {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async first() {
      calls.first += 1;
      if (this.sql.includes('JOIN amazon_profiles')) return { ...currentJob };
      throw new Error(`unexpected first query: ${this.sql}`);
    }
    async all() { throw new Error('unexpected all()'); }
    async run() { throw new Error('unexpected run()'); }
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
          { results:[{ ...currentJob }] },
        ];
      }
      calls.mutationBatch += 1;
      throw new Error('mutation batch forbidden in Cloudflare runtime factory fixture');
    },
  };
}

function createBucket() {
  const calls = { get:0, head:0, put:0, list:0, delete:0 };
  return {
    calls,
    async get(key) {
      calls.get += 1;
      assert.equal(key, 'raw/amazon-1.json.gz');
      throw new Error('simulated R2 read failure');
    },
    async head() { calls.head += 1; throw new Error('HEAD forbidden'); },
    async put() { calls.put += 1; throw new Error('PUT forbidden'); },
    async list() { calls.list += 1; throw new Error('LIST forbidden'); },
    async delete() { calls.delete += 1; throw new Error('DELETE forbidden'); },
  };
}

function build(status, { envOverrides = {}, acquisitionAdapters = {} } = {}) {
  const db = createDb(status);
  const bucket = createBucket();
  let nowCalls = 0;
  const env = { STORE_01_DB:db, DATA_BUCKET:bucket, ...envOverrides };
  const runtime = createCloudflareReportCycleRuntime({
    env,
    acquisitionAdapters,
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
    now:() => {
      nowCalls += 1;
      return '2026-08-16T03:20:00+08:00';
    },
  });
  return { runtime, env, db, bucket, getNowCalls:() => nowCalls };
}

assert.throws(
  () => createCloudflareReportCycleRuntime(),
  (error) => error instanceof CloudflareReportCycleRuntimeFactoryError
    && error.code === 'CLOUDFLARE_REPORT_CYCLE_ENV_INVALID',
);
assert.throws(
  () => createCloudflareReportCycleRuntime({ env:{} }),
  (error) => error instanceof CloudflareReportCycleRuntimeFactoryError
    && error.code === 'CLOUDFLARE_REPORT_CYCLE_STORE_DB_BINDING_INVALID',
);
assert.throws(
  () => createCloudflareReportCycleRuntime({
    env:{ STORE_01_DB:{ prepare(){}, batch(){} }, DATA_BUCKET:{ get(){} } },
    acquisitionAdapters:[],
    maxCompressedBytes:1,
    maxDecompressedBytes:1,
    now:'2026-08-16T03:20:00+08:00',
  }),
  (error) => error instanceof CloudflareReportCycleRuntimeFactoryError
    && error.code === 'CLOUDFLARE_REPORT_CYCLE_ACQUISITION_ADAPTERS_INVALID',
);

// requested is scheduler-BLOCKED: concrete factory must perform one read-only snapshot,
// touch no R2 method, resolve no completion timestamp, and invoke no mutation batch.
{
  const h = build('requested');
  const result = await h.runtime.advance('run-cloudflare');
  assert.equal(result.directive, 'BLOCKED');
  assert.equal(result.executed, false);
  assert.equal(result.waiting, true);
  assert.equal(h.db.calls.snapshotBatch, 1);
  assert.equal(h.db.calls.mutationBatch, 0);
  assert.equal(h.db.calls.first, 0);
  assert.equal(h.getNowCalls(), 0);
  assert.deepEqual(h.bucket.calls, { get:0, head:0, put:0, list:0, delete:0 });
}

// With no acquisition adapters supplied, queued still fails closed after fresh routing.
{
  const h = build('queued');
  let caught = null;
  try { await h.runtime.advance('run-cloudflare'); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.code, 'REPORT_CYCLE_RUNTIME_EXECUTION_FAILED:CREATE_AMAZON_REPORT');
  assert.equal(caught.cause?.code, 'REPORT_CYCLE_CREATE_AMAZON_REPORT_ADAPTER_REQUIRED');
  assert.equal(h.db.calls.snapshotBatch, 1);
  assert.equal(h.db.calls.mutationBatch, 0);
  assert.equal(h.db.calls.first, 0);
  assert.equal(h.getNowCalls(), 0);
  assert.deepEqual(h.bucket.calls, { get:0, head:0, put:0, list:0, delete:0 });
}

// Even when a concrete acquisition delegate is injected, the runtime kill switches are
// authoritative. Current Dev semantics (SYNC_TRIGGER_ENABLED=false; AMAZON flag absent)
// block before the injected delegate and before any R2/D1 mutation path can run.
{
  let delegateCalls = 0;
  const h = build('queued', {
    envOverrides:{ SYNC_TRIGGER_ENABLED:'false' },
    acquisitionAdapters:{
      createAmazonReport:async () => { delegateCalls += 1; return { action:'should-not-run' }; },
    },
  });
  let caught = null;
  try { await h.runtime.advance('run-cloudflare'); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.code, 'REPORT_CYCLE_RUNTIME_EXECUTION_FAILED:CREATE_AMAZON_REPORT');
  assert.equal(caught.cause?.code, 'REPORT_CYCLE_EXECUTION_FAILED:CREATE_AMAZON_REPORT');
  assert.equal(
    caught.cause?.cause?.code,
    'REPORT_CYCLE_ACQUISITION_DISABLED:SYNC_TRIGGER_ENABLED',
  );
  assert.equal(delegateCalls, 0);
  assert.equal(h.db.calls.snapshotBatch, 1);
  assert.equal(h.db.calls.mutationBatch, 0);
  assert.deepEqual(h.bucket.calls, { get:0, head:0, put:0, list:0, delete:0 });
}

// Both exact grants are required before an injected delegate becomes reachable. This is
// a contract-only fixture; repository deployment config remains disabled and unchanged.
{
  let delegateCalls = 0;
  const h = build('queued', {
    envOverrides:{ SYNC_TRIGGER_ENABLED:'true', AMAZON_ADS_ENABLED:'true' },
    acquisitionAdapters:{
      createAmazonReport:async (input) => {
        delegateCalls += 1;
        assert.equal(input.directive, 'CREATE_AMAZON_REPORT');
        return { action:'created-by-test-adapter' };
      },
    },
  });
  const result = await h.runtime.advance('run-cloudflare');
  assert.equal(result.directive, 'CREATE_AMAZON_REPORT');
  assert.equal(result.executed, true);
  assert.deepEqual(result.result, { action:'created-by-test-adapter' });
  assert.equal(delegateCalls, 1);
  assert.equal(h.db.calls.snapshotBatch, 1);
  assert.equal(h.db.calls.mutationBatch, 0);
  assert.deepEqual(h.bucket.calls, { get:0, head:0, put:0, list:0, delete:0 });
}

// downloaded composes router -> ingestion freshness snapshot -> concrete ingestion runtime
// -> GET-only DATA_BUCKET reader. The simulated R2 failure occurs before any D1 mutation batch.
{
  const h = build('downloaded');
  let caught = null;
  try { await h.runtime.advance('run-cloudflare'); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.code, 'REPORT_CYCLE_RUNTIME_INGESTION_FAILED');
  assert.equal(caught.cause?.code, 'REPORT_CYCLE_INGESTION_EXECUTION_FAILED');
  assert.equal(caught.cause?.cause?.code, 'SEARCH_TERM_INGESTION_STAGE_FAILED');
  assert.equal(caught.cause?.cause?.cause?.code, 'SEARCH_TERM_STAGE_R2_READ_FAILED');
  assert.equal(caught.cause?.cause?.cause?.cause?.code, 'R2_RAW_READER_GET_FAILED');
  assert.equal(h.db.calls.snapshotBatch, 2);
  assert.equal(h.db.calls.mutationBatch, 0);
  assert.equal(h.db.calls.first, 2);
  assert.equal(h.getNowCalls(), 0);
  assert.deepEqual(h.bucket.calls, { get:1, head:0, put:0, list:0, delete:0 });
}

console.log('concrete Cloudflare report cycle runtime factory: PASS');
