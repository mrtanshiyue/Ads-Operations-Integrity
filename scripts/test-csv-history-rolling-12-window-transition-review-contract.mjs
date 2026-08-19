import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const assetRelative = 'assets/cloudflare-native-csv-history-rolling-12-window-transition-review-v1.js';
const assetSource = await readFile(path.join(distRoot, assetRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const rollingTag = '<script type="module" src="assets/cloudflare-native-csv-history-rolling-12-operating-review-v1.js?v=1.0.0"></script>';
const transitionTag = '<script type="module" src="assets/cloudflare-native-csv-history-rolling-12-window-transition-review-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(transitionTag).length - 1, 1, 'Rolling-12 transition asset must be injected exactly once');
assert.ok(indexSource.indexOf(rollingTag) < indexSource.indexOf(transitionTag), 'Rolling-12 transition review must load after Rolling-12 operating review');
assert.ok(indexSource.indexOf(transitionTag) < indexSource.indexOf(monthlyReceiptTag), 'Rolling-12 transition review must load before legacy monthly receipt workflow');
assert.match(assetSource, /csv-history-rolling-12-window-transition-review-v1/);
assert.match(assetSource, /Rolling-12 Window Transition Review/);
assert.match(assetSource, /overlap_aware_one_quarter_out_one_quarter_in_three_quarters_shared/);
assert.match(assetSource, /incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12/);
assert.match(assetSource, /current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals/);
assert.match(assetSource, /sameQuarterKeyDoesNotImplySameEvidence: true/);
assert.match(assetSource, /sharedEvidenceIdentityMustMatch: true/);
assert.match(assetSource, /overlapMonths: sharedQuarterKeys\.length \* 3/);
assert.match(assetSource, /overlapCollapsed: false/);
assert.match(assetSource, /sharedEvidenceAutoReconciled: false/);
assert.match(assetSource, /crossWindowAggregationApplied: false/);
assert.match(assetSource, /crossWindowNormalizationApplied: false/);
assert.match(assetSource, /windowSelectionAutoReordered: false/);
assert.match(assetSource, /recommendationGenerated: false/);
assert.match(assetSource, /actionGenerated: false/);
assert.match(assetSource, /Same quarter key does not imply same evidence/);
assert.match(assetSource, /This is not an independent-period comparison/);

for (const pattern of [
  /\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /\bWebSocket\b/, /\bEventSource\b/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /CloudflareNativeAPI/, /\/api\/v1\//,
  /CONTROL_DB/, /STORE_01_DB/, /DATA_BUCKET/, /AMAZON_ADS_ENABLED/, /optimization-actions/, /execution-permits/,
]) assert.equal(pattern.test(assetSource), false, `Rolling-12 transition review must remain explicit-local and execution-free: ${pattern}`);

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?r12TransitionEngine=${Date.now()}`);
const transitionMod = await import(`${pathToFileURL(path.join(distRoot, assetRelative)).href}?r12Transition=${Date.now()}`);
assert.equal(transitionMod.CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_SCHEMA_VERSION, 'csv-history-rolling-12-window-transition-review-v1');
assert.equal(transitionMod.CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_UI_VERSION, '1.0.0');
assert.equal(typeof transitionMod.buildHistoricalRolling12WindowTransitionReview, 'function');

const q2_2025 = await completeQuarter({ year: 2025, quarter: 2, seed: '25q2', metrics: { spendMicros: 1_000_000, salesMicros: 4_000_000, orders: 1, acos: 0.25, roas: 4 } });
const q3_2025 = await completeQuarter({ year: 2025, quarter: 3, seed: '25q3', metrics: { spendMicros: 2_000_000, salesMicros: 5_000_000, orders: 2, acos: 0.4, roas: 2.5 } });
const q4_2025 = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4', metrics: { spendMicros: 3_000_000, salesMicros: 6_000_000, orders: 3, acos: 0.5, roas: 2 } });
const q1_2026 = await completeQuarter({ year: 2026, quarter: 1, seed: '26q1', metrics: { spendMicros: 4_000_000, salesMicros: 8_000_000, orders: 4, acos: 0.5, roas: 2 } });
const q2_2026 = await completeQuarter({ year: 2026, quarter: 2, seed: '26q2', metrics: { spendMicros: 6_000_000, salesMicros: 12_000_000, orders: 6, acos: 0.5, roas: 2 } });
const ledger = await ledgerFrom(...q2_2025, ...q3_2025, ...q4_2025, ...q1_2026, ...q2_2026);
const transition = await transitionMod.buildHistoricalRolling12WindowTransitionReview(ledger, '2026-Q1-R12', '2026-Q2-R12');

assert.equal(transition.schemaVersion, 'csv-history-rolling-12-window-transition-review-v1');
assert.equal(transition.previousLedgerFingerprint, ledger.ledgerFingerprint);
assert.equal(transition.currentLedgerFingerprint, ledger.ledgerFingerprint);
assert.equal(transition.sameLedgerFingerprint, true);
assert.equal(transition.transitionAllowed, true);
assert.equal(transition.interpretationAllowed, true);
assert.equal(transition.rawEvidenceOnly, false);
assert.equal(transition.transitionSemantics, 'overlap_aware_one_quarter_out_one_quarter_in_three_quarters_shared');
assert.equal(transition.additiveDeltaBasis, 'incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12');
assert.equal(transition.ratioDeltaBasis, 'current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals');
assert.equal(transition.decomposition.outgoingQuarterKey, '2025-Q2');
assert.deepEqual(transition.decomposition.sharedQuarterKeys, ['2025-Q3', '2025-Q4', '2026-Q1']);
assert.equal(transition.decomposition.incomingQuarterKey, '2026-Q2');
assert.equal(transition.decomposition.sharedQuarterCount, 3);
assert.equal(transition.decomposition.overlapMonths, 9);
assert.equal(transition.decomposition.overlapCollapsed, false);
assert.equal(transition.decomposition.sharedQuarterEvidence.length, 3);
assert.equal(transition.decomposition.sharedQuarterEvidence.every((item) => item.canonicalQuarterFingerprintConsistent === true), true);
assert.equal(transition.decomposition.sharedQuarterEvidence.every((item) => item.sourceInputSetFingerprintsConsistent === true), true);
assert.equal(transition.decomposition.sharedQuarterEvidence.every((item) => item.sourceContentSha256sConsistent === true), true);
assert.equal(transition.comparabilityGate.checks.exactlyThreeSharedQuarters, true);
assert.equal(transition.comparabilityGate.checks.exactlyOneOutgoingQuarter, true);
assert.equal(transition.comparabilityGate.checks.exactlyOneIncomingQuarter, true);
assert.equal(transition.comparabilityGate.checks.additiveWindowTransitionIdentityValid, true);
assert.equal(transition.comparabilityGate.checks.ratioWindowTotalsConsistent, true);
assert.equal(transition.comparabilityGate.sharedEvidenceIdentityMustMatch, true);
assert.equal(transition.comparabilityGate.sameQuarterKeyDoesNotImplySameEvidence, true);
assert.deepEqual(transition.comparabilityGate.blockers, []);

const expectedAdditive = {
  spendMicros: { previous: 30_000_000, outgoing: 3_000_000, incoming: 18_000_000, current: 45_000_000, delta: 15_000_000 },
  salesMicros: { previous: 69_000_000, outgoing: 12_000_000, incoming: 36_000_000, current: 93_000_000, delta: 24_000_000 },
  orders: { previous: 30, outgoing: 3, incoming: 18, current: 45, delta: 15 },
  adContributionMicros: { previous: 39_000_000, outgoing: 9_000_000, incoming: 18_000_000, current: 48_000_000, delta: 9_000_000 },
};
for (const [key, expected] of Object.entries(expectedAdditive)) {
  const metric = transition.transitionMetrics.additive[key];
  assert.equal(metric.previousRolling12Value, expected.previous);
  assert.equal(metric.outgoingQuarterValue, expected.outgoing);
  assert.equal(metric.incomingQuarterValue, expected.incoming);
  assert.equal(metric.currentRolling12Value, expected.current);
  assert.equal(metric.rolling12Delta, expected.delta);
  assert.equal(metric.fullWindowDelta, expected.delta);
  assert.equal(metric.interpretationAllowed, true);
}

const previousAcos = 30_000_000 / 69_000_000;
const currentAcos = 45_000_000 / 93_000_000;
const previousRoas = 69_000_000 / 30_000_000;
const currentRoas = 93_000_000 / 45_000_000;
assert.equal(transition.transitionMetrics.ratios.acos.previousRolling12Value, previousAcos);
assert.equal(transition.transitionMetrics.ratios.acos.currentRolling12Value, currentAcos);
assert.equal(transition.transitionMetrics.ratios.acos.rolling12Delta, currentAcos - previousAcos);
assert.equal(transition.transitionMetrics.ratios.acos.incomingOutgoingQuarterRatioDeltaUsed, false);
assert.equal(transition.transitionMetrics.ratios.roas.previousRolling12Value, previousRoas);
assert.equal(transition.transitionMetrics.ratios.roas.currentRolling12Value, currentRoas);
assert.equal(transition.transitionMetrics.ratios.roas.rolling12Delta, currentRoas - previousRoas);
assert.equal(transition.transitionMetrics.ratios.roas.incomingOutgoingQuarterRatioDeltaUsed, false);
assert.equal(transition.crossWindowAggregationApplied, false);
assert.equal(transition.crossWindowNormalizationApplied, false);
assert.equal(transition.overlapCollapseApplied, false);
assert.equal(transition.sharedEvidenceAutoReconciled, false);
assert.equal(transition.gapRepairApplied, false);
assert.equal(transition.windowSelectionAutoReordered, false);
assert.equal(transition.recommendationGenerated, false);
assert.equal(transition.actionGenerated, false);
assert.equal(transition.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(transition.authority);

const q4_2025_drift = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4-drift', metrics: { spendMicros: 3_000_000, salesMicros: 6_000_000, orders: 3, acos: 0.5, roas: 2 } });
const driftCurrentLedger = await ledgerFrom(...q3_2025, ...q4_2025_drift, ...q1_2026, ...q2_2026);
const drifted = await transitionMod.buildHistoricalRolling12WindowTransitionReview(ledger, '2026-Q1-R12', '2026-Q2-R12', { currentLedger: driftCurrentLedger });
assert.equal(drifted.transitionAllowed, false);
assert.equal(drifted.interpretationAllowed, false);
assert.equal(drifted.rawEvidenceOnly, true);
assert.equal(drifted.sameLedgerFingerprint, false);
assert.ok(drifted.comparabilityGate.blockers.includes('shared_quarter_evidence_identity_mismatch'));
assert.ok(drifted.comparabilityGate.blockers.includes('shared_quarter_source_input_set_fingerprint_mismatch'));
assert.ok(drifted.comparabilityGate.blockers.includes('shared_quarter_source_sha256_mismatch'));
const q4Drift = drifted.decomposition.sharedQuarterEvidence.find((item) => item.quarter === '2025-Q4');
assert.ok(q4Drift);
assert.equal(q4Drift.canonicalQuarterFingerprintConsistent, false);
assert.equal(q4Drift.sourceInputSetFingerprintsConsistent, false);
assert.equal(q4Drift.sourceContentSha256sConsistent, false);
assert.notEqual(q4Drift.previousCanonicalQuarterFingerprint, q4Drift.currentCanonicalQuarterFingerprint);
assertTransitionMetricsWithheld(drifted.transitionMetrics);
assert.equal(drifted.rawPreviousWindowEvidence.rawQuarterEvidence.length, 4);
assert.equal(drifted.rawCurrentWindowEvidence.rawQuarterEvidence.length, 4);

const partialCurrentLedger = await ledgerFrom(...q3_2025, ...q4_2025, ...q1_2026, ...q2_2026.slice(0, 2));
const blockedCurrent = await transitionMod.buildHistoricalRolling12WindowTransitionReview(ledger, '2026-Q1-R12', '2026-Q2-R12', { currentLedger: partialCurrentLedger });
assert.equal(blockedCurrent.transitionAllowed, false);
assert.equal(blockedCurrent.interpretationAllowed, false);
assert.equal(blockedCurrent.rawEvidenceOnly, true);
assert.ok(blockedCurrent.comparabilityGate.blockers.includes('current_rolling_12_window_blocked'));
assertTransitionMetricsWithheld(blockedCurrent.transitionMetrics);
assert.equal(blockedCurrent.rawCurrentWindowEvidence.rawEvidenceRetained, true);

const reversed = await transitionMod.buildHistoricalRolling12WindowTransitionReview(ledger, '2026-Q2-R12', '2026-Q1-R12');
assert.equal(reversed.transitionAllowed, false);
assert.equal(reversed.rawEvidenceOnly, true);
assert.ok(reversed.comparabilityGate.blockers.includes('rolling_12_endpoints_not_forward_adjacent_natural_quarters'));
assertTransitionMetricsWithheld(reversed.transitionMetrics);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-rolling-12-window-transition-review-v1',
  overlapAware: true,
  outgoingQuarterExplicit: true,
  incomingQuarterExplicit: true,
  sharedQuarterCountRequired: 3,
  sharedOverlapMonths: 9,
  additiveDeltaUsesIncomingMinusOutgoing: true,
  additiveDeltaEqualsFullRolling12Delta: true,
  ratioDeltaUsesFullRolling12Totals: true,
  incomingOutgoingQuarterRatioDeltaUsed: false,
  sharedCanonicalQuarterFingerprintRequired: true,
  sharedSourceInputSetFingerprintsRequired: true,
  sharedSourceSha256EvidenceRequired: true,
  sameQuarterKeyDoesNotImplySameEvidence: true,
  sharedEvidenceConflictBlocked: true,
  blockedWindowCannotBeUpgraded: true,
  reversedTransitionBlocked: true,
  blockedMetricsWithheld: true,
  rawEvidenceRetained: true,
  overlapCollapseApplied: false,
  sharedEvidenceAutoReconciled: false,
  normalizationApplied: false,
  recommendationGenerated: false,
  actionGenerated: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function assertTransitionMetricsWithheld(metrics) {
  for (const item of Object.values(metrics.additive)) {
    for (const key of ['previousRolling12Value', 'currentRolling12Value', 'outgoingQuarterValue', 'incomingQuarterValue', 'rolling12Delta', 'fullWindowDelta']) assert.equal(item[key], null);
    assert.equal(item.interpretationAllowed, false);
  }
  for (const item of Object.values(metrics.ratios)) {
    for (const key of ['previousRolling12Value', 'currentRolling12Value', 'rolling12Delta']) assert.equal(item[key], null);
    assert.equal(item.incomingOutgoingQuarterRatioDeltaUsed, false);
    assert.equal(item.interpretationAllowed, false);
  }
}
function assertAuthorityFalse(authority) {
  assert.equal(authority.authoritative, false);
  assert.equal(authority.canonicalAmazonIdentityResolved, false);
  assert.equal(authority.governancePersistenceAllowed, false);
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.amazonMutationAuthorized, false);
}
async function completeQuarter({ year, quarter, seed, marketplace = 'US', currencyCode = 'USD', metrics }) {
  const startMonth = (quarter - 1) * 3 + 1;
  const out = [];
  for (let index = 0; index < 3; index += 1) {
    const monthNumber = startMonth + index;
    const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
    const expectedDayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    out.push(await fixture({ seed: `${seed}-${index}`, month, startDate: `${month}-01`, endDate: `${month}-${String(expectedDayCount).padStart(2, '0')}`, expectedDayCount, marketplace, currencyCode, metrics }));
  }
  return out;
}
async function ledgerFrom(...analyses) {
  let ledger = await engine.createCsvHistoryLedger(analyses[0]);
  for (const analysis of analyses.slice(1)) ledger = await engine.mergeCsvHistoryLedger(ledger, analysis);
  return ledger;
}
async function fixture({ seed, month, startDate, endDate, expectedDayCount, marketplace, currencyCode, metrics }) {
  const contentSha256 = await sha256Hex(`${month}:${seed}:${marketplace}:${currencyCode}`);
  const sourceReceipt = { schemaVersion: 'csv-import-v1', reportType: 'spSearchTerm', sourceFileName: `${month}-${seed}.csv`, contentSha256, reportStartDate: startDate, reportEndDate: endDate, rowCount: 10, acceptedRows: 10, rejectedRows: 0, advertiserAccountId: null, profileId: null, marketplace, currencyCode };
  const inputSetFingerprint = await sha256Hex(canonicalJson([{ schemaVersion: sourceReceipt.schemaVersion, reportType: sourceReceipt.reportType, contentSha256, reportStartDate: startDate, reportEndDate: endDate, rowCount: 10 }]));
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: { kind: 'csv_import_set', batchCount: 1, contentSha256s: [contentSha256], inputSetFingerprint, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false },
    range: { startDate, endDate }, imports: [sourceReceipt],
    dataQuality: { authority, qualityState: 'single_window', safeForNaiveAggregation: true, contiguousCoverage: true, summary: { overlapPairCount: 0, gapCount: 0 } },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount: 0, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: { authority, summary: { monthlySnapshotCount: 1, aggregationSafe: true, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false }, monthlySnapshots: [{ periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount: expectedDayCount, factCount: 10, metrics, adContributionMicros: metrics.salesMicros - metrics.spendMicros, profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit', coverage: { expectedDayCount, coveredDayCount: expectedDayCount, coverageRatio: 1, complete: true }, reliability: { state: 'complete_coverage', aggregationSafe: true, coverageComplete: true, analyticalDecisionUse: 'observed_review_only' }, requiresHumanReview: true, persistenceAuthorized: false, executionAuthorized: false, amazonMutationAuthorized: false }] },
    analysis: { authority },
  };
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
