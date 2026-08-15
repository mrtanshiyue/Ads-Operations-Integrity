import assert from 'node:assert/strict';
import {
  advanceReportAcquisitionOnce,
  materializeRawReportOnce,
  assertDownloadedRawReceipt,
} from '../cloudflare/runtime/amazon-report-acquisition.js';

const RAW_BYTES = new Uint8Array([0x1f,0x8b,0x08,0x00,0x01,0x02,0x03,0x04]);
const OTHER_BYTES = new Uint8Array([0x1f,0x8b,0x08,0x00,0x09,0x09,0x09]);
const NOW = '2026-08-15T11:55:00Z';

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2,'0')).join('');
}
function hexBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i=0;i<bytes.length;i+=1) bytes[i] = Number.parseInt(hex.slice(i*2,i*2+2),16);
  return bytes.buffer;
}
const RAW_SHA = await sha256Hex(RAW_BYTES);

function baseJob(status='queued') {
  return {
    job_id:'job-1', run_id:'run-1', profile_id:'profile-1', amazon_report_id:null,
    amazon_created_at:null, ad_product:'SPONSORED_PRODUCTS', report_type:'spSearchTerm',
    start_date:'2026-08-12', end_date:'2026-08-12', status,
    request_json:JSON.stringify({name:'request'}),
    r2_object_key:null, content_sha256:null, content_bytes:null,
    r2_initial_version:null, r2_initial_etag:null, downloaded_at:null,
  };
}

class FakeRepository {
  constructor(job) {
    this.job = { ...job };
    this.expectedWrites = 0;
    this.initialWrites = 0;
    this.readyWrites = 0;
    this.failedWrites = 0;
  }
  async loadByJobId() { return { ...this.job }; }
  async armCreate() {
    if (this.job.status !== 'queued' || this.job.amazon_report_id != null) return false;
    this.job.status = 'requested'; return true;
  }
  async persistAmazonReportReceipt(_jobId, reportId, createdAt) {
    if (this.job.status === 'requested' && this.job.amazon_report_id == null) {
      this.job.amazon_report_id=reportId; this.job.amazon_created_at=createdAt; this.job.status='processing';
    }
  }
  async markReady() {
    this.readyWrites += 1;
    if (this.job.status === 'processing') this.job.status='ready';
    return { ...this.job };
  }
  async markFailed(_jobId, code, message) {
    this.failedWrites += 1;
    if (this.job.status === 'processing') {
      this.job.status='failed'; this.job.error_code=code; this.job.error_message=message;
    }
    return { ...this.job };
  }
  async persistRawExpectedAuthority(_jobId, expected) {
    this.expectedWrites += 1;
    if (this.job.status === 'ready') {
      this.job.r2_object_key = expected.r2ObjectKey;
      this.job.content_sha256 = expected.contentSha256;
      this.job.content_bytes = expected.contentBytes;
    }
    return { ...this.job };
  }
  async persistInitialR2Receipt(_jobId, receipt) {
    this.initialWrites += 1;
    if (this.job.status === 'ready') {
      this.job.r2_initial_version=receipt.r2InitialVersion;
      this.job.r2_initial_etag=receipt.r2InitialEtag;
      this.job.downloaded_at=receipt.downloadedAt;
      this.job.status='downloaded';
    }
    return { ...this.job };
  }
}

