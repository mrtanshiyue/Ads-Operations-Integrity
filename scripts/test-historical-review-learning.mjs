import assert from 'node:assert/strict';
import {
  HISTORICAL_REVIEW_LEARNING_SCHEMA_VERSION,
  buildHistoricalReviewLearning,
} from '../cloudflare/runtime/historical-review-learning.js';

function currentItem({ inboxItemId, fingerprint, state = 'unreviewed', persisted = false, actionType = 'negative_keyword.review_exact', value = 'waste term' }) {
  return {
    inboxItemId,
    recommendationFingerprint: fingerprint,
    review: { state, persisted },
    decisionPacket: {
      schemaVersion: 'recommendation-decision-packet-v1',
      authority: { readOnly: true, executionAuthorized: false, amazonMutationAuthorized: false },
      recommendation: {
        inboxItemId,
        actionType,
        candidateType: actionType.startsWith('keyword.') ? 'Harvest Candidate' : 'Exact Negative Candidate',
        matchScope: 'exact',
        value,
      },
      reviewEvidence: { currentFingerprint: fingerprint },
    },
  };
}

function historicalReview({ id, fingerprint, state, updatedAt, note = null, inboxItemId = 'item-1', actionType = 'negative_keyword.review_exact', value = 'waste term' }) {
  return {
    reviewId: id,
    recommendationFingerprint: fingerprint,
    state,
    persisted: true,
    note,
    reviewedAt: updatedAt,
    updatedAt,
    sourceEvidenceSha256: `sha-${fingerprint}`,
    sourceEvidence: {
      descriptor: {
        sourceKind: 'csv_recommendation_inbox_v1',
        inboxItemId,
        candidateType: actionType.startsWith('keyword.') ? 'Harvest Candidate' : 'Exact Negative Candidate',
        actionType,
        matchScope: 'exact',
        value,
      },
    },
  };
}

const learning = buildHistoricalReviewLearning({
  storeId: 'STORE01',
  currentEntries: [
    { contextKey: 'context-1', item: currentItem({ inboxItemId: 'item-1', fingerprint: 'fp-current', state: 'needs_review', persisted: true }) },
    { contextKey: 'context-2', item: currentItem({ inboxItemId: 'item-2', fingerprint: 'fp-new', actionType: 'keyword.review_harvest', value: 'good term' }) },
  ],
  historicalEntries: [
    { contextKey: 'context-1', review: historicalReview({ id: 'r3', fingerprint: 'fp-current', state: 'open', note: '  Prior operator rationale: keep under review.  ', updatedAt: '2026-06-03T00:00:00.000Z' }) },
    { contextKey: 'context-1', review: historicalReview({ id: 'r2', fingerprint: 'fp-old', state: 'acknowledged', note: 'Older rationale must not replace the latest review rationale.', updatedAt: '2026-06-02T00:00:00.000Z' }) },
    { contextKey: 'context-1', review: historicalReview({ id: 'r1', fingerprint: 'fp-older', state: 'acknowledged', updatedAt: '2026-06-01T00:00:00.000Z' }) },
    { contextKey: 'context-old', review: historicalReview({ id: 'old-1', fingerprint: 'fp-historical-only', state: 'open', note: '   ', updatedAt: '2026-05-01T00:00:00.000Z', inboxItemId: 'old-item', value: 'old waste term' }) },
    { contextKey: null, review: { recommendationFingerprint: 'unusable', state: 'acknowledged' } },
  ],
});

assert.equal(learning.schemaVersion, HISTORICAL_REVIEW_LEARNING_SCHEMA_VERSION);
assert.deepEqual(learning.authority, {
  readOnly: true,
  adaptiveLearningAuthorized: false,
  ruleMutationAuthorized: false,
  recommendationMutationAuthorized: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});
assert.deepEqual(learning.semantics, {
  recurrenceIsEffectiveness: false,
  acknowledgedMeansApproved: false,
  acknowledgedMeansExecuted: false,
  needsReviewMeansRejected: false,
  approvedMeansExecuted: false,
  approvedMeansSuccessful: false,
  rejectedMeansFailed: false,
  finalDispositionIsEffectiveness: false,
  historicalOutcomeAvailable: false,
  automaticFeedbackIntoRecommendations: false,
});
assert.equal(learning.summary.historicalRecordCount, 5);
assert.equal(learning.summary.usableHistoricalRecordCount, 4);
assert.equal(learning.summary.unusableHistoricalRecordCount, 1);
assert.equal(learning.summary.historicalContextCount, 2);
assert.equal(learning.summary.currentContextCount, 2);
assert.equal(learning.summary.recurrentContextCount, 1);
assert.equal(learning.summary.currentMatchedRecordCount, 1);
assert.equal(learning.summary.staleEvidenceRecordCount, 2);
assert.equal(learning.summary.historicalOnlyContextCount, 1);
assert.deepEqual(learning.summary.stateCounts, { acknowledged: 3, needs_review: 2, approved: 0, rejected: 0, unsupported: 0 });

