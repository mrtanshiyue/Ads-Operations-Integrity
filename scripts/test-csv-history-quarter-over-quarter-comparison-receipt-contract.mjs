import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const assetRelative = 'assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-v1.js';
const helperRelative = 'assets/csv-analysis-engine/csv-history-deterministic-receipt.js';
const assetSource = await readFile(path.join(distRoot, assetRelative), 'utf8');
const helperSource = await readFile(path.join(distRoot, helperRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const qoqTag = '<script type="module" src="assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-v1.js?v=1.0.0"></script>';
const qoqReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(qoqReceiptTag).length - 1, 1, 'QoQ comparison receipt asset must be injected exactly once');
assert.ok(indexSource.indexOf(qoqTag) < indexSource.indexOf(qoqReceiptTag), 'QoQ receipt must load after QoQ comparison');
assert.ok(indexSource.indexOf(qoqReceiptTag) < indexSource.indexOf(monthlyReceiptTag), 'QoQ receipt must load before monthly historical comparison receipt');
assert.match(assetSource, /csv-history-quarter-over-quarter-comparison-receipt-v1/);
assert.match(assetSource, /QoQ Comparison Receipt/);
assert.match(assetSource, /local replay · deterministic/);
assert.match(assetSource, /Blocked QoQ selections remain exportable as raw-evidence-only receipts with every delta withheld/);
assert.match(assetSource, /Ad Contribution = Sales - Ad Spend only; it is not Net Profit/);
assert.match(assetSource, /generatedTimestampIncluded: false/);
assert.match(assetSource, /comparisonRecomputedFromLedger: true/);
assert.match(assetSource, /quarter_b_minus_quarter_a/);
assert.match(assetSource, /operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder/);
assert.match(helperSource, /csv-history-number-projection-v1/);
assert.match(helperSource, /fingerprintDeterministicReceiptPayload/);
assert.match(helperSource, /serializeDeterministicReceiptJson/);

for (const source of [assetSource, helperSource]) {
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
    assert.equal(pattern.test(source), false, `QoQ receipt must remain local-only and execution-free: ${pattern}`);
  }
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?qoqReceiptEngine=${Date.now()}`);
const helper = await import(`${pathToFileURL(path.join(distRoot, helperRelative)).href}?qoqReceiptHelper=${Date.now()}`);
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, assetRelative)).href}?qoqReceipt=${Date.now()}`);

assert.equal(helper.CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION, 'csv-history-number-projection-v1');
assert.equal(typeof helper.fingerprintDeterministicReceiptPayload, 'function');
assert.equal(typeof helper.serializeDeterministicReceiptJson, 'function');
assert.equal(receiptMod.CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_SCHEMA_VERSION, 'csv-history-quarter-over-quarter-comparison-receipt-v1');
assert.equal(receiptMod.CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_UI_VERSION, '1.0.0');
assert.equal(typeof receiptMod.buildHistoricalQuarterOverQuarterComparisonReceipt, 'function');
assert.equal(typeof receiptMod.validateHistoricalQuarterOverQuarterComparisonReceipt, 'function');
assert.equal(typeof receiptMod.parseHistoricalQuarterOverQuarterComparisonReceipt, 'function');
assert.equal(typeof receiptMod.serializeHistoricalQuarterOverQuarterComparisonReceipt, 'function');

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

