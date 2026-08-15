import assert from 'node:assert/strict';
import { buildCreateOnlyR2PutOptions } from '../cloudflare/runtime/amazon-raw-object-contract.js';
import {
  createR2CreateOnlyRawObjectWriter,
  R2RawObjectWriterError,
} from '../cloudflare/runtime/r2-raw-object-writer.js';
import {
  createCloudflareReportCycleAcquisitionTransportAdapters,
  CloudflareReportCycleAcquisitionTransportError,
} from '../cloudflare/runtime/sync-report-cycle-acquisition-transports.js';
import { createCloudflareReportCycleRuntime } from '../cloudflare/runtime/sync-report-cycle-cloudflare-runtime.js';

function expectCode(code, fn) {
  assert.throws(
    fn,
    (error) => error instanceof R2RawObjectWriterError && error.code === code,
  );
}

function bucketHarness({ result = null, error = null } = {}) {
  const calls = { put:0, get:0, head:0, list:0, delete:0 };
  const observed = [];
  return {
    calls,
    observed,
    bucket:{
      async put(key, bytes, options) {
        calls.put += 1;
        observed.push({ key, bytes, options });
        if (error) throw error;
        return typeof result === 'function' ? result({ key, bytes, options }) : result;
      },
      async get() { calls.get += 1; throw new Error('GET forbidden'); },
      async head() { calls.head += 1; throw new Error('HEAD forbidden'); },
      async list() { calls.list += 1; throw new Error('LIST forbidden'); },
      async delete() { calls.delete += 1; throw new Error('DELETE forbidden'); },
    },
  };
}

async function validInput() {
  const bytes = new TextEncoder().encode('compressed-artifact-fixture');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    key:'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-1.json.gz',
    bytes,
    options:buildCreateOnlyR2PutOptions(hex),
  };
}

expectCode('R2_RAW_WRITER_BUCKET_INVALID', () => createR2CreateOnlyRawObjectWriter());
expectCode('R2_RAW_WRITER_BUCKET_INVALID', () => createR2CreateOnlyRawObjectWriter({ bucket:{} }));

// Successful create-only PUT passes a copied body and the exact conditional/native checksum policy.
{
  const input = await validInput();
  const expectedReceipt = {
    key:input.key,
    size:input.bytes.byteLength,
    version:'version-1',
    etag:'etag-1',
    checksums:{ sha256:input.options.sha256 },
  };
  const h = bucketHarness({ result:expectedReceipt });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  const result = await putRawObject(input);
  assert.equal(result, expectedReceipt);
  assert.deepEqual(h.calls, { put:1, get:0, head:0, list:0, delete:0 });
  assert.equal(h.observed[0].key, input.key);
  assert.deepEqual([...h.observed[0].bytes], [...input.bytes]);
  assert.notEqual(h.observed[0].bytes.buffer, input.bytes.buffer, 'writer must snapshot mutable input bytes');
  assert.deepEqual(h.observed[0].options.onlyIf, { etagDoesNotMatch:'*' });
  assert.equal(new Uint8Array(h.observed[0].options.sha256).byteLength, 32);
}

// Conditional failure is not returned as null. It becomes an error so the acquisition layer
// can perform its durable D1 race reread without any HEAD/GET provenance backfill.
{
  const input = await validInput();
  const h = bucketHarness({ result:null });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  await assert.rejects(
    () => putRawObject(input),
    (error) => error instanceof R2RawObjectWriterError
      && error.code === 'R2_RAW_WRITER_CREATE_CONDITION_FAILED',
  );
  assert.deepEqual(h.calls, { put:1, get:0, head:0, list:0, delete:0 });
}