const current = learning.contexts.find((context) => context.contextKey === 'context-1');
assert.ok(current);
assert.equal(current.currentCandidateActive, true);
assert.equal(current.currentFingerprint, 'fp-current');
assert.equal(current.currentReviewState, 'needs_review');
assert.equal(current.historicalRecordCount, 3);
assert.equal(current.distinctFingerprintCount, 3);
assert.equal(current.currentMatchedRecordCount, 1);
assert.equal(current.staleEvidenceCount, 2);
assert.equal(current.acknowledgedCount, 2);
assert.equal(current.needsReviewCount, 1);
assert.equal(current.approvedCount, 0);
assert.equal(current.rejectedCount, 0);
assert.equal(current.recurrent, true);
assert.equal(current.currentEvidenceDrift, true);
assert.equal(current.latestHistoricalReview.recommendationFingerprint, 'fp-current');
assert.equal(Object.hasOwn(current.latestHistoricalReview, 'note'), true);
assert.equal(current.latestHistoricalReview.note, 'Prior operator rationale: keep under review.');

const historicalOnly = learning.contexts.find((context) => context.contextKey === 'context-old');
assert.ok(historicalOnly);
assert.equal(historicalOnly.currentCandidateActive, false);
assert.equal(historicalOnly.currentFingerprint, null);
assert.equal(historicalOnly.currentReviewState, null);
assert.equal(historicalOnly.staleEvidenceCount, null);
assert.equal(historicalOnly.currentEvidenceDrift, null);
assert.equal(historicalOnly.value, 'old waste term');
assert.equal(Object.hasOwn(historicalOnly.latestHistoricalReview, 'note'), true);
assert.equal(historicalOnly.latestHistoricalReview.note, null);

const neverReviewedCurrent = learning.contexts.find((context) => context.contextKey === 'context-2');
assert.ok(neverReviewedCurrent);
assert.equal(neverReviewedCurrent.currentCandidateActive, true);
assert.equal(neverReviewedCurrent.historicalRecordCount, 0);
assert.equal(neverReviewedCurrent.recurrent, false);
assert.equal(neverReviewedCurrent.staleEvidenceCount, 0);
assert.equal(neverReviewedCurrent.latestHistoricalReview, null);

const dispositionLearning = buildHistoricalReviewLearning({
  storeId: 'STORE01',
  historicalEntries: [
    { contextKey: 'd1', review: historicalReview({ id: 'approved-1', fingerprint: 'approved-fp', state: 'approved', updatedAt: '2026-07-01T00:00:00.000Z' }) },
    { contextKey: 'd2', review: historicalReview({ id: 'rejected-1', fingerprint: 'rejected-fp', state: 'rejected', updatedAt: '2026-07-02T00:00:00.000Z' }) },
    { contextKey: 'd3', review: historicalReview({ id: 'dismissed-1', fingerprint: 'dismissed-fp', state: 'dismissed', updatedAt: '2026-07-03T00:00:00.000Z' }) },
    { contextKey: 'd4', review: historicalReview({ id: 'snoozed-1', fingerprint: 'snoozed-fp', state: 'snoozed', updatedAt: '2026-07-04T00:00:00.000Z' }) },
  ],
});
assert.deepEqual(dispositionLearning.summary.stateCounts, { acknowledged: 0, needs_review: 0, approved: 1, rejected: 2, unsupported: 1 });
assert.equal(dispositionLearning.semantics.approvedMeansExecuted, false);
assert.equal(dispositionLearning.semantics.approvedMeansSuccessful, false);
assert.equal(dispositionLearning.semantics.rejectedMeansFailed, false);
assert.equal(dispositionLearning.semantics.finalDispositionIsEffectiveness, false);

assert.throws(() => buildHistoricalReviewLearning({
  currentEntries: [
    { contextKey: 'dup', item: currentItem({ inboxItemId: 'a', fingerprint: 'a' }) },
    { contextKey: 'dup', item: currentItem({ inboxItemId: 'b', fingerprint: 'b' }) },
  ],
}), /HISTORICAL_LEARNING_CURRENT_CONTEXT_DUPLICATE/);

console.log(JSON.stringify({
  ok: true,
  contract: HISTORICAL_REVIEW_LEARNING_SCHEMA_VERSION,
  historicalRecordCount: learning.summary.historicalRecordCount,
  recurrentContextCount: learning.summary.recurrentContextCount,
  staleEvidenceRecordCount: learning.summary.staleEvidenceRecordCount,
  historicalOnlyContextCount: learning.summary.historicalOnlyContextCount,
  latestHistoricalReviewNoteProjected: current.latestHistoricalReview.note,
  blankHistoricalReviewNoteNormalized: historicalOnly.latestHistoricalReview.note,
  adaptiveLearningAuthorized: learning.authority.adaptiveLearningAuthorized,
  executionAuthorized: learning.authority.executionAuthorized,
  amazonMutationAuthorized: learning.authority.amazonMutationAuthorized,
}));
