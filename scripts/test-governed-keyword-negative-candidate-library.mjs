import assert from 'node:assert/strict';
import {
  GOVERNED_KEYWORD_NEGATIVE_CANDIDATE_LIBRARY_SCHEMA_VERSION,
  buildGovernedKeywordNegativeCandidateLibrary,
} from '../cloudflare/runtime/governed-keyword-negative-candidate-library.js';

const baseBinding = Object.freeze({
  recommendationFingerprint: 'fp-current',
  analysisWindow: Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-30' }),
  sourceImportIds: Object.freeze(['import-b', 'import-a']),
  sourceEvidenceSha256: 'sha-current',
});

const library = buildGovernedKeywordNegativeCandidateLibrary({
  storeId: 'STORE01',
  analysisScope: {
    complete: true,
    financiallyComparable: true,
    candidateEmissionAuthorized: true,
    overflowObserved: false,
    reasons: [],
  },
  entries: [
    {
      item: {
        itemClass: 'recommendation_candidate',
        inboxItemId: 'csv-inbox:keyword.review_scale:operator_review:scale term',
        candidateType: 'Scale Candidate',
        actionType: 'keyword.review_scale',
        matchScope: 'operator_review',
        value: 'scale term',
        priority: 'high',
        priorityScore: 82,
      },
      binding: { ...baseBinding, recommendationFingerprint: 'fp-scale' },
      currentReview: null,
      staleReviews: [],
      financiallyComparable: true,
      decisionPacket: { schemaVersion: 'recommendation-decision-packet-v1' },
    },
    {
      item: {
        itemClass: 'recommendation_candidate',
        inboxItemId: 'csv-inbox:negative_keyword.review_exact:exact:waste term',
        candidateType: 'Exact Negative Candidate',
        actionType: 'negative_keyword.review_exact',
        matchScope: 'exact',
        value: 'waste term',
        priority: 'critical',
        priorityScore: 95,
      },
      binding: baseBinding,
      currentReview: {
        recommendationFingerprint: 'fp-current',
        state: 'needs_review',
        persisted: true,
      },
      staleReviews: [
        { recommendationFingerprint: 'fp-old-1', state: 'acknowledged' },
        { recommendationFingerprint: 'fp-old-2', state: 'needs_review' },
      ],
      financiallyComparable: true,
      decisionPacket: { schemaVersion: 'recommendation-decision-packet-v1' },
    },
    {
      item: {
        itemClass: 'recommendation_candidate',
        inboxItemId: 'csv-inbox:keyword.review_harvest:exact_review:good term',
        candidateType: 'Harvest Candidate',
        actionType: 'keyword.review_harvest',
        matchScope: 'exact_review',
        value: 'good term',
        priority: 'medium',
        priorityScore: 60,
      },
      binding: { ...baseBinding, recommendationFingerprint: 'fp-harvest' },
      currentReview: { recommendationFingerprint: 'fp-harvest', state: 'acknowledged', persisted: true },
      staleReviews: [],
      financiallyComparable: false,
      decisionPacket: { schemaVersion: 'recommendation-decision-packet-v1' },
    },
  ],
});

assert.equal(library.schemaVersion, GOVERNED_KEYWORD_NEGATIVE_CANDIDATE_LIBRARY_SCHEMA_VERSION);
assert.deepEqual(library.authority, {
  readOnly: true,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});
assert.equal(library.status.available, true);
assert.equal(library.summary.candidateCount, 3);
assert.equal(library.summary.keywordCount, 2);
assert.equal(library.summary.negativeCount, 1);
assert.equal(library.summary.staleEvidenceCandidateCount, 1);
assert.deepEqual(library.items.map((item) => item.priority), ['critical', 'high', 'medium']);

const negative = library.items[0];
assert.equal(negative.libraryFamily, 'negative');
assert.equal(negative.libraryKind, 'exact_negative');
assert.equal(negative.currentReviewState, 'needs_review');
assert.equal(negative.currentReviewPersisted, true);
assert.equal(negative.staleEvidenceCount, 2);
assert.equal(negative.currentFingerprint, 'fp-current');
assert.deepEqual(negative.sourceImportIds, ['import-a', 'import-b']);
assert.equal(negative.decisionPacketAvailable, true);
assert.equal(negative.authority.executionAuthorized, false);
assert.equal(negative.authority.amazonMutationAuthorized, false);

const blocked = buildGovernedKeywordNegativeCandidateLibrary({
  storeId: 'STORE01',
  analysisScope: {
    complete: true,
    financiallyComparable: true,
    candidateEmissionAuthorized: false,
    reasons: ['scope_blocked'],
  },
  entries: [],
});
assert.equal(blocked.status.available, false);
assert.equal(blocked.status.reasonCode, 'candidate_emission_not_authorized');
assert.equal(blocked.summary.candidateCount, null);
assert.deepEqual(blocked.items, []);

assert.throws(() => buildGovernedKeywordNegativeCandidateLibrary({
  analysisScope: { candidateEmissionAuthorized: true },
  entries: [{
    item: {
      itemClass: 'recommendation_candidate',
      inboxItemId: 'bad',
      actionType: 'keyword.review_unknown',
      candidateType: 'Unknown',
      matchScope: 'exact',
      value: 'bad',
      priority: 'low',
    },
    binding: baseBinding,
  }],
}), /CANDIDATE_LIBRARY_ACTION_TYPE_UNSUPPORTED/);

assert.throws(() => buildGovernedKeywordNegativeCandidateLibrary({
  analysisScope: { candidateEmissionAuthorized: true },
  entries: [{
    item: {
      itemClass: 'recommendation_candidate',
      inboxItemId: 'bad-stale',
      actionType: 'negative_keyword.review_exact',
      candidateType: 'Exact Negative Candidate',
      matchScope: 'exact',
      value: 'bad stale',
      priority: 'low',
    },
    binding: baseBinding,
    staleReviews: [{ recommendationFingerprint: 'fp-current' }],
  }],
}), /CANDIDATE_LIBRARY_STALE_FINGERPRINT_MATCHES_CURRENT/);

console.log(JSON.stringify({
  ok: true,
  contract: GOVERNED_KEYWORD_NEGATIVE_CANDIDATE_LIBRARY_SCHEMA_VERSION,
  candidateCount: library.summary.candidateCount,
  candidateEmissionBlockedFailsClosed: blocked.status.available === false,
  executionAuthorized: library.authority.executionAuthorized,
  amazonMutationAuthorized: library.authority.amazonMutationAuthorized,
}));
