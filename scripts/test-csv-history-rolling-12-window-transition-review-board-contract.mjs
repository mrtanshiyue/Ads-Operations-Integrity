import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const boardRelative = 'assets/cloudflare-native-csv-history-rolling-12-window-transition-review-board-v1.js';
const receiptRelative = 'assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js';
const verificationRelative = 'assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-verification-v1.js';
const boardSource = await readFile(path.join(distRoot, boardRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const verificationTag = '<script type="module" src="assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-verification-v1.js?v=1.0.0"></script>';
const boardTag = '<script type="module" src="assets/cloudflare-native-csv-history-rolling-12-window-transition-review-board-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(boardTag).length - 1, 1, 'Rolling-12 transition review board asset must be injected exactly once');
assert.ok(indexSource.indexOf(verificationTag) < indexSource.indexOf(boardTag), 'Review board must load after transition receipt verification');
assert.ok(indexSource.indexOf(boardTag) < indexSource.indexOf(monthlyReceiptTag), 'Review board must load before legacy monthly receipt workflow');
assert.match(boardSource, /csv-history-rolling-12-window-transition-review-board-v1/);
assert.match(boardSource, /read_only_projection_of_verified_rolling_12_transition_receipt/);
assert.match(boardSource, /exact local-ledger replay verification/);
assert.match(boardSource, /movement and evidence state without judging business outcomes/);
assert.match(boardSource, /Additive movement uses incoming minus outgoing/);
assert.match(boardSource, /ACoS and ROAS movement uses the two full Rolling-12 totals only/);
assert.match(boardSource, /movementOnlyNoOutcomeJudgment: true/);
assert.match(boardSource, /outcomeQualityClassificationApplied: false/);
assert.match(boardSource, /recommendationGenerated: false/);
assert.match(boardSource, /actionGenerated: false/);
assert.match(boardSource, /ratioDerivedFromFullRolling12Totals: true/);
assert.match(boardSource, /incomingOutgoingQuarterRatioDeltaUsed: false/);
assert.match(boardSource, /sharedEvidenceAutoReconciled: false/);
assert.match(boardSource, /Ad Contribution = Sales - Ad Spend only; it is not Net Profit/);

for (const pattern of [
  /\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /\bWebSocket\b/, /\bEventSource\b/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /CloudflareNativeAPI/, /\/api\/v1\//,
  /CONTROL_DB/, /STORE_01_DB/, /DATA_BUCKET/, /AMAZON_ADS_ENABLED/, /optimization-actions/, /execution-permits/,
]) assert.equal(pattern.test(boardSource), false, `Review board must remain explicit-local and execution-free: ${pattern}`);

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?r12BoardEngine=${Date.now()}`);
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, receiptRelative)).href}?r12BoardReceipt=${Date.now()}`);
const verificationMod = await import(`${pathToFileURL(path.join(distRoot, verificationRelative)).href}?r12BoardVerification=${Date.now()}`);
const boardMod = await import(`${pathToFileURL(path.join(distRoot, boardRelative)).href}?r12Board=${Date.now()}`);

assert.equal(boardMod.CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_BOARD_SCHEMA_VERSION, 'csv-history-rolling-12-window-transition-review-board-v1');
assert.equal(boardMod.CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_BOARD_UI_VERSION, '1.0.0');
assert.equal(typeof boardMod.buildHistoricalRolling12WindowTransitionReviewBoard, 'function');
assert.equal(typeof verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers, 'function');

const q2025q2 = await completeQuarter({ year: 2025, quarter: 2, seed: '2025-q2', metrics: { spendMicros: 1_000_000, salesMicros: 4_000_000, orders: 1, acos: 0.25, roas: 4 } });
const q2025q3 = await completeQuarter({ year: 2025, quarter: 3, seed: '2025-q3', metrics: { spendMicros: 2_000_000, salesMicros: 5_000_000, orders: 2, acos: 0.4, roas: 2.5 } });
const q2025q4 = await completeQuarter({ year: 2025, quarter: 4, seed: '2025-q4', metrics: { spendMicros: 3_000_000, salesMicros: 6_000_000, orders: 3, acos: 0.5, roas: 2 } });
const q2026q1 = await completeQuarter({ year: 2026, quarter: 1, seed: '2026-q1', metrics: { spendMicros: 4_000_000, salesMicros: 8_000_000, orders: 4, acos: 0.5, roas: 2 } });
const q2026q2 = await completeQuarter({ year: 2026, quarter: 2, seed: '2026-q2', metrics: { spendMicros: 5_000_000, salesMicros: 10_000_000, orders: 5, acos: 0.5, roas: 2 } });

const ledger = await ledgerFrom(...q2025q2, ...q2025q3, ...q2025q4, ...q2026q1, ...q2026q2);
const receipt = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q1-R12', '2026-Q2-R12');
const board = await boardMod.buildHistoricalRolling12WindowTransitionReviewBoard(ledger, receipt);

assert.equal(board.schemaVersion, 'csv-history-rolling-12-window-transition-review-board-v1');
assert.equal(board.boardPurpose, 'read_only_projection_of_verified_rolling_12_transition_receipt');
assert.equal(board.operatorState, 'verified_transition_review_only');
assert.equal(board.receiptFingerprint, receipt.receiptFingerprint);
assert.equal(board.verificationState, 'verified_against_explicit_local_ledgers');
assert.equal(board.receiptFingerprintMatch, true);
assert.equal(board.receiptSerializationMatch, true);
assert.equal(board.transitionAllowed, true);
assert.equal(board.interpretationAllowed, true);
assert.equal(board.rawEvidenceOnly, false);
assert.equal(board.selection.previousWindowKey, '2026-Q1-R12');
assert.equal(board.selection.currentWindowKey, '2026-Q2-R12');
assert.equal(board.selection.windowSelectionAutoReordered, false);
assert.equal(board.decomposition.outgoingQuarterKey, '2025-Q2');
assert.deepEqual(board.decomposition.sharedQuarterKeys, ['2025-Q3', '2025-Q4', '2026-Q1']);
assert.equal(board.decomposition.sharedQuarterCount, 3);
assert.equal(board.decomposition.overlapMonths, 9);
assert.equal(board.decomposition.incomingQuarterKey, '2026-Q2');
assert.equal(board.decomposition.overlapCollapsed, false);
assert.equal(board.gate.verificationRequired, true);
assert.equal(board.gate.standaloneReceiptValidatedFirst, true);
assert.equal(board.gate.exactReplayFingerprintRequired, true);
assert.equal(board.gate.exactReplaySerializationRequired, true);
assert.equal(board.gate.sharedEvidenceIdentityMustMatch, true);
assert.equal(board.gate.sameQuarterKeyDoesNotImplySameEvidence, true);
assert.deepEqual(board.gate.blockers, []);
assert.equal(board.evidence.sharedQuarterEvidence.length, 3);
assert.equal(board.evidence.sharedQuarterBindings.length, 3);
assert.equal(board.evidence.rawEvidenceRetained, true);
assert.equal(board.metrics.length, 6);

const spend = metric(board, 'spendMicros');
assert.equal(spend.metricKind, 'additive');
assert.equal(spend.previousRolling12Value, 30_000_000);
assert.equal(spend.currentRolling12Value, 42_000_000);
assert.equal(spend.outgoingQuarterValue, 3_000_000);
assert.equal(spend.incomingQuarterValue, 15_000_000);
assert.equal(spend.rolling12Delta, 12_000_000);
assert.equal(spend.movementDirection, 'increase');
assert.equal(spend.outcomeQualityClassification, 'not_assigned');
assert.equal(spend.recommendationGenerated, false);
assert.equal(metric(board, 'salesMicros').rolling12Delta, 18_000_000);
assert.equal(metric(board, 'orders').rolling12Delta, 12);
assert.equal(metric(board, 'adContributionMicros').rolling12Delta, 6_000_000);

const acos = metric(board, 'acos');
assert.equal(acos.metricKind, 'ratio');
assert.equal(acos.outgoingQuarterValue, null);
assert.equal(acos.incomingQuarterValue, null);
assert.equal(acos.ratioDerivedFromFullRolling12Totals, true);
assert.equal(acos.incomingOutgoingQuarterRatioDeltaUsed, false);
assert.equal(acos.movementDirection, 'increase');
const roas = metric(board, 'roas');
assert.equal(roas.ratioDerivedFromFullRolling12Totals, true);
assert.equal(roas.incomingOutgoingQuarterRatioDeltaUsed, false);
assert.equal(roas.movementDirection, 'decrease');

assert.equal(board.movementOnlyNoOutcomeJudgment, true);
assert.equal(board.outcomeQualityClassificationApplied, false);
assert.equal(board.recommendationGenerated, false);
assert.equal(board.actionGenerated, false);
assert.equal(board.crossWindowAggregationApplied, false);
assert.equal(board.crossWindowNormalizationApplied, false);
assert.equal(board.overlapCollapseApplied, false);
assert.equal(board.sharedEvidenceAutoReconciled, false);
assert.equal(board.gapRepairApplied, false);
assert.equal(board.windowSelectionAutoReordered, false);
assert.equal(board.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(board.authority);
assert.equal(Object.isFrozen(board), true);

const blockedReceipt = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q2-R12', '2026-Q1-R12');
const blockedBoard = await boardMod.buildHistoricalRolling12WindowTransitionReviewBoard(ledger, blockedReceipt);
assert.equal(blockedBoard.operatorState, 'verified_blocked_raw_evidence_only');
assert.equal(blockedBoard.transitionAllowed, false);
assert.equal(blockedBoard.interpretationAllowed, false);
assert.equal(blockedBoard.rawEvidenceOnly, true);
assert.ok(blockedBoard.gate.blockers.length > 0);
assert.equal(blockedBoard.gate.blockedTransitionCannotBeUpgraded, true);
assert.equal(blockedBoard.evidence.rawEvidenceRetained, true);
for (const item of blockedBoard.metrics) {
  assert.equal(item.rolling12Delta, null);
  assert.equal(item.movementDirection, 'withheld_not_comparable');
  assert.equal(item.interpretationAllowed, false);
  assert.equal(item.outcomeQualityClassification, 'not_assigned');
  assert.equal(item.recommendationGenerated, false);
}
assertAuthorityFalse(blockedBoard.authority);

const previousLedger = await ledgerFrom(...q2025q2, ...q2025q3, ...q2025q4, ...q2026q1);
const currentLedger = await ledgerFrom(...q2025q3, ...q2025q4, ...q2026q1, ...q2026q2);
const twoLedgerReceipt = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(previousLedger, '2026-Q1-R12', '2026-Q2-R12', { currentLedger });
await assert.rejects(
  () => boardMod.buildHistoricalRolling12WindowTransitionReviewBoard(previousLedger, twoLedgerReceipt),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_VERIFICATION_CURRENT_LEDGER_REQUIRED',
  'A review board must not silently choose a current ledger when the verified receipt binds a distinct fingerprint',
);
const twoLedgerBoard = await boardMod.buildHistoricalRolling12WindowTransitionReviewBoard(previousLedger, twoLedgerReceipt, { currentLedger });
assert.equal(twoLedgerBoard.transitionAllowed, true);
assert.equal(twoLedgerBoard.sameLedgerFingerprint, false);
assert.equal(twoLedgerBoard.receiptFingerprintMatch, true);
assert.equal(twoLedgerBoard.receiptSerializationMatch, true);
assert.equal(twoLedgerBoard.decomposition.sharedQuarterCount, 3);
assertAuthorityFalse(twoLedgerBoard.authority);

const tampered = JSON.parse(receiptMod.serializeHistoricalRolling12WindowTransitionReceipt(receipt));
tampered.transition.transitionMetrics.additive.salesMicros.currentRolling12Value += 1;
await assert.rejects(
  () => boardMod.buildHistoricalRolling12WindowTransitionReviewBoard(ledger, tampered),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_FINGERPRINT_MISMATCH',
  'Review board projection must fail before rendering if standalone receipt integrity is tampered',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-rolling-12-window-transition-review-board-v1',
  verifiedReceiptReplayRequired: true,
  exactReplayFingerprintRequired: true,
  exactReplaySerializationRequired: true,
  oneQuarterOutThreeSharedOneQuarterInProjected: true,
  additiveIncomingMinusOutgoingMovementProjected: true,
  ratioMovementUsesFullRolling12Totals: true,
  incomingOutgoingQuarterRatioDeltaUsed: false,
  blockedReceiptRemainsRawEvidenceOnly: true,
  distinctLedgerRequiresExplicitCurrentLedger: true,
  receiptTamperingBlockedBeforeProjection: true,
  movementOnlyNoOutcomeJudgment: true,
  outcomeQualityClassificationApplied: false,
  recommendationGenerated: false,
  actionGenerated: false,
  rawEvidenceRetained: true,
  overlapCollapseApplied: false,
  sharedEvidenceAutoReconciled: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function metric(boardValue, key) {
  const found = boardValue.metrics.find((item) => item.key === key);
  assert.ok(found, `Missing metric ${key}`);
  return found;
}
function assertAuthorityFalse(authority) {
  assert.equal(authority.authoritative, false);
  assert.equal(authority.canonicalAmazonIdentityResolved, false);
  assert.equal(authority.governancePersistenceAllowed, false);
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.amazonMutationAuthorized, false);
}
async function completeQuarter({ year, quarter, seed, metrics }) {
  const startMonth = (quarter - 1) * 3 + 1;
  const out = [];
  for (let index = 0; index < 3; index += 1) {
    const monthNumber = startMonth + index;
    const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
    const expectedDayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    out.push(await fixture({ seed: `${seed}-${index}`, month, startDate: `${month}-01`, endDate: `${month}-${String(expectedDayCount).padStart(2, '0')}`, expectedDayCount, metrics }));
  }
  return out;
}
async function ledgerFrom(...analyses) {
  let ledgerValue = await engine.createCsvHistoryLedger(analyses[0]);
  for (const analysis of analyses.slice(1)) ledgerValue = await engine.mergeCsvHistoryLedger(ledgerValue, analysis);
  return ledgerValue;
}
async function fixture({ seed, month, startDate, endDate, expectedDayCount, metrics }) {
  const contentSha256 = await sha256Hex(`${month}:${seed}:US:USD`);
  const sourceReceipt = {
    schemaVersion: 'csv-import-v1', reportType: 'spSearchTerm', sourceFileName: `${month}-${seed}.csv`, contentSha256,
    reportStartDate: startDate, reportEndDate: endDate, rowCount: 10, acceptedRows: 10, rejectedRows: 0,
    advertiserAccountId: null, profileId: null, marketplace: 'US', currencyCode: 'USD',
  };
  const inputSetFingerprint = await sha256Hex(canonicalJson([{
    schemaVersion: sourceReceipt.schemaVersion, reportType: sourceReceipt.reportType, contentSha256,
    reportStartDate: startDate, reportEndDate: endDate, rowCount: 10,
  }]));
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: { kind: 'csv_import_set', batchCount: 1, contentSha256s: [contentSha256], inputSetFingerprint, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false },
    range: { startDate, endDate }, imports: [sourceReceipt],
    dataQuality: { authority, qualityState: 'single_window', safeForNaiveAggregation: true, contiguousCoverage: true, summary: { overlapPairCount: 0, gapCount: 0 } },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount: 0, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: {
      authority,
      summary: { monthlySnapshotCount: 1, aggregationSafe: true, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false },
      monthlySnapshots: [{
        periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount: expectedDayCount, factCount: 10,
        metrics, adContributionMicros: metrics.salesMicros - metrics.spendMicros,
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
