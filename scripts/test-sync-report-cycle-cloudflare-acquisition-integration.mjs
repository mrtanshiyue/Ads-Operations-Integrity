import assert from 'node:assert/strict';
import {
  createCloudflareReportCycleRuntime,
  CloudflareReportCycleRuntimeFactoryError,
} from '../cloudflare/runtime/sync-report-cycle-cloudflare-runtime.js';

const FP = 'f'.repeat(64);
const MAX_COMPRESSED = 1024 * 1024;
const MAX_DECOMPRESSED = 4 * 1024 * 1024;

function run() {
  return {
    run_id:'run-integration',
    profile_id:'profile-1',
    status:'running',
    report_plan_fingerprint:FP,
    report_plan_job_count:1,
  };
}

function membership() {
  return {
    run_id:'run-integration',
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

function queuedJob(overrides = {}) {
  const member = membership();
  return {
    job_id:member.job_id,
    run_id:member.run_id,
    profile_id:member.profile_id,
    ad_product:member.ad_product,
    report_type:member.report_type,
    start_date:member.start_date,
    end_date:member.end_date,
    status:'queued',
    idempotency_key:member.idempotency_key,
    request_fingerprint:member.request_fingerprint,
    request_json:member.request_json,
    amazon_report_id:null,
    amazon_created_at:null,
    r2_object_key:null,
    content_sha256:null,
    content_bytes:null,
    r2_initial_version:null,
    r2_initial_etag:null,
    downloaded_at:null,
    raw_row_count:null,
    row_count:null,
    ingested_at:null,
    error_code:null,
    error_message:null,
    created_at:'2026-08-16T03:35:00+08:00',
    updated_at:'2026-08-16T03:35:00+08:00',
    ...overrides,
  };
}

function createDb() {
  const state = { job:queuedJob() };
  const calls = { snapshotBatch:0, jobLoads:0, arm:0, persistCreate:0, otherMutation:0 };

  class Statement {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async first() {
      if (this.sql.includes('FROM report_jobs') && this.sql.includes('WHERE job_id = ?1 LIMIT 1')) {
        calls.jobLoads += 1;
        return { ...state.job };
      }
      throw new Error(`unexpected first query: ${this.sql}`);
    }
    async all() { throw new Error(`unexpected all query: ${this.sql}`); }
    async run() {
      if (this.sql.includes("SET status = 'requested'") && this.sql.includes("status = 'queued'")) {
        calls.arm += 1;
        if (state.job.status === 'queued' && state.job.amazon_report_id == null) {
          state.job = { ...state.job, status:'requested' };
          return { meta:{ changes:1 } };
        }
        return { meta:{ changes:0 } };
      }
      if (this.sql.includes('SET amazon_report_id = ?2') && this.sql.includes("status = 'requested'")) {
        calls.persistCreate += 1;
        const [, reportId, createdAt] = this.args;
        if (state.job.status === 'requested' && state.job.amazon_report_id == null) {
          state.job = {
            ...state.job,
            amazon_report_id:reportId,
            amazon_created_at:createdAt,
            status:'processing',
          };
          return { meta:{ changes:1 } };
        }
        return { meta:{ changes:0 } };
      }
      calls.otherMutation += 1;
      throw new Error(`unexpected mutation query: ${this.sql}`);
    }
  }

  return {
    state,
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
          { results:[{ ...state.job }] },
        ];
      }
      throw new Error('unexpected batch');
    },
  };
}

function createBucket() {
  const calls = { get:0, head:0, put:0, list:0, delete:0 };
  return {
    calls,
    async get() { calls.get += 1; throw new Error('GET not expected'); },
    async head() { calls.head += 1; throw new Error('HEAD forbidden'); },
    async put() { calls.put += 1; throw new Error('PUT forbidden'); },
    async list() { calls.list += 1; throw new Error('LIST forbidden'); },
    async delete() { calls.delete += 1; throw new Error('DELETE forbidden'); },
  };
}

