import assert from 'node:assert/strict';
import {
  createReportCycleAcquisitionAdapters,
  ReportCycleAcquisitionAdapterError,
} from '../cloudflare/runtime/sync-report-cycle-acquisition-adapter.js';

const RAW_BYTES = new Uint8Array([0x1f,0x8b,0x08,0x00,0x01,0x02,0x03,0x04]);
const NOW = '2026-08-15T14:12:00Z';

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

const RAW_SHA = await sha256Hex(RAW_BYTES);

function baseJob(status = 'queued', overrides = {}) {
  return {
    job_id:'job-1',
    run_id:'run-1',
    profile_id:'profile-1',
    amazon_report_id:null,
    amazon_created_at:null,
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    status,
    request_json:JSON.stringify({ name:'request' }),
    r2_object_key:null,
    content_sha256:null,
    content_bytes:null,
    r2_initial_version:null,
    r2_initial_etag:null,
    downloaded_at:null,
    ...overrides,
  };
}

class FakeRepository {
  constructor(job) {
    this.job = { ...job };
    this.loadCalls = 0;
  }

  async loadByJobId() {
    this.loadCalls += 1;
    return this.job ? { ...this.job } : null;
  }

  async armCreate() {
    if (this.job.status !== 'queued' || this.job.amazon_report_id != null) return false;
    this.job.status = 'requested';
    return true;
  }

  async persistAmazonReportReceipt(_jobId, reportId, createdAt) {
    if (this.job.status === 'requested' && this.job.amazon_report_id == null) {
      this.job.amazon_report_id = reportId;
      this.job.amazon_created_at = createdAt;
      this.job.status = 'processing';
    }
  }

  async markReady() {
    if (this.job.status === 'processing') this.job.status = 'ready';
    return { ...this.job };
  }

  async markFailed(_jobId, errorCode, errorMessage) {
    if (this.job.status === 'processing') {
      this.job.status = 'failed';
      this.job.error_code = errorCode;
      this.job.error_message = errorMessage;
    }
    return { ...this.job };
  }

  async persistRawExpectedAuthority(_jobId, expected) {
    if (this.job.status === 'ready') {
      this.job.r2_object_key = expected.r2ObjectKey;
      this.job.content_sha256 = expected.contentSha256;
      this.job.content_bytes = expected.contentBytes;
    }
    return { ...this.job };
  }

  async persistInitialR2Receipt(_jobId, receipt) {
    if (this.job.status === 'ready') {
      this.job.r2_initial_version = receipt.r2InitialVersion;
      this.job.r2_initial_etag = receipt.r2InitialEtag;
      this.job.downloaded_at = receipt.downloadedAt;
      this.job.status = 'downloaded';
    }
    return { ...this.job };
  }
}

function makeExternalAdapters(calls, overrides = {}) {
  return {
    async createReport() {
      calls.create += 1;
      return { reportId:'amazon-report-1', createdAt:'2026-08-15T14:11:00Z' };
    },
    async pollReport() {
      calls.poll += 1;
      return { state:'processing' };
    },
    async downloadReport() {
      calls.download += 1;
      return { bytes:RAW_BYTES, contentEncoding:'identity' };
    },
    async putRawObject({ key, bytes }) {
      calls.put += 1;
      return {
        key,
        size:bytes.byteLength,
        version:'v1',
        etag:'etag-1',
        checksums:{ sha256:hexBuffer(RAW_SHA) },
      };
    },
    ...overrides,
  };
}

function input(directive, expectedStatus, overrides = {}) {
  return {
    runId:'run-1',
    jobId:'job-1',
    directive,
    expectedStatus,
    ...overrides,
  };
}

