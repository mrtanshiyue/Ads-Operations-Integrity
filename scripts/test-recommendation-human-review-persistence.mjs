import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  authorizeReviewCandidateForPersistence,
  effectiveReviewNote,
  parseReviewNoteRequest,
  persistedStateToUiState,
  reviewContextKeyFromEvidenceJson,
} from '../cloudflare/runtime/csv-recommendation-human-review-api.js';
import {
  buildRecommendationReviewBinding,
  evaluateRecommendationReviewRequest,
} from '../cloudflare/runtime/csv-recommendation-human-review-contract.js';

function item(overrides = {}) {
  return {
    inboxItemId: 'csv-inbox:negative_keyword:exact:bad term',
    itemClass: 'recommendation_candidate',
    candidateType: 'waste_term',
    actionType: 'negative_keyword',
    matchScope: 'exact',
    value: 'bad term',
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
      identityConfidence: { state: 'observed_csv_targeting_ids_resolved', canonicalAmazonIdentityResolved: false },
    },
    review: { state: 'unreviewed', persistenceAuthorized: false },
    authority: {
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
      canonicalAmazonIdentityResolved: false,
    },
    ...overrides,
  };
}

const scope = {
  complete: true,
  financiallyComparable: true,
  candidateEmissionAuthorized: true,
  overflowObserved: false,
  reasons: [],
};
const authorized = authorizeReviewCandidateForPersistence(item(), scope);
assert.equal(authorized.review.persistenceAuthorized, true);
assert.equal(authorized.authority.governancePersistenceAllowed, true);
assert.equal(authorized.authority.executionAuthorized, false);
assert.equal(authorized.authority.amazonMutationAuthorized, false);

const acknowledged = await evaluateRecommendationReviewRequest({
  inboxItem: authorized,
  requestedState: 'acknowledged',
  analysisScope: scope,
});
assert.equal(acknowledged.persistenceAuthorized, true);
assert.equal(acknowledged.advisoryReviewRecord.state, 'acknowledged');
assert.equal(acknowledged.execution.optimizationActionMutationAllowed, false);
assert.equal(acknowledged.execution.executionAuthorized, false);
assert.equal(acknowledged.execution.amazonMutationAuthorized, false);

const needsReview = await evaluateRecommendationReviewRequest({
  inboxItem: authorized,
  requestedState: 'needs_review',
  analysisScope: scope,
});
assert.equal(needsReview.persistenceAuthorized, true);
assert.equal(needsReview.advisoryReviewRecord.state, 'open');

const blockedByScope = authorizeReviewCandidateForPersistence(item(), {
  ...scope,
  candidateEmissionAuthorized: false,
});
assert.notEqual(blockedByScope.review.persistenceAuthorized, true);

const root = authorizeReviewCandidateForPersistence(item({ matchScope: 'phrase_review' }), scope);
assert.notEqual(root.review.persistenceAuthorized, true);

const ungoverned = authorizeReviewCandidateForPersistence(item({
  evidenceSummary: { ...item().evidenceSummary, recommendationGoverned: false },
}), scope);
assert.notEqual(ungoverned.review.persistenceAuthorized, true);

for (const state of ['approved', 'rejected']) {
  const result = await evaluateRecommendationReviewRequest({
    inboxItem: authorized,
    requestedState: state,
    analysisScope: scope,
  });
  assert.equal(result.persistenceAuthorized, true);
  assert.equal(result.advisoryReviewRecord.state, state);
  assert.equal(result.execution.optimizationActionApprovalAllowed, false);
  assert.equal(result.execution.executionAuthorized, false);
  assert.equal(result.execution.amazonMutationAuthorized, false);
}
assert.equal(persistedStateToUiState('acknowledged'), 'acknowledged');
assert.equal(persistedStateToUiState('open'), 'needs_review');
assert.equal(persistedStateToUiState('approved'), 'approved');
assert.equal(persistedStateToUiState('rejected'), 'rejected');
assert.equal(persistedStateToUiState('dismissed'), 'rejected');
assert.equal(persistedStateToUiState('snoozed'), null);

