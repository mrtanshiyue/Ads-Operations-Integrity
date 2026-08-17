import assert from 'node:assert/strict';
import {
  AMAZON_UNIFIED_TARGET_CONTRACT_SOURCE,
  AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
  buildAmazonMutationRequest,
  buildExecutionPlan,
  classifyMutationTransportOutcome,
  validatePermitBinding,
} from '../cloudflare/runtime/amazon-action-execution-safety.js';

const requestFingerprint = '2'.repeat(64);
const baseAction = {
  action_id: 'act-unified-negative-01',
  profile_id: 'profile-real-01',
  entity_type: 'search_term',
  entity_id: 'row-real-01',
  action_type: 'negative_keyword.create',
  status: 'approved',
  proposed_json: JSON.stringify({
    scope: 'ad_group',
    campaignId: 'campaign-01',
    adGroupId: 'adgroup-01',
    keywordText: 'free reading glasses',
    matchType: 'EXACT',
    executionDestinationContract: 'search-term-ad-group-v1',
    amazonMutationContract: AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
  }),
  rationale_json: JSON.stringify({ governance: { requestFingerprint } }),
  external_request_id: null,
  applied_at: null,
};

assert.equal(AMAZON_UNIFIED_TARGET_CONTRACT_SOURCE.repository, 'amzn/ads-advanced-tools-docs');
assert.equal(AMAZON_UNIFIED_TARGET_CONTRACT_SOURCE.collectionPath, 'postman/Amazon_Ads_Unified_API.postman_collection.json');

const plan = await buildExecutionPlan({ storeId: 'store-01', action: baseAction });
assert.equal(plan.valid, true);
assert.equal(plan.dryRunReady, true);
assert.equal(plan.mutation.endpointMappingVerified, true);
assert.equal(plan.mutation.method, 'POST');
assert.equal(plan.mutation.endpointPath, '/adsApi/v1/create/targets');
assert.equal(plan.mutation.frozenContract, AMAZON_UNIFIED_TARGET_CONTRACT_VERSION);
assert.equal(plan.permitIssuanceReady, true);
assert.equal(plan.networkDispatchAuthorized, false);

const mutation = buildAmazonMutationRequest(plan);
assert.equal(mutation.ready, true);
assert.equal(mutation.method, 'POST');
assert.equal(mutation.endpointPath, '/adsApi/v1/create/targets');
assert.deepEqual(mutation.requiredHeaderNames, [
  'Authorization',
  'Amazon-Ads-AccountId',
  'Amazon-Ads-ClientId',
  'Amazon-Advertising-API-Scope',
  'Content-Type',
  'Accept',
]);
assert.deepEqual(mutation.body, {
  targets: [{
    adGroupId: 'adgroup-01',
    adProduct: 'SPONSORED_PRODUCTS',
    negative: true,
    state: 'ENABLED',
    targetDetails: {
      keywordTarget: {
        keyword: 'free reading glasses',
        matchType: 'EXACT',
      },
    },
    targetType: 'KEYWORD',
  }],
});
assert.equal(mutation.expectedResponse.httpStatus, 207);
assert.equal(mutation.expectedResponse.singleEntityIndex, 0);
assert.equal(mutation.networkDispatchAuthorized, false);

const legacyPlan = await buildExecutionPlan({
  storeId: 'store-01',
  action: {
    ...baseAction,
    action_id: 'act-before-unified-contract',
    proposed_json: JSON.stringify({
      scope: 'ad_group',
      campaignId: 'campaign-01',
      adGroupId: 'adgroup-01',
      keywordText: 'free reading glasses',
      matchType: 'EXACT',
    }),
  },
});
assert.equal(legacyPlan.valid, true);
assert.equal(legacyPlan.mutation.endpointMappingVerified, false);
assert.equal(legacyPlan.mutation.blockingReason, 'amazon_mutation_contract_not_frozen');
assert.equal(legacyPlan.permitIssuanceReady, false);
assert.equal(legacyPlan.networkDispatchAuthorized, false);

