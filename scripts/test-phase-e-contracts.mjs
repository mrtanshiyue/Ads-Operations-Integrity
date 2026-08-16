import assert from 'node:assert/strict';
import {
  normalizeWorkflowIntent,
  computeSyncIntentFingerprint,
  computeSyncInstanceId,
  assertIntentReceipt, buildManualSyncRegistration, assertSyncRunReceipt,
} from '../cloudflare/runtime/sync-intent-contract.js';
import { parseAmazonId, exactDecimalToMicros } from '../cloudflare/runtime/amazon-numeric.js';
import { marketplaceContractForStore, resolveCanonicalProfile } from '../cloudflare/runtime/amazon-profile-contract.js';
import {
  resolveReportContract, planReportChunks, buildAmazonReportRequest,
  computeRequestFingerprint, computeReportAcquisitionIdentity,
} from '../cloudflare/runtime/amazon-report-contract.js';
import {
  canTransitionReportJob, assertReportTransition, amazonCreateDecision, rawObjectDecision, canonicalProfileReceiptDecision,
} from '../cloudflare/runtime/amazon-producer-state.js';
import { classifySearchTermTargeting, buildSearchTermRowKey } from '../cloudflare/runtime/amazon-search-term-parser.js';

function expectCode(fn, code) {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code);
  }
}

const baseIntent = {
  storeId: 'store-dev-01',
  startDate: '2026-08-01',
  endDate: '2026-08-12',
  datasets: ['search_term_daily', 'campaign_daily'],
  triggerType: 'manual',
};
const normalizedA = normalizeWorkflowIntent(baseIntent);
const normalizedB = normalizeWorkflowIntent({ ...baseIntent, datasets: ['campaign_daily', 'search_term_daily', 'campaign_daily'] });
assert.deepEqual(normalizedA, normalizedB);
const fpA = await computeSyncIntentFingerprint(normalizedA);
const fpB = await computeSyncIntentFingerprint(normalizedB);
assert.equal(fpA, fpB);

const instanceA = await computeSyncInstanceId({
  storeId: baseIntent.storeId, actorUserId: 'user-dev-owner', idempotencyKey: 'client-key-0001',
});
const instanceSame = await computeSyncInstanceId({
  storeId: baseIntent.storeId, actorUserId: 'user-dev-owner', idempotencyKey: 'client-key-0001',
});
const instanceOtherActor = await computeSyncInstanceId({
  storeId: baseIntent.storeId, actorUserId: 'user-other', idempotencyKey: 'client-key-0001',
});
assert.equal(instanceA, instanceSame);
assert.notEqual(instanceA, instanceOtherActor);
const changedIntentFp = await computeSyncIntentFingerprint({ ...baseIntent, endDate: '2026-08-13' });
assertIntentReceipt(fpA, fpA);
expectCode(() => assertIntentReceipt(fpA, changedIntentFp), 'IDEMPOTENCY_KEY_REUSE_CONFLICT');
expectCode(() => assertIntentReceipt(null, fpA), 'IDEMPOTENCY_RECEIPT_UNVERIFIABLE');
expectCode(() => normalizeWorkflowIntent({ ...baseIntent, profileId: 'p1' }), 'CALLER_PROFILE_AUTHORITY_REMOVED');
expectCode(() => normalizeWorkflowIntent({ ...baseIntent, reportConfigVersion: 'v1' }), 'CALLER_REPORT_CONFIG_AUTHORITY_REMOVED');

const registration = await buildManualSyncRegistration({
  storeId: 'store-dev-01', actorUserId: 'user-dev-owner', idempotencyKey: 'client-key-0002',
  requestBody: { startDate: '2026-08-01', endDate: '2026-08-12', datasets: ['search_term_daily','campaign_daily'] },
});
assert.equal(registration.workflowParams.profileId, undefined);
assert.equal(registration.workflowParams.reportConfigVersion, undefined);
assert.equal(registration.workflowParams.requestedBy, undefined);
assert.equal(assertSyncRunReceipt({
  run_id: registration.instanceId, requested_by: 'user-dev-owner', trigger_type: 'manual',
  intent_fingerprint: registration.intentFingerprint, status: 'queued', profile_id: null,
}, registration), 'CREATE_BATCH_IDEMPOTENT');
assert.equal(assertSyncRunReceipt({
  run_id: registration.instanceId, requested_by: 'user-dev-owner', trigger_type: 'manual',
  intent_fingerprint: registration.intentFingerprint, status: 'running', profile_id: 'p1',
}, registration), 'REUSE_RUNNING');
expectCode(() => assertSyncRunReceipt({
  run_id: registration.instanceId, requested_by: 'user-dev-owner', trigger_type: 'manual',
  intent_fingerprint: 'different', status: 'queued', profile_id: null,
}, registration), 'IDEMPOTENCY_KEY_REUSE_CONFLICT');

