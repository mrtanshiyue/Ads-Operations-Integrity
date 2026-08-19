import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const chronologyRelative = 'assets/cloudflare-native-csv-history-rolling-12-transition-chronology-v1.js';
const chronologyReceiptRelative = 'assets/cloudflare-native-csv-history-rolling-12-transition-chronology-receipt-v1.js';
const chronologyVerificationRelative = 'assets/cloudflare-native-csv-history-rolling-12-transition-chronology-receipt-verification-v1.js';
const auditChainRelative = 'assets/cloudflare-native-csv-history-audit-chain-index-v1.js';
const transitionReceiptRelative = 'assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js';
const transitionBoardRelative = 'assets/cloudflare-native-csv-history-rolling-12-window-transition-review-board-v1.js';

const chronologySource = await readFile(path.join(repoRoot, chronologyRelative), 'utf8');
const chronologyDistSource = await readFile(path.join(distRoot, chronologyRelative), 'utf8');
const chronologyVerificationSource = await readFile(path.join(repoRoot, chronologyVerificationRelative), 'utf8');
const chronologyVerificationDistSource = await readFile(path.join(distRoot, chronologyVerificationRelative), 'utf8');
const auditChainSource = await readFile(path.join(repoRoot, auditChainRelative), 'utf8');
const auditChainDistSource = await readFile(path.join(distRoot, auditChainRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');

const chronologyMod = await import(`${pathToFileURL(path.join(distRoot, chronologyRelative)).href}?r12Chronology=${Date.now()}`);
const chronologyReceiptMod = await import(`${pathToFileURL(path.join(distRoot, chronologyReceiptRelative)).href}?r12ChronologyReceiptReplay=${Date.now()}`);
const chronologyVerificationMod = await import(`${pathToFileURL(path.join(distRoot, chronologyVerificationRelative)).href}?r12ChronologyVerification=${Date.now()}`);
const auditChainMod = await import(`${pathToFileURL(path.join(distRoot, auditChainRelative)).href}?historyAuditChain=${Date.now()}`);
const transitionReceiptMod = await import(`${pathToFileURL(path.join(distRoot, transitionReceiptRelative)).href}?r12TransitionReceiptChronology=${Date.now()}`);
const transitionBoardMod = await import(`${pathToFileURL(path.join(distRoot, transitionBoardRelative)).href}?r12TransitionBoardChronology=${Date.now()}`);
const ledgerEngine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?r12ChronologyLedger=${Date.now()}`);

const {
  CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_SCHEMA_VERSION,
  projectHistoricalRolling12VerifiedTransitionChronology,
} = chronologyMod;

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

assert.equal(chronologySource, chronologyDistSource, 'Canonical build must preserve the chronology module source exactly');
assert.equal(chronologyVerificationSource, chronologyVerificationDistSource, 'Canonical build must preserve chronology replay verification exactly');
assert.equal(auditChainSource, auditChainDistSource, 'Canonical build must preserve the historical audit-chain index exactly');
assert.equal(indexSource.includes('cloudflare-native-csv-history-rolling-12-transition-chronology-receipt-v1.js'), false, 'Chronology receipt library must not be injected as a page script');
assert.equal(indexSource.includes('cloudflare-native-csv-history-rolling-12-transition-chronology-receipt-verification-v1.js'), false, 'Chronology receipt verification library must not be injected as a page script');
assert.equal(indexSource.includes('cloudflare-native-csv-history-audit-chain-index-v1.js'), false, 'Audit-chain index library must not be injected as a page script');
assert.equal(CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_SCHEMA_VERSION, 'csv-history-rolling-12-transition-chronology-v1');
assert.equal(typeof projectHistoricalRolling12VerifiedTransitionChronology, 'function');

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
assert.equal(nonAdjacent.blockers.some((item) => item.code === 'non_adjacent_transition_sequence'), true);
assert.equal(nonAdjacent.transitions[0].metrics[0].rolling12Delta, null);
assert.equal(nonAdjacent.transitions[0].metrics[0].movementDirection, 'withheld_not_comparable');
assert.equal(nonAdjacent.transitions[1].interpretationAllowed, false);
assert.equal(nonAdjacent.transitions[1].rawEvidenceOnly, true);

const evidenceMismatch = projectHistoricalRolling12VerifiedTransitionChronology([
  { board: first },
  { board: board('2026-Q2-R12', '2026-Q3-R12', 'receipt-evidence-mismatch', 5, { previousLedgerFingerprint: 'ledger-different-Q2-evidence' }) },
]);
assert.equal(evidenceMismatch.chronologyAllowed, false);
assert.equal(evidenceMismatch.blockers.some((item) => item.code === 'non_contiguous_ledger_evidence'), true);
assert.equal(evidenceMismatch.transitions[0].metrics[0].rolling12Delta, null);
assert.equal(evidenceMismatch.transitions[1].rawEvidenceOnly, true);

const missingFingerprint = projectHistoricalRolling12VerifiedTransitionChronology([
  { board: first },
  { board: board('2026-Q2-R12', '2026-Q3-R12', 'receipt-missing-ledger', 5, { previousLedgerFingerprint: '' }) },
]);
assert.equal(missingFingerprint.chronologyAllowed, false);
assert.equal(missingFingerprint.blockers.some((item) => item.code === 'missing_ledger_fingerprint'), true);

const unverified = projectHistoricalRolling12VerifiedTransitionChronology([
  { board: first },
  { board: second },
  { board: board('2026-Q3-R12', '2026-Q4-R12', 'receipt-3', 6, { receiptFingerprintMatch: false }) },
]);
assert.equal(unverified.chronologyAllowed, false);
assert.equal(unverified.blockers.some((item) => item.code === 'transition_not_verified_allowed'), true);
for (const transition of unverified.transitions) {
  assert.equal(transition.interpretationAllowed, false);
  assert.equal(transition.rawEvidenceOnly, true);
  assert.equal(transition.metrics[0].rolling12Delta, null);
}

assert.throws(
  () => projectHistoricalRolling12VerifiedTransitionChronology([{ board: first }]),
  /At least two ordered Rolling-12 transition review boards are required/,
);

const q2_2025 = await completeQuarter({ year: 2025, quarter: 2, seed: '25q2', metrics: metrics(1_000_000, 4_000_000, 1) });
const q3_2025 = await completeQuarter({ year: 2025, quarter: 3, seed: '25q3', metrics: metrics(2_000_000, 5_000_000, 2) });
const q4_2025 = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4', metrics: metrics(3_000_000, 6_000_000, 3) });
const q1_2026 = await completeQuarter({ year: 2026, quarter: 1, seed: '26q1', metrics: metrics(4_000_000, 8_000_000, 4) });
const q2_2026 = await completeQuarter({ year: 2026, quarter: 2, seed: '26q2', metrics: metrics(6_000_000, 12_000_000, 6) });
const q3_2026 = await completeQuarter({ year: 2026, quarter: 3, seed: '26q3', metrics: metrics(7_000_000, 14_000_000, 7) });
const localLedger = await ledgerFrom(...q2_2025, ...q3_2025, ...q4_2025, ...q1_2026, ...q2_2026, ...q3_2026);
const transitionOne = await transitionReceiptMod.buildHistoricalRolling12WindowTransitionReceipt(localLedger, '2026-Q1-R12', '2026-Q2-R12');
const transitionTwo = await transitionReceiptMod.buildHistoricalRolling12WindowTransitionReceipt(localLedger, '2026-Q2-R12', '2026-Q3-R12');
const boardOne = await transitionBoardMod.buildHistoricalRolling12WindowTransitionReviewBoard(localLedger, transitionOne);
const boardTwo = await transitionBoardMod.buildHistoricalRolling12WindowTransitionReviewBoard(localLedger, transitionTwo);
const chronologyReceipt = await chronologyReceiptMod.buildHistoricalRolling12TransitionChronologyReceipt([{ board: boardOne }, { board: boardTwo }]);
const chronologyEntries = [
  { previousLedger: localLedger, receipt: transitionOne },
  { previousLedger: localLedger, receipt: transitionTwo },
];

const chronologyVerification = await chronologyVerificationMod.verifyHistoricalRolling12TransitionChronologyReceiptAgainstLedgers(chronologyReceipt, chronologyEntries);
assert.equal(chronologyVerification.schemaVersion, 'csv-history-rolling-12-transition-chronology-receipt-verification-v1');
assert.equal(chronologyVerification.verificationState, 'verified_against_explicit_local_ledgers');
assert.equal(chronologyVerification.receiptFingerprint, chronologyReceipt.receiptFingerprint);
assert.equal(chronologyVerification.recomputedReceiptFingerprint, chronologyReceipt.receiptFingerprint);
assert.equal(chronologyVerification.receiptFingerprintMatch, true);
assert.equal(chronologyVerification.receiptSerializationMatch, true);
assert.equal(chronologyVerification.chronologyRecomputationMatch, true);
assert.equal(chronologyVerification.orderedTransitionBindingsMatch, true);
assert.deepEqual(chronologyVerification.transitionReceiptFingerprints, [transitionOne.receiptFingerprint, transitionTwo.receiptFingerprint]);
assert.deepEqual(chronologyVerification.ledgerFingerprintChain, [localLedger.ledgerFingerprint, localLedger.ledgerFingerprint, localLedger.ledgerFingerprint]);
assert.equal(chronologyVerification.chronologyAllowed, true);
assert.equal(chronologyVerification.interpretationAllowed, true);
assert.equal(chronologyVerification.rawEvidenceOnly, false);
assert.equal(chronologyVerification.ledgerContinuitySatisfied, true);
assert.equal(chronologyVerification.windowSequenceContinuitySatisfied, true);
assert.equal(chronologyVerification.standaloneChronologyReceiptValidatedFirst, true);
assert.equal(chronologyVerification.everyTransitionReceiptVerifiedAgainstExplicitLocalLedgers, true);
assert.equal(chronologyVerification.chronologyReplayedFromExplicitLocalEvidence, true);
assert.equal(chronologyVerification.transitionOrderPreserved, true);
assert.equal(chronologyVerification.generatedTimestampIncluded, false);
assert.equal(chronologyVerification.recommendationGenerated, false);
assert.equal(chronologyVerification.actionGenerated, false);
assertAuthorityFalse(chronologyVerification.authority);
assert.equal(Object.isFrozen(chronologyVerification), true);

await assert.rejects(
  () => chronologyVerificationMod.verifyHistoricalRolling12TransitionChronologyReceiptAgainstLedgers(chronologyReceipt, [chronologyEntries[1], chronologyEntries[0]]),
  (error) => error?.code === 'CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_VERIFICATION_RECEIPT_FINGERPRINT_MISMATCH',
  'Reordered explicit transition evidence must fail against ordered chronology bindings',
);

const blockedTransitionTwo = await transitionReceiptMod.buildHistoricalRolling12WindowTransitionReceipt(localLedger, '2026-Q2-R12', '2026-Q1-R12');
const blockedBoardTwo = await transitionBoardMod.buildHistoricalRolling12WindowTransitionReviewBoard(localLedger, blockedTransitionTwo);
const blockedChronologyReceipt = await chronologyReceiptMod.buildHistoricalRolling12TransitionChronologyReceipt([{ board: boardOne }, { board: blockedBoardTwo }]);
const blockedChronologyVerification = await chronologyVerificationMod.verifyHistoricalRolling12TransitionChronologyReceiptAgainstLedgers(blockedChronologyReceipt, [
  chronologyEntries[0],
  { previousLedger: localLedger, receipt: blockedTransitionTwo },
]);
assert.equal(blockedChronologyVerification.chronologyAllowed, false);
assert.equal(blockedChronologyVerification.interpretationAllowed, false);
assert.equal(blockedChronologyVerification.rawEvidenceOnly, true);
assert.equal(blockedChronologyVerification.blockedChronologyCannotBeUpgraded, true);
assert.equal(blockedChronologyVerification.receiptFingerprintMatch, true);
assert.equal(blockedChronologyVerification.receiptSerializationMatch, true);

const driftQ4 = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4-drift', metrics: metrics(3_000_000, 6_000_000, 3) });
const driftLedger = await ledgerFrom(...q2_2025, ...q3_2025, ...driftQ4, ...q1_2026, ...q2_2026, ...q3_2026);
const driftTransitionTwo = await transitionReceiptMod.buildHistoricalRolling12WindowTransitionReceipt(driftLedger, '2026-Q2-R12', '2026-Q3-R12');
const driftBoardTwo = await transitionBoardMod.buildHistoricalRolling12WindowTransitionReviewBoard(driftLedger, driftTransitionTwo);
const nonContiguousReceipt = await chronologyReceiptMod.buildHistoricalRolling12TransitionChronologyReceipt([{ board: boardOne }, { board: driftBoardTwo }]);
const nonContiguousVerification = await chronologyVerificationMod.verifyHistoricalRolling12TransitionChronologyReceiptAgainstLedgers(nonContiguousReceipt, [
  chronologyEntries[0],
  { previousLedger: driftLedger, receipt: driftTransitionTwo },
]);
assert.equal(nonContiguousVerification.chronologyAllowed, false);
assert.equal(nonContiguousVerification.rawEvidenceOnly, true);
assert.equal(nonContiguousVerification.ledgerContinuitySatisfied, false);
assert.equal(nonContiguousVerification.blockers.some((item) => item.code === 'non_contiguous_ledger_evidence'), true);
assert.notEqual(nonContiguousVerification.ledgerFingerprintChain[1], nonContiguousVerification.ledgerFingerprintChain[2]);

const auditChainA = await auditChainMod.buildHistoricalAuditChainIndex({
  chronologyInputs: [{ receipt: chronologyReceipt, entries: chronologyEntries }],
});
const auditChainB = await auditChainMod.buildHistoricalAuditChainIndex({
  chronologyInputs: [{ receipt: chronologyReceipt, entries: chronologyEntries }],
});
assert.equal(auditChainA.schemaVersion, 'csv-history-audit-chain-index-v1');
assert.equal(auditChainA.indexFingerprint, auditChainB.indexFingerprint);
assert.equal(auditChainA.indexPurpose, 'deterministic_catalog_of_replay_verified_historical_audit_evidence');
assert.equal(auditChainA.comparisonPackageIndex, null);
assert.equal(auditChainA.evidenceSummary.comparisonPackageCount, 0);
assert.equal(auditChainA.evidenceSummary.rolling12ChronologyCount, 1);
assert.equal(auditChainA.evidenceSummary.totalCatalogEntries, 1);
assert.equal(auditChainA.rolling12Chronologies[0].receiptFingerprint, chronologyReceipt.receiptFingerprint);
assert.deepEqual(auditChainA.rolling12Chronologies[0].transitionReceiptFingerprints, [transitionOne.receiptFingerprint, transitionTwo.receiptFingerprint]);
assert.equal(auditChainA.deterministic.generatedTimestampIncluded, false);
assert.equal(auditChainA.deterministic.chronologyInternalTransitionOrderPreserved, true);
assert.equal(auditChainA.crossArtifactAggregationApplied, false);
assert.equal(auditChainA.crossArtifactNormalizationApplied, false);
assert.equal(auditChainA.automaticTrendInferenceApplied, false);
assert.equal(auditChainA.recommendationGenerated, false);
assert.equal(auditChainA.actionGenerated, false);
assertAuthorityFalse(auditChainA.authority);
const validatedAuditChain = await auditChainMod.validateHistoricalAuditChainIndex(auditChainA);
assert.equal(validatedAuditChain.indexFingerprint, auditChainA.indexFingerprint);
const auditChainVerification = await auditChainMod.verifyHistoricalAuditChainIndexAgainstEvidence(auditChainA, {
  chronologyInputs: [{ receipt: chronologyReceipt, entries: chronologyEntries }],
});
assert.equal(auditChainVerification.schemaVersion, 'csv-history-audit-chain-index-verification-v1');
assert.equal(auditChainVerification.verificationState, 'audit_chain_index_verified_against_explicit_local_evidence');
assert.equal(auditChainVerification.indexFingerprintMatch, true);
assert.equal(auditChainVerification.indexSerializationMatch, true);
assert.equal(auditChainVerification.replayedFromExplicitLocalEvidence, true);
assert.equal(auditChainVerification.generatedTimestampIncluded, false);
assertAuthorityFalse(auditChainVerification.authority);

const auditChainTampered = structuredClone(auditChainA);
auditChainTampered.rolling12Chronologies[0].lastWindowKey = '2099-Q4-R12';
await assert.rejects(
  () => auditChainMod.validateHistoricalAuditChainIndex(auditChainTampered),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_CHAIN_INDEX_FINGERPRINT_MISMATCH',
  'Audit-chain catalog tampering must fail deterministic fingerprint validation',
);

for (const source of [chronologySource, chronologyVerificationSource, auditChainSource]) {
  for (const pattern of [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /navigator\.sendBeacon/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bindexedDB\b/,
    /CloudflareNativeAPI/,
    /\/api\/v1\//,
    /CONTROL_DB/,
    /STORE_01_DB/,
    /DATA_BUCKET/,
    /AMAZON_ADS_ENABLED/,
    /optimization-actions/,
    /execution-permits/,
  ]) assert.equal(pattern.test(source), false, `Historical audit chain assets must remain explicit-local and execution-free: ${pattern}`);
}

assert.match(chronologySource, /buildHistoricalRolling12WindowTransitionReviewBoard/);
assert.match(chronologySource, /non_contiguous_ledger_evidence/);
assert.match(chronologySource, /missing_ledger_fingerprint/);
assert.match(chronologySource, /crossWindowAggregationApplied: false/);
assert.match(chronologySource, /crossWindowNormalizationApplied: false/);
assert.match(chronologySource, /automaticTrendInferenceApplied: false/);
assert.match(chronologySource, /outcomeQualityJudgmentApplied: false/);
assert.match(chronologySource, /recommendationGenerated: false/);
assert.match(chronologySource, /actionGenerated: false/);
assert.match(chronologySource, /windowSelectionAutoReordered: false/);
assert.match(chronologySource, /invalidTransitionAutoSkipped: false/);
assert.doesNotMatch(chronologySource, /\.sort\s*\(/);
assert.match(chronologyVerificationSource, /standaloneChronologyReceiptValidatedFirst: true/);
assert.match(chronologyVerificationSource, /everyTransitionReceiptVerifiedAgainstExplicitLocalLedgers: true/);
assert.match(chronologyVerificationSource, /chronologyReplayedFromExplicitLocalEvidence: true/);
assert.match(chronologyVerificationSource, /blockedChronologyCannotBeUpgraded: true/);
assert.match(chronologyVerificationSource, /transitionOrderPreserved: true/);
assert.match(chronologyVerificationSource, /receiptSerializationMatch: true/);
assert.match(chronologyVerificationSource, /ledgerContinuitySatisfied/);
assert.doesNotMatch(chronologyVerificationSource, /\.sort\s*\(/);
assert.match(auditChainSource, /csv-history-audit-chain-index-v1/);
assert.match(auditChainSource, /csv-history-audit-package-index-verification-v1/);
assert.match(auditChainSource, /chronologyInternalTransitionOrderPreserved: true/);
assert.match(auditChainSource, /selectionOrderAffectsFingerprint: false/);
assert.match(auditChainSource, /crossArtifactAggregationApplied: false/);
assert.match(auditChainSource, /replayedFromExplicitLocalEvidence: true/);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-rolling-12-transition-chronology-v1',
  packagedArtifactVerified: true,
  transitionCount: chronology.transitionCount,
  chronologyAllowed: chronology.chronologyAllowed,
  nonAdjacentFailsClosed: true,
  evidenceMismatchFailsClosed: true,
  missingLedgerFingerprintFailsClosed: true,
  unverifiedFailsClosed: true,
  chronologyReceiptStandaloneValidationFirst: true,
  transitionReceiptsReplayedAgainstExplicitLocalLedgers: true,
  chronologyReceiptFingerprintReplayMatch: true,
  chronologyReceiptSerializationReplayMatch: true,
  orderedTransitionBindingReplay: true,
  blockedChronologyNotUpgraded: true,
  nonContiguousLedgerEvidenceReplayedAndBlocked: true,
  auditChainIndexDeterministic: true,
  auditChainIndexReplayVerified: true,
  auditChainComparisonPackageIndexCompatible: true,
  chronologyLibrariesNotPageInjected: true,
  crossWindowAggregationApplied: chronology.crossWindowAggregationApplied,
  automaticTrendInferenceApplied: chronology.automaticTrendInferenceApplied,
  outcomeQualityJudgmentApplied: chronology.outcomeQualityJudgmentApplied,
  recommendationGenerated: chronology.recommendationGenerated,
  actionGenerated: chronology.actionGenerated,
  amazonLiveApiCalls: false,
  cloudflareWrites: false,
  d1RemoteWrites: false,
}, null, 2));

function metrics(spendMicros, salesMicros, orders) {
  return { spendMicros, salesMicros, orders, acos: spendMicros / salesMicros, roas: salesMicros / spendMicros };
}

async function completeQuarter({ year, quarter, seed, marketplace = 'US', currencyCode = 'USD', metrics: quarterMetrics }) {
  const startMonth = (quarter - 1) * 3 + 1;
  const out = [];
  for (let index = 0; index < 3; index += 1) {
    const monthNumber = startMonth + index;
    const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
    const expectedDayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    out.push(await fixture({ seed: `${seed}-${index}`, month, startDate: `${month}-01`, endDate: `${month}-${String(expectedDayCount).padStart(2, '0')}`, expectedDayCount, marketplace, currencyCode, metrics: quarterMetrics }));
  }
  return out;
}

async function ledgerFrom(...analyses) {
  let ledger = await ledgerEngine.createCsvHistoryLedger(analyses[0]);
  for (const analysis of analyses.slice(1)) ledger = await ledgerEngine.mergeCsvHistoryLedger(ledger, analysis);
  return ledger;
}

async function fixture({ seed, month, startDate, endDate, expectedDayCount, marketplace, currencyCode, metrics: monthMetrics }) {
  const contentSha256 = await sha256Hex(`${month}:${seed}:${marketplace}:${currencyCode}`);
  const sourceReceipt = {
    schemaVersion: 'csv-import-v1', reportType: 'spSearchTerm', sourceFileName: `${month}-${seed}.csv`, contentSha256,
    reportStartDate: startDate, reportEndDate: endDate, rowCount: 10, acceptedRows: 10, rejectedRows: 0,
    advertiserAccountId: null, profileId: null, marketplace, currencyCode,
  };
  const inputSetFingerprint = await sha256Hex(canonicalJson([{
    schemaVersion: sourceReceipt.schemaVersion,
    reportType: sourceReceipt.reportType,
    contentSha256,
    reportStartDate: startDate,
    reportEndDate: endDate,
    rowCount: 10,
  }]));
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: { kind: 'csv_import_set', batchCount: 1, contentSha256s: [contentSha256], inputSetFingerprint, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false },
    range: { startDate, endDate },
    imports: [sourceReceipt],
    dataQuality: { authority, qualityState: 'single_window', safeForNaiveAggregation: true, contiguousCoverage: true, summary: { overlapPairCount: 0, gapCount: 0 } },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount: 0, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: {
      authority,
      summary: { monthlySnapshotCount: 1, aggregationSafe: true, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false },
      monthlySnapshots: [{
        periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount: expectedDayCount, factCount: 10,
        metrics: monthMetrics,
        adContributionMicros: monthMetrics.salesMicros - monthMetrics.spendMicros,
        profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
        coverage: { expectedDayCount, coveredDayCount: expectedDayCount, coverageRatio: 1, complete: true },
        reliability: { state: 'complete_coverage', aggregationSafe: true, coverageComplete: true, analyticalDecisionUse: 'observed_review_only' },
        requiresHumanReview: true, persistenceAuthorized: false, executionAuthorized: false, amazonMutationAuthorized: false,
      }],
    },
    analysis: { authority },
  };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
