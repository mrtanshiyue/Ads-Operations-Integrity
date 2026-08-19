import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_SCHEMA_VERSION,
  projectHistoricalRolling12VerifiedTransitionChronology,
} from '../assets/cloudflare-native-csv-history-rolling-12-transition-chronology-v1.js';

function assertAuthorityFalse(authority) {
  assert.equal(authority.authoritative, false);
  assert.equal(authority.canonicalAmazonIdentityResolved, false);
  assert.equal(authority.governancePersistenceAllowed, false);
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.amazonMutationAuthorized, false);
}

function board(previousWindowKey, currentWindowKey, fingerprint, delta, overrides = {}) {
  return {
    schemaVersion: 'csv-history-rolling-12-window-transition-review-board-v1',
    boardPurpose: 'read_only_projection_of_verified_rolling_12_transition_receipt',
    operatorState: 'verified_transition_review_only',
    receiptFingerprint: fingerprint,
    verificationState: 'verified_against_explicit_local_ledgers',
    receiptFingerprintMatch: true,
    receiptSerializationMatch: true,
    transitionAllowed: true,
    interpretationAllowed: true,
    rawEvidenceOnly: false,
    previousLedgerFingerprint: `ledger-${previousWindowKey}`,
    currentLedgerFingerprint: `ledger-${currentWindowKey}`,
    selection: {
      previousWindowKey,
      currentWindowKey,
      windowSelectionAutoReordered: false,
    },
    decomposition: {
      outgoingQuarterKey: previousWindowKey.replace('-R12', ''),
      incomingQuarterKey: currentWindowKey.replace('-R12', ''),
      sharedQuarterKeys: ['shared-a', 'shared-b', 'shared-c'],
      sharedQuarterCount: 3,
    },
    metrics: [{
      key: 'spendMicros',
      metricKind: 'additive',
      previousRolling12Value: 100,
      currentRolling12Value: 100 + delta,
      rolling12Delta: delta,
      movementDirection: delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'unchanged',
      interpretationAllowed: true,
      outcomeQualityClassification: 'not_assigned',
      recommendationGenerated: false,
      actionGenerated: false,
    }],
    ...overrides,
  };
}

const first = board('2026-Q1-R12', '2026-Q2-R12', 'receipt-1', 12);
const second = board('2026-Q2-R12', '2026-Q3-R12', 'receipt-2', -4);
const chronology = projectHistoricalRolling12VerifiedTransitionChronology([
  { board: first },
  { board: second },
]);

