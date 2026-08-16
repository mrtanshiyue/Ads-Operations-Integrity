import assert from 'node:assert/strict';
import {
  AMAZON_ADS_SYNC_DEFAULTS,
  AmazonAdsSyncRuntimeError,
  advanceAmazonAdsReportCycle,
  amazonAdsExecutionEnabled,
  createScopedReportCycleEnv,
  requiresAmazonReportTransport,
  resolveAmazonAdsSyncPolicy,
  shouldSleepAfterReportCycleAdvance,
  summarizeReportCycleAdvance,
} from '../cloudflare/runtime/amazon-ads-sync-runtime.js';

assert.equal(amazonAdsExecutionEnabled({ AMAZON_ADS_ENABLED:'true' }), true);
assert.equal(amazonAdsExecutionEnabled({ AMAZON_ADS_ENABLED:'false' }), false);
assert.equal(amazonAdsExecutionEnabled({ AMAZON_ADS_ENABLED:true }), false);
assert.equal(amazonAdsExecutionEnabled({}), false);

assert.deepEqual(resolveAmazonAdsSyncPolicy({}), AMAZON_ADS_SYNC_DEFAULTS);
assert.deepEqual(resolveAmazonAdsSyncPolicy({
  AMAZON_ADS_MAX_COMPRESSED_REPORT_BYTES:'1048576',
  AMAZON_ADS_MAX_DECOMPRESSED_REPORT_BYTES:'4194304',
  AMAZON_ADS_REPORT_POLL_INTERVAL_MS:'15000',
}), {
  maxCompressedBytes:1048576,
  maxDecompressedBytes:4194304,
  pollIntervalMs:15000,
});
assert.throws(
  () => resolveAmazonAdsSyncPolicy({ AMAZON_ADS_REPORT_POLL_INTERVAL_MS:'4999' }),
  (error) => error instanceof AmazonAdsSyncRuntimeError
    && error.code === 'AMAZON_ADS_REPORT_POLL_INTERVAL_TOO_SMALL',
);
assert.throws(
  () => resolveAmazonAdsSyncPolicy({
    AMAZON_ADS_MAX_COMPRESSED_REPORT_BYTES:'10',
    AMAZON_ADS_MAX_DECOMPRESSED_REPORT_BYTES:'9',
  }),
  /AMAZON_ADS_REPORT_SIZE_POLICY_INVALID/,
);

const storeDb = { prepare(){}, batch(){} };
const bucket = { get(){}, put(){} };
const scoped = createScopedReportCycleEnv({
  DATA_BUCKET:bucket,
  AMAZON_ADS_ENABLED:'true',
  AMAZON_ADS_CLIENT_SECRET:'must-not-leak',
  STORE_02_DB:{ prepare(){}, batch(){} },
}, storeDb);
assert.equal(scoped.STORE_01_DB, storeDb);
assert.equal(scoped.DATA_BUCKET, bucket);
assert.equal(scoped.AMAZON_ADS_ENABLED, 'true');
assert.equal(Object.prototype.hasOwnProperty.call(scoped, 'AMAZON_ADS_CLIENT_SECRET'), false);
assert.equal(Object.prototype.hasOwnProperty.call(scoped, 'STORE_02_DB'), false);

for (const directive of ['CREATE_AMAZON_REPORT', 'POLL_AMAZON_REPORT', 'MATERIALIZE_RAW_OBJECT']) {
  assert.equal(requiresAmazonReportTransport(directive), true);
}
for (const directive of ['AWAIT_INGESTION', 'FINALIZE_RUN', 'BLOCKED', 'RUN_TERMINAL']) {
  assert.equal(requiresAmazonReportTransport(directive), false);
}

const created = summarizeReportCycleAdvance({
  directive:'CREATE_AMAZON_REPORT',
  executed:true,
  waiting:false,
  jobId:'job-1',
  result:{ action:'amazon_report_created', waiting:true },
});
assert.deepEqual(created, {
  directive:'CREATE_AMAZON_REPORT',
  executed:true,
  waiting:false,
  jobId:'job-1',
  reason:null,
  action:'amazon_report_created',
  actionWaiting:true,
  runStatus:null,
});
assert.equal(shouldSleepAfterReportCycleAdvance(created), true);

