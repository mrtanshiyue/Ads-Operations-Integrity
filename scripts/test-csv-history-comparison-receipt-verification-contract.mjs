import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const verificationRelative = 'assets/cloudflare-native-csv-history-comparison-receipt-verification-v1.js';
const verificationSource = await readFile(path.join(distRoot, verificationRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const receiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';
const verificationTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-verification-v1.js?v=1.0.0"></script>';
const provenanceTag = '<script type="module" src="assets/cloudflare-native-csv-provenance-audit-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(verificationTag).length - 1, 1, 'Comparison receipt verification must be injected exactly once');
assert.ok(indexSource.indexOf(receiptTag) < indexSource.indexOf(verificationTag), 'Verification must load after comparison receipt builder');
assert.ok(indexSource.indexOf(verificationTag) < indexSource.indexOf(provenanceTag), 'Verification must load before provenance audit');
assert.match(verificationSource, /Comparison Receipt Verification/);
assert.match(verificationSource, /exact fingerprint and serialization match/);
assert.match(verificationSource, /receipt drift, ledger drift, evidence-key drift, or authority escalation fails closed/);
assert.match(verificationSource, /generatedTimestampIncluded: false/);
assert.match(verificationSource, /replayedFromExplicitLocalLedger: true/);

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
  assert.equal(pattern.test(verificationSource), false, `Receipt verification must remain local-only and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?verificationEngine=${Date.now()}`);
const history = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-history-ledger-v1.js')).href}?verificationHistory=${Date.now()}`);
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-history-comparison-receipt-v1.js')).href}?verificationReceipt=${Date.now()}`);
const verificationMod = await import(`${pathToFileURL(path.join(distRoot, verificationRelative)).href}?verification=${Date.now()}`);

assert.equal(verificationMod.CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION, 'csv-history-comparison-receipt-verification-v1');
assert.equal(verificationMod.CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION, '1.0.0');
assert.equal(typeof verificationMod.verifyHistoricalComparisonReceiptAgainstLedger, 'function');

const completeA = await fixture({
  hashChar: 'a', month: '2026-04', startDate: '2026-04-01', endDate: '2026-04-30', expectedDayCount: 30, coveredDayCount: 30,
});
const completeB = await fixture({
  hashChar: 'b', month: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31', expectedDayCount: 31, coveredDayCount: 31,
  metrics: { spendMicros: 5_000_000, salesMicros: 11_000_000, orders: 4, acos: 5 / 11, roas: 2.2 },
});
const ledger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(completeA), completeB);
const rows = history.buildHistoricalMonthlyWorkspace(ledger).rows;
const receipt = await receiptMod.buildHistoricalComparisonReceipt(ledger, select(rows[0]), select(rows[1]));
const verification = await verificationMod.verifyHistoricalComparisonReceiptAgainstLedger(ledger, receipt);

assert.equal(verification.schemaVersion, 'csv-history-comparison-receipt-verification-v1');
assert.equal(verification.verificationState, 'verified_against_local_ledger');
assert.equal(verification.receiptFingerprint, receipt.receiptFingerprint);
assert.equal(verification.recomputedReceiptFingerprint, receipt.receiptFingerprint);
assert.equal(verification.ledgerFingerprint, ledger.ledgerFingerprint);
assert.deepEqual(verification.periodAEvidenceKey, receipt.source.periodAEvidenceKey);
assert.deepEqual(verification.periodBEvidenceKey, receipt.source.periodBEvidenceKey);
assert.equal(verification.comparisonAllowed, true);
assert.equal(verification.rawEvidenceOnly, false);
assert.equal(verification.receiptSerializationMatch, true);
assert.equal(verification.receiptFingerprintMatch, true);
assert.equal(verification.generatedTimestampIncluded, false);
assert.equal(verification.replayedFromExplicitLocalLedger, true);
assert.equal(verification.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(verification.crossSnapshotAggregationApplied, false);
assert.equal(verification.normalizationApplied, false);
assertAuthorityFalse(verification.authority);
assert.equal(Object.isFrozen(verification), true);

const partialA = await fixture({
  hashChar: 'c', month: '2026-06', startDate: '2026-06-01', endDate: '2026-06-15', expectedDayCount: 30, coveredDayCount: 15,
});
const partialB = await fixture({
  hashChar: 'd', month: '2026-07', startDate: '2026-07-01', endDate: '2026-07-15', expectedDayCount: 31, coveredDayCount: 15,
});
const partialLedger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(partialA), partialB);
const partialRows = history.buildHistoricalMonthlyWorkspace(partialLedger).rows;
const blockedReceipt = await receiptMod.buildHistoricalComparisonReceipt(partialLedger, select(partialRows[0]), select(partialRows[1]));
const blockedVerification = await verificationMod.verifyHistoricalComparisonReceiptAgainstLedger(partialLedger, blockedReceipt);
assert.equal(blockedReceipt.comparison.comparisonAllowed, false);
assert.equal(blockedVerification.verificationState, 'verified_against_local_ledger');
assert.equal(blockedVerification.comparisonAllowed, false);
assert.equal(blockedVerification.rawEvidenceOnly, true);
assert.equal(blockedVerification.receiptFingerprintMatch, true);
assert.equal(blockedVerification.receiptSerializationMatch, true);
assertAuthorityFalse(blockedVerification.authority);

const wrongLedger = await engine.createCsvHistoryLedger(await fixture({
  hashChar: 'e', month: '2026-08', startDate: '2026-08-01', endDate: '2026-08-31', expectedDayCount: 31, coveredDayCount: 31,
}));
await assert.rejects(
  () => verificationMod.verifyHistoricalComparisonReceiptAgainstLedger(wrongLedger, receipt),
  (error) => error?.code === 'CSV_HISTORY_COMPARISON_RECEIPT_LEDGER_FINGERPRINT_MISMATCH',
  'A different local ledger must not verify a valid receipt',
);

const tamperedReceipt = JSON.parse(receiptMod.serializeHistoricalComparisonReceipt(receipt));
tamperedReceipt.comparison.metrics.salesMicros.periodBValue += 1;
await assert.rejects(
  () => verificationMod.verifyHistoricalComparisonReceiptAgainstLedger(ledger, tamperedReceipt),
  (error) => error?.code === 'CSV_HISTORY_COMPARISON_RECEIPT_FINGERPRINT_MISMATCH',
  'Receipt tampering must fail before ledger replay',
);

const escalatedReceipt = JSON.parse(receiptMod.serializeHistoricalComparisonReceipt(receipt));
escalatedReceipt.authority.executionAuthorized = true;
await assert.rejects(
  () => verificationMod.verifyHistoricalComparisonReceiptAgainstLedger(ledger, escalatedReceipt),
  (error) => error?.code === 'CSV_HISTORY_COMPARISON_RECEIPT_AUTHORITY_ESCALATION_BLOCKED',
  'Receipt authority escalation must fail before replay',
);

const ledgerDrift = JSON.parse(engine.serializeCsvHistoryLedger(ledger));
ledgerDrift.ledgerFingerprint = 'f'.repeat(64);
await assert.rejects(
  () => verificationMod.verifyHistoricalComparisonReceiptAgainstLedger(ledgerDrift, receipt),
  (error) => error?.code === 'CSV_HISTORY_LEDGER_FINGERPRINT_MISMATCH',
  'Tampered ledger fingerprints must fail ledger validation',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-comparison-receipt-verification-v1',
  standaloneReceiptIntegrityCheckedFirst: true,
  explicitLocalLedgerReplay: true,
  exactReceiptFingerprintMatchRequired: true,
  exactReceiptSerializationMatchRequired: true,
  allowedReceiptVerified: true,
  blockedRawEvidenceReceiptVerified: true,
  wrongLedgerBlocked: true,
  receiptTamperBlocked: true,
  ledgerTamperBlocked: true,
  authorityEscalationBlocked: true,
  generatedTimestampIncluded: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  crossSnapshotAggregationApplied: false,
  normalizationApplied: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function select(row) {
  return {
    ledgerFingerprint: row.ledgerFingerprint,
    sourceInputSetFingerprint: row.sourceInputSetFingerprint,
    month: row.month,
  };
}

function assertAuthorityFalse(authority) {
  assert.equal(authority.authoritative, false);
  assert.equal(authority.canonicalAmazonIdentityResolved, false);
  assert.equal(authority.governancePersistenceAllowed, false);
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.amazonMutationAuthorized, false);
}

async function fixture({
  hashChar,
  month,
  startDate,
  endDate,
  expectedDayCount,
  coveredDayCount,
  metrics = { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
}) {
  const contentSha256 = hashChar.repeat(64);
  const sourceReceipt = {
    schemaVersion: 'csv-import-v1',
    reportType: 'spSearchTerm',
    sourceFileName: `${month}.csv`,
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
  const complete = coveredDayCount === expectedDayCount;
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
        periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount, factCount: 10,
        metrics,
        adContributionMicros: metrics.salesMicros - metrics.spendMicros,
        profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
        coverage: { expectedDayCount, coveredDayCount, coverageRatio: coveredDayCount / expectedDayCount, complete },
        reliability: { state: complete ? 'complete_coverage' : 'incomplete_coverage', aggregationSafe: true, coverageComplete: complete, analyticalDecisionUse: complete ? 'observed_review_only' : 'review_with_partial_coverage' },
        requiresHumanReview: true, persistenceAuthorized: false, executionAuthorized: false, amazonMutationAuthorized: false,
      }],
    },
    analysis: { authority },
  };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
