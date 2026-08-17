import assert from 'node:assert/strict';
import {
  AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
  buildExecutionPlan,
} from '../cloudflare/runtime/amazon-action-execution-safety.js';
import {
  buildDormantNegativeKeywordMutationEnvelope,
  buildDormantTransportReceiptEvidence,
} from '../cloudflare/runtime/amazon-negative-keyword-mutation-adapter.js';
import {
  buildNegativeKeywordTargetReadbackRequest,
  verifyNegativeKeywordTargetReadback,
} from '../cloudflare/runtime/amazon-execution-reconciliation.js';
import {
  canFinalizeConfirmedAmazonMutation,
  determineAmazonExecutionReconciliation,
} from '../cloudflare/runtime/amazon-execution-finalization.js';

const plan = await buildExecutionPlan({
  storeId: 'store-test-01',
  action: {
    action_id: 'act_phase11_reconciliation',
    profile_id: 'profile-test-01',
    entity_type: 'search_term',
    entity_id: 'search-term-row-01',
    action_type: 'negative_keyword.create',
    status: 'approved',
    proposed_json: JSON.stringify({
      keywordText: 'blue light reading glasses',
      matchType: 'EXACT',
      scope: 'ad_group',
      campaignId: 'campaign-01',
      adGroupId: 'ad-group-01',
      executionDestinationContract: 'search-term-ad-group-v1',
      amazonMutationContract: AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
    }),
    rationale_json: JSON.stringify({ governance: { requestFingerprint: 'a'.repeat(64) } }),
  },
});
assert.equal(plan.valid, true);
assert.equal(plan.permitIssuanceReady, true);
assert.equal(plan.networkDispatchAuthorized, false);

const mutationEnvelope = await buildDormantNegativeKeywordMutationEnvelope(plan);
assert.equal(mutationEnvelope.ready, true);
assert.equal(mutationEnvelope.requestBodySha256.length, 64);

const readbackRequest = buildNegativeKeywordTargetReadbackRequest(plan);
assert.equal(readbackRequest.ready, true);
assert.equal(readbackRequest.method, 'POST');
assert.equal(readbackRequest.endpointPath, '/adsApi/v1/query/targets');
assert.deepEqual(readbackRequest.body.stateFilter, { include: ['ENABLED', 'PAUSED'] });
assert.deepEqual(readbackRequest.body.adProductFilter, { include: ['SPONSORED_PRODUCTS'] });
assert.deepEqual(readbackRequest.body.negativeFilter, { include: [true] });
assert.deepEqual(readbackRequest.body.targetTypeFilter, { include: ['KEYWORD'] });
assert.equal(readbackRequest.body.maxResults, 1000);
assert.equal(Object.hasOwn(readbackRequest.body, 'targetIds'), false);
assert.equal(readbackRequest.networkDispatchAuthorized, false);

const exactTarget = {
  targetId: 'target-amazon-01',
  campaignId: 'campaign-01',
  adGroupId: 'ad-group-01',
  adProduct: 'SPONSORED_PRODUCTS',
  negative: true,
  state: 'ENABLED',
  targetType: 'KEYWORD',
  targetDetails: { keywordTarget: { keyword: 'blue light reading glasses', matchType: 'EXACT' } },
};
const confirmed = await verifyNegativeKeywordTargetReadback({
  plan,
  responseBody: JSON.stringify({ targets: [exactTarget] }),
  observedAt: '2026-08-17T09:30:00.000Z',
});
assert.equal(confirmed.result, 'confirmed');
assert.equal(confirmed.targetId, 'target-amazon-01');
assert.equal(confirmed.expectedFingerprint, plan.targetFingerprint);
assert.equal(confirmed.observedFingerprint, plan.targetFingerprint);
assert.equal(confirmed.networkDispatchAuthorized, false);

const notFound = await verifyNegativeKeywordTargetReadback({ plan, responseBody: JSON.stringify({ targets: [] }) });
assert.equal(notFound.result, 'not_found');
assert.ok(notFound.errors.includes('exact_target_not_found'));

const ambiguous = await verifyNegativeKeywordTargetReadback({ plan, responseBody: JSON.stringify({ targets: [exactTarget, { ...exactTarget, targetId: 'target-amazon-02' }] }) });
assert.equal(ambiguous.result, 'unknown');
assert.ok(ambiguous.errors.includes('ambiguous_exact_target_match'));

