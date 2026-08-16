import assert from 'node:assert/strict';
import {
  AMAZON_ADS_SYNC_DEFAULTS,
  AmazonAdsSyncRuntimeError,
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

console.log('Amazon Ads sync runtime composition tests: PASS');