function build({ amazonAdsEnabled, acquisitionTransportAdapters }) {
  const db = createDb();
  const bucket = createBucket();
  const env = {
    STORE_01_DB:db,
    DATA_BUCKET:bucket,
    AMAZON_ADS_ENABLED:amazonAdsEnabled,
  };
  const runtime = createCloudflareReportCycleRuntime({
    env,
    acquisitionTransportAdapters,
    storeCode:'DEV01',
    maxCompressedBytes:MAX_COMPRESSED,
    maxDecompressedBytes:MAX_DECOMPRESSED,
    now:'2026-08-16T03:40:00+08:00',
  });
  return { runtime, db, bucket };
}

// A caller must choose exactly one acquisition source. Two sources would create ambiguous authority.
{
  const db = createDb();
  const bucket = createBucket();
  assert.throws(
    () => createCloudflareReportCycleRuntime({
      env:{ STORE_01_DB:db, DATA_BUCKET:bucket },
      acquisitionAdapters:{ createAmazonReport:async () => ({}) },
      acquisitionTransportAdapters:{ createReport:async () => ({}) },
      storeCode:'DEV01',
      maxCompressedBytes:MAX_COMPRESSED,
      maxDecompressedBytes:MAX_DECOMPRESSED,
      now:'2026-08-16T03:40:00+08:00',
    }),
    (error) => error instanceof CloudflareReportCycleRuntimeFactoryError
      && error.code === 'CLOUDFLARE_REPORT_CYCLE_ACQUISITION_SOURCE_CONFLICT',
  );
}

// Raw transports are composed behind the Amazon capability gate. With Dev-style false,
// the transport is never called and the acquisition repository performs no durable job read/mutation.
{
  let createCalls = 0;
  const h = build({
    amazonAdsEnabled:'false',
    acquisitionTransportAdapters:{
      createReport:async () => { createCalls += 1; return { reportId:'forbidden', createdAt:'forbidden' }; },
    },
  });
  let caught = null;
  try { await h.runtime.advance('run-integration'); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.code, 'REPORT_CYCLE_RUNTIME_EXECUTION_FAILED:CREATE_AMAZON_REPORT');
  assert.equal(caught.cause?.code, 'REPORT_CYCLE_EXECUTION_FAILED:CREATE_AMAZON_REPORT');
  assert.equal(caught.cause?.cause?.code, 'REPORT_CYCLE_ACQUISITION_DISABLED:AMAZON_ADS_ENABLED');
  assert.equal(createCalls, 0);
  assert.equal(h.db.calls.snapshotBatch, 1);
  assert.equal(h.db.calls.jobLoads, 0);
  assert.equal(h.db.calls.arm, 0);
  assert.equal(h.db.calls.persistCreate, 0);
  assert.deepEqual(h.bucket.calls, { get:0, head:0, put:0, list:0, delete:0 });
}

// Under an explicit test-only Amazon grant, the same raw transport path is wired through
// durable freshness + concrete D1 repository before the injected Create Report transport.
{
  let createCalls = 0;
  const h = build({
    amazonAdsEnabled:'true',
    acquisitionTransportAdapters:{
      async createReport(request) {
        createCalls += 1;
        assert.deepEqual(request, { reportType:'spSearchTerm' });
        return { reportId:'amazon-created-1', createdAt:'2026-08-16T03:41:00+08:00' };
      },
    },
  });
  const result = await h.runtime.advance('run-integration');
  assert.equal(result.directive, 'CREATE_AMAZON_REPORT');
  assert.equal(result.executed, true);
  assert.equal(result.result.action, 'amazon_report_created');
  assert.equal(result.result.job.status, 'processing');
  assert.equal(result.result.job.amazon_report_id, 'amazon-created-1');
  assert.equal(createCalls, 1);
  assert.equal(h.db.calls.snapshotBatch, 1);
  assert.ok(h.db.calls.jobLoads >= 3, 'freshness and receipt verification must reread durable job state');
  assert.equal(h.db.calls.arm, 1);
  assert.equal(h.db.calls.persistCreate, 1);
  assert.equal(h.db.calls.otherMutation, 0);
  assert.deepEqual(h.bucket.calls, { get:0, head:0, put:0, list:0, delete:0 });
}

console.log('concrete acquisition integration into Cloudflare report cycle runtime: PASS');