const positiveKeywordPlan = await buildExecutionPlan({
  storeId: 'store-01',
  action: {
    ...baseAction,
    action_id: 'act-positive-still-blocked',
    action_type: 'keyword.create',
    proposed_json: JSON.stringify({
      scope: 'ad_group',
      campaignId: 'campaign-01',
      adGroupId: 'adgroup-01',
      keywordText: 'reading glasses',
      matchType: 'EXACT',
      bidMicros: 1500000,
      amazonMutationContract: AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
    }),
  },
});
assert.equal(positiveKeywordPlan.valid, true);
assert.equal(positiveKeywordPlan.mutation.endpointMappingVerified, false);
assert.equal(positiveKeywordPlan.mutation.blockingReason, 'positive_keyword_bid_mapping_unverified');
assert.equal(positiveKeywordPlan.permitIssuanceReady, false);

const permitCheck = validatePermitBinding({
  permit: {
    state: 'issued',
    transition: 'apply',
    actionId: plan.action.actionId,
    profileId: plan.action.profileId,
    entityId: plan.action.entityId,
    actionType: plan.action.actionType,
    requestFingerprint: plan.requestFingerprint,
    targetFingerprint: plan.targetFingerprint,
    executionFingerprint: plan.executionFingerprint,
    expiresAt: '2026-08-17T18:00:00Z',
  },
  plan,
  now: new Date('2026-08-17T16:30:00Z'),
});
assert.equal(permitCheck.valid, true);
assert.equal(permitCheck.singleUse, true);
assert.equal(permitCheck.networkDispatchAuthorized, false);

const success207 = classifyMutationTransportOutcome({
  dispatched: true,
  httpStatus: 207,
  amazonRequestId: 'request-success',
  responseBody: {
    error: [],
    partialSuccess: [],
    success: [{ index: 0, target: { targetId: 'target-01' } }],
  },
});
assert.equal(success207.transportOutcome, 'accepted');
assert.equal(success207.retryDisposition, 'readback_required');
assert.equal(success207.readbackRequired, true);

const error207 = classifyMutationTransportOutcome({
  dispatched: true,
  httpStatus: 207,
  responseBody: {
    error: [{ index: 0, errors: [{ code: 'FIELD_VALUE_IS_INVALID' }] }],
    partialSuccess: [],
    success: [],
  },
});
assert.equal(error207.transportOutcome, 'rejected');
assert.equal(error207.retryDisposition, 'not_retryable');
assert.equal(error207.readbackRequired, false);

const partial207 = classifyMutationTransportOutcome({
  dispatched: true,
  httpStatus: 207,
  responseBody: {
    error: [],
    partialSuccess: [{ index: 0 }],
    success: [],
  },
});
assert.equal(partial207.transportOutcome, 'unknown');
assert.equal(partial207.retryDisposition, 'readback_required');
assert.equal(partial207.readbackRequired, true);

const malformed207 = classifyMutationTransportOutcome({
  dispatched: true,
  httpStatus: 207,
  responseBody: 'not-json',
});
assert.equal(malformed207.transportOutcome, 'unknown');
assert.equal(malformed207.retryDisposition, 'readback_required');

console.log(JSON.stringify({
  ok: true,
  contract: 'amazon-unified-negative-target-v1',
  officialSource: AMAZON_UNIFIED_TARGET_CONTRACT_SOURCE.repository,
  endpoint: '/adsApi/v1/create/targets',
  actionType: 'negative_keyword.create',
  targetType: 'KEYWORD',
  adProduct: 'SPONSORED_PRODUCTS',
  negative: true,
  matchTypes: ['EXACT', 'PHRASE'],
  http207BusinessOutcomeParsed: true,
  legacyActionsAutoUpgraded: false,
  positiveKeywordBidMapping: 'blocked',
  permitBindingReady: true,
  networkDispatch: 'disabled',
}, null, 2));
