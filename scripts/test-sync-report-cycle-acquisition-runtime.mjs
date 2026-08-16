import assert from 'node:assert/strict';
import {
  createCloudflareReportCycleAcquisitionAdapters,
  CloudflareReportCycleAcquisitionFactoryError,
} from '../cloudflare/runtime/sync-report-cycle-acquisition-runtime.js';

const MAX_COMPRESSED = 1024 * 1024;

function job(status = 'queued', overrides = {}) {
  return {
    job_id:'job-1',
    run_id:'run-1',
    profile_id:'profile-1',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    status,
    idempotency_key:'idem-1',
    request_fingerprint:'request-1',
    request_json:'{"name":"request"}',
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
    ...overrides,
  };
}

function createDb(initialJob) {
  const state = { job:{ ...initialJob } };
  const calls = { load:0, arm:0, persistCreate:0, otherMutation:0, batch:0 };

  class Statement {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async first() {
      if (this.sql.includes('FROM report_jobs') && this.sql.includes('WHERE job_id = ?1 LIMIT 1')) {
        calls.load += 1;
        return state.job ? { ...state.job } : null;
      }
      throw new Error(`unexpected first query: ${this.sql}`);
    }
    async all() { throw new Error(`unexpected all query: ${this.sql}`); }
    async run() {
      if (this.sql.includes("SET status = 'requested'") && this.sql.includes("status = 'queued'")) {
        calls.arm += 1;
        if (state.job.status === 'queued' && state.job.amazon_report_id == null) {
          state.job.status = 'requested';
          return { meta:{ changes:1 } };
        }
        return { meta:{ changes:0 } };
      }
      if (this.sql.includes('SET amazon_report_id = ?2') && this.sql.includes("status = 'requested'")) {
        calls.persistCreate += 1;
        const [, reportId, createdAt] = this.args;
        if (state.job.status === 'requested' && state.job.amazon_report_id == null) {
          state.job.amazon_report_id = reportId;
          state.job.amazon_created_at = createdAt;
          state.job.status = 'processing';
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
    async batch() { calls.batch += 1; throw new Error('batch not expected'); },
  };
}

function input(directive, expectedStatus) {
  return Object.freeze({
    runId:'run-1',
    jobId:'job-1',
    directive,
    expectedStatus,
  });
}

function expectFactoryCode(code, fn) {
  assert.throws(
    fn,
    (error) => error instanceof CloudflareReportCycleAcquisitionFactoryError && error.code === code,
  );
}

expectFactoryCode('REPORT_CYCLE_ACQUISITION_ENV_INVALID', () =>
  createCloudflareReportCycleAcquisitionAdapters(),
);
expectFactoryCode('REPORT_CYCLE_ACQUISITION_STORE_DB_BINDING_INVALID', () =>
  createCloudflareReportCycleAcquisitionAdapters({ env:{} }),
);
{
  const db = createDb(job());
  expectFactoryCode('REPORT_CYCLE_ACQUISITION_STORE_CODE_REQUIRED', () =>
    createCloudflareReportCycleAcquisitionAdapters({
      env:{ STORE_01_DB:db }, storeCode:' ', maxCompressedBytes:1, now:'now',
    }),
  );
  expectFactoryCode('REPORT_CYCLE_ACQUISITION_COMPRESSED_SIZE_POLICY_INVALID', () =>
    createCloudflareReportCycleAcquisitionAdapters({
      env:{ STORE_01_DB:db }, storeCode:'DEV01', maxCompressedBytes:0, now:'now',
    }),
  );
  expectFactoryCode('REPORT_CYCLE_ACQUISITION_TRANSPORT_NOT_ALLOWED:headRawObject', () =>
    createCloudflareReportCycleAcquisitionAdapters({
      env:{ STORE_01_DB:db },
      storeCode:'DEV01',
      transportAdapters:{ headRawObject() {} },
      maxCompressedBytes:1,
      now:'now',
    }),
  );
}

// Fresh queued durable authority reaches exactly one injected Create Report transport and
// persists only the requested arm + immutable Amazon report receipt through concrete D1 SQL.
{
  const db = createDb(job('queued'));
  const transportCalls = { create:0, poll:0, download:0, put:0 };
  let nowCalls = 0;
  const adapters = createCloudflareReportCycleAcquisitionAdapters({
    env:{ STORE_01_DB:db },
    storeCode:'DEV01',
    transportAdapters:{
      async createReport(request) {
        transportCalls.create += 1;
        assert.deepEqual(request, { name:'request' });
        return { reportId:'amazon-1', createdAt:'2026-08-16T03:30:00+08:00' };
      },
      async pollReport() { transportCalls.poll += 1; throw new Error('poll forbidden'); },
      async downloadReport() { transportCalls.download += 1; throw new Error('download forbidden'); },
      async putRawObject() { transportCalls.put += 1; throw new Error('put forbidden'); },
    },
    maxCompressedBytes:MAX_COMPRESSED,
    now:() => { nowCalls += 1; return '2026-08-16T03:31:00+08:00'; },
  });

  assert.equal(nowCalls, 0, 'factory construction must not resolve time');
  const result = await adapters.createAmazonReport(input('CREATE_AMAZON_REPORT', 'queued'));
  assert.equal(result.action, 'amazon_report_created');
  assert.equal(result.job.status, 'processing');
  assert.equal(result.job.amazon_report_id, 'amazon-1');
  assert.deepEqual(transportCalls, { create:1, poll:0, download:0, put:0 });
  assert.deepEqual(db.calls, { load:4, arm:1, persistCreate:1, otherMutation:0, batch:0 });
  assert.equal(nowCalls, 1, 'invocation resolves time independently');
}

// A queued directive whose durable job has already advanced to processing is stale. The concrete
// D1 repository may perform the one guarded read, but no transport or mutation is allowed.
{
  const db = createDb(job('processing', {
    amazon_report_id:'amazon-existing',
    amazon_created_at:'source-time',
  }));
  let createCalls = 0;
  const adapters = createCloudflareReportCycleAcquisitionAdapters({
    env:{ STORE_01_DB:db },
    storeCode:'DEV01',
    transportAdapters:{ createReport:async () => { createCalls += 1; return {}; } },
    maxCompressedBytes:MAX_COMPRESSED,
    now:'2026-08-16T03:32:00+08:00',
  });

  await assert.rejects(
    () => adapters.createAmazonReport(input('CREATE_AMAZON_REPORT', 'queued')),
    (error) => error.code === 'REPORT_CYCLE_ACQUISITION_STATUS_STALE:queued:processing',
  );
  assert.equal(createCalls, 0);
  assert.deepEqual(db.calls, { load:1, arm:0, persistCreate:0, otherMutation:0, batch:0 });
}

// Missing external transport remains missing. The factory never manufactures Amazon capability.
{
  const db = createDb(job('queued'));
  const adapters = createCloudflareReportCycleAcquisitionAdapters({
    env:{ STORE_01_DB:db },
    storeCode:'DEV01',
    transportAdapters:{},
    maxCompressedBytes:MAX_COMPRESSED,
    now:'2026-08-16T03:33:00+08:00',
  });
  await assert.rejects(
    () => adapters.createAmazonReport(input('CREATE_AMAZON_REPORT', 'queued')),
    (error) => error.code === 'REPORT_CYCLE_ACQUISITION_EXECUTION_FAILED:CREATE_AMAZON_REPORT'
      && error.cause?.code === 'AMAZON_CREATE_REPORT_ADAPTER_REQUIRED',
  );
  assert.deepEqual(db.calls, { load:1, arm:0, persistCreate:0, otherMutation:0, batch:0 });
}

console.log('concrete report cycle acquisition adapter factory: PASS');