const usStore = { marketplace_code: 'US', amazon_region: 'NA' };
assert.equal(marketplaceContractForStore(usStore).marketplaceStringId, 'ATVPDKIKX0DER');
const seller = resolveCanonicalProfile(usStore, [{
  profileId: '12345678901234567890', countryCode: 'US', currencyCode: 'USD', timezone: 'America/Los_Angeles',
  accountInfo: { marketplaceStringId: 'ATVPDKIKX0DER', type: 'seller', name: 'Store' },
}]);
assert.equal(seller.profileId, '12345678901234567890');
assert.equal(seller.accountType, 'seller');
expectCode(() => resolveCanonicalProfile(usStore, []), 'CANONICAL_PROFILE_NOT_FOUND');
expectCode(() => resolveCanonicalProfile(usStore, [
  { profileId: '1', countryCode: 'US', currencyCode: 'USD', accountInfo: { marketplaceStringId: 'ATVPDKIKX0DER', type: 'seller' } },
  { profileId: '2', countryCode: 'US', currencyCode: 'USD', accountInfo: { marketplaceStringId: 'ATVPDKIKX0DER', type: 'vendor' } },
]), 'CANONICAL_PROFILE_AMBIGUOUS');
expectCode(() => resolveCanonicalProfile(usStore, [
  { profileId: '1', countryCode: 'US', currencyCode: 'USD', accountInfo: { marketplaceStringId: 'ATVPDKIKX0DER', type: 'agency' } },
]), 'PROFILE_ACCOUNT_TYPE_UNSUPPORTED');
expectCode(() => marketplaceContractForStore({ marketplace_code: 'US', amazon_region: 'EU' }), 'STORE_AMAZON_REGION_MISMATCH');

