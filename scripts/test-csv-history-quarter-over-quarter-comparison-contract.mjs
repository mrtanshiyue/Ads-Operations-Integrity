import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const relative = 'assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-v1.js';
const source = await readFile(path.join(distRoot, relative), 'utf8');
const indexHtml = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const quarterlyTag = '<script type="module" src="assets/cloudflare-native-csv-history-quarterly-operating-review-v1.js?v=1.0.0"></script>';
const qoqTag = '<script type="module" src="assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-v1.js?v=1.0.0"></script>';
const receiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexHtml.split(qoqTag).length - 1, 1, 'QoQ comparison must be injected exactly once');
assert.ok(indexHtml.indexOf(quarterlyTag) < indexHtml.indexOf(qoqTag), 'QoQ comparison must load after quarterly operating review');
assert.ok(indexHtml.indexOf(qoqTag) < indexHtml.indexOf(receiptTag), 'QoQ comparison must load before historical comparison receipt workflow');
assert.match(source, /csv-history-quarter-over-quarter-comparison-v1/);
assert.match(source, /Quarter-over-Quarter Comparison/);
assert.match(source, /Period B must be the immediately following quarter/);
assert.match(source, /Delta direction is B − A/);
assert.match(source, /No selection is silently reordered/);
assert.match(source, /quarter_b_minus_quarter_a/);
assert.match(source, /operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder/);
assert.match(source, /blockedQuarterCannotBeUpgraded: true/);
assert.match(source, /crossQuarterAggregationApplied: false/);
assert.match(source, /crossQuarterNormalizationApplied: false/);
assert.match(source, /quarterSelectionAutoReordered: false/);
assert.match(source, /sameMonthAggregationApplied: false/);
assert.match(source, /businessRowDeduplicationApplied: false/);
assert.match(source, /overlapCollapseApplied: false/);
assert.match(source, /gapRepairApplied: false/);
assert.match(source, /sales_minus_ad_spend_only_not_net_profit/);

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
  assert.equal(pattern.test(source), false, `QoQ comparison must remain explicit-local and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?qoqEngine=${Date.now()}`);
const qoq = await import(`${pathToFileURL(path.join(distRoot, relative)).href}?qoq=${Date.now()}`);

assert.equal(qoq.CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_SCHEMA_VERSION, 'csv-history-quarter-over-quarter-comparison-v1');
assert.equal(qoq.CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_UI_VERSION, '1.0.0');
assert.equal(typeof qoq.buildHistoricalQuarterOverQuarterComparison, 'function');

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
const comparison = await qoq.buildHistoricalQuarterOverQuarterComparison(ledger, '2026-Q1', '2026-Q2');

assert.equal(comparison.schemaVersion, 'csv-history-quarter-over-quarter-comparison-v1');
assert.equal(comparison.ledgerFingerprint, ledger.ledgerFingerprint);
assert.equal(comparison.comparisonAllowed, true);
assert.equal(comparison.interpretationAllowed, true);
assert.equal(comparison.rawEvidenceOnly, false);
assert.equal(comparison.deltaBasis, 'quarter_b_minus_quarter_a');
assert.equal(comparison.selectionPolicy, 'operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder');
assert.equal(comparison.periodA.quarter, '2026-Q1');
assert.equal(comparison.periodB.quarter, '2026-Q2');
assert.equal(comparison.periodA.quarterAggregationAllowed, true);
assert.equal(comparison.periodB.quarterAggregationAllowed, true);
assert.equal(comparison.periodA.rawMonthlyEvidence.length, 3);
assert.equal(comparison.periodB.rawMonthlyEvidence.length, 3);
assert.equal(comparison.periodA.rawEvidenceRetained, true);
assert.equal(comparison.periodB.rawEvidenceRetained, true);
assert.equal(comparison.comparabilityGate.forwardAdjacentCalendarQuartersRequired, true);
assert.equal(comparison.comparabilityGate.blockedQuarterCannotBeUpgraded, true);
assert.ok(Object.values(comparison.comparabilityGate.checks).every(Boolean), 'All QoQ gates must pass for adjacent complete compatible quarters');
assert.deepEqual(comparison.comparabilityGate.reasons, []);