// Transport exceptions remain ambiguous and preserve the underlying cause for the acquisition layer.
{
  const input = await validInput();
  const h = bucketHarness({ error:new Error('simulated R2 transport failure') });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  await assert.rejects(
    () => putRawObject(input),
    (error) => error instanceof R2RawObjectWriterError
      && error.code === 'R2_RAW_WRITER_PUT_FAILED'
      && error.cause?.message === 'simulated R2 transport failure',
  );
  assert.deepEqual(h.calls, { put:1, get:0, head:0, list:0, delete:0 });
}

// The adapter accepts only the frozen create-only policy built by the raw-object contract.
{
  const input = await validInput();
  const h = bucketHarness({ result:{} });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  for (const [options, code] of [
    [{ sha256:input.options.sha256 }, 'R2_RAW_WRITER_OPTIONS_NOT_CREATE_ONLY'],
    [{ onlyIf:{ etagDoesNotMatch:'not-star' }, sha256:input.options.sha256 }, 'R2_RAW_WRITER_CREATE_ONLY_CONDITION_REQUIRED'],
    [{ onlyIf:{ etagDoesNotMatch:'*' }, sha256:input.options.sha256, httpMetadata:{} }, 'R2_RAW_WRITER_OPTIONS_NOT_CREATE_ONLY'],
  ]) {
    await assert.rejects(
      () => putRawObject({ ...input, options }),
      (error) => error instanceof R2RawObjectWriterError && error.code === code,
    );
  }
  assert.equal(h.calls.put, 0);
}

// A caller cannot provide a checksum that does not match the exact bytes passed to R2.
{
  const input = await validInput();
  const wrongHex = '00'.repeat(32);
  const h = bucketHarness({ result:{} });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  await assert.rejects(
    () => putRawObject({ ...input, options:buildCreateOnlyR2PutOptions(wrongHex) }),
    (error) => error instanceof R2RawObjectWriterError
      && error.code === 'R2_RAW_WRITER_SHA256_MISMATCH',
  );
  assert.equal(h.calls.put, 0);
}

// Cloudflare transport composition owns the only putRawObject authority.
{
  const h = bucketHarness({ result:{} });
  const createReport = async () => ({ reportId:'x', createdAt:'t' });
  const transports = createCloudflareReportCycleAcquisitionTransportAdapters({
    env:{ DATA_BUCKET:h.bucket },
    amazonTransportAdapters:{ createReport },
  });
  assert.equal(transports.createReport, createReport);
  assert.equal(typeof transports.putRawObject, 'function');
  assert.ok(Object.isFrozen(transports));

  assert.throws(
    () => createCloudflareReportCycleAcquisitionTransportAdapters({
      env:{ DATA_BUCKET:h.bucket },
      amazonTransportAdapters:{ putRawObject:async () => ({}) },
    }),
    (error) => error instanceof CloudflareReportCycleAcquisitionTransportError
      && error.code === 'REPORT_CYCLE_TRANSPORT_PUT_AUTHORITY_CONFLICT',
  );
}

const MATERIALIZE_FP = '9'.repeat(64);
const MATERIALIZE_BYTES = new Uint8Array([0x1f,0x8b,0x08,0x00,0x10,0x20,0x30,0x40]);

function materializeMembership() {
  return {
    run_id:'run-materialize', job_id:'job-materialize', profile_id:'profile-1',
    report_plan_fingerprint:MATERIALIZE_FP, dataset_key:'search_term_daily',
    contract_id:'search-term-sp-v1', ad_product:'SPONSORED_PRODUCTS', report_type:'spSearchTerm',
    start_date:'2026-08-12', end_date:'2026-08-12', idempotency_key:'idem-materialize',
    request_fingerprint:'request-materialize', request_json:'{"reportType":"spSearchTerm"}',
  };
}
function readyMaterializeJob() {
  const m = materializeMembership();
  return {
    job_id:m.job_id, run_id:m.run_id, profile_id:m.profile_id,
    amazon_report_id:'amazon-materialize-1', amazon_created_at:'2026-08-16T03:50:00+08:00',
    ad_product:m.ad_product, report_type:m.report_type, start_date:m.start_date, end_date:m.end_date,
    status:'ready', idempotency_key:m.idempotency_key, request_fingerprint:m.request_fingerprint,
    request_json:m.request_json, r2_object_key:null, content_sha256:null, content_bytes:null,
    r2_initial_version:null, r2_initial_etag:null, raw_row_count:null, row_count:null,
    downloaded_at:null, ingested_at:null, error_code:null, error_message:null,
    created_at:'2026-08-16T03:49:00+08:00', updated_at:'2026-08-16T03:50:00+08:00',
  };
}

