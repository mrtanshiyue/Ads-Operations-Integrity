import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const verificationRelative = 'assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-verification-v1.js';
const receiptRelative = 'assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-v1.js';
const verificationSource = await readFile(path.join(distRoot, verificationRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const receiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-v1.js?v=1.0.0"></script>';
const verificationTag = '<script type="module" src="assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-verification-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(verificationTag).length - 1, 1, 'QoQ receipt verification asset must be injected exactly once');
assert.ok(indexSource.indexOf(receiptTag) < indexSource.indexOf(verificationTag), 'QoQ receipt verification must load after QoQ receipt builder');
assert.ok(indexSource.indexOf(verificationTag) < indexSource.indexOf(monthlyReceiptTag), 'QoQ receipt verification must load before monthly historical receipt workflow');
assert.match(verificationSource, /csv-history-quarter-over-quarter-comparison-receipt-verification-v1/);
assert.match(verificationSource, /QoQ Receipt Verification/);
assert.match(verificationSource, /ledger-bound replay/);
assert.match(verificationSource, /exact fingerprint and deterministic serialization equality/);
assert.match(verificationSource, /verification never upgrades comparability or execution authority/);
assert.match(verificationSource, /generatedTimestampIncluded: false/);
assert.match(verificationSource, /replayedFromExplicitLocalLedger: true/);
assert.match(verificationSource, /quarter_b_minus_quarter_a/);
assert.match(verificationSource, /operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder/);
assert.match(verificationSource, /crossQuarterAggregationApplied: false/);
assert.match(verificationSource, /crossQuarterNormalizationApplied: false/);
assert.match(verificationSource, /quarterSelectionAutoReordered: false/);
assert.match(verificationSource, /sales_minus_ad_spend_only_not_net_profit/);

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
]) {
  assert.equal(pattern.test(verificationSource), false, `QoQ receipt verification must remain explicit-local and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?qoqVerificationEngine=${Date.now()}`);
const helper = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-deterministic-receipt.js')).href}?qoqVerificationHelper=${Date.now()}`);
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, receiptRelative)).href}?qoqVerificationReceipt=${Date.now()}`);
const verificationMod = await import(`${pathToFileURL(path.join(distRoot, verificationRelative)).href}?qoqVerification=${Date.now()}`);

assert.equal(verificationMod.CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION, 'csv-history-quarter-over-quarter-comparison-receipt-verification-v1');
assert.equal(verificationMod.CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION, '1.0.0');
assert.equal(typeof verificationMod.verifyHistoricalQuarterOverQuarterComparisonReceiptAgainstLedger, 'function');

const q1 = await completeQuarter({
  year: 2026,
  quarter: 1,
  hashChars: ['a', 'b', 'c'],
  metrics: { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
});
const q2 = await completeQuarter({
  year: 2026,
  quarter: 2,
  hashChars: ['d', 'e', 'f'],
  metrics: { spendMicros: 5_000_000, salesMicros: 12_000_000, orders: 4, acos: 5 / 12, roas: 2.4 },
});
const ledger = await ledgerFrom(...q1, ...q2);
const receipt = await receiptMod.buildHistoricalQuarterOverQuarterComparisonReceipt(ledger, '2026-Q1', '2026-Q2');
const verification = await verificationMod.verifyHistoricalQuarterOverQuarterComparisonReceiptAgainstLedger(ledger, receipt);

assert.equal(verification.schemaVersion, 'csv-history-quarter-over-quarter-comparison-receipt-verification-v1');
assert.equal(verification.verificationState, 'verified_against_local_ledger');
assert.equal(verification.receiptFingerprint, receipt.receiptFingerprint);
assert.equal(verification.recomputedReceiptFingerprint, receipt.receiptFingerprint);
assert.equal(verification.ledgerFingerprint, ledger.ledgerFingerprint);
assert.equal(verification.periodAQuarter, '2026-Q1');
assert.equal(verification.periodBQuarter, '2026-Q2');
assert.deepEqual(verification.periodASourceInputSetFingerprints, receipt.source.periodASourceInputSetFingerprints);
assert.deepEqual(verification.periodBSourceInputSetFingerprints, receipt.source.periodBSourceInputSetFingerprints);
assert.equal(verification.comparisonAllowed, true);
assert.equal(verification.interpretationAllowed, true);
assert.equal(verification.rawEvidenceOnly, false);
assert.equal(verification.receiptFingerprintMatch, true);
assert.equal(verification.receiptSerializationMatch, true);
assert.equal(verification.generatedTimestampIncluded, false);
assert.equal(verification.replayedFromExplicitLocalLedger, true);
assert.equal(verification.deltaBasis, 'quarter_b_minus_quarter_a');
assert.equal(verification.selectionPolicy, 'operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder');
assert.equal(verification.crossQuarterAggregationApplied, false);
assert.equal(verification.crossQuarterNormalizationApplied, false);
assert.equal(verification.quarterSelectionAutoReordered, false);
assert.equal(verification.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(verification.authority);
assert.equal(Object.isFrozen(verification), true);

const blockedReceipt = await receiptMod.buildHistoricalQuarterOverQuarterComparisonReceipt(ledger, '2026-Q2', '2026-Q1');
const blockedVerification = await verificationMod.verifyHistoricalQuarterOverQuarterComparisonReceiptAgainstLedger(ledger, blockedReceipt);
assert.equal(blockedVerification.verificationState, 'verified_against_local_ledger');
assert.equal(blockedVerification.comparisonAllowed, false);
assert.equal(blockedVerification.interpretationAllowed, false);
assert.equal(blockedVerification.rawEvidenceOnly, true);
assert.equal(blockedVerification.periodAQuarter, '2026-Q2');
assert.equal(blockedVerification.periodBQuarter, '2026-Q1');
assert.equal(blockedVerification.quarterSelectionAutoReordered, false);
assert.equal(blockedVerification.receiptFingerprintMatch, true);
assert.equal(blockedVerification.receiptSerializationMatch, true);
assertAuthorityFalse(blockedVerification.authority);

const otherQ1 = await completeQuarter({
  year: 2026,
  quarter: 1,
  hashChars: ['1', '2', '3'],
  metrics: { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
});
const otherQ2 = await completeQuarter({
  year: 2026,
  quarter: 2,
  hashChars: ['4', '5', '6'],
  metrics: { spendMicros: 5_000_000, salesMicros: 12_000_000, orders: 4, acos: 5 / 12, roas: 2.4 },
});
const otherLedger = await ledgerFrom(...otherQ1, ...otherQ2);
await assert.rejects(
  () => verificationMod.verifyHistoricalQuarterOverQuarterComparisonReceiptAgainstLedger(otherLedger, receipt),
  (error) => error?.code === 'CSV_HISTORY_QOQ_RECEIPT_LEDGER_FINGERPRINT_MISMATCH',
  'A different valid ledger must fail the receipt ledger binding before replay authority can be claimed',
);

const tampered = JSON.parse(receiptMod.serializeHistoricalQuarterOverQuarterComparisonReceipt(receipt));
tampered.comparison.metrics.salesMicros.periodBValue += 1;
await assert.rejects(
  () => verificationMod.verifyHistoricalQuarterOverQuarterComparisonReceiptAgainstLedger(ledger, tampered),
  (error) => error?.code === 'CSV_HISTORY_QOQ_RECEIPT_FINGERPRINT_MISMATCH',
  'Standalone receipt tampering must fail before replay verification',
);

const rebound = JSON.parse(receiptMod.serializeHistoricalQuarterOverQuarterComparisonReceipt(receipt));
rebound.source.periodAQuarter = '2025-Q4';
delete rebound.receiptFingerprint;
rebound.receiptFingerprint = await helper.fingerprintDeterministicReceiptPayload(rebound);
await assert.rejects(
  () => verificationMod.verifyHistoricalQuarterOverQuarterComparisonReceiptAgainstLedger(ledger, rebound),
  (error) => error?.code === 'CSV_HISTORY_QOQ_RECEIPT_PERIOD_A_BINDING_MISMATCH',
  'A re-fingerprinted quarter-binding drift must fail standalone receipt validation before replay',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-quarter-over-quarter-comparison-receipt-verification-v1',
  explicitLocalLedgerReplay: true,
  standaloneReceiptValidationFirst: true,
  exactReceiptFingerprintReplayMatch: true,
  exactReceiptSerializationReplayMatch: true,
  allowedReceiptVerified: true,
  blockedRawEvidenceReceiptVerifiedWithoutUpgrade: true,
  ledgerDriftBlocked: true,
  receiptTamperingBlocked: true,
  refingerprintedQuarterBindingDriftBlocked: true,
  generatedTimestampIncluded: false,
  crossQuarterAggregationApplied: false,
  crossQuarterNormalizationApplied: false,
  quarterSelectionAutoReordered: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

async function completeQuarter({ year, quarter, hashChars, metrics }) {
  const startMonth = (quarter - 1) * 3 + 1;
  const out = [];
  for (let index = 0; index < 3; index += 1) {
    const monthNumber = startMonth + index;
    const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
    const expectedDayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    out.push(await fixture({
      hashChar: hashChars[index],
      month,
      startDate: `${month}-01`,
      endDate: `${month}-${String(expectedDayCount).padStart(2, '0')}`,
      expectedDayCount,
      metrics,
    }));
  }
  return out;
}

async function ledgerFrom(...analyses) {
  let ledger = await engine.createCsvHistoryLedger(analyses[0]);
  for (const analysis of analyses.slice(1)) ledger = await engine.mergeCsvHistoryLedger(ledger, analysis);
  return ledger;
}

function assertAuthorityFalse(authority) {
  assert.equal(authority.authoritative, false);
  assert.equal(authority.canonicalAmazonIdentityResolved, false);
  assert.equal(authority.governancePersistenceAllowed, false);
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.amazonMutationAuthorized, false);
}

async function fixture({ hashChar, month, startDate, endDate, expectedDayCount, metrics }) {
  const contentSha256 = hashChar.repeat(64);
  const sourceReceipt = {
    schemaVersion: 'csv-import-v1',
    reportType: 'spSearchTerm',
    sourceFileName: `${month}-${hashChar}.csv`,
    contentSha256,
    reportStartDate: startDate,
    reportEndDate: endDate,
    rowCount: 10,
    acceptedRows: 10,
    rejectedRows: 0,
    advertiserAccountId: null,
    profileId: null,
    marketplace: 'US',
    currencyCode: 'USD',
  };
  const fingerprintPayload = [{
    schemaVersion: sourceReceipt.schemaVersion,
    reportType: sourceReceipt.reportType,
    contentSha256: sourceReceipt.contentSha256,
    reportStartDate: sourceReceipt.reportStartDate,
    reportEndDate: sourceReceipt.reportEndDate,
    rowCount: sourceReceipt.rowCount,
  }];
  const inputSetFingerprint = await sha256Hex(canonicalJson(fingerprintPayload));
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: {
      kind: 'csv_import_set', batchCount: 1, contentSha256s: [contentSha256], inputSetFingerprint,
      canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false,
    },
    range: { startDate, endDate },
    imports: [sourceReceipt],
    dataQuality: {
      authority, qualityState: 'single_window', safeForNaiveAggregation: true, contiguousCoverage: true,
      summary: { overlapPairCount: 0, gapCount: 0 },
    },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount: 0, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: {
      authority,
      summary: { monthlySnapshotCount: 1, aggregationSafe: true, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false },
      monthlySnapshots: [{
        periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount: expectedDayCount, factCount: 10,
        metrics,
        adContributionMicros: metrics.salesMicros - metrics.spendMicros,
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
