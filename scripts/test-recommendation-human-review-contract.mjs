import assert from 'node:assert/strict';
import {
  buildRecommendationReviewBinding,
  compareRecommendationReviewBindings,
  evaluateRecommendationReviewRequest,
} from '../cloudflare/runtime/csv-recommendation-human-review-contract.js';

function inboxItem(overrides = {}) {
  return {
    inboxItemId: 'csv-inbox:negative_keyword:exact:bad term',
    itemClass: 'recommendation_candidate',
    candidateType: 'waste_term',
    actionType: 'negative_keyword',
    matchScope: 'exact',
    value: 'Bad   Term',
    priority: 'high',
    priorityScore: 84,
    reason: 'persistent spend without orders',
    evidenceSummary: {
      spendMicros: 12300000,
      salesMicros: 0,
      orders: 0,
      clicks: 44,
      acos: null,
      cvr: 0,
      analysisWindow: { startDate: '2026-06-01', endDate: '2026-06-30' },
      sourceImportIds: ['csv-import-a'],
      rootStates: ['toxic'],
      recommendationGoverned: true,
      provenanceGate: 'exact_source_object',
      identityConfidence: { state: 'observed_only', canonicalAmazonIdentityResolved: false },
    },
    review: { persistenceAuthorized: false },
    authority: {
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
    ...overrides,
  };
}

const item = inboxItem();
const bindingA = await buildRecommendationReviewBinding(item);
const bindingB = await buildRecommendationReviewBinding(inboxItem({ value: 'bad term' }));
assert.equal(bindingA.contextFingerprint, bindingB.contextFingerprint);
assert.equal(bindingA.recommendationFingerprint, bindingB.recommendationFingerprint);
assert.equal(bindingA.entityType, 'search_term');
assert.match(bindingA.recommendationFingerprint, /^[a-f0-9]{64}$/);
assert.match(bindingA.sourceEvidenceSha256, /^[a-f0-9]{64}$/);

const viewed = await evaluateRecommendationReviewRequest({
  inboxItem: item,
  requestedState: 'viewed',
  analysisScope: { candidateEmissionAuthorized: true },
});
assert.equal(viewed.stateClass, 'session');
assert.equal(viewed.persistenceAuthorized, false);
assert.ok(viewed.reasons.includes('session_presentation_state_only'));

const acknowledgedBlocked = await evaluateRecommendationReviewRequest({
  inboxItem: item,
  requestedState: 'acknowledged',
  analysisScope: { candidateEmissionAuthorized: true },
});
assert.equal(acknowledgedBlocked.schemaReusable, true);
assert.equal(acknowledgedBlocked.persistenceAuthorized, false);
assert.ok(acknowledgedBlocked.reasons.includes('review_persistence_not_authorized'));
assert.ok(acknowledgedBlocked.reasons.includes('governance_persistence_not_authorized'));
assert.equal(acknowledgedBlocked.execution.optimizationActionMutationAllowed, false);
assert.equal(acknowledgedBlocked.execution.executionAuthorized, false);
assert.equal(acknowledgedBlocked.execution.amazonMutationAuthorized, false);

const futureGovernedItem = inboxItem({
  review: { persistenceAuthorized: true },
  authority: {
    governancePersistenceAllowed: true,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
  },
});
const acknowledged = await evaluateRecommendationReviewRequest({
  inboxItem: futureGovernedItem,
  requestedState: 'acknowledged',
  analysisScope: { candidateEmissionAuthorized: true },
});
assert.equal(acknowledged.persistenceAuthorized, true);
assert.equal(acknowledged.advisoryReviewRecord.state, 'acknowledged');
assert.equal(acknowledged.execution.futurePromotionStatus, 'proposed');
assert.equal(acknowledged.execution.futurePromotionEnabled, false);

const needsReview = await evaluateRecommendationReviewRequest({
  inboxItem: futureGovernedItem,
  requestedState: 'needs_review',
  analysisScope: { candidateEmissionAuthorized: true },
});
assert.equal(needsReview.persistenceAuthorized, true);
assert.equal(needsReview.advisoryReviewRecord.state, 'open');

for (const state of ['approved', 'rejected']) {
  const result = await evaluateRecommendationReviewRequest({
    inboxItem: futureGovernedItem,
    requestedState: state,
    analysisScope: { candidateEmissionAuthorized: true },
  });
  assert.equal(result.persistenceAuthorized, true);
  assert.equal(result.schemaReusable, true);
  assert.equal(result.advisoryReviewRecord.state, state);
  assert.equal(result.execution.optimizationActionApprovalAllowed, false);
  assert.equal(result.execution.executionAuthorized, false);
  assert.equal(result.execution.amazonMutationAuthorized, false);
}

const suppressed = await evaluateRecommendationReviewRequest({
  inboxItem: futureGovernedItem,
  requestedState: 'acknowledged',
  analysisScope: { candidateEmissionAuthorized: false },
});
assert.equal(suppressed.persistenceAuthorized, false);
assert.ok(suppressed.reasons.includes('candidate_emission_not_authorized'));

const rootItem = inboxItem({
  inboxItemId: 'csv-inbox:negative_keyword:phrase_review:bad',
  matchScope: 'phrase_review',
  value: 'bad',
  review: { persistenceAuthorized: true },
  authority: {
    governancePersistenceAllowed: true,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
  },
});
const rootReview = await evaluateRecommendationReviewRequest({
  inboxItem: rootItem,
  requestedState: 'acknowledged',
  analysisScope: { candidateEmissionAuthorized: true },
});
assert.equal(rootReview.binding.entityType, 'root');
assert.equal(rootReview.persistenceAuthorized, false);
assert.ok(rootReview.reasons.includes('review_entity_type_schema_mapping_missing'));

const laterEvidence = await buildRecommendationReviewBinding(inboxItem({
  evidenceSummary: {
    ...item.evidenceSummary,
    analysisWindow: { startDate: '2026-07-01', endDate: '2026-07-31' },
    sourceImportIds: ['csv-import-b'],
  },
}));
const stale = compareRecommendationReviewBindings(bindingA, laterEvidence);
assert.equal(stale.sameContext, true);
assert.equal(stale.stale, true);

const sameScopeChangedMetrics = await buildRecommendationReviewBinding(inboxItem({
  evidenceSummary: {
    ...item.evidenceSummary,
    clicks: item.evidenceSummary.clicks + 1,
  },
}));
assert.equal(bindingA.contextFingerprint, sameScopeChangedMetrics.contextFingerprint);
assert.notEqual(bindingA.sourceEvidenceSha256, sameScopeChangedMetrics.sourceEvidenceSha256);
assert.notEqual(bindingA.recommendationFingerprint, sameScopeChangedMetrics.recommendationFingerprint);
const sameScopeStale = compareRecommendationReviewBindings(bindingA, sameScopeChangedMetrics);
assert.equal(sameScopeStale.sameContext, true);
assert.equal(sameScopeStale.stale, true);

const differentCandidate = await buildRecommendationReviewBinding(inboxItem({
  inboxItemId: 'csv-inbox:negative_keyword:exact:other term',
  value: 'other term',
}));
const unrelated = compareRecommendationReviewBindings(bindingA, differentCandidate);
assert.equal(unrelated.sameContext, false);
assert.equal(unrelated.stale, false);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-recommendation-human-review-v1',
  sessionStatesRemainNonPersistent: true,
  acknowledgedAndNeedsReviewReuseExistingAdvisorySchema: true,
  approvedRejectedReviewOnlyPersistence: true,
  rootCandidatePersistenceFailsClosed: true,
  staleEvidenceDetectedByStableContext: true,
  sameScopeEvidenceMutationChangesRecommendationFingerprint: true,
  optimizationActionApprovalSeparated: true,
  amazonMutationAuthorized: false,
}));