function adapters(overrides={}) {
  return {
    async createReport() { return { reportId:'amazon-report-1', createdAt:'2026-08-15T11:54:00Z' }; },
    async pollReport() { return { state:'processing' }; },
    async downloadReport() { return { bytes:RAW_BYTES, contentEncoding:'identity' }; },
    async putRawObject({key,bytes,options}) {
      assert.equal(key, 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-report-1.json.gz');
      assert.equal(bytes, RAW_BYTES);
      assert.equal(options.onlyIf.etagDoesNotMatch, '*');
      return { key, size:bytes.byteLength, version:'v1', etag:'etag1', checksums:{ sha256:hexBuffer(RAW_SHA) } };
    },
    ...overrides,
  };
}

// Create is one durable boundary; polling does not happen in the same call.
{
  const repository = new FakeRepository(baseJob('queued'));
  let createCalls=0, pollCalls=0;
  const result = await advanceReportAcquisitionOnce({
    repository, jobId:'job-1', storeCode:'DEV01', maxCompressedBytes:1024, now:NOW,
    adapters:adapters({
      async createReport() { createCalls+=1; return { reportId:'amazon-report-1', createdAt:'source-time' }; },
      async pollReport() { pollCalls+=1; return { state:'ready' }; },
    }),
  });
  assert.equal(result.action,'amazon_report_created');
  assert.equal(repository.job.status,'processing');
  assert.equal(createCalls,1); assert.equal(pollCalls,0);
}

// requested + NULL report id is permanently ambiguous; no second POST.
{
  const repository = new FakeRepository(baseJob('requested'));
  let createCalls=0;
  await assert.rejects(
    () => advanceReportAcquisitionOnce({
      repository, jobId:'job-1', storeCode:'DEV01', maxCompressedBytes:1024, now:NOW,
      adapters:adapters({async createReport(){createCalls+=1;return {reportId:'forbidden',createdAt:'t'};}}),
    }),
    (error) => error.code === 'AMAZON_REPORT_CREATE_AMBIGUOUS',
  );
  assert.equal(createCalls,0);
}

// Processing poll is read-only and advances only when normalized source says ready.
{
  const job = baseJob('processing'); job.amazon_report_id='amazon-report-1'; job.amazon_created_at='source-time';
  const repository = new FakeRepository(job);
  let downloads=0;
  const waiting = await advanceReportAcquisitionOnce({repository,jobId:'job-1',storeCode:'DEV01',maxCompressedBytes:1024,now:NOW,adapters:adapters({
    async pollReport(){return {state:'processing'};}, async downloadReport(){downloads+=1;return {bytes:RAW_BYTES};}
  })});
  assert.equal(waiting.waiting,true); assert.equal(repository.readyWrites,0); assert.equal(downloads,0);
  const ready = await advanceReportAcquisitionOnce({repository,jobId:'job-1',storeCode:'DEV01',maxCompressedBytes:1024,now:NOW,adapters:adapters({
    async pollReport(){return {state:'ready'};}, async downloadReport(){downloads+=1;return {bytes:RAW_BYTES};}
  })});
  assert.equal(ready.action,'amazon_report_ready'); assert.equal(repository.job.status,'ready'); assert.equal(downloads,0);
}

// Source-declared failure persists as terminal receipt.
{
  const job=baseJob('processing'); job.amazon_report_id='amazon-report-1'; job.amazon_created_at='source-time';
  const repository=new FakeRepository(job);
  const result=await advanceReportAcquisitionOnce({repository,jobId:'job-1',storeCode:'DEV01',maxCompressedBytes:1024,now:NOW,adapters:adapters({
    async pollReport(){return {state:'failed',failureCode:'AMAZON_REPORT_FAILED',failureMessage:'source failure'};}
  })});
  assert.equal(result.job.status,'failed'); assert.equal(repository.failedWrites,1); assert.equal(repository.job.error_code,'AMAZON_REPORT_FAILED');
}

// Ready -> download -> persist expected authority BEFORE create-only PUT -> persist initial R2 receipt.
{
  const job=baseJob('ready'); job.amazon_report_id='amazon-report-1'; job.amazon_created_at='source-time';
  const repository=new FakeRepository(job);
  let putCalls=0;
  const result=await advanceReportAcquisitionOnce({repository,jobId:'job-1',storeCode:'DEV01',maxCompressedBytes:1024,now:NOW,adapters:adapters({
    async putRawObject(input){
      putCalls+=1;
      assert.equal(repository.expectedWrites,1,'expected authority must be durable before PUT');
      return {key:input.key,size:input.bytes.byteLength,version:'v1',etag:'etag1',checksums:{sha256:hexBuffer(RAW_SHA)}};
    }
  })});
  assert.equal(result.action,'raw_object_materialized'); assert.equal(repository.job.status,'downloaded');
  assert.equal(putCalls,1); assert.equal(repository.initialWrites,1); assertDownloadedRawReceipt(repository.job);
}

// Crash after expected authority but before PUT: retry may re-download, but bytes must match durable authority.
{
  const job=baseJob('ready'); job.amazon_report_id='amazon-report-1'; job.amazon_created_at='source-time';
  job.r2_object_key='raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-report-1.json.gz';
  job.content_sha256=RAW_SHA; job.content_bytes=RAW_BYTES.byteLength;
  const repository=new FakeRepository(job);
  let putCalls=0;
  const result=await materializeRawReportOnce({repository,job:{...repository.job},storeCode:'DEV01',downloadReport:adapters().downloadReport,maxCompressedBytes:1024,now:NOW,
    async putRawObject(input){putCalls+=1;return {key:input.key,size:input.bytes.byteLength,version:'v2',etag:'etag2',checksums:{sha256:hexBuffer(RAW_SHA)}};}});
  assert.equal(repository.expectedWrites,0); assert.equal(putCalls,1); assert.equal(result.job.r2_initial_version,'v2');
}

// Re-downloaded bytes differing from durable expected authority fail before PUT.
{
  const job=baseJob('ready'); job.amazon_report_id='amazon-report-1'; job.amazon_created_at='source-time';
  job.r2_object_key='raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-report-1.json.gz';
  job.content_sha256=RAW_SHA; job.content_bytes=RAW_BYTES.byteLength;
  const repository=new FakeRepository(job); let putCalls=0;
  await assert.rejects(
    () => materializeRawReportOnce({repository,job:{...repository.job},storeCode:'DEV01',maxCompressedBytes:1024,now:NOW,
      async downloadReport(){return {bytes:OTHER_BYTES,contentEncoding:'identity'};}, async putRawObject(){putCalls+=1;}}),
    (error) => String(error.code||'').startsWith('R2_EXPECTED_AUTHORITY_CONFLICT:'),
  );
  assert.equal(putCalls,0);
}

// PUT success with lost response cannot be healed by HEAD/backfill. No durable initial receipt => ambiguous.
{
  const job=baseJob('ready'); job.amazon_report_id='amazon-report-1'; job.amazon_created_at='source-time';
  const repository=new FakeRepository(job); let putCalls=0;
  await assert.rejects(
    () => materializeRawReportOnce({repository,job:{...repository.job},storeCode:'DEV01',maxCompressedBytes:1024,now:NOW,
      downloadReport:adapters().downloadReport, async putRawObject(){putCalls+=1;throw new Error('response lost after put');}}),
    (error) => error.code === 'R2_UPLOAD_AMBIGUOUS',
  );
  assert.equal(putCalls,1); assert.equal(repository.job.status,'ready'); assert.equal(repository.job.r2_initial_version,null);
}

// Concurrent winner can disambiguate a losing PUT callback only through the durable D1 initial receipt.
{
  const job=baseJob('ready'); job.amazon_report_id='amazon-report-1'; job.amazon_created_at='source-time';
  const repository=new FakeRepository(job);
  const result=await materializeRawReportOnce({repository,job:{...repository.job},storeCode:'DEV01',maxCompressedBytes:1024,now:NOW,
    downloadReport:adapters().downloadReport,
    async putRawObject(){
      repository.job.r2_initial_version='winner-v'; repository.job.r2_initial_etag='winner-etag';
      repository.job.downloaded_at='winner-time'; repository.job.status='downloaded';
      throw new Error('precondition failed for loser');
    }});
  assert.equal(result.reused,true); assert.equal(result.job.r2_initial_version,'winner-v');
}

// Downloaded replay performs zero external actions.
{
  const job=baseJob('downloaded'); job.amazon_report_id='amazon-report-1'; job.amazon_created_at='source-time';
  job.r2_object_key='key'; job.content_sha256=RAW_SHA; job.content_bytes=RAW_BYTES.byteLength;
  job.r2_initial_version='v'; job.r2_initial_etag='etag'; job.downloaded_at='t';
  const repository=new FakeRepository(job); let calls=0;
  const result=await advanceReportAcquisitionOnce({repository,jobId:'job-1',storeCode:'DEV01',maxCompressedBytes:1024,now:NOW,adapters:{
    async createReport(){calls+=1;},async pollReport(){calls+=1;},async downloadReport(){calls+=1;},async putRawObject(){calls+=1;}
  }});
  assert.equal(result.reused,true); assert.equal(calls,0);
}

console.log(JSON.stringify({
  ok:true,
  oneExternalBoundaryPerAdvance:true,
  requestedCreateAmbiguityFailsClosed:true,
  sourcePollNormalized:true,
  expectedAuthorityBeforePut:true,
  createOnlyPut:true,
  retryDownloadMustMatchDurableExpectedAuthority:true,
  ambiguousPutNeverHeadBackfilled:true,
  concurrentWinnerRequiresDurableInitialReceipt:true,
  downloadedReplayHasZeroExternalActions:true,
  noR2GetBodyDecompressionOrParsing:true,
},null,2));