const paginated = await verifyNegativeKeywordTargetReadback({ plan, responseBody: JSON.stringify({ targets: [exactTarget], nextToken: 'opaque-token' }) });
assert.equal(paginated.result, 'unknown');
assert.ok(paginated.errors.includes('target_query_result_may_be_truncated'));

const capped = await verifyNegativeKeywordTargetReadback({
  plan,
  responseBody: { targets: Array.from({ length: 1000 }, (_, index) => ({ ...exactTarget, targetId: `target-${index}` })) },
});
assert.equal(capped.result, 'unknown');
assert.ok(capped.errors.includes('target_query_result_may_be_truncated'));

const paused = await verifyNegativeKeywordTargetReadback({ plan, responseBody: { targets: [{ ...exactTarget, state: 'PAUSED' }] } });
assert.equal(paused.result, 'mismatch');
assert.ok(paused.errors.includes('state_mismatch'));

const transport = await buildDormantTransportReceiptEvidence({
  dispatched: true,
  httpStatus: 207,
  amazonRequestId: 'amazon-request-01',
  responseBody: JSON.stringify({ error: [], partialSuccess: [], success: [{ index: 0, targetId: 'target-amazon-01' }] }),
});
assert.equal(transport.dispatched, true);
assert.equal(transport.httpStatus, 207);
assert.equal(transport.amazonRequestId, 'amazon-request-01');
assert.equal(transport.transportOutcome, 'accepted');
assert.equal(transport.retryDisposition, 'readback_required');
assert.equal(transport.responseBodySha256.length, 64);
assert.equal(transport.networkDispatchAuthorized, false);

const receipt = {
  actionId: plan.action.actionId,
  executionFingerprint: plan.executionFingerprint,
  transportOutcome: transport.transportOutcome,
  retryDisposition: transport.retryDisposition,
  amazonRequestId: transport.amazonRequestId,
};
const finalizationGate = canFinalizeConfirmedAmazonMutation({ receipt, verification: confirmed, plan });
assert.equal(finalizationGate.allowed, true);
assert.equal(finalizationGate.blindRetryAuthorized, false);
assert.equal(finalizationGate.networkDispatchAuthorized, false);

const applied = determineAmazonExecutionReconciliation({ receipt, verification: confirmed, plan });
assert.equal(applied.disposition, 'confirmed_applied');
assert.equal(applied.actionStatus, 'applied');
assert.equal(applied.blindRetryAuthorized, false);

const unresolved = determineAmazonExecutionReconciliation({
  receipt: { ...receipt, transportOutcome: 'unknown', retryDisposition: 'readback_required' },
  verification: notFound,
  plan,
});
assert.equal(unresolved.disposition, 'readback_unresolved');
assert.equal(unresolved.actionStatus, 'applying');
assert.equal(unresolved.blindRetryAuthorized, false);

const mismatch = determineAmazonExecutionReconciliation({ receipt, verification: paused, plan });
assert.equal(mismatch.disposition, 'failed_terminal');
assert.equal(mismatch.actionStatus, 'failed');

const badExecutionFingerprint = determineAmazonExecutionReconciliation({
  receipt: { ...receipt, executionFingerprint: 'b'.repeat(64) },
  verification: confirmed,
  plan,
});
assert.equal(badExecutionFingerprint.disposition, 'readback_unresolved');
assert.equal(badExecutionFingerprint.actionStatus, 'applying');

const rejected = determineAmazonExecutionReconciliation({
  receipt: { ...receipt, transportOutcome: 'rejected', retryDisposition: 'not_retryable' },
  verification: null,
  plan,
});
assert.equal(rejected.disposition, 'failed_terminal');
assert.equal(rejected.actionStatus, 'failed');

console.log(JSON.stringify({
  ok: true,
  contract: 'phase11-execution-reconciliation-v1',
  officialUnifiedTargetReadbackRequest: true,
  guessedTargetIdQueryFilter: false,
  uniqueExactTargetCorrelation: true,
  resultCapFailsClosed: true,
  immutableTransportEvidenceFields: true,
  targetFingerprintVerification: true,
  confirmedOnlyFinalization: true,
  unknownOutcomeNoBlindRetry: true,
  networkDispatchAuthorized: false,
}, null, 2));
