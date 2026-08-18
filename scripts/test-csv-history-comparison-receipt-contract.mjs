import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const assetRelative = 'assets/cloudflare-native-csv-history-comparison-receipt-v1.js';
const assetSource = await readFile(path.join(distRoot, assetRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const historyTag = '<script type="module" src="assets/cloudflare-native-csv-history-ledger-v1.js?v=1.4.0"></script>';
const receiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';
const provenanceTag = '<script type="module" src="assets/cloudflare-native-csv-provenance-audit-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(receiptTag).length - 1, 1, 'Historical comparison receipt asset must be injected exactly once');
assert.ok(indexSource.indexOf(historyTag) < indexSource.indexOf(receiptTag), 'Comparison receipt must load after historical ledger/comparison engine');
assert.ok(indexSource.indexOf(receiptTag) < indexSource.indexOf(provenanceTag), 'Comparison receipt must load before provenance audit');
assert.match(assetSource, /Historical Comparison Receipt/);
assert.match(assetSource, /local replay · deterministic/);
assert.match(assetSource, /Blocked comparisons remain exportable as raw-evidence-only receipts with deltas withheld/);
assert.match(assetSource, /Ad Contribution = Sales - Ad Spend only; it is not Net Profit/);
assert.match(assetSource, /generatedTimestampIncluded: false/);
assert.match(assetSource, /comparisonRecomputedFromLedger: true/);

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
  assert.equal(pattern.test(assetSource), false, `Comparison receipt must remain local-only and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?receiptEngine=${Date.now()}`);
const history = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-history-ledger-v1.js')).href}?receiptHistory=${Date.now()}`);
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, assetRelative)).href}?receipt=${Date.now()}`);

assert.equal(receiptMod.CSV_HISTORY_COMPARISON_RECEIPT_SCHEMA_VERSION, 'csv-history-comparison-receipt-v1');
assert.equal(receiptMod.CSV_HISTORY_COMPARISON_RECEIPT_UI_VERSION, '1.0.0');
assert.equal(typeof receiptMod.buildHistoricalComparisonReceipt, 'function');
assert.equal(typeof receiptMod.validateHistoricalComparisonReceipt, 'function');
assert.equal(typeof receiptMod.parseHistoricalComparisonReceipt, 'function');
assert.equal(typeof receiptMod.serializeHistoricalComparisonReceipt, 'function');

const completeA = await fixture({
  hashChar: 'a', month: '2026-06', startDate: '2026-06-01', endDate: '2026-06-30', expectedDayCount: 30, coveredDayCount: 30,
  metrics: { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
});
const completeB = await fixture({
  hashChar: 'b', month: '2026-07', startDate: '2026-07-01', endDate: '2026-07-31', expectedDayCount: 31, coveredDayCount: 31,
  metrics: { spendMicros: 5_000_000, salesMicros: 12_000_000, orders: 5, acos: 5 / 12, roas: 2.4 },
});
const completeLedger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(completeA), completeB);
const completeRows = history.buildHistoricalMonthlyWorkspace(completeLedger).rows;
const selectionA = select(completeRows[0]);
const selectionB = select(completeRows[1]);

const receipt1 = await receiptMod.buildHistoricalComparisonReceipt(completeLedger, selectionA, selectionB);
const receipt2 = await receiptMod.buildHistoricalComparisonReceipt(completeLedger, selectionA, selectionB);
assert.equal(receipt1.schemaVersion, 'csv-history-comparison-receipt-v1');
assert.equal(receipt1.receiptPurpose, 'local_historical_comparison_audit_only');
assert.match(receipt1.receiptFingerprint, /^[a-f0-9]{64}$/);
assert.equal(receipt1.receiptFingerprint, receipt2.receiptFingerprint, 'Same immutable ledger selections must reproduce the same receipt fingerprint');
assert.equal(receipt1.deterministic.generatedTimestampIncluded, false);
assert.equal(receipt1.deterministic.comparisonRecomputedFromLedger, true);
assert.equal(Object.prototype.hasOwnProperty.call(receipt1, 'generatedAt'), false, 'Receipt must not contain a wall-clock timestamp');
assert.equal(receipt1.source.ledgerFingerprint, completeLedger.ledgerFingerprint);
assert.deepEqual(receipt1.source.periodAEvidenceKey, selectionA);
assert.deepEqual(receipt1.source.periodBEvidenceKey, selectionB);
assert.equal(receipt1.comparison.comparisonAllowed, true);
assert.equal(receipt1.comparison.interpretationAllowed, true);
assert.equal(receipt1.comparison.rawEvidenceOnly, false);
assert.equal(receipt1.comparison.deltaBasis, 'period_b_minus_period_a');
assert.equal(receipt1.comparison.metrics.spendMicros.delta, 1_000_000);
assert.equal(receipt1.comparison.metrics.salesMicros.delta, 2_000_000);
assert.equal(receipt1.comparison.metrics.orders.delta, 2);
assert.ok(Math.abs(receipt1.comparison.metrics.acos.delta - ((5 / 12) - 0.4)) < 1e-12);
assert.ok(Math.abs(receipt1.comparison.metrics.roas.delta + 0.1) < 1e-12);
assert.equal(receipt1.comparison.metrics.adContributionMicros.periodAValue, 6_000_000);
assert.equal(receipt1.comparison.metrics.adContributionMicros.periodBValue, 7_000_000);
assert.equal(receipt1.comparison.metrics.adContributionMicros.delta, 1_000_000);
assert.equal(receipt1.comparison.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(receipt1.comparison.crossSnapshotAggregationApplied, false);
assert.equal(receipt1.comparison.normalizationApplied, false);
assertAuthorityFalse(receipt1.authority);
assertAuthorityFalse(receipt1.comparison.authority);
assert.equal(Object.isFrozen(receipt1), true);

const serialized1 = receiptMod.serializeHistoricalComparisonReceipt(receipt1);
const serialized2 = receiptMod.serializeHistoricalComparisonReceipt(receipt2);
assert.equal(serialized1, serialized2, 'Comparison receipt serialization must be deterministic');
const parsed = await receiptMod.parseHistoricalComparisonReceipt(serialized1);
assert.equal(parsed.receiptFingerprint, receipt1.receiptFingerprint);
assert.deepEqual(parsed.source, receipt1.source);
assert.equal(receiptMod.serializeHistoricalComparisonReceipt(parsed), serialized1, 'Validated receipt must round-trip without serialization drift');

const partialA = await fixture({
  hashChar: 'c', month: '2026-08', startDate: '2026-08-01', endDate: '2026-08-14', expectedDayCount: 31, coveredDayCount: 14,
});
const partialB = await fixture({
  hashChar: 'd', month: '2026-09', startDate: '2026-09-01', endDate: '2026-09-15', expectedDayCount: 30, coveredDayCount: 15,
});
const partialLedger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(partialA), partialB);
const partialRows = history.buildHistoricalMonthlyWorkspace(partialLedger).rows;
const blockedReceipt = await receiptMod.buildHistoricalComparisonReceipt(partialLedger, select(partialRows[0]), select(partialRows[1]));
assert.match(blockedReceipt.receiptFingerprint, /^[a-f0-9]{64}$/);
assert.equal(blockedReceipt.comparison.comparisonAllowed, false);
assert.equal(blockedReceipt.comparison.interpretationAllowed, false);
assert.equal(blockedReceipt.comparison.rawEvidenceOnly, true);
assert.ok(blockedReceipt.comparison.comparabilityGate.reasons.includes('incomplete_coverage'));
for (const metric of Object.values(blockedReceipt.comparison.metrics)) {
  assert.equal(metric.delta, null, 'Blocked receipt must retain raw values while withholding deltas');
  assert.equal(metric.interpretationAllowed, false);
  assert.equal(metric.direction, 'withheld_not_comparable');
}
assert.doesNotThrow(() => receiptMod.serializeHistoricalComparisonReceipt(blockedReceipt), 'Blocked comparison must still be exportable as an audit receipt');
assertAuthorityFalse(blockedReceipt.authority);

const tampered = JSON.parse(serialized1);
tampered.comparison.metrics.salesMicros.periodBValue += 1;
await assert.rejects(
  () => receiptMod.validateHistoricalComparisonReceipt(tampered),
  (error) => error?.code === 'CSV_HISTORY_COMPARISON_RECEIPT_FINGERPRINT_MISMATCH',
  'Receipt metric tampering must fail fingerprint validation',
);
const escalated = JSON.parse(serialized1);
escalated.authority.executionAuthorized = true;
await assert.rejects(
  () => receiptMod.validateHistoricalComparisonReceipt(escalated),
  (error) => error?.code === 'CSV_HISTORY_COMPARISON_RECEIPT_AUTHORITY_ESCALATION_BLOCKED',
  'Receipt authority escalation must fail closed',
);
const bindingDrift = JSON.parse(serialized1);
bindingDrift.source.periodAEvidenceKey.month = '2026-05';
bindingDrift.receiptFingerprint = await refingerprintWithoutExposingInternals(bindingDrift);
await assert.rejects(
  () => receiptMod.validateHistoricalComparisonReceipt(bindingDrift),
  (error) => error?.code === 'CSV_HISTORY_COMPARISON_RECEIPT_PERIOD_A_BINDING_MISMATCH',
  'A valid fingerprint cannot legitimize evidence-key binding drift',
);

await assert.rejects(
  () => receiptMod.buildHistoricalComparisonReceipt(completeLedger, { ...selectionA, month: '2026-05' }, selectionB),
  'Receipt generation must inherit exact historical evidence fail-closed selection rules',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-comparison-receipt-v1',
  explicitLocalLedgerReplay: true,
  deterministicReceiptFingerprint: true,
  deterministicSerialization: true,
  generatedTimestampIncluded: false,
  allowedComparisonReceipt: true,
  blockedComparisonReceiptExportable: true,
  blockedDeltasWithheld: true,
  exactEvidenceKeysBound: true,
  tamperDetection: true,
  authorityEscalationBlocked: true,
  crossSnapshotAggregationApplied: false,
  normalizationApplied: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
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

async function refingerprintWithoutExposingInternals(receipt) {
  const payload = structuredClone(receipt);
  delete payload.receiptFingerprint;
  const projected = projectNumbers(payload);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(projected)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function projectNumbers(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return { $csvHistoryNumber: Object.is(value, -0) ? '0' : String(value) };
  if (Array.isArray(value)) return value.map(projectNumbers);
  const out = {};
  for (const key of Object.keys(value)) out[key] = projectNumbers(value[key]);
  return out;
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
  const receipt = {
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
    schemaVersion: receipt.schemaVersion,
    reportType: receipt.reportType,
    contentSha256: receipt.contentSha256,
    reportStartDate: receipt.reportStartDate,
    reportEndDate: receipt.reportEndDate,
    rowCount: receipt.rowCount,
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
    imports: [receipt],
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