async function expectCode(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ReportCycleAcquisitionAdapterError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function build(repository, calls, overrides = {}) {
  return createReportCycleAcquisitionAdapters({
    repository,
    storeCode:'DEV01',
    acquisitionAdapters:makeExternalAdapters(calls, overrides),
    maxCompressedBytes:1024,
    now:NOW,
  });
}

// queued directive against a freshly processing receipt must fail before a second Create Report POST.
{
  const repository = new FakeRepository(baseJob('processing', {
    amazon_report_id:'amazon-report-1',
    amazon_created_at:'source-time',
  }));
  const calls = { create:0, poll:0, download:0, put:0 };
  const adapters = build(repository, calls);
  await expectCode('REPORT_CYCLE_ACQUISITION_STATUS_STALE:queued:processing', () =>
    adapters.createAmazonReport(input('CREATE_AMAZON_REPORT', 'queued')),
  );
  assert.deepEqual(calls, { create:0, poll:0, download:0, put:0 });
  assert.equal(repository.loadCalls, 1);
}

// processing directive cannot turn into ready-stage download/R2 materialization after a race.
{
  const repository = new FakeRepository(baseJob('ready', {
    amazon_report_id:'amazon-report-1',
    amazon_created_at:'source-time',
  }));
  const calls = { create:0, poll:0, download:0, put:0 };
  const adapters = build(repository, calls);
  await expectCode('REPORT_CYCLE_ACQUISITION_STATUS_STALE:processing:ready', () =>
    adapters.pollAmazonReport(input('POLL_AMAZON_REPORT', 'processing')),
  );
  assert.deepEqual(calls, { create:0, poll:0, download:0, put:0 });
}

// ready directive against an already-downloaded receipt performs zero Amazon/R2 actions.
{
  const repository = new FakeRepository(baseJob('downloaded'));
  const calls = { create:0, poll:0, download:0, put:0 };
  const adapters = build(repository, calls);
  await expectCode('REPORT_CYCLE_ACQUISITION_STATUS_STALE:ready:downloaded', () =>
    adapters.materializeRawObject(input('MATERIALIZE_RAW_OBJECT', 'ready')),
  );
  assert.deepEqual(calls, { create:0, poll:0, download:0, put:0 });
}

// run identity drift is rejected by the same first durable load guard.
{
  const repository = new FakeRepository(baseJob('queued', { run_id:'run-other' }));
  const calls = { create:0, poll:0, download:0, put:0 };
  const adapters = build(repository, calls);
  await expectCode('REPORT_CYCLE_ACQUISITION_RUN_CONFLICT', () =>
    adapters.createAmazonReport(input('CREATE_AMAZON_REPORT', 'queued')),
  );
  assert.deepEqual(calls, { create:0, poll:0, download:0, put:0 });
}

// forged adapter envelope is rejected before even reading durable state.
{
  const repository = new FakeRepository(baseJob('queued'));
  const calls = { create:0, poll:0, download:0, put:0 };
  const adapters = build(repository, calls);
  await expectCode('REPORT_CYCLE_ACQUISITION_DIRECTIVE_CONFLICT', () =>
    adapters.createAmazonReport(input('POLL_AMAZON_REPORT', 'queued')),
  );
  await expectCode('REPORT_CYCLE_ACQUISITION_EXPECTED_STATUS_CONFLICT', () =>
    adapters.createAmazonReport(input('CREATE_AMAZON_REPORT', 'processing')),
  );
  assert.equal(repository.loadCalls, 0);
  assert.deepEqual(calls, { create:0, poll:0, download:0, put:0 });
}

// Matching queued authority reaches only the Create Report boundary.
{
  const repository = new FakeRepository(baseJob('queued'));
  const calls = { create:0, poll:0, download:0, put:0 };
  const adapters = build(repository, calls);
  const result = await adapters.createAmazonReport(input('CREATE_AMAZON_REPORT', 'queued'));
  assert.equal(result.action, 'amazon_report_created');
  assert.equal(repository.job.status, 'processing');
  assert.deepEqual(calls, { create:1, poll:0, download:0, put:0 });
}

// Matching processing authority reaches only one source poll.
{
  const repository = new FakeRepository(baseJob('processing', {
    amazon_report_id:'amazon-report-1',
    amazon_created_at:'source-time',
  }));
  const calls = { create:0, poll:0, download:0, put:0 };
  const adapters = build(repository, calls);
  const result = await adapters.pollAmazonReport(input('POLL_AMAZON_REPORT', 'processing'));
  assert.equal(result.action, 'amazon_report_polled');
  assert.equal(result.waiting, true);
  assert.deepEqual(calls, { create:0, poll:1, download:0, put:0 });
}

// Matching ready authority may download and materialize exactly through the existing receipt-first path.
{
  const repository = new FakeRepository(baseJob('ready', {
    amazon_report_id:'amazon-report-1',
    amazon_created_at:'source-time',
  }));
  const calls = { create:0, poll:0, download:0, put:0 };
  const adapters = build(repository, calls);
  const result = await adapters.materializeRawObject(input('MATERIALIZE_RAW_OBJECT', 'ready'));
  assert.equal(result.action, 'raw_object_materialized');
  assert.equal(repository.job.status, 'downloaded');
  assert.deepEqual(calls, { create:0, poll:0, download:1, put:1 });
}

// Underlying acquisition failures remain causally visible but cannot be confused with freshness errors.
{
  const repository = new FakeRepository(baseJob('processing', {
    amazon_report_id:'amazon-report-1',
    amazon_created_at:'source-time',
  }));
  const calls = { create:0, poll:0, download:0, put:0 };
  const adapters = build(repository, calls, {
    async pollReport() {
      calls.poll += 1;
      throw new Error('poll transport failed');
    },
  });
  const error = await expectCode('REPORT_CYCLE_ACQUISITION_EXECUTION_FAILED:POLL_AMAZON_REPORT', () =>
    adapters.pollAmazonReport(input('POLL_AMAZON_REPORT', 'processing')),
  );
  assert.equal(error.cause.code, undefined);
  assert.equal(error.cause.message, 'poll transport failed');
  assert.equal(calls.poll, 1);
}

console.log('report cycle acquisition durable-state freshness guard: PASS');
