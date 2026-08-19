import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const assetRelative = 'assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js';
const helperRelative = 'assets/csv-analysis-engine/csv-history-deterministic-receipt.js';
const assetSource = await readFile(path.join(distRoot, assetRelative), 'utf8');
const helperSource = await readFile(path.join(distRoot, helperRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const transitionTag = '<script type="module" src="assets/cloudflare-native-csv-history-rolling-12-window-transition-review-v1.js?v=1.0.0"></script>';
const receiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(receiptTag).length - 1, 1, 'Rolling-12 transition receipt asset must be injected exactly once');
assert.ok(indexSource.indexOf(transitionTag) < indexSource.indexOf(receiptTag), 'Rolling-12 transition receipt must load after transition review');
assert.ok(indexSource.indexOf(receiptTag) < indexSource.indexOf(monthlyReceiptTag), 'Rolling-12 transition receipt must load before legacy monthly receipt workflow');
assert.match(assetSource, /csv-history-rolling-12-window-transition-receipt-v1/);
assert.match(assetSource, /Rolling-12 Transition Receipt/);
assert.match(assetSource, /local replay · deterministic/);
assert.match(assetSource, /generatedTimestampIncluded: false/);
assert.match(assetSource, /transitionRecomputedFromLedgerEvidence: true/);
assert.match(assetSource, /previousAndCurrentLedgerEvidenceBound: true/);
assert.match(assetSource, /sharedQuarterEvidenceIdentityBound: true/);
assert.match(assetSource, /Same quarter key does not imply same evidence/);
assert.match(assetSource, /Blocked transitions remain exportable as raw-evidence-only receipts with all transition metrics withheld/);
assert.match(assetSource, /incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12/);
assert.match(assetSource, /current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals/);
assert.match(assetSource, /sharedQuarterBindings/);
assert.match(helperSource, /csv-history-number-projection-v1/);
assert.match(helperSource, /fingerprintDeterministicReceiptPayload/);
assert.match(helperSource, /serializeDeterministicReceiptJson/);

for (const source of [assetSource, helperSource]) {
  for (const pattern of [
    /\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /\bWebSocket\b/, /\bEventSource\b/,
    /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /CloudflareNativeAPI/, /\/api\/v1\//,
    /CONTROL_DB/, /STORE_01_DB/, /DATA_BUCKET/, /AMAZON_ADS_ENABLED/, /optimization-actions/, /execution-permits/,
  ]) assert.equal(pattern.test(source), false, `Rolling-12 transition receipt must remain local-only and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?r12TransitionReceiptEngine=${Date.now()}`);
const helper = await import(`${pathToFileURL(path.join(distRoot, helperRelative)).href}?r12TransitionReceiptHelper=${Date.now()}`);
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, assetRelative)).href}?r12TransitionReceipt=${Date.now()}`);

assert.equal(receiptMod.CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_SCHEMA_VERSION, 'csv-history-rolling-12-window-transition-receipt-v1');
assert.equal(receiptMod.CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_UI_VERSION, '1.0.0');
assert.equal(typeof receiptMod.buildHistoricalRolling12WindowTransitionReceipt, 'function');
assert.equal(typeof receiptMod.validateHistoricalRolling12WindowTransitionReceipt, 'function');
assert.equal(typeof receiptMod.parseHistoricalRolling12WindowTransitionReceipt, 'function');
assert.equal(typeof receiptMod.serializeHistoricalRolling12WindowTransitionReceipt, 'function');

const q2_2025 = await completeQuarter({ year: 2025, quarter: 2, seed: '25q2', metrics: { spendMicros: 1_000_000, salesMicros: 4_000_000, orders: 1, acos: 0.25, roas: 4 } });
const q3_2025 = await completeQuarter({ year: 2025, quarter: 3, seed: '25q3', metrics: { spendMicros: 2_000_000, salesMicros: 5_000_000, orders: 2, acos: 0.4, roas: 2.5 } });
const q4_2025 = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4', metrics: { spendMicros: 3_000_000, salesMicros: 6_000_000, orders: 3, acos: 0.5, roas: 2 } });
const q1_2026 = await completeQuarter({ year: 2026, quarter: 1, seed: '26q1', metrics: { spendMicros: 4_000_000, salesMicros: 8_000_000, orders: 4, acos: 0.5, roas: 2 } });
const q2_2026 = await completeQuarter({ year: 2026, quarter: 2, seed: '26q2', metrics: { spendMicros: 6_000_000, salesMicros: 12_000_000, orders: 6, acos: 0.5, roas: 2 } });
const ledger = await ledgerFrom(...q2_2025, ...q3_2025, ...q4_2025, ...q1_2026, ...q2_2026);

const receipt1 = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q1-R12', '2026-Q2-R12');
const receipt2 = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q1-R12', '2026-Q2-R12');
assert.equal(receipt1.schemaVersion, 'csv-history-rolling-12-window-transition-receipt-v1');
assert.equal(receipt1.receiptPurpose, 'local_historical_rolling_12_window_transition_audit_only');
assert.match(receipt1.receiptFingerprint, /^[a-f0-9]{64}$/);
assert.equal(receipt1.receiptFingerprint, receipt2.receiptFingerprint, 'Same ledger evidence and window selections must reproduce the same transition receipt fingerprint');
assert.equal(receipt1.deterministic.generatedTimestampIncluded, false);
assert.equal(receipt1.deterministic.canonicalProjectionVersion, 'csv-history-number-projection-v1');
assert.equal(receipt1.deterministic.transitionRecomputedFromLedgerEvidence, true);
assert.equal(receipt1.deterministic.previousAndCurrentLedgerEvidenceBound, true);
assert.equal(receipt1.deterministic.sharedQuarterEvidenceIdentityBound, true);
assert.equal(Object.prototype.hasOwnProperty.call(receipt1, 'generatedAt'), false);
assert.equal(receipt1.source.previousLedgerFingerprint, ledger.ledgerFingerprint);
assert.equal(receipt1.source.currentLedgerFingerprint, ledger.ledgerFingerprint);
assert.equal(receipt1.source.previousWindowKey, '2026-Q1-R12');
assert.equal(receipt1.source.currentWindowKey, '2026-Q2-R12');
assert.equal(receipt1.source.outgoingQuarterKey, '2025-Q2');
assert.equal(receipt1.source.incomingQuarterKey, '2026-Q2');
assert.deepEqual(receipt1.source.sharedQuarterKeys, ['2025-Q3', '2025-Q4', '2026-Q1']);
assert.equal(receipt1.source.sharedQuarterBindings.length, 3);
assert.equal(receipt1.source.sharedQuarterBindings.every((item) => /^[a-f0-9]{64}$/.test(item.previousCanonicalQuarterFingerprint)), true);
assert.equal(receipt1.source.sharedQuarterBindings.every((item) => item.previousCanonicalQuarterFingerprint === item.currentCanonicalQuarterFingerprint), true);
assert.deepEqual(receipt1.source.previousWindowSourceInputSetFingerprints, receipt1.transition.previousWindow.sourceInputSetFingerprints);
assert.deepEqual(receipt1.source.currentWindowSourceInputSetFingerprints, receipt1.transition.currentWindow.sourceInputSetFingerprints);
assert.equal(receipt1.source.outgoingCanonicalQuarterFingerprint, receipt1.transition.decomposition.outgoingQuarter.canonicalQuarterFingerprint);
assert.equal(receipt1.source.incomingCanonicalQuarterFingerprint, receipt1.transition.decomposition.incomingQuarter.canonicalQuarterFingerprint);
assert.equal(receipt1.transition.transitionAllowed, true);
assert.equal(receipt1.transition.interpretationAllowed, true);
assert.equal(receipt1.transition.rawEvidenceOnly, false);
assert.equal(receipt1.transition.decomposition.sharedQuarterCount, 3);
assert.equal(receipt1.transition.decomposition.overlapMonths, 9);
assert.equal(receipt1.transition.transitionMetrics.additive.spendMicros.rolling12Delta, 15_000_000);
assert.equal(receipt1.transition.transitionMetrics.additive.salesMicros.rolling12Delta, 24_000_000);
assert.equal(receipt1.transition.transitionMetrics.additive.orders.rolling12Delta, 15);
assert.equal(receipt1.transition.transitionMetrics.additive.adContributionMicros.rolling12Delta, 9_000_000);
assert.equal(receipt1.transition.transitionMetrics.ratios.acos.incomingOutgoingQuarterRatioDeltaUsed, false);
assert.equal(receipt1.transition.transitionMetrics.ratios.roas.incomingOutgoingQuarterRatioDeltaUsed, false);
assert.equal(receipt1.transition.overlapCollapseApplied, false);
assert.equal(receipt1.transition.sharedEvidenceAutoReconciled, false);
assert.equal(receipt1.transition.windowSelectionAutoReordered, false);
assert.equal(receipt1.transition.recommendationGenerated, false);
assert.equal(receipt1.transition.actionGenerated, false);
assert.equal(receipt1.transition.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(receipt1.authority);
assertAuthorityFalse(receipt1.transition.authority);
assert.equal(Object.isFrozen(receipt1), true);

const serialized1 = receiptMod.serializeHistoricalRolling12WindowTransitionReceipt(receipt1);
const serialized2 = receiptMod.serializeHistoricalRolling12WindowTransitionReceipt(receipt2);
assert.equal(serialized1, serialized2, 'Transition receipt serialization must be deterministic');
const parsed = await receiptMod.parseHistoricalRolling12WindowTransitionReceipt(serialized1);
assert.equal(parsed.receiptFingerprint, receipt1.receiptFingerprint);
assert.deepEqual(parsed.source, receipt1.source);
assert.equal(receiptMod.serializeHistoricalRolling12WindowTransitionReceipt(parsed), serialized1, 'Validated transition receipt must round-trip without serialization drift');

const reversed = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q2-R12', '2026-Q1-R12');
assert.match(reversed.receiptFingerprint, /^[a-f0-9]{64}$/);
assert.equal(reversed.transition.transitionAllowed, false);
assert.equal(reversed.transition.interpretationAllowed, false);
assert.equal(reversed.transition.rawEvidenceOnly, true);
assert.ok(reversed.transition.comparabilityGate.blockers.includes('rolling_12_endpoints_not_forward_adjacent_natural_quarters'));
assertTransitionMetricsWithheld(reversed.transition.transitionMetrics);
assert.doesNotThrow(() => receiptMod.serializeHistoricalRolling12WindowTransitionReceipt(reversed), 'Blocked transition must remain exportable as an audit receipt');

const q4_2025_drift = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4-drift', metrics: { spendMicros: 3_000_000, salesMicros: 6_000_000, orders: 3, acos: 0.5, roas: 2 } });
const driftCurrentLedger = await ledgerFrom(...q3_2025, ...q4_2025_drift, ...q1_2026, ...q2_2026);
const driftReceipt1 = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q1-R12', '2026-Q2-R12', { currentLedger: driftCurrentLedger });
const driftReceipt2 = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q1-R12', '2026-Q2-R12', { currentLedger: driftCurrentLedger });
assert.equal(driftReceipt1.receiptFingerprint, driftReceipt2.receiptFingerprint, 'Blocked cross-ledger evidence drift must still produce deterministic audit receipts');
assert.equal(driftReceipt1.source.previousLedgerFingerprint, ledger.ledgerFingerprint);
assert.equal(driftReceipt1.source.currentLedgerFingerprint, driftCurrentLedger.ledgerFingerprint);
assert.notEqual(driftReceipt1.source.previousLedgerFingerprint, driftReceipt1.source.currentLedgerFingerprint);
assert.equal(driftReceipt1.transition.transitionAllowed, false);
assert.ok(driftReceipt1.transition.comparabilityGate.blockers.includes('shared_quarter_evidence_identity_mismatch'));
assert.ok(driftReceipt1.transition.comparabilityGate.blockers.includes('shared_quarter_source_input_set_fingerprint_mismatch'));
assert.ok(driftReceipt1.transition.comparabilityGate.blockers.includes('shared_quarter_source_sha256_mismatch'));
const q4Binding = driftReceipt1.source.sharedQuarterBindings.find((item) => item.quarter === '2025-Q4');
assert.ok(q4Binding);
assert.notEqual(q4Binding.previousCanonicalQuarterFingerprint, q4Binding.currentCanonicalQuarterFingerprint);
assert.notDeepEqual(q4Binding.previousSourceInputSetFingerprints, q4Binding.currentSourceInputSetFingerprints);
assert.notDeepEqual(q4Binding.previousSourceContentSha256s, q4Binding.currentSourceContentSha256s);
assertTransitionMetricsWithheld(driftReceipt1.transition.transitionMetrics);
assert.doesNotThrow(() => receiptMod.serializeHistoricalRolling12WindowTransitionReceipt(driftReceipt1));

const tampered = JSON.parse(serialized1);
tampered.transition.transitionMetrics.additive.salesMicros.currentRolling12Value += 1;
await assert.rejects(
  () => receiptMod.validateHistoricalRolling12WindowTransitionReceipt(tampered),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_ADDITIVE_TRANSITION_INVALID' || error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_FINGERPRINT_MISMATCH',
  'Transition metric tampering must fail closed',
);

const escalated = JSON.parse(serialized1);
escalated.authority.executionAuthorized = true;
await assert.rejects(
  () => receiptMod.validateHistoricalRolling12WindowTransitionReceipt(escalated),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_AUTHORITY_ESCALATION_BLOCKED',
  'Receipt authority escalation must fail closed',
);

const bindingDrift = JSON.parse(serialized1);
bindingDrift.source.previousWindowKey = '2025-Q4-R12';
delete bindingDrift.receiptFingerprint;
bindingDrift.receiptFingerprint = await helper.fingerprintDeterministicReceiptPayload(bindingDrift);
await assert.rejects(
  () => receiptMod.validateHistoricalRolling12WindowTransitionReceipt(bindingDrift),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_PREVIOUS_WINDOW_BINDING_MISMATCH',
  'A valid fingerprint cannot legitimize source binding drift',
);

const sharedBindingDrift = JSON.parse(serialized1);
sharedBindingDrift.source.sharedQuarterBindings[1].previousCanonicalQuarterFingerprint = '0'.repeat(64);
delete sharedBindingDrift.receiptFingerprint;
sharedBindingDrift.receiptFingerprint = await helper.fingerprintDeterministicReceiptPayload(sharedBindingDrift);
await assert.rejects(
  () => receiptMod.validateHistoricalRolling12WindowTransitionReceipt(sharedBindingDrift),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_SHARED_EVIDENCE_BINDING_MISMATCH',
  'A valid fingerprint cannot legitimize shared-quarter evidence binding drift',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-rolling-12-window-transition-receipt-v1',
  deterministicReceiptFingerprint: true,
  deterministicSerialization: true,
  generatedTimestampIncluded: false,
  transitionRecomputedFromLedgerEvidence: true,
  previousAndCurrentLedgerEvidenceBound: true,
  outgoingIncomingQuarterIdentitiesBound: true,
  sharedQuarterEvidenceIdentityBound: true,
  allowedTransitionReceipt: true,
  blockedTransitionReceiptExportable: true,
  crossLedgerSharedEvidenceConflictReceiptExportable: true,
  blockedTransitionMetricsWithheld: true,
  incomingOutgoingQuarterRatioDeltaUsed: false,
  tamperDetection: true,
  sourceBindingDriftBlocked: true,
  sharedEvidenceBindingDriftBlocked: true,
  authorityEscalationBlocked: true,
  overlapCollapseApplied: false,
  sharedEvidenceAutoReconciled: false,
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