const receipt1 = await receiptMod.buildHistoricalQuarterOverQuarterComparisonReceipt(ledger, '2026-Q1', '2026-Q2');
const receipt2 = await receiptMod.buildHistoricalQuarterOverQuarterComparisonReceipt(ledger, '2026-Q1', '2026-Q2');
assert.equal(receipt1.schemaVersion, 'csv-history-quarter-over-quarter-comparison-receipt-v1');
assert.equal(receipt1.receiptPurpose, 'local_historical_quarter_over_quarter_comparison_audit_only');
assert.match(receipt1.receiptFingerprint, /^[a-f0-9]{64}$/);
assert.equal(receipt1.receiptFingerprint, receipt2.receiptFingerprint, 'Same immutable ledger and quarter selections must reproduce the same QoQ receipt fingerprint');
assert.equal(receipt1.deterministic.generatedTimestampIncluded, false);
assert.equal(receipt1.deterministic.canonicalProjectionVersion, 'csv-history-number-projection-v1');
assert.equal(receipt1.deterministic.comparisonRecomputedFromLedger, true);
assert.equal(Object.prototype.hasOwnProperty.call(receipt1, 'generatedAt'), false, 'QoQ receipt must not include wall-clock timestamps');
assert.equal(receipt1.source.ledgerFingerprint, ledger.ledgerFingerprint);
assert.equal(receipt1.source.periodAQuarter, '2026-Q1');
assert.equal(receipt1.source.periodBQuarter, '2026-Q2');
assert.deepEqual(receipt1.source.periodASourceInputSetFingerprints, receipt1.comparison.periodA.sourceInputSetFingerprints);
assert.deepEqual(receipt1.source.periodBSourceInputSetFingerprints, receipt1.comparison.periodB.sourceInputSetFingerprints);
assert.equal(receipt1.comparison.comparisonAllowed, true);
assert.equal(receipt1.comparison.interpretationAllowed, true);
assert.equal(receipt1.comparison.rawEvidenceOnly, false);
assert.equal(receipt1.comparison.deltaBasis, 'quarter_b_minus_quarter_a');
assert.equal(receipt1.comparison.metrics.spendMicros.delta, 3_000_000);
assert.equal(receipt1.comparison.metrics.salesMicros.delta, 6_000_000);
assert.equal(receipt1.comparison.metrics.orders.delta, 3);
assert.equal(receipt1.comparison.metrics.adContributionMicros.delta, 3_000_000);
assert.equal(receipt1.comparison.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(receipt1.comparison.crossQuarterAggregationApplied, false);
assert.equal(receipt1.comparison.crossQuarterNormalizationApplied, false);
assert.equal(receipt1.comparison.quarterSelectionAutoReordered, false);
assertAuthorityFalse(receipt1.authority);
assertAuthorityFalse(receipt1.comparison.authority);
assert.equal(Object.isFrozen(receipt1), true);

const serialized1 = receiptMod.serializeHistoricalQuarterOverQuarterComparisonReceipt(receipt1);
const serialized2 = receiptMod.serializeHistoricalQuarterOverQuarterComparisonReceipt(receipt2);
assert.equal(serialized1, serialized2, 'QoQ receipt serialization must be deterministic');
const parsed = await receiptMod.parseHistoricalQuarterOverQuarterComparisonReceipt(serialized1);
assert.equal(parsed.receiptFingerprint, receipt1.receiptFingerprint);
assert.deepEqual(parsed.source, receipt1.source);
assert.equal(receiptMod.serializeHistoricalQuarterOverQuarterComparisonReceipt(parsed), serialized1, 'Validated QoQ receipt must round-trip without serialization drift');

const blocked = await receiptMod.buildHistoricalQuarterOverQuarterComparisonReceipt(ledger, '2026-Q2', '2026-Q1');
assert.match(blocked.receiptFingerprint, /^[a-f0-9]{64}$/);
assert.equal(blocked.comparison.comparisonAllowed, false);
assert.equal(blocked.comparison.interpretationAllowed, false);
assert.equal(blocked.comparison.rawEvidenceOnly, true);
assert.equal(blocked.comparison.quarterSelectionAutoReordered, false);
assert.equal(blocked.comparison.periodA.quarter, '2026-Q2');
assert.equal(blocked.comparison.periodB.quarter, '2026-Q1');
assert.ok(blocked.comparison.comparabilityGate.reasons.includes('quarters_not_forward_adjacent'));
for (const metric of Object.values(blocked.comparison.metrics)) {
  assert.equal(metric.delta, null, 'Blocked QoQ receipt must retain raw values while withholding deltas');
  assert.equal(metric.interpretationAllowed, false);
  assert.equal(metric.direction, 'withheld_not_comparable');
}
assert.doesNotThrow(() => receiptMod.serializeHistoricalQuarterOverQuarterComparisonReceipt(blocked), 'Blocked QoQ comparison must remain exportable as an audit receipt');

const tampered = JSON.parse(serialized1);
tampered.comparison.metrics.salesMicros.periodBValue += 1;
await assert.rejects(
  () => receiptMod.validateHistoricalQuarterOverQuarterComparisonReceipt(tampered),
  (error) => error?.code === 'CSV_HISTORY_QOQ_RECEIPT_FINGERPRINT_MISMATCH',
  'QoQ receipt metric tampering must fail fingerprint validation',
);

const escalated = JSON.parse(serialized1);
escalated.authority.executionAuthorized = true;
await assert.rejects(
  () => receiptMod.validateHistoricalQuarterOverQuarterComparisonReceipt(escalated),
  (error) => error?.code === 'CSV_HISTORY_QOQ_RECEIPT_AUTHORITY_ESCALATION_BLOCKED',
  'QoQ receipt authority escalation must fail closed',
);

const bindingDrift = JSON.parse(serialized1);
bindingDrift.source.periodAQuarter = '2025-Q4';
delete bindingDrift.receiptFingerprint;
bindingDrift.receiptFingerprint = await helper.fingerprintDeterministicReceiptPayload(bindingDrift);
await assert.rejects(
  () => receiptMod.validateHistoricalQuarterOverQuarterComparisonReceipt(bindingDrift),
  (error) => error?.code === 'CSV_HISTORY_QOQ_RECEIPT_PERIOD_A_BINDING_MISMATCH',
  'A valid fingerprint cannot legitimize quarter binding drift',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-quarter-over-quarter-comparison-receipt-v1',
  deterministicReceiptFingerprint: true,
  deterministicSerialization: true,
  generatedTimestampIncluded: false,
  comparisonRecomputedFromLedger: true,
  allowedQoQReceipt: true,
  blockedQoQReceiptExportable: true,
  blockedDeltasWithheld: true,
  operatorSelectionNotReordered: true,
  quarterAndSourceBindingsLocked: true,
  tamperDetection: true,
  authorityEscalationBlocked: true,
  crossQuarterAggregationApplied: false,
  crossQuarterNormalizationApplied: false,
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
      coveredDayCount: expectedDayCount,
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

async function fixture({ hashChar, month, startDate, endDate, expectedDayCount, coveredDayCount, metrics }) {
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
        periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount, factCount: 10,
        metrics,
        adContributionMicros: metrics.salesMicros - metrics.spendMicros,
        profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
        coverage: { expectedDayCount, coveredDayCount, coverageRatio: coveredDayCount / expectedDayCount, complete: true },
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
