import assert from 'node:assert/strict';
import { buildRecommendationDecisionPacket, RECOMMENDATION_DECISION_PACKET_SCHEMA_VERSION } from '../cloudflare/runtime/recommendation-decision-packet.js';

const item = Object.freeze({
  inboxItemId: 'csv-inbox:negative_exact:exact:bad term',
  itemClass: 'recommendation_candidate',
  candidateType: 'waste_term',
  actionType: 'negative_exact',
  matchScope: 'exact',
  value: 'bad term',
  priority: 'high',
  priorityScore: 82,
  reason: 'Spend without attributed orders',
  impactedRoots: [{ root: 'bad', primaryState: 'toxic', states: ['toxic'], termCount: 2 }],
  lifecycleContext: [{ searchTerm: 'bad term', state: 'deteriorating', previousClassification: 'watchlist', currentClassification: 'waste' }],
  evidenceSummary: {
    spendMicros: 1200000,
    salesMicros: 0,
    orders: 0,
    clicks: 9,
    acos: null,
    cvr: 0,
    analysisWindow: { startDate: '2026-06-01', endDate: '2026-06-02' },
    sourceImportIds: ['import-1'],
    rootStates: ['toxic'],
    recommendationGoverned: true,
    provenanceGate: 'exact_source_object',
  },
});

const sourceSnapshot = {
  contract: 'csv-recommendation-human-review-v1',
  descriptor: {
    sourceKind: 'csv_recommendation_inbox_v1',
    inboxItemId: item.inboxItemId,
    candidateType: item.candidateType,
    actionType: item.actionType,
    matchScope: item.matchScope,
    value: item.value,
  },
  evidence: { spendMicros: '1200000', orders: '0', provenanceGate: 'exact_source_object' },
};
const binding = Object.freeze({
  sourceKind: 'csv_recommendation_inbox_v1',
  contextFingerprint: 'context-current',
  recommendationFingerprint: 'fingerprint-current',
  sourceEvidenceSha256: 'sha-current',
  sourceEvidenceJson: JSON.stringify(sourceSnapshot),
  analysisWindow: item.evidenceSummary.analysisWindow,
  sourceImportIds: ['import-1'],
});
const currentReview = Object.freeze({
  reviewId: 'review-current',
  recommendationFingerprint: 'fingerprint-current',
  state: 'needs_review',
  persisted: true,
  note: '  Current operator rationale  ',
  reviewedAt: '2026-08-20T00:00:00.000Z',
});
const staleReview = Object.freeze({
  reviewId: 'review-old',
  recommendationFingerprint: 'fingerprint-old',
  state: 'acknowledged',
  persisted: true,
  note: '  Prior operator rationale  ',
  sourceEvidenceSha256: 'sha-old',
  sourceEvidence: { descriptor: sourceSnapshot.descriptor, evidence: { spendMicros: '900000' } },
});

const packet = buildRecommendationDecisionPacket({
  item,
  binding,
  currentReview,
  staleReviews: [staleReview],
  analysisScope: {
    complete: true,
    financiallyComparable: true,
    candidateEmissionAuthorized: true,
    reasons: [],
  },
});

assert.equal(packet.schemaVersion, RECOMMENDATION_DECISION_PACKET_SCHEMA_VERSION);
assert.deepEqual(packet.authority, {
  sourceKind: 'csv_recommendation_inbox_v1',
  readOnly: true,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
  optimizationActionPersistenceAuthorized: false,
});
assert.equal(packet.recommendation.inboxItemId, item.inboxItemId);
assert.equal(packet.why.reason, item.reason);
assert.equal(packet.priorityEvidence.priority, 'high');
assert.equal(packet.priorityEvidence.acos, null);
assert.equal(packet.root.impactedRoots[0].primaryState, 'toxic');
assert.equal(packet.lifecycle.items[0].state, 'deteriorating');
assert.equal(packet.financialComparability.financiallyComparable, true);
assert.equal(packet.reviewEvidence.currentFingerprint, 'fingerprint-current');
assert.equal(packet.reviewEvidence.priorReviewState, 'needs_review');
assert.equal(packet.reviewEvidence.currentRationale, 'Current operator rationale');
assert.equal(packet.reviewEvidence.staleEvidenceCount, 1);
assert.equal(packet.reviewEvidence.staleEvidence[0].rationale, 'Prior operator rationale');
assert.equal(packet.reviewEvidence.staleEvidence[0].stale, true);
assert.equal(packet.reviewEvidence.staleEvidence[0].inheritedAsCurrent, false);
assert.equal(packet.sourceEvidence.sourceEvidenceJson, binding.sourceEvidenceJson);
assert.equal(packet.sourceEvidence.snapshot.descriptor.inboxItemId, item.inboxItemId);

const blankRationale = buildRecommendationDecisionPacket({
  item,
  binding,
  currentReview: { ...currentReview, note: '   ' },
  staleReviews: [{ ...staleReview, note: '\t  ' }],
  analysisScope: { complete: true, financiallyComparable: true, candidateEmissionAuthorized: true, reasons: [] },
});
assert.equal(blankRationale.reviewEvidence.currentRationale, null);
assert.equal(blankRationale.reviewEvidence.staleEvidence[0].rationale, null);

const unreviewed = buildRecommendationDecisionPacket({
  item,
  binding,
  currentReview: null,
  staleReviews: [staleReview],
  analysisScope: { complete: false, financiallyComparable: false, candidateEmissionAuthorized: false, reasons: ['scope_blocked'] },
});
assert.equal(unreviewed.reviewEvidence.priorReviewState, 'unreviewed');
assert.equal(unreviewed.reviewEvidence.currentRationale, null);
assert.equal(unreviewed.reviewEvidence.currentReview, null);
assert.equal(unreviewed.financialComparability.financiallyComparable, false);
assert.equal(unreviewed.financialComparability.analysisScopeComplete, false);
assert.deepEqual(unreviewed.financialComparability.reasons, ['scope_blocked']);

assert.throws(() => buildRecommendationDecisionPacket({
  item,
  binding,
  currentReview: { ...currentReview, recommendationFingerprint: 'wrong' },
}), /DECISION_PACKET_CURRENT_REVIEW_FINGERPRINT_MISMATCH/);

assert.throws(() => buildRecommendationDecisionPacket({
  item,
  binding,
  staleReviews: [{ ...staleReview, recommendationFingerprint: binding.recommendationFingerprint }],
}), /DECISION_PACKET_STALE_REVIEW_MATCHES_CURRENT/);

console.log('Recommendation Decision Packet v1 contract: PASS');
