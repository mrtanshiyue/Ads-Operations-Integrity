import assert from 'node:assert/strict';
import {
  GOVERNED_KEYWORD_NEGATIVE_CANDIDATE_LIBRARY_SCHEMA_VERSION,
  buildGovernedKeywordNegativeCandidateLibrary,
} from '../cloudflare/runtime/governed-keyword-negative-candidate-library.js';

function packet({ inboxItemId, actionType, candidateType, matchScope, value, priority, priorityScore, fingerprint, reviewState = 'unreviewed', stale = [], financiallyComparable = true }) {
  return {
    schemaVersion: 'recommendation-decision-packet-v1',
    authority: {
      readOnly: true,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
    recommendation: { inboxItemId, actionType, candidateType, matchScope, value },
    priorityEvidence: { priority, priorityScore },
    financialComparability: { financiallyComparable },
    reviewEvidence: {
      currentFingerprint: fingerprint,
      priorReviewState: reviewState,
      staleEvidenceCount: stale.length,
      staleEvidence: stale.map((entry) => ({ ...entry, stale: true, inheritedAsCurrent: false })),
    },
    sourceEvidence: {
      analysisWindow: { startDate: '2026-06-01', endDate: '2026-06-30' },
      sourceImportIds: ['import-b', 'import-a'],
      sourceEvidenceSha256: `sha-${fingerprint}`,
    },
  };
}

function responseItem(input) {
  return {
    inboxItemId: input.inboxItemId,
    recommendationFingerprint: input.fingerprint,
    review: {
      state: input.reviewState || 'unreviewed',
      persisted: input.persisted === true,
    },
    decisionPacket: packet(input),
  };
}

const library = buildGovernedKeywordNegativeCandidateLibrary({
  storeId: 'STORE01',
  analysisScope: {
    complete: true,
    financiallyComparable: true,
    candidateEmissionAuthorized: true,
    overflowObserved: false,
    reasons: [],
  },
  items: [
    responseItem({
      inboxItemId: 'csv-inbox:keyword.review_scale:operator_review:scale term',
      actionType: 'keyword.review_scale',
      candidateType: 'Scale Candidate',
      matchScope: 'operator_review',
      value: 'scale term',
      priority: 'high',
      priorityScore: 82,
      fingerprint: 'fp-scale',
    }),
    responseItem({
      inboxItemId: 'csv-inbox:negative_keyword.review_exact:exact:waste term',
      actionType: 'negative_keyword.review_exact',
      candidateType: 'Exact Negative Candidate',
      matchScope: 'exact',
      value: 'waste term',
      priority: 'critical',
      priorityScore: 95,
      fingerprint: 'fp-current',
      reviewState: 'needs_review',
      persisted: true,
      stale: [
        { recommendationFingerprint: 'fp-old-1', state: 'acknowledged' },
        { recommendationFingerprint: 'fp-old-2', state: 'needs_review' },
      ],
    }),
    responseItem({
      inboxItemId: 'csv-inbox:keyword.review_harvest:exact_review:good term',
      actionType: 'keyword.review_harvest',
      candidateType: 'Harvest Candidate',
      matchScope: 'exact_review',
      value: 'good term',
      priority: 'medium',
      priorityScore: 60,
      fingerprint: 'fp-harvest',
      reviewState: 'acknowledged',
      persisted: true,
      financiallyComparable: false,
    }),
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
  items: [],
});
assert.equal(blocked.status.available, false);
assert.equal(blocked.status.reasonCode, 'candidate_emission_not_authorized');
assert.equal(blocked.summary.candidateCount, null);
assert.deepEqual(blocked.items, []);

const unsupported = responseItem({
  inboxItemId: 'bad',
  actionType: 'keyword.review_unknown',
  candidateType: 'Unknown',
  matchScope: 'exact',
  value: 'bad',
  priority: 'low',
  priorityScore: 1,
  fingerprint: 'fp-bad',
});
assert.throws(() => buildGovernedKeywordNegativeCandidateLibrary({
  analysisScope: { candidateEmissionAuthorized: true },
  items: [unsupported],
}), /CANDIDATE_LIBRARY_ACTION_TYPE_UNSUPPORTED/);

const badStale = responseItem({
  inboxItemId: 'bad-stale',
  actionType: 'negative_keyword.review_exact',
  candidateType: 'Exact Negative Candidate',
  matchScope: 'exact',
  value: 'bad stale',
  priority: 'low',
  priorityScore: 1,
  fingerprint: 'fp-current-stale',
  stale: [{ recommendationFingerprint: 'fp-current-stale', state: 'needs_review' }],
});
assert.throws(() => buildGovernedKeywordNegativeCandidateLibrary({
  analysisScope: { candidateEmissionAuthorized: true },
  items: [badStale],
}), /CANDIDATE_LIBRARY_STALE_INHERITANCE_INVALID/);

console.log(JSON.stringify({
  ok: true,
  contract: GOVERNED_KEYWORD_NEGATIVE_CANDIDATE_LIBRARY_SCHEMA_VERSION,
  candidateCount: library.summary.candidateCount,
  candidateEmissionBlockedFailsClosed: blocked.status.available === false,
  executionAuthorized: library.authority.executionAuthorized,
  amazonMutationAuthorized: library.authority.amazonMutationAuthorized,
}));