function materializeDb() {
  const state = { job:readyMaterializeJob() };
  const calls = { snapshotBatch:0, loads:0, expectedWrites:0, receiptWrites:0, otherWrites:0 };
  class Statement {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async first() {
      if (this.sql.includes('FROM report_jobs') && this.sql.includes('WHERE job_id = ?1 LIMIT 1')) {
        calls.loads += 1;
        return { ...state.job };
      }
      throw new Error(`unexpected first query: ${this.sql}`);
    }
    async all() { throw new Error(`unexpected all query: ${this.sql}`); }
    async run() {
      if (this.sql.includes('SET r2_object_key = ?2') && this.sql.includes("status = 'ready'")) {
        calls.expectedWrites += 1;
        const [, key, sha256, bytes] = this.args;
        if (state.job.status === 'ready') {
          state.job = { ...state.job, r2_object_key:key, content_sha256:sha256, content_bytes:bytes };
        }
        return { meta:{ changes:1 } };
      }
      if (this.sql.includes('SET r2_initial_version = ?2') && this.sql.includes("status = 'ready'")) {
        calls.receiptWrites += 1;
        const [, version, etag, downloadedAt] = this.args;
        if (state.job.status === 'ready') {
          state.job = {
            ...state.job, r2_initial_version:version, r2_initial_etag:etag,
            downloaded_at:downloadedAt, status:'downloaded',
          };
        }
        return { meta:{ changes:1 } };
      }
      calls.otherWrites += 1;
      throw new Error(`unexpected mutation query: ${this.sql}`);
    }
  }
  return {
    state, calls,
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      const sql = statements.map((statement) => statement.sql || '').join('\n');
      if (statements.length === 3
          && sql.includes('FROM sync_runs')
          && sql.includes('FROM sync_report_plan_jobs')
          && sql.includes('FROM report_jobs')) {
        calls.snapshotBatch += 1;
        return [
          { results:[{
            run_id:'run-materialize', profile_id:'profile-1', status:'running',
            report_plan_fingerprint:MATERIALIZE_FP, report_plan_job_count:1,
          }] },
          { results:[materializeMembership()] },
          { results:[{ ...state.job }] },
        ];
      }
      throw new Error('unexpected batch');
    },
  };
}

function materializeBucket(db, mode) {
  const calls = { put:0, get:0, head:0, list:0, delete:0 };
  return {
    calls,
    async put(key, bytes, options) {
      calls.put += 1;
      assert.equal(
        key,
        'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-materialize-1.json.gz',
      );
      assert.deepEqual([...bytes], [...MATERIALIZE_BYTES]);
      assert.deepEqual(options.onlyIf, { etagDoesNotMatch:'*' });
      assert.equal(new Uint8Array(options.sha256).byteLength, 32);
      if (mode === 'winner') {
        db.state.job = {
          ...db.state.job,
          r2_initial_version:'winner-version', r2_initial_etag:'winner-etag',
          downloaded_at:'winner-time', status:'downloaded',
        };
        return null;
      }
      if (mode === 'null') return null;
      return {
        key, size:bytes.byteLength, version:'version-success', etag:'etag-success',
        checksums:{ sha256:options.sha256 },
      };
    },
    async get() { calls.get += 1; throw new Error('GET forbidden'); },
    async head() { calls.head += 1; throw new Error('HEAD forbidden'); },
    async list() { calls.list += 1; throw new Error('LIST forbidden'); },
    async delete() { calls.delete += 1; throw new Error('DELETE forbidden'); },
  };
}