assert.equal(chronology.schemaVersion, CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_SCHEMA_VERSION);
assert.equal(chronology.chronologyPurpose, 'ordered_read_only_projection_of_independently_verified_rolling_12_transitions');
assert.equal(chronology.operatorState, 'verified_transition_chronology_review_only');
assert.equal(chronology.transitionCount, 2);
assert.equal(chronology.firstWindowKey, '2026-Q1-R12');
assert.equal(chronology.lastWindowKey, '2026-Q3-R12');
assert.equal(chronology.chronologyAllowed, true);
assert.equal(chronology.rawEvidenceOnly, false);
assert.deepEqual(chronology.blockers, []);
assert.equal(chronology.transitions[0].metrics[0].rolling12Delta, 12);
assert.equal(chronology.transitions[1].metrics[0].rolling12Delta, -4);
assert.equal(chronology.transitions[0].metrics[0].outcomeQualityClassification, 'not_assigned');
assert.equal(chronology.transitions[1].recommendationGenerated, false);
assert.equal(chronology.transitions[1].actionGenerated, false);
assert.equal(chronology.chronologyProjectionApplied, true);
assert.equal(chronology.crossWindowAggregationApplied, false);
assert.equal(chronology.crossWindowNormalizationApplied, false);
assert.equal(chronology.overlapCollapseApplied, false);
assert.equal(chronology.automaticTrendInferenceApplied, false);
assert.equal(chronology.outcomeQualityJudgmentApplied, false);
assert.equal(chronology.recommendationGenerated, false);
assert.equal(chronology.actionGenerated, false);
assert.equal(chronology.windowSelectionAutoReordered, false);
assert.equal(chronology.invalidTransitionAutoSkipped, false);
assert.equal(chronology.sharedEvidenceAutoReconciled, false);
assert.equal(chronology.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(Object.hasOwn(chronology, 'totalSpendMicros'), false);
assert.equal(Object.hasOwn(chronology, 'aggregateMetrics'), false);
assertAuthorityFalse(chronology.authority);
assert.equal(Object.isFrozen(chronology), true);
assert.equal(Object.isFrozen(chronology.transitions), true);
assert.equal(Object.isFrozen(chronology.transitions[0].metrics), true);

const nonAdjacent = projectHistoricalRolling12VerifiedTransitionChronology([
  { board: first },
  { board: board('2026-Q4-R12', '2027-Q1-R12', 'receipt-gap', 9) },
]);
assert.equal(nonAdjacent.chronologyAllowed, false);
assert.equal(nonAdjacent.operatorState, 'chronology_blocked_raw_evidence_only');
assert.equal(nonAdjacent.blockers[0].code, 'non_adjacent_transition_sequence');
assert.equal(nonAdjacent.transitions[0].metrics[0].rolling12Delta, null);
assert.equal(nonAdjacent.transitions[0].metrics[0].movementDirection, 'withheld_not_comparable');
assert.equal(nonAdjacent.transitions[1].interpretationAllowed, false);
assert.equal(nonAdjacent.transitions[1].rawEvidenceOnly, true);

const unverified = projectHistoricalRolling12VerifiedTransitionChronology([
  { board: first },
  { board: second },
  { board: board('2026-Q3-R12', '2026-Q4-R12', 'receipt-3', 6, { receiptFingerprintMatch: false }) },
]);
assert.equal(unverified.chronologyAllowed, false);
assert.equal(unverified.blockers[0].code, 'transition_not_verified_allowed');
for (const transition of unverified.transitions) {
  assert.equal(transition.interpretationAllowed, false);
  assert.equal(transition.rawEvidenceOnly, true);
  assert.equal(transition.metrics[0].rolling12Delta, null);
}

assert.throws(
  () => projectHistoricalRolling12VerifiedTransitionChronology([{ board: first }]),
  /At least two ordered Rolling-12 transition review boards are required/,
);

const source = await readFile(new URL('../assets/cloudflare-native-csv-history-rolling-12-transition-chronology-v1.js', import.meta.url), 'utf8');
assert.match(source, /buildHistoricalRolling12WindowTransitionReviewBoard/);
assert.match(source, /crossWindowAggregationApplied: false/);
assert.match(source, /crossWindowNormalizationApplied: false/);
assert.match(source, /automaticTrendInferenceApplied: false/);
assert.match(source, /outcomeQualityJudgmentApplied: false/);
assert.match(source, /recommendationGenerated: false/);
assert.match(source, /actionGenerated: false/);
assert.match(source, /windowSelectionAutoReordered: false/);
assert.match(source, /invalidTransitionAutoSkipped: false/);
assert.doesNotMatch(source, /\.sort\s*\(/);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-rolling-12-transition-chronology-v1',
  transitionCount: chronology.transitionCount,
  chronologyAllowed: chronology.chronologyAllowed,
  nonAdjacentFailsClosed: true,
  unverifiedFailsClosed: true,
  crossWindowAggregationApplied: chronology.crossWindowAggregationApplied,
  automaticTrendInferenceApplied: chronology.automaticTrendInferenceApplied,
  outcomeQualityJudgmentApplied: chronology.outcomeQualityJudgmentApplied,
  recommendationGenerated: chronology.recommendationGenerated,
  actionGenerated: chronology.actionGenerated,
  amazonLiveApiCalls: false,
  cloudflareWrites: false,
  d1RemoteWrites: false,
}, null, 2));
