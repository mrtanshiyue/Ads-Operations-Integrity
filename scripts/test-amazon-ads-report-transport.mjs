import assert from 'node:assert/strict';
import {
  AmazonAdsReportTransportError,
  createAmazonAdsReportTransport,
  resolveAmazonAdsApiBaseUrl,
} from '../cloudflare/runtime/amazon-ads-report-transport.js';

const GZIP = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status:init.status ?? 200,
    headers:{ 'content-type':'application/json', ...(init.headers || {}) },
  });
}

function baseOptions(overrides = {}) {
  return {
    clientId:'client-id',
    profileId:'123456789',
    region:'NA',
    accessToken:'access-token',
    sleep:async () => {},
    ...overrides,
  };
}

async function testRegionMapping() {
  assert.equal(resolveAmazonAdsApiBaseUrl('NA'), 'https://advertising-api.amazon.com');
  assert.equal(resolveAmazonAdsApiBaseUrl('eu'), 'https://advertising-api-eu.amazon.com');
  assert.equal(resolveAmazonAdsApiBaseUrl('FE'), 'https://advertising-api-fe.amazon.com');
  assert.throws(() => resolveAmazonAdsApiBaseUrl('unknown'), /AMAZON_ADS_REGION_UNSUPPORTED/);
}

async function testCreateUsesV3ProfileScopedHeadersAndNeverRetries() {
  const calls = [];
  const transport = createAmazonAdsReportTransport(baseOptions({
    maxReadRetries:5,
    fetchImpl:async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        reportId:'report-1',
        createdAt:'2026-08-16T00:00:00Z',
        status:'PENDING',
      });
    },
  }));
  const receipt = await transport.createReport({ name:'test', startDate:'2026-08-15' });
  assert.deepEqual(receipt, { reportId:'report-1', createdAt:'2026-08-16T00:00:00Z' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://advertising-api.amazon.com/reporting/reports');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['amazon-advertising-api-clientid'], 'client-id');
  assert.equal(calls[0].init.headers['amazon-advertising-api-scope'], '123456789');
  assert.equal(calls[0].init.headers.authorization, 'Bearer access-token');
  assert.equal(calls[0].init.headers['content-type'], 'application/vnd.createasyncreportrequest.v3+json');

  let failedCalls = 0;
  const noRetryTransport = createAmazonAdsReportTransport(baseOptions({
    maxReadRetries:9,
    fetchImpl:async () => {
      failedCalls += 1;
      throw new Error('network lost after send');
    },
  }));
  await assert.rejects(noRetryTransport.createReport({ name:'ambiguous' }), (error) => {
    assert.ok(error instanceof AmazonAdsReportTransportError);
    assert.equal(error.code, 'AMAZON_ADS_CREATE_OUTCOME_AMBIGUOUS');
    assert.equal(error.ambiguous, true);
    return true;
  });
  assert.equal(failedCalls, 1);
}

async function testPollRetriesReadsAndMapsStates() {
  let calls = 0;
  const sleeps = [];
  const transport = createAmazonAdsReportTransport(baseOptions({
    maxReadRetries:2,
    sleep:async (ms) => { sleeps.push(ms); },
    fetchImpl:async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status:429, headers:{ 'retry-after':'2' } });
      return jsonResponse({ reportId:'report-1', status:'COMPLETED', url:'https://example.com/report.gz' });
    },
  }));
  assert.deepEqual(await transport.pollReport('report-1'), { state:'ready' });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);

  const failed = createAmazonAdsReportTransport(baseOptions({
    fetchImpl:async () => jsonResponse({ status:'FAILURE', failureReason:'INTERNAL_ERROR' }),
  }));
  assert.deepEqual(await failed.pollReport('report-2'), {
    state:'failed',
    failureCode:'AMAZON_REPORT_FAILED',
    failureMessage:'INTERNAL_ERROR',
  });

  const pending = createAmazonAdsReportTransport(baseOptions({
    fetchImpl:async () => jsonResponse({ status:'PENDING' }),
  }));
  assert.deepEqual(await pending.pollReport('report-3'), { state:'processing' });
}

async function testDownloadRechecksStatusAndReturnsRawBytes() {
  const calls = [];
  const transport = createAmazonAdsReportTransport(baseOptions({
    fetchImpl:async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/reporting/reports/')) {
        return jsonResponse({
          reportId:'report-4',
          status:'COMPLETED',
          url:'https://signed.example.com/report.json.gz?signature=abc',
          urlExpiresAt:'2026-08-16T01:00:00Z',
        });
      }
      return new Response(GZIP, {
        status:200,
        headers:{ 'content-length':String(GZIP.byteLength) },
      });
    },
  }));
  const result = await transport.downloadReport('report-4');
  assert.deepEqual([...result.bytes], [...GZIP]);
  assert.equal(result.contentEncoding, 'identity');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['amazon-advertising-api-scope'], '123456789');
  assert.equal(calls[1].url.startsWith('https://signed.example.com/'), true);
  assert.equal(calls[1].init.headers.authorization, undefined);
  assert.equal(calls[1].init.headers['accept-encoding'], 'identity');
}

async function testDownloadHardening() {
  const tooLarge = createAmazonAdsReportTransport(baseOptions({
    maxDownloadBytes:4,
    fetchImpl:async (url) => {
      if (url.includes('/reporting/reports/')) {
        return jsonResponse({ status:'COMPLETED', url:'https://signed.example.com/report.gz' });
      }
      return new Response(GZIP, { status:200, headers:{ 'content-length':'8' } });
    },
  }));
  await assert.rejects(tooLarge.downloadReport('report-5'), /AMAZON_ADS_REPORT_DOWNLOAD_TOO_LARGE/);

  const chunkedTooLarge = createAmazonAdsReportTransport(baseOptions({
    maxDownloadBytes:4,
    fetchImpl:async (url) => {
      if (url.includes('/reporting/reports/')) {
        return jsonResponse({ status:'COMPLETED', url:'https://signed.example.com/chunked.gz' });
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x1f, 0x8b, 0x08]));
          controller.enqueue(new Uint8Array([0x00, 0x01, 0x02]));
          controller.close();
        },
      });
      return new Response(stream, { status:200 });
    },
  }));
  await assert.rejects(chunkedTooLarge.downloadReport('report-5b'), /AMAZON_ADS_REPORT_DOWNLOAD_TOO_LARGE/);

  const notReady = createAmazonAdsReportTransport(baseOptions({
    fetchImpl:async () => jsonResponse({ status:'PROCESSING' }),
  }));
  await assert.rejects(notReady.downloadReport('report-6'), /AMAZON_ADS_DOWNLOAD_REPORT_NOT_READY:PROCESSING/);

  const invalidUrl = createAmazonAdsReportTransport(baseOptions({
    fetchImpl:async () => jsonResponse({ status:'COMPLETED', url:'http://unsafe.example.com/report.gz' }),
  }));
  await assert.rejects(invalidUrl.downloadReport('report-7'), /AMAZON_ADS_DOWNLOAD_URL_INVALID/);
}

await testRegionMapping();
await testCreateUsesV3ProfileScopedHeadersAndNeverRetries();
await testPollRetriesReadsAndMapsStates();
await testDownloadRechecksStatusAndReturnsRawBytes();
await testDownloadHardening();
console.log('Amazon Ads report transport tests: PASS');