function materializeRuntime(mode) {
  const db = materializeDb();
  const bucket = materializeBucket(db, mode);
  let downloads = 0;
  const runtime = createCloudflareReportCycleRuntime({
    env:{ STORE_01_DB:db, DATA_BUCKET:bucket, AMAZON_ADS_ENABLED:'true' },
    amazonTransportAdapters:{
      async downloadReport(reportId) {
        downloads += 1;
        assert.equal(reportId, 'amazon-materialize-1');
        return { bytes:MATERIALIZE_BYTES, contentEncoding:'identity' };
      },
    },
    storeCode:'DEV01',
    maxCompressedBytes:1024,
    maxDecompressedBytes:4096,
    now:'2026-08-16T03:55:00+08:00',
  });
  return { db, bucket, runtime, downloads:() => downloads };
}

// ready -> download -> durable expected authority -> concrete create-only PUT -> initial D1 receipt.
{
  const h = materializeRuntime('success');
  const result = await h.runtime.advance('run-materialize');
  assert.equal(result.directive, 'MATERIALIZE_RAW_OBJECT');
  assert.equal(result.result.action, 'raw_object_materialized');
  assert.equal(result.result.job.status, 'downloaded');
  assert.equal(result.result.job.r2_initial_version, 'version-success');
  assert.equal(h.downloads(), 1);
  assert.equal(h.db.calls.snapshotBatch, 1);
  assert.equal(h.db.calls.expectedWrites, 1);
  assert.equal(h.db.calls.receiptWrites, 1);
  assert.equal(h.db.calls.otherWrites, 0);
  assert.deepEqual(h.bucket.calls, { put:1, get:0, head:0, list:0, delete:0 });
}

// Conditional null with a concurrent durable D1 winner is recovered only by the acquisition reread.
{
  const h = materializeRuntime('winner');
  const result = await h.runtime.advance('run-materialize');
  assert.equal(result.directive, 'MATERIALIZE_RAW_OBJECT');
  assert.equal(result.result.action, 'raw_receipt_reused_after_put_race');
  assert.equal(result.result.reused, true);
  assert.equal(result.result.job.r2_initial_version, 'winner-version');
  assert.equal(h.db.calls.expectedWrites, 1);
  assert.equal(h.db.calls.receiptWrites, 0);
  assert.deepEqual(h.bucket.calls, { put:1, get:0, head:0, list:0, delete:0 });
}

// Conditional null without a durable winner remains ambiguous; no R2 HEAD/GET is permitted.
{
  const h = materializeRuntime('null');
  let caught = null;
  try { await h.runtime.advance('run-materialize'); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.code, 'REPORT_CYCLE_RUNTIME_EXECUTION_FAILED:MATERIALIZE_RAW_OBJECT');
  assert.equal(caught.cause?.code, 'REPORT_CYCLE_EXECUTION_FAILED:MATERIALIZE_RAW_OBJECT');
  assert.equal(caught.cause?.cause?.code, 'REPORT_CYCLE_ACQUISITION_EXECUTION_FAILED:MATERIALIZE_RAW_OBJECT');
  assert.equal(caught.cause?.cause?.cause?.code, 'R2_UPLOAD_AMBIGUOUS');
  assert.equal(caught.cause?.cause?.cause?.cause?.code, 'R2_RAW_WRITER_CREATE_CONDITION_FAILED');
  assert.equal(h.db.state.job.status, 'ready');
  assert.equal(h.db.calls.expectedWrites, 1);
  assert.equal(h.db.calls.receiptWrites, 0);
  assert.deepEqual(h.bucket.calls, { put:1, get:0, head:0, list:0, delete:0 });
}

console.log('concrete R2 create-only raw object writer + acquisition composition: PASS');