const staged = summarizeReportCycleAdvance({
  directive:'AWAIT_INGESTION',
  executed:true,
  waiting:true,
  jobId:'job-1',
  result:{
    directive:'AWAIT_INGESTION',
    waiting:true,
    result:{ action:'search_term_stage_ready', waiting:true },
  },
});
assert.equal(staged.action, 'search_term_stage_ready');
assert.equal(staged.actionWaiting, true);
assert.equal(shouldSleepAfterReportCycleAdvance(staged), false);

const finalized = summarizeReportCycleAdvance({
  directive:'FINALIZE_RUN',
  executed:true,
  waiting:false,
  result:{ finalized:true, run:{ status:'succeeded' } },
});
assert.equal(finalized.runStatus, 'succeeded');
assert.equal(shouldSleepAfterReportCycleAdvance(finalized), false);

// Credential acquisition for an Amazon boundary must happen before the concrete report-cycle
// runtime can arm queued -> requested. If token refresh fails, durable report state must remain
// read-only and no Amazon/R2 side effect may become reachable.
{
  const runId = 'run-preflight-1';
  const profileId = 'profile-preflight-1';
  const fingerprint = 'a'.repeat(64);
  const sharedIdentity = Object.freeze({
    run_id:runId,
    job_id:'job-preflight-1',
    profile_id:profileId,
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    idempotency_key:'amazon-ads:preflight-test',
    request_fingerprint:'request-preflight-test',
    request_json:'{"name":"preflight-test"}',
  });
  const run = Object.freeze({
    run_id:runId,
    profile_id:profileId,
    status:'running',
    report_plan_fingerprint:fingerprint,
    report_plan_job_count:1,
  });
  const membership = Object.freeze({
    ...sharedIdentity,
    report_plan_fingerprint:fingerprint,
    dataset_key:'search_term_daily',
    contract_id:'search_term_daily.sp.v1',
  });
  const job = Object.freeze({
    ...sharedIdentity,
    status:'queued',
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
  });

  const observedSql = [];
  const mutationSql = [];
  const preflightDb = {
    prepare(sql) {
      const text = String(sql);
      observedSql.push(text);
      if (/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text)) mutationSql.push(text);
      return {
        bind(...params) {
          return Object.freeze({ sql:text, params:Object.freeze(params) });
        },
      };
    },
    async batch(statements) {
      assert.equal(statements.length, 3);
      assert(statements.every((statement) => /^\s*SELECT\b/i.test(statement.sql)));
      return [
        { results:[run] },
        { results:[membership] },
        { results:[job] },
      ];
    },
  };

  let tokenCalls = 0;
  let amazonFetchCalls = 0;
  let r2Reads = 0;
  let r2Writes = 0;
  const credentialProvider = {
    async getAccessToken() {
      tokenCalls += 1;
      throw new Error('credential_preflight_failed');
    },
  };
  const preflightBucket = {
    get() { r2Reads += 1; },
    put() { r2Writes += 1; },
  };

  await assert.rejects(
    () => advanceAmazonAdsReportCycle({
      env:{
        AMAZON_ADS_ENABLED:'true',
        AMAZON_ADS_CLIENT_ID:'client-preflight-test',
        DATA_BUCKET:preflightBucket,
      },
      route:{
        storeId:'store-preflight-1',
        storeCode:'DEV01',
        marketplaceCode:'US',
        amazonRegion:'NA',
      },
      storeDb:preflightDb,
      runId,
      profileId,
      credentialProvider,
      fetchImpl:async () => {
        amazonFetchCalls += 1;
        throw new Error('amazon_fetch_must_not_run');
      },
    }),
    /credential_preflight_failed/,
  );

  assert.equal(tokenCalls, 1);
  assert(observedSql.length >= 3);
  assert.equal(mutationSql.length, 0, 'credential failure must happen before any D1 report mutation');
  assert.equal(amazonFetchCalls, 0, 'credential failure must happen before Amazon report transport is reachable');
  assert.equal(r2Reads, 0, 'credential failure must happen before R2 read is reachable');
  assert.equal(r2Writes, 0, 'credential failure must happen before R2 write is reachable');
}

console.log('Amazon Ads sync runtime composition tests: PASS');
