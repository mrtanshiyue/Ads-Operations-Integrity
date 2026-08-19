import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const verificationRelative = 'assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-verification-v1.js';
const receiptRelative = 'assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js';
const verificationSource = await readFile(path.join(distRoot, verificationRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const receiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js?v=1.0.0"></script>';
const verificationTag = '<script type="module" src="assets/cloudflare-native-csv-history-rolling-12-window-transition-receipt-verification-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(verificationTag).length - 1, 1, 'Rolling-12 transition receipt verification asset must be injected exactly once');
assert.ok(indexSource.indexOf(receiptTag) < indexSource.indexOf(verificationTag), 'Rolling-12 transition receipt verification must load after transition receipt');
assert.ok(indexSource.indexOf(verificationTag) < indexSource.indexOf(monthlyReceiptTag), 'Rolling-12 transition receipt verification must load before legacy monthly receipt workflow');
assert.match(verificationSource, /csv-history-rolling-12-window-transition-receipt-verification-v1/);
assert.match(verificationSource, /Rolling-12 Transition Receipt Verification/);
assert.match(verificationSource, /ledger-bound replay · fail closed/);
assert.match(verificationSource, /exact receipt fingerprint plus deterministic serialization equality/);
assert.match(verificationSource, /a second explicit current ledger is required/);
assert.match(verificationSource, /Verification never chooses a newer ledger, reconciles shared-quarter conflicts, upgrades a blocked transition, or grants execution authority/);
assert.match(verificationSource, /standaloneReceiptValidatedFirst: true/);
assert.match(verificationSource, /replayedFromExplicitLocalLedgers: true/);
assert.match(verificationSource, /overlap_aware_one_quarter_out_one_quarter_in_three_quarters_shared/);
assert.match(verificationSource, /incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12/);
assert.match(verificationSource, /current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals/);
assert.match(verificationSource, /overlapCollapseApplied: false/);
assert.match(verificationSource, /sharedEvidenceAutoReconciled: false/);
assert.match(verificationSource, /crossWindowAggregationApplied: false/);
assert.match(verificationSource, /crossWindowNormalizationApplied: false/);
assert.match(verificationSource, /windowSelectionAutoReordered: false/);
assert.match(verificationSource, /recommendationGenerated: false/);
assert.match(verificationSource, /actionGenerated: false/);
assert.match(verificationSource, /sales_minus_ad_spend_only_not_net_profit/);

for (const pattern of [
  /\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /\bWebSocket\b/, /\bEventSource\b/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /CloudflareNativeAPI/, /\/api\/v1\//,
  /CONTROL_DB/, /STORE_01_DB/, /DATA_BUCKET/, /AMAZON_ADS_ENABLED/, /optimization-actions/, /execution-permits/,
]) assert.equal(pattern.test(verificationSource), false, `Rolling-12 transition receipt verification must remain explicit-local and execution-free: ${pattern}`);

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?r12TransitionVerificationEngine=${Date.now()}`);
const helper = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-deterministic-receipt.js')).href}?r12TransitionVerificationHelper=${Date.now()}`);
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, receiptRelative)).href}?r12TransitionVerificationReceipt=${Date.now()}`);
const verificationMod = await import(`${pathToFileURL(path.join(distRoot, verificationRelative)).href}?r12TransitionVerification=${Date.now()}`);

assert.equal(verificationMod.CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_VERIFICATION_SCHEMA_VERSION, 'csv-history-rolling-12-window-transition-receipt-verification-v1');
assert.equal(verificationMod.CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_VERIFICATION_UI_VERSION, '1.0.0');
assert.equal(typeof verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers, 'function');

const q2_2025 = await completeQuarter({ year: 2025, quarter: 2, seed: '25q2', metrics: { spendMicros: 1_000_000, salesMicros: 4_000_000, orders: 1, acos: 0.25, roas: 4 } });
const q3_2025 = await completeQuarter({ year: 2025, quarter: 3, seed: '25q3', metrics: { spendMicros: 2_000_000, salesMicros: 5_000_000, orders: 2, acos: 0.4, roas: 2.5 } });
const q4_2025 = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4', metrics: { spendMicros: 3_000_000, salesMicros: 6_000_000, orders: 3, acos: 0.5, roas: 2 } });
const q1_2026 = await completeQuarter({ year: 2026, quarter: 1, seed: '26q1', metrics: { spendMicros: 4_000_000, salesMicros: 8_000_000, orders: 4, acos: 0.5, roas: 2 } });
const q2_2026 = await completeQuarter({ year: 2026, quarter: 2, seed: '26q2', metrics: { spendMicros: 6_000_000, salesMicros: 12_000_000, orders: 6, acos: 0.5, roas: 2 } });
const ledger = await ledgerFrom(...q2_2025, ...q3_2025, ...q4_2025, ...q1_2026, ...q2_2026);

const receipt = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q1-R12', '2026-Q2-R12');
const verification = await verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(ledger, receipt);
assert.equal(verification.schemaVersion, 'csv-history-rolling-12-window-transition-receipt-verification-v1');
assert.equal(verification.verificationState, 'verified_against_explicit_local_ledgers');
assert.equal(verification.receiptFingerprint, receipt.receiptFingerprint);
assert.equal(verification.recomputedReceiptFingerprint, receipt.receiptFingerprint);
assert.equal(verification.previousLedgerFingerprint, ledger.ledgerFingerprint);
assert.equal(verification.currentLedgerFingerprint, ledger.ledgerFingerprint);
assert.equal(verification.sameLedgerFingerprint, true);
assert.equal(verification.distinctCurrentLedgerRequired, false);
assert.equal(verification.distinctCurrentLedgerProvided, false);
assert.equal(verification.previousWindowKey, '2026-Q1-R12');
assert.equal(verification.currentWindowKey, '2026-Q2-R12');
assert.equal(verification.outgoingQuarterKey, '2025-Q2');
assert.equal(verification.incomingQuarterKey, '2026-Q2');
assert.deepEqual(verification.sharedQuarterKeys, ['2025-Q3', '2025-Q4', '2026-Q1']);
assert.equal(verification.sharedQuarterBindings.length, 3);
assert.deepEqual(verification.sharedQuarterBindings, receipt.source.sharedQuarterBindings);
assert.equal(verification.transitionAllowed, true);
assert.equal(verification.interpretationAllowed, true);
assert.equal(verification.rawEvidenceOnly, false);
assert.equal(verification.receiptFingerprintMatch, true);
assert.equal(verification.receiptSerializationMatch, true);
assert.equal(verification.generatedTimestampIncluded, false);
assert.equal(verification.standaloneReceiptValidatedFirst, true);
assert.equal(verification.replayedFromExplicitLocalLedgers, true);
assert.equal(verification.transitionSemantics, 'overlap_aware_one_quarter_out_one_quarter_in_three_quarters_shared');
assert.equal(verification.additiveDeltaBasis, 'incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12');
assert.equal(verification.ratioDeltaBasis, 'current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals');
assert.equal(verification.overlapCollapseApplied, false);
assert.equal(verification.sharedEvidenceAutoReconciled, false);
assert.equal(verification.crossWindowAggregationApplied, false);
assert.equal(verification.crossWindowNormalizationApplied, false);
assert.equal(verification.windowSelectionAutoReordered, false);
assert.equal(verification.recommendationGenerated, false);
assert.equal(verification.actionGenerated, false);
assert.equal(verification.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(verification.authority);
assert.equal(Object.isFrozen(verification), true);

const blockedReceipt = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q2-R12', '2026-Q1-R12');
const blockedVerification = await verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(ledger, blockedReceipt);
assert.equal(blockedVerification.verificationState, 'verified_against_explicit_local_ledgers');
assert.equal(blockedVerification.transitionAllowed, false);
assert.equal(blockedVerification.interpretationAllowed, false);
assert.equal(blockedVerification.rawEvidenceOnly, true);
assert.equal(blockedVerification.previousWindowKey, '2026-Q2-R12');
assert.equal(blockedVerification.currentWindowKey, '2026-Q1-R12');
assert.equal(blockedVerification.receiptFingerprintMatch, true);
assert.equal(blockedVerification.receiptSerializationMatch, true);
assert.equal(blockedVerification.windowSelectionAutoReordered, false);
assertAuthorityFalse(blockedVerification.authority);

const q4_2025_drift = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4-drift', metrics: { spendMicros: 3_000_000, salesMicros: 6_000_000, orders: 3, acos: 0.5, roas: 2 } });
const driftCurrentLedger = await ledgerFrom(...q3_2025, ...q4_2025_drift, ...q1_2026, ...q2_2026);
const driftReceipt = await receiptMod.buildHistoricalRolling12WindowTransitionReceipt(ledger, '2026-Q1-R12', '2026-Q2-R12', { currentLedger: driftCurrentLedger });
assert.equal(driftReceipt.transition.transitionAllowed, false);
assert.notEqual(driftReceipt.source.previousLedgerFingerprint, driftReceipt.source.currentLedgerFingerprint);
await assert.rejects(
  () => verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(ledger, driftReceipt),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_VERIFICATION_CURRENT_LEDGER_REQUIRED',
  'A receipt bound to two ledger fingerprints must require the explicit current ledger',
);
const driftVerification = await verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(ledger, driftReceipt, { currentLedger: driftCurrentLedger });
assert.equal(driftVerification.verificationState, 'verified_against_explicit_local_ledgers');
assert.equal(driftVerification.previousLedgerFingerprint, ledger.ledgerFingerprint);
assert.equal(driftVerification.currentLedgerFingerprint, driftCurrentLedger.ledgerFingerprint);
assert.equal(driftVerification.sameLedgerFingerprint, false);
assert.equal(driftVerification.distinctCurrentLedgerRequired, true);
assert.equal(driftVerification.distinctCurrentLedgerProvided, true);
assert.equal(driftVerification.transitionAllowed, false);
assert.equal(driftVerification.interpretationAllowed, false);
assert.equal(driftVerification.rawEvidenceOnly, true);
assert.equal(driftVerification.receiptFingerprintMatch, true);
assert.equal(driftVerification.receiptSerializationMatch, true);
const q4Binding = driftVerification.sharedQuarterBindings.find((item) => item.quarter === '2025-Q4');
assert.ok(q4Binding);
assert.notEqual(q4Binding.previousCanonicalQuarterFingerprint, q4Binding.currentCanonicalQuarterFingerprint);
assert.notDeepEqual(q4Binding.previousSourceInputSetFingerprints, q4Binding.currentSourceInputSetFingerprints);
assert.notDeepEqual(q4Binding.previousSourceContentSha256s, q4Binding.currentSourceContentSha256s);
assertAuthorityFalse(driftVerification.authority);

await assert.rejects(
  () => verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(driftCurrentLedger, receipt),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_VERIFICATION_PREVIOUS_LEDGER_FINGERPRINT_MISMATCH',
  'A different valid previous ledger must fail before replay verification',
);
await assert.rejects(
  () => verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(ledger, driftReceipt, { currentLedger: ledger }),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_VERIFICATION_CURRENT_LEDGER_FINGERPRINT_MISMATCH',
  'A different valid current ledger must fail before replay verification',
);

const tampered = JSON.parse(receiptMod.serializeHistoricalRolling12WindowTransitionReceipt(receipt));
tampered.transition.transitionMetrics.additive.salesMicros.currentRolling12Value += 1;
await assert.rejects(
  () => verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(ledger, tampered),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_ADDITIVE_TRANSITION_INVALID' || error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_FINGERPRINT_MISMATCH',
  'Standalone receipt tampering must fail before ledger replay verification',
);

const rebound = JSON.parse(receiptMod.serializeHistoricalRolling12WindowTransitionReceipt(receipt));
rebound.source.previousLedgerFingerprint = '0'.repeat(64);
delete rebound.receiptFingerprint;
rebound.receiptFingerprint = await helper.fingerprintDeterministicReceiptPayload(rebound);
await assert.rejects(
  () => verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(ledger, rebound),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_PREVIOUS_LEDGER_BINDING_MISMATCH',
  'A re-fingerprinted ledger-binding drift must fail standalone receipt validation before replay',
);

const escalated = JSON.parse(receiptMod.serializeHistoricalRolling12WindowTransitionReceipt(receipt));
escalated.authority.executionAuthorized = true;
await assert.rejects(
  () => verificationMod.verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(ledger, escalated),
  (error) => error?.code === 'CSV_HISTORY_R12_TRANSITION_RECEIPT_AUTHORITY_ESCALATION_BLOCKED',
  'Verification must reject receipt authority escalation before replay',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-rolling-12-window-transition-receipt-verification-v1',
  standaloneReceiptValidationFirst: true,
  explicitPreviousLedgerBinding: true,
  explicitDistinctCurrentLedgerBinding: true,
  distinctCurrentLedgerRequiredWhenFingerprintsDiffer: true,
  exactReceiptFingerprintReplayMatch: true,
  exactReceiptSerializationReplayMatch: true,
  allowedReceiptVerified: true,
  blockedRawEvidenceReceiptVerifiedWithoutUpgrade: true,
  sharedEvidenceConflictReceiptVerifiedWithoutReconciliation: true,
  previousLedgerDriftBlocked: true,
  currentLedgerDriftBlocked: true,
  receiptTamperingBlocked: true,
  refingerprintedLedgerBindingDriftBlocked: true,
  authorityEscalationBlocked: true,
  generatedTimestampIncluded: false,
  overlapCollapseApplied: false,
  sharedEvidenceAutoReconciled: false,
  crossWindowAggregationApplied: false,
  crossWindowNormalizationApplied: false,
  windowSelectionAutoReordered: false,
  recommendationGenerated: false,
  actionGenerated: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

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
