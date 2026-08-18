import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const assetRelative = 'assets/cloudflare-native-csv-history-year-over-year-ytd-comparison-v1.js';
const assetSource = await readFile(path.join(distRoot, assetRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const ytdTag = '<script type="module" src="assets/cloudflare-native-csv-history-year-to-date-operating-review-v1.js?v=1.0.0"></script>';
const yoyTag = '<script type="module" src="assets/cloudflare-native-csv-history-year-over-year-ytd-comparison-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(yoyTag).length - 1, 1, 'YoY YTD comparison asset must be injected exactly once');
assert.ok(indexSource.indexOf(ytdTag) < indexSource.indexOf(yoyTag), 'YoY YTD comparison must load after canonical YTD operating review');
assert.ok(indexSource.indexOf(yoyTag) < indexSource.indexOf(monthlyReceiptTag), 'YoY YTD comparison must load before legacy monthly receipt workflow');
assert.match(assetSource, /csv-history-year-over-year-ytd-comparison-v1/);
assert.match(assetSource, /Year-over-Year YTD Comparison/);
assert.match(assetSource, /Period B must be the next natural year and use the same YTD through-quarter/);
assert.match(assetSource, /ytd_period_b_minus_ytd_period_a/);
assert.match(assetSource, /operator_selected_forward_adjacent_years_same_ytd_quarter_no_auto_reorder/);
assert.match(assetSource, /forwardAdjacentYearsRequired: true/);
assert.match(assetSource, /sameThroughQuarterRequired: true/);
assert.match(assetSource, /blockedYtdPeriodCannotBeUpgraded: true/);
assert.match(assetSource, /crossYearAggregationApplied: false/);
assert.match(assetSource, /crossYearNormalizationApplied: false/);
assert.match(assetSource, /ytdPeriodReaggregationApplied: false/);
assert.match(assetSource, /periodSelectionAutoReordered: false/);
assert.match(assetSource, /sameMonthAggregationApplied: false/);
assert.match(assetSource, /businessRowDeduplicationApplied: false/);
assert.match(assetSource, /overlapCollapseApplied: false/);
assert.match(assetSource, /gapRepairApplied: false/);
assert.match(assetSource, /Sales - Ad Spend only, not Net Profit/);

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
  assert.equal(pattern.test(assetSource), false, `YoY YTD comparison must remain explicit-local and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?yoyYtdEngine=${Date.now()}`);
const comparisonMod = await import(`${pathToFileURL(path.join(distRoot, assetRelative)).href}?yoyYtd=${Date.now()}`);

assert.equal(comparisonMod.CSV_HISTORY_YEAR_OVER_YEAR_YTD_COMPARISON_SCHEMA_VERSION, 'csv-history-year-over-year-ytd-comparison-v1');
assert.equal(comparisonMod.CSV_HISTORY_YEAR_OVER_YEAR_YTD_COMPARISON_UI_VERSION, '1.0.0');
assert.equal(typeof comparisonMod.buildHistoricalYearOverYearYtdComparison, 'function');

const y2025q1 = await completeQuarter({
  year: 2025,
  quarter: 1,
  hashChars: ['a', 'b', 'c'],
  metrics: { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
});
const y2025q2 = await completeQuarter({
  year: 2025,
  quarter: 2,
  hashChars: ['d', 'e', 'f'],
  metrics: { spendMicros: 5_000_000, salesMicros: 12_000_000, orders: 4, acos: 5 / 12, roas: 2.4 },
});
const y2026q1 = await completeQuarter({
  year: 2026,
  quarter: 1,
  hashChars: ['1', '2', '3'],
  metrics: { spendMicros: 6_000_000, salesMicros: 15_000_000, orders: 5, acos: 0.4, roas: 2.5 },
});
const y2026q2 = await completeQuarter({
  year: 2026,
  quarter: 2,
  hashChars: ['4', '5', '6'],
  metrics: { spendMicros: 7_000_000, salesMicros: 18_000_000, orders: 6, acos: 7 / 18, roas: 18 / 7 },
});

const ledger = await ledgerFrom(...y2025q1, ...y2025q2, ...y2026q1, ...y2026q2);
const comparison = await comparisonMod.buildHistoricalYearOverYearYtdComparison(ledger, '2025-YTD-Q2', '2026-YTD-Q2');
assert.equal(comparison.schemaVersion, 'csv-history-year-over-year-ytd-comparison-v1');
assert.equal(comparison.ledgerFingerprint, ledger.ledgerFingerprint);
assert.equal(comparison.comparisonAllowed, true);
assert.equal(comparison.interpretationAllowed, true);
assert.equal(comparison.rawEvidenceOnly, false);
assert.equal(comparison.deltaBasis, 'ytd_period_b_minus_ytd_period_a');
assert.equal(comparison.selectionPolicy, 'operator_selected_forward_adjacent_years_same_ytd_quarter_no_auto_reorder');
assert.equal(comparison.periodA.periodKey, '2025-YTD-Q2');
assert.equal(comparison.periodB.periodKey, '2026-YTD-Q2');
assert.equal(comparison.periodA.throughQuarter, '2025-Q2');
assert.equal(comparison.periodB.throughQuarter, '2026-Q2');
assert.equal(comparison.periodA.ytdAggregationAllowed, true);
assert.equal(comparison.periodB.ytdAggregationAllowed, true);
assert.equal(comparison.periodA.rawQuarterEvidence.length, 2);
assert.equal(comparison.periodB.rawQuarterEvidence.length, 2);
assert.equal(comparison.periodA.sourceInputSetFingerprints.length, 6);
assert.equal(comparison.periodB.sourceInputSetFingerprints.length, 6);
assert.equal(new Set([...comparison.periodA.sourceInputSetFingerprints, ...comparison.periodB.sourceInputSetFingerprints]).size, 12);
assert.equal(new Set([...comparison.periodA.sourceContentSha256s, ...comparison.periodB.sourceContentSha256s]).size, 12);
assert.equal(comparison.comparabilityGate.checks.distinctPeriods, true);
assert.equal(comparison.comparabilityGate.checks.forwardAdjacentYears, true);
assert.equal(comparison.comparabilityGate.checks.sameThroughQuarter, true);
assert.equal(comparison.comparabilityGate.checks.periodAAggregationAllowed, true);
assert.equal(comparison.comparabilityGate.checks.periodBAggregationAllowed, true);
assert.equal(comparison.comparabilityGate.checks.sourceInputSetsDisjoint, true);
assert.equal(comparison.comparabilityGate.checks.sourceContentHashesDisjoint, true);
assert.deepEqual(comparison.comparabilityGate.reasons, []);
assert.equal(comparison.metrics.spendMicros.periodAValue, 27_000_000);
assert.equal(comparison.metrics.spendMicros.periodBValue, 39_000_000);
assert.equal(comparison.metrics.spendMicros.delta, 12_000_000);
assert.equal(comparison.metrics.spendMicros.direction, 'increase');
assert.equal(comparison.metrics.salesMicros.periodAValue, 66_000_000);
assert.equal(comparison.metrics.salesMicros.periodBValue, 99_000_000);
assert.equal(comparison.metrics.salesMicros.delta, 33_000_000);
assert.equal(comparison.metrics.orders.periodAValue, 21);
assert.equal(comparison.metrics.orders.periodBValue, 33);
assert.equal(comparison.metrics.orders.delta, 12);
assert.equal(comparison.metrics.acos.periodAValue, 27_000_000 / 66_000_000);
assert.equal(comparison.metrics.acos.periodBValue, 39_000_000 / 99_000_000);
assert.equal(comparison.metrics.acos.delta, (39_000_000 / 99_000_000) - (27_000_000 / 66_000_000));
assert.equal(comparison.metrics.acos.direction, 'decrease');
assert.equal(comparison.metrics.roas.periodAValue, 66_000_000 / 27_000_000);
assert.equal(comparison.metrics.roas.periodBValue, 99_000_000 / 39_000_000);
assert.equal(comparison.metrics.roas.delta, (99_000_000 / 39_000_000) - (66_000_000 / 27_000_000));
assert.equal(comparison.metrics.roas.direction, 'increase');
assert.equal(comparison.metrics.adContributionMicros.periodAValue, 39_000_000);
assert.equal(comparison.metrics.adContributionMicros.periodBValue, 60_000_000);
assert.equal(comparison.metrics.adContributionMicros.delta, 21_000_000);
assert.equal(comparison.crossYearAggregationApplied, false);
assert.equal(comparison.crossYearNormalizationApplied, false);
assert.equal(comparison.ytdPeriodReaggregationApplied, false);
assert.equal(comparison.periodSelectionAutoReordered, false);
assert.equal(comparison.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(comparison.authority);
assertAuthorityFalse(comparison.periodA.authority);
assertAuthorityFalse(comparison.periodB.authority);

const reversed = await comparisonMod.buildHistoricalYearOverYearYtdComparison(ledger, '2026-YTD-Q2', '2025-YTD-Q2');
assert.equal(reversed.comparisonAllowed, false);
assert.equal(reversed.interpretationAllowed, false);
assert.equal(reversed.rawEvidenceOnly, true);
assert.equal(reversed.periodA.periodKey, '2026-YTD-Q2');
assert.equal(reversed.periodB.periodKey, '2025-YTD-Q2');
assert.equal(reversed.periodSelectionAutoReordered, false);
assert.ok(reversed.comparabilityGate.reasons.includes('years_not_forward_adjacent'));
assertAllDeltasWithheld(reversed);

const mismatchedEndpoint = await comparisonMod.buildHistoricalYearOverYearYtdComparison(ledger, '2025-YTD-Q1', '2026-YTD-Q2');
assert.equal(mismatchedEndpoint.comparisonAllowed, false);
assert.ok(mismatchedEndpoint.comparabilityGate.reasons.includes('ytd_through_quarter_mismatch'));
assert.equal(mismatchedEndpoint.periodA.periodKey, '2025-YTD-Q1');
assert.equal(mismatchedEndpoint.periodB.periodKey, '2026-YTD-Q2');
assertAllDeltasWithheld(mismatchedEndpoint);

const partial2026Ledger = await ledgerFrom(...y2025q1, ...y2025q2, ...y2026q1, ...y2026q2.slice(0, 2));
const blockedYtd = await comparisonMod.buildHistoricalYearOverYearYtdComparison(partial2026Ledger, '2025-YTD-Q2', '2026-YTD-Q2');
assert.equal(blockedYtd.periodA.ytdAggregationAllowed, true);
assert.equal(blockedYtd.periodB.ytdAggregationAllowed, false);
assert.equal(blockedYtd.periodB.rawEvidenceOnly, true);
assert.equal(blockedYtd.comparisonAllowed, false);
assert.ok(blockedYtd.comparabilityGate.reasons.includes('period_b_ytd_gate_blocked'));
assert.equal(blockedYtd.periodB.rawQuarterEvidence.length, 2);
assertAllDeltasWithheld(blockedYtd);

const ca2026q1 = await completeQuarter({
  year: 2026,
  quarter: 1,
  hashChars: ['7', '8', '9'],
  marketplace: 'CA',
  metrics: { spendMicros: 6_000_000, salesMicros: 15_000_000, orders: 5, acos: 0.4, roas: 2.5 },
});
const ca2026q2 = await completeQuarter({
  year: 2026,
  quarter: 2,
  hashChars: ['0', 'a', 'b'],
  marketplace: 'CA',
  metrics: { spendMicros: 7_000_000, salesMicros: 18_000_000, orders: 6, acos: 7 / 18, roas: 18 / 7 },
});
const marketplaceLedger = await ledgerFrom(...y2025q1, ...y2025q2, ...ca2026q1, ...ca2026q2);
const marketplaceMismatch = await comparisonMod.buildHistoricalYearOverYearYtdComparison(marketplaceLedger, '2025-YTD-Q2', '2026-YTD-Q2');
assert.equal(marketplaceMismatch.periodA.ytdAggregationAllowed, true);
assert.equal(marketplaceMismatch.periodB.ytdAggregationAllowed, true);
assert.equal(marketplaceMismatch.comparisonAllowed, false);
assert.ok(marketplaceMismatch.comparabilityGate.reasons.includes('marketplace_mismatch_or_unknown'));
assertAllDeltasWithheld(marketplaceMismatch);

await assert.rejects(
  () => comparisonMod.buildHistoricalYearOverYearYtdComparison(ledger, '2025-Q2', '2026-YTD-Q2'),
  (error) => error?.code === 'CSV_HISTORY_YOY_YTD_PERIOD_A_KEY_INVALID',
  'Non-YTD Period A key must fail selection before comparison',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-year-over-year-ytd-comparison-v1',
  canonicalYtdReviewReused: true,
  forwardAdjacentYearsRequired: true,
  sameThroughQuarterRequired: true,
  deltaBasis: 'ytd_period_b_minus_ytd_period_a',
  allowedComparison: true,
  reversedYearsBlockedWithoutReorder: true,
  mismatchedYtdQuarterBlocked: true,
  blockedYtdPeriodCannotBeUpgraded: true,
  marketplaceMismatchBlocked: true,
  blockedDeltasWithheld: true,
  rawYtdQuarterMonthEvidenceRetained: true,
  crossYearAggregationApplied: false,
  crossYearNormalizationApplied: false,
  ytdPeriodReaggregationApplied: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function assertAllDeltasWithheld(comparison) {
  for (const metric of Object.values(comparison.metrics)) {
    assert.equal(metric.delta, null);
    assert.equal(metric.direction, 'withheld_not_comparable');
    assert.equal(metric.interpretationAllowed, false);
  }
}

async function completeQuarter({ year, quarter, hashChars, marketplace = 'US', currencyCode = 'USD', metrics }) {
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
      marketplace,
      currencyCode,
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

async function fixture({ hashChar, month, startDate, endDate, expectedDayCount, marketplace, currencyCode, metrics }) {
  const contentSha256 = await sha256Hex(`${month}:${hashChar}:${marketplace}:${currencyCode}`);
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
    marketplace,
    currencyCode,
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