assert.equal(parseAmazonId('12345678901234567890'), '12345678901234567890');
assert.equal(parseAmazonId(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
expectCode(() => parseAmazonId(Number.MAX_SAFE_INTEGER + 1), 'SOURCE_ID_PRECISION_UNSAFE');
assert.equal(exactDecimalToMicros('0'), 0);
assert.equal(exactDecimalToMicros('0.000001'), 1);
assert.equal(exactDecimalToMicros('9.45'), 9_450_000);
assert.equal(exactDecimalToMicros('9.450000'), 9_450_000);
expectCode(() => exactDecimalToMicros('1.0000001'), 'SOURCE_MONEY_DECIMAL_INVALID');
expectCode(() => exactDecimalToMicros(9.45), 'SOURCE_MONEY_LEXICAL_REQUIRED');

const sellerContract = resolveReportContract('search_term_daily', 'seller');
const vendorContract = resolveReportContract('search_term_daily', 'vendor');
assert.equal(sellerContract.attribution.windowDays, 7);
assert.equal(vendorContract.attribution.windowDays, 14);
const chunks = planReportChunks('2026-08-01', '2026-09-05');
assert.deepEqual(chunks, [
  { startDate: '2026-08-01', endDate: '2026-08-31' },
  { startDate: '2026-09-01', endDate: '2026-09-05' },
]);
const request = buildAmazonReportRequest(sellerContract, chunks[0]);
assert.deepEqual(request.configuration.filters, [{
  field: 'keywordType', values: ['BROAD','PHRASE','EXACT','TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED'],
}]);
const reqFp1 = await computeRequestFingerprint({ contract: sellerContract, storeId: 'store-dev-01', profileId: 'p1', chunk: chunks[0] });
const reqFp2 = await computeRequestFingerprint({ contract: sellerContract, storeId: 'store-dev-01', profileId: 'p1', chunk: chunks[0] });
const reqFpOther = await computeRequestFingerprint({ contract: sellerContract, storeId: 'store-dev-01', profileId: 'p2', chunk: chunks[0] });
assert.equal(reqFp1, reqFp2);
assert.notEqual(reqFp1, reqFpOther);
const acq1 = await computeReportAcquisitionIdentity({ workflowInstanceId: instanceA, requestFingerprint: reqFp1 });
const acq2 = await computeReportAcquisitionIdentity({ workflowInstanceId: instanceA, requestFingerprint: reqFp1 });
const acqOther = await computeReportAcquisitionIdentity({ workflowInstanceId: instanceOtherActor, requestFingerprint: reqFp1 });
assert.deepEqual(acq1, acq2);
assert.notEqual(acq1.jobId, acqOther.jobId);

assert.equal(canTransitionReportJob('queued', 'requested'), true);
assert.equal(canTransitionReportJob('requested', 'processing'), true);
assert.equal(canTransitionReportJob('ready', 'downloaded'), true);
assert.equal(canTransitionReportJob('ingested', 'downloaded'), false);
expectCode(() => assertReportTransition('queued', 'processing'), 'REPORT_JOB_STATUS_TRANSITION_INVALID');
assert.equal(amazonCreateDecision({ status: 'queued', amazon_report_id: null }), 'ARM_AND_CREATE_ONCE');
expectCode(() => amazonCreateDecision({ status: 'requested', amazon_report_id: null }), 'AMAZON_REPORT_CREATE_AMBIGUOUS');
assert.equal(amazonCreateDecision({ status: 'processing', amazon_report_id: 'r1' }), 'REUSE_AMAZON_REPORT');

assert.equal(canonicalProfileReceiptDecision({ status: 'queued', profile_id: null }, 'p1'), 'ASSIGN_PROFILE_AND_START');
assert.equal(canonicalProfileReceiptDecision({ status: 'running', profile_id: 'p1' }, 'p1'), 'REUSE_PROFILE_RECEIPT');
expectCode(() => canonicalProfileReceiptDecision({ status: 'running', profile_id: 'p2' }, 'p1'), 'CANONICAL_PROFILE_RECEIPT_CONFLICT');
expectCode(() => canonicalProfileReceiptDecision({ status: 'running', profile_id: null }, 'p1'), 'SYNC_RUNNING_PROFILE_RECEIPT_MISSING');
assert.equal(rawObjectDecision({ r2_object_key: 'raw/k', content_sha256: 'a'.repeat(64), content_bytes: 10 }), 'PUT_CREATE_ONLY');
assert.equal(rawObjectDecision({
  r2_object_key: 'raw/k', content_sha256: 'a'.repeat(64), content_bytes: 10,
  r2_initial_version: 'v1', r2_initial_etag: 'etag',
}), 'REUSE_INITIAL_R2_RECEIPT');
expectCode(() => rawObjectDecision({ r2_object_key: 'raw/k', content_sha256: 'a'.repeat(64), content_bytes: 10, r2_initial_version: 'v1' }), 'R2_INITIAL_RECEIPT_INCOMPLETE');

assert.deepEqual(classifySearchTermTargeting({ keywordType: 'BROAD', keywordId: 'k1' }), {
  sourceKeywordType: 'BROAD', targetingKind: 'keyword', keywordId: 'k1', targetId: null,
});
assert.deepEqual(classifySearchTermTargeting({ keywordType: 'TARGETING_EXPRESSION', keywordId: 't1' }), {
  sourceKeywordType: 'TARGETING_EXPRESSION', targetingKind: 'target', keywordId: null, targetId: 't1',
});
expectCode(() => classifySearchTermTargeting({ keywordType: 'UNKNOWN', keywordId: 'x' }), 'SOURCE_KEYWORD_TYPE_UNSUPPORTED');
const rowKey1 = await buildSearchTermRowKey({
  profileId: 'p1', reportDate: '2026-08-12', campaignId: 'c1', adGroupId: 'a1',
  targetingKind: 'keyword', keywordOrTargetId: 'k1', keywordType: 'BROAD', matchType: 'BROAD', searchTerm: 'Reading  Glasses',
});
const rowKey2 = await buildSearchTermRowKey({
  profileId: 'p1', reportDate: '2026-08-12', campaignId: 'c1', adGroupId: 'a1',
  targetingKind: 'keyword', keywordOrTargetId: 'k1', keywordType: 'BROAD', matchType: 'BROAD', searchTerm: 'reading glasses',
});
assert.notEqual(rowKey1, rowKey2, 'raw searchTerm must participate in row identity');

console.log(JSON.stringify({
  ok: true,
  syncIntent: true,
  profileResolution: true,
  reportContract: true,
  producerState: true,
  numericIntegrity: true,
  targetingIdentity: true,
  rowKeyRawSearchTerm: true,
}, null, 2));