assertMetric(comparison.metrics.spendMicros, 12_000_000, 15_000_000, 3_000_000, 'increase');
assertMetric(comparison.metrics.salesMicros, 30_000_000, 36_000_000, 6_000_000, 'increase');
assertMetric(comparison.metrics.orders, 9, 12, 3, 'increase');
assertApprox(comparison.metrics.acos.periodAValue, 0.4);
assertApprox(comparison.metrics.acos.periodBValue, 15 / 36);
assertApprox(comparison.metrics.acos.delta, (15 / 36) - 0.4);
assert.equal(comparison.metrics.acos.direction, 'increase');
assertApprox(comparison.metrics.roas.periodAValue, 2.5);
assertApprox(comparison.metrics.roas.periodBValue, 36 / 15);
assertApprox(comparison.metrics.roas.delta, (36 / 15) - 2.5);
assert.equal(comparison.metrics.roas.direction, 'decrease');
assertMetric(comparison.metrics.adContributionMicros, 18_000_000, 21_000_000, 3_000_000, 'increase');
for (const item of Object.values(comparison.metrics)) assert.equal(item.interpretationAllowed, true);
assert.equal(comparison.crossQuarterAggregationApplied, false);
assert.equal(comparison.crossQuarterNormalizationApplied, false);
assert.equal(comparison.quarterSelectionAutoReordered, false);
assert.equal(comparison.sameMonthAggregationApplied, false);
assert.equal(comparison.businessRowDeduplicationApplied, false);
assert.equal(comparison.overlapCollapseApplied, false);
assert.equal(comparison.gapRepairApplied, false);
assert.equal(comparison.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(comparison.authority);
assertAuthorityFalse(comparison.periodA.authority);
assertAuthorityFalse(comparison.periodB.authority);

const reverse = await qoq.buildHistoricalQuarterOverQuarterComparison(ledger, '2026-Q2', '2026-Q1');
assert.equal(reverse.comparisonAllowed, false);
assert.equal(reverse.rawEvidenceOnly, true);
assert.equal(reverse.quarterSelectionAutoReordered, false);
assert.ok(reverse.comparabilityGate.reasons.includes('quarters_not_forward_adjacent'));
assertAllDeltasWithheld(reverse);
assert.equal(reverse.periodA.quarter, '2026-Q2', 'Reverse operator selection must remain Period A');
assert.equal(reverse.periodB.quarter, '2026-Q1', 'Reverse operator selection must remain Period B');

const sameQuarter = await qoq.buildHistoricalQuarterOverQuarterComparison(ledger, '2026-Q1', '2026-Q1');
assert.equal(sameQuarter.comparisonAllowed, false);
assert.ok(sameQuarter.comparabilityGate.reasons.includes('same_quarter_selected_twice'));
assert.ok(sameQuarter.comparabilityGate.reasons.includes('quarters_not_forward_adjacent'));
assertAllDeltasWithheld(sameQuarter);

const q3 = await completeQuarter({
  year: 2026,
  quarter: 3,
  hashChars: ['1', '2', '3'],
  metrics: { spendMicros: 6_000_000, salesMicros: 15_000_000, orders: 5, acos: 0.4, roas: 2.5 },
});
const threeQuarterLedger = await ledgerFrom(...q1, ...q2, ...q3);
const skippedQuarter = await qoq.buildHistoricalQuarterOverQuarterComparison(threeQuarterLedger, '2026-Q1', '2026-Q3');
assert.equal(skippedQuarter.comparisonAllowed, false);
assert.ok(skippedQuarter.comparabilityGate.reasons.includes('quarters_not_forward_adjacent'));
assertAllDeltasWithheld(skippedQuarter);

const q4 = await completeQuarter({
  year: 2026,
  quarter: 4,
  hashChars: ['4', '5', '6'],
  metrics: { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
});
const nextYearQ1 = await completeQuarter({
  year: 2027,
  quarter: 1,
  hashChars: ['7', '8', '9'],
  metrics: { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
});
const yearBoundaryLedger = await ledgerFrom(...q4, ...nextYearQ1);
const yearBoundary = await qoq.buildHistoricalQuarterOverQuarterComparison(yearBoundaryLedger, '2026-Q4', '2027-Q1');
assert.equal(yearBoundary.comparisonAllowed, true, 'Q4 to next-year Q1 must count as forward adjacent calendar quarters');
assertAllDirectionsFlat(yearBoundary);

const partialQ2 = await completeQuarter({
  year: 2026,
  quarter: 2,
  hashChars: ['d', 'e', 'f'],
  metrics: { spendMicros: 5_000_000, salesMicros: 12_000_000, orders: 4, acos: 5 / 12, roas: 2.4 },
  partialMonthIndex: 1,
});
const partialLedger = await ledgerFrom(...q1, ...partialQ2);
const partialComparison = await qoq.buildHistoricalQuarterOverQuarterComparison(partialLedger, '2026-Q1', '2026-Q2');
assert.equal(partialComparison.comparisonAllowed, false);
assert.ok(partialComparison.comparabilityGate.reasons.includes('period_b_quarter_gate_blocked'));
assert.equal(partialComparison.periodB.quarterAggregationAllowed, false);
assert.equal(partialComparison.periodB.rawEvidenceOnly, true);
assert.equal(partialComparison.periodB.rawMonthlyEvidence.length, 3, 'Blocked quarter raw monthly evidence must remain visible');
assertAllDeltasWithheld(partialComparison);

const q2Canada = await completeQuarter({
  year: 2026,
  quarter: 2,
  hashChars: ['d', 'e', 'f'],
  metrics: { spendMicros: 5_000_000, salesMicros: 12_000_000, orders: 4, acos: 5 / 12, roas: 2.4 },
  marketplace: 'CA',
  currencyCode: 'CAD',
});
const marketLedger = await ledgerFrom(...q1, ...q2Canada);
const marketComparison = await qoq.buildHistoricalQuarterOverQuarterComparison(marketLedger, '2026-Q1', '2026-Q2');
assert.equal(marketComparison.periodA.quarterAggregationAllowed, true);
assert.equal(marketComparison.periodB.quarterAggregationAllowed, true, 'A coherent CA/CAD quarter may aggregate internally');
assert.equal(marketComparison.comparisonAllowed, false, 'Cross-quarter market/currency mismatch must block QoQ');
assert.ok(marketComparison.comparabilityGate.reasons.includes('marketplace_mismatch_or_unknown'));
assert.ok(marketComparison.comparabilityGate.reasons.includes('currency_mismatch_or_unknown'));
assertAllDeltasWithheld(marketComparison);

await assert.rejects(
  () => qoq.buildHistoricalQuarterOverQuarterComparison(ledger, '2026-Q0', '2026-Q2'),
  (error) => error?.code === 'CSV_HISTORY_QOQ_PERIOD_A_KEY_INVALID',
  'Invalid Period A quarter key must fail closed',
);
await assert.rejects(
  () => qoq.buildHistoricalQuarterOverQuarterComparison(ledger, '2026-Q1', '2026-Q3'),
  (error) => error?.code === 'CSV_HISTORY_QOQ_PERIOD_B_SELECTION_NOT_EXACT',
  'Unknown Period B quarter must fail exact selection instead of inventing evidence',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-quarter-over-quarter-comparison-v1',
  deltaBasis: 'quarter_b_minus_quarter_a',
  adjacentForwardQuartersRequired: true,
  q4ToNextYearQ1Accepted: true,
  reverseSelectionNotAutoReordered: true,
  nonAdjacentQuarterBlocked: true,
  blockedQuarterCannotBeUpgraded: true,
  marketplaceMismatchBlocked: true,
  currencyMismatchBlocked: true,
  blockedDeltasWithheld: true,
  rawQuarterEvidenceRetained: true,
  crossQuarterAggregationApplied: false,
  crossQuarterNormalizationApplied: false,
  sameMonthAggregationApplied: false,
  businessRowDeduplicationApplied: false,
  overlapCollapseApplied: false,
  gapRepairApplied: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

async function completeQuarter({ year, quarter, hashChars, metrics, marketplace = 'US', currencyCode = 'USD', partialMonthIndex = -1 }) {
  const startMonth = (quarter - 1) * 3 + 1;
  const out = [];
  for (let index = 0; index < 3; index += 1) {
    const monthNumber = startMonth + index;
    const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
    const expectedDayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const coveredDayCount = index === partialMonthIndex ? Math.max(1, expectedDayCount - 7) : expectedDayCount;
    out.push(await fixture({
      hashChar: hashChars[index],
      month,
      startDate: `${month}-01`,
      endDate: `${month}-${String(expectedDayCount).padStart(2, '0')}`,
      expectedDayCount,
      coveredDayCount,
      metrics,
      marketplace,
      currencyCode,
    }));
  }
  return out;
}

async function ledgerFrom(...analyses) {
  let ledger = await engine.createCsvHistoryLedger(analyses[0]);
  for (const analysis of analyses.slice(1)) ledger = await engine.mergeCsvHistoryLedger(ledger, analysis);
  return ledger;
}

function assertMetric(item, a, b, delta, direction) {
  assert.equal(item.periodAValue, a);
  assert.equal(item.periodBValue, b);
  assert.equal(item.delta, delta);
  assert.equal(item.direction, direction);
  assert.equal(item.interpretationAllowed, true);
}

function assertApprox(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} ≈ ${expected}`);
}

function assertAllDeltasWithheld(comparison) {
  for (const item of Object.values(comparison.metrics)) {
    assert.equal(item.delta, null);
    assert.equal(item.direction, 'withheld_not_comparable');
    assert.equal(item.interpretationAllowed, false);
  }
}

function assertAllDirectionsFlat(comparison) {
  assert.equal(comparison.comparisonAllowed, true);
  for (const item of Object.values(comparison.metrics)) {
    assertApprox(item.delta, 0);
    assert.equal(item.direction, 'flat');
  }
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
  metrics,
  marketplace,
  currencyCode,
}) {
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