const omittedNote = parseReviewNoteRequest({ inboxItemId: 'item', state: 'approved' });
assert.deepEqual(omittedNote, { provided: false, value: null });
assert.equal(effectiveReviewNote(omittedNote, 'Existing rationale'), 'Existing rationale');
assert.equal(effectiveReviewNote(omittedNote, null), null);

const explicitNote = parseReviewNoteRequest({ note: '  Keep this rationale  ' });
assert.deepEqual(explicitNote, { provided: true, value: 'Keep this rationale' });
assert.equal(effectiveReviewNote(explicitNote, 'Old rationale'), 'Keep this rationale');

const explicitBlank = parseReviewNoteRequest({ note: '   ' });
assert.deepEqual(explicitBlank, { provided: true, value: null });
assert.equal(effectiveReviewNote(explicitBlank, 'Existing rationale'), null);
const explicitNull = parseReviewNoteRequest({ note: null });
assert.deepEqual(explicitNull, { provided: true, value: null });
assert.equal(effectiveReviewNote(explicitNull, 'Existing rationale'), null);
assert.equal(parseReviewNoteRequest({ note: 'x'.repeat(4001) }).error, 'review_note_too_long');

const binding = await buildRecommendationReviewBinding(authorized);
const contextKey = reviewContextKeyFromEvidenceJson(binding.sourceEvidenceJson);
assert.ok(contextKey);
const changedEvidence = authorizeReviewCandidateForPersistence(item({
  evidenceSummary: { ...item().evidenceSummary, clicks: 45 },
}), scope);
const changedBinding = await buildRecommendationReviewBinding(changedEvidence);
assert.equal(reviewContextKeyFromEvidenceJson(changedBinding.sourceEvidenceJson), contextKey);
assert.notEqual(changedBinding.recommendationFingerprint, binding.recommendationFingerprint);
assert.notEqual(changedBinding.sourceEvidenceSha256, binding.sourceEvidenceSha256);

const apiSource = readFileSync(new URL('../cloudflare/runtime/csv-recommendation-human-review-api.js', import.meta.url), 'utf8');
const wrapperSource = readFileSync(new URL('../cloudflare/runtime/csv-productization-api.js', import.meta.url), 'utf8');
assert.ok(apiSource.includes('advisory_review_records'));
assert.ok(apiSource.includes('recommendation_review.persisted'));
assert.ok(apiSource.includes('review_candidate_not_currently_emitted'));
assert.ok(apiSource.includes('authenticated_actor_required'));
assert.ok(apiSource.includes('requestedState'));
assert.ok(apiSource.includes('source_evidence_sha256'));
assert.ok(apiSource.includes('effectiveReviewNote(noteRequest, existing.reviewer_note)'));
assert.ok(apiSource.includes('effectiveReviewNote(noteRequest, raced.reviewer_note)'));
assert.ok(!apiSource.includes('optimization_actions'));
assert.ok(!apiSource.includes('optimization_execution_permits'));
assert.ok(!apiSource.includes('amazon-ads'));
assert.ok(wrapperSource.includes('handleCsvRecommendationHumanReviewPersistenceRoute'));

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-recommendation-human-review-persistence-v1',
  existingAdvisoryReviewTableReused: true,
  migrationRequired: true,
  acknowledgedMapped: true,
  needsReviewMappedToOpen: true,
  rootPersistenceFailsClosed: true,
  approvedRejectedReviewOnlyPersistence: true,
  omittedNotePreservesExistingRationale: true,
  explicitBlankOrNullClearsRationale: true,
  explicitNoteIsTrimmed: true,
  evidenceMutationChangesFingerprint: true,
  idempotencyKey: 'source_kind+recommendation_fingerprint',
  optimizationActionMutationAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}));
