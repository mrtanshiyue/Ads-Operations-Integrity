import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const assetRelative = 'assets/cloudflare-native-csv-history-rolling-12-operating-review-v1.js';
const assetSource = await readFile(path.join(distRoot, assetRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const boardTag = '<script type="module" src="assets/cloudflare-native-csv-history-year-over-year-ytd-review-board-v1.js?v=1.0.0"></script>';
const rollingTag = '<script type="module" src="assets/cloudflare-native-csv-history-rolling-12-operating-review-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(rollingTag).length - 1, 1, 'Rolling-12 asset must be injected exactly once');
assert.ok(indexSource.indexOf(boardTag) < indexSource.indexOf(rollingTag), 'Rolling-12 must load after YoY YTD review board');
assert.ok(indexSource.indexOf(rollingTag) < indexSource.indexOf(monthlyReceiptTag), 'Rolling-12 must load before legacy monthly receipt workflow');
assert.match(assetSource, /csv-history-rolling-12-operating-review-v1/);
assert.match(assetSource, /Rolling-12 Operating Review/);
assert.match(assetSource, /four_forward_adjacent_validated_natural_quarters/);
assert.match(assetSource, /rollingWindowCadence: 'quarter_aligned'/);
assert.match(assetSource, /windowLengthMonths: 12/);
assert.match(assetSource, /windowLengthQuarters: 4/);
assert.match(assetSource, /observed_natural_quarter_endpoints_no_auto_fill_or_reorder/);
assert.match(assetSource, /never reconstructs or repairs monthly evidence/);
assert.match(assetSource, /ACoS and ROAS are recomputed from Rolling-12 totals/);
assert.match(assetSource, /Ad Contribution = Sales - Ad Spend only; it is not Net Profit/);
assert.match(assetSource, /crossWindowAggregationApplied: false/);
assert.match(assetSource, /normalizationApplied: false/);
assert.match(assetSource, /sameMonthAggregationApplied: false/);
assert.match(assetSource, /businessRowDeduplicationApplied: false/);
assert.match(assetSource, /overlapCollapseApplied: false/);
assert.match(assetSource, /gapRepairApplied: false/);
assert.match(assetSource, /quarterSelectionAutoReordered: false/);
assert.match(assetSource, /recommendationGenerated: false/);
assert.match(assetSource, /actionGenerated: false/);

for (const pattern of [
  /\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /\bWebSocket\b/, /\bEventSource\b/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /CloudflareNativeAPI/, /\/api\/v1\//,
  /CONTROL_DB/, /STORE_01_DB/, /DATA_BUCKET/, /AMAZON_ADS_ENABLED/, /optimization-actions/, /execution-permits/,
]) assert.equal(pattern.test(assetSource), false, `Rolling-12 must remain explicit-local and execution-free: ${pattern}`);

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?r12Engine=${Date.now()}`);
const r12Mod = await import(`${pathToFileURL(path.join(distRoot, assetRelative)).href}?r12=${Date.now()}`);
assert.equal(r12Mod.CSV_HISTORY_ROLLING_12_OPERATING_REVIEW_SCHEMA_VERSION, 'csv-history-rolling-12-operating-review-v1');
assert.equal(r12Mod.CSV_HISTORY_ROLLING_12_OPERATING_REVIEW_UI_VERSION, '1.0.0');
assert.equal(typeof r12Mod.buildHistoricalRolling12OperatingReview, 'function');

const q3_2025 = await completeQuarter({ year: 2025, quarter: 3, seed: '25q3', metrics: { spendMicros: 1_000_000, salesMicros: 4_000_000, orders: 1, acos: 0.25, roas: 4 } });
const q4_2025 = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4', metrics: { spendMicros: 2_000_000, salesMicros: 5_000_000, orders: 2, acos: 0.4, roas: 2.5 } });
const q1_2026 = await completeQuarter({ year: 2026, quarter: 1, seed: '26q1', metrics: { spendMicros: 3_000_000, salesMicros: 6_000_000, orders: 3, acos: 0.5, roas: 2 } });
const q2_2026 = await completeQuarter({ year: 2026, quarter: 2, seed: '26q2', metrics: { spendMicros: 4_000_000, salesMicros: 8_000_000, orders: 4, acos: 0.5, roas: 2 } });
const ledger = await ledgerFrom(...q3_2025, ...q4_2025, ...q1_2026, ...q2_2026);
const review = await r12Mod.buildHistoricalRolling12OperatingReview(ledger);

assert.equal(review.schemaVersion, 'csv-history-rolling-12-operating-review-v1');
assert.equal(review.ledgerFingerprint, ledger.ledgerFingerprint);
assert.equal(review.aggregationBasis, 'four_forward_adjacent_validated_natural_quarters');
assert.equal(review.rollingWindowCadence, 'quarter_aligned');
assert.equal(review.windowLengthMonths, 12);
assert.equal(review.windowLengthQuarters, 4);
assert.equal(review.windowSelectionPolicy, 'observed_natural_quarter_endpoints_no_auto_fill_or_reorder');
assert.equal(review.sourceQuarterCount, 4);
assert.equal(review.quarterlyReviewSchemaVersion, 'csv-history-quarterly-operating-review-v1');
assert.equal(review.windowCount, 4);
assert.equal(review.aggregationAllowedWindowCount, 1);
assert.equal(review.aggregationBlockedWindowCount, 3);
assert.equal(review.rawEvidenceRetainedWhenBlocked, true);
assert.equal(review.crossWindowAggregationApplied, false);
assert.equal(review.normalizationApplied, false);
assert.equal(review.sameMonthAggregationApplied, false);
assert.equal(review.recommendationGenerated, false);
assert.equal(review.actionGenerated, false);
assert.equal(review.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(review.authority);

const early = windowByKey(review, '2025-Q3-R12');
assert.equal(early.rolling12AggregationAllowed, false);
assert.equal(early.rawEvidenceOnly, true);
assert.deepEqual(early.expectedQuarterKeys, ['2024-Q4', '2025-Q1', '2025-Q2', '2025-Q3']);
assert.deepEqual(early.missingQuarterKeys, ['2024-Q4', '2025-Q1', '2025-Q2']);
assert.ok(early.blockers.includes('missing_or_duplicate_quarter_evidence'));
assert.equal(early.rawQuarterEvidence.length, 1);
assertAllMetricsWithheld(early);

const allowed = windowByKey(review, '2026-Q2-R12');
assert.equal(allowed.throughQuarter, '2026-Q2');
assert.equal(allowed.periodStartDate, '2025-07-01');
assert.equal(allowed.periodEndDate, '2026-06-30');
assert.deepEqual(allowed.expectedQuarterKeys, ['2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2']);
assert.deepEqual(allowed.observedQuarterKeys, allowed.expectedQuarterKeys);
assert.deepEqual(allowed.missingQuarterKeys, []);
assert.deepEqual(allowed.duplicateQuarterKeys, []);
assert.equal(allowed.sourceQuarterCount, 4);
assert.equal(allowed.rolling12AggregationAllowed, true);
assert.equal(allowed.aggregationWithheld, false);
assert.equal(allowed.interpretationAllowed, true);
assert.equal(allowed.rawEvidenceOnly, false);
assert.equal(allowed.marketplace, 'US');
assert.equal(allowed.currencyCode, 'USD');
assert.equal(allowed.metrics.spendMicros, 30_000_000);
assert.equal(allowed.metrics.salesMicros, 69_000_000);
assert.equal(allowed.metrics.orders, 30);
assert.equal(allowed.metrics.adContributionMicros, 39_000_000);
assert.equal(allowed.metrics.acos, 30_000_000 / 69_000_000, 'Rolling-12 ACoS must be recomputed from totals, not averaged from quarter ratios');
assert.equal(allowed.metrics.roas, 69_000_000 / 30_000_000, 'Rolling-12 ROAS must be recomputed from totals, not averaged from quarter ratios');
assert.equal(allowed.sourceInputSetFingerprints.length, 12);
assert.equal(new Set(allowed.sourceInputSetFingerprints).size, 12);
assert.equal(allowed.sourceContentSha256s.length, 12);
assert.equal(new Set(allowed.sourceContentSha256s).size, 12);
assert.equal(allowed.rawQuarterEvidence.length, 4);
assert.equal(allowed.rawQuarterEvidence.every((item) => item.quarterAggregationAllowed === true), true);
assert.equal(allowed.rawQuarterEvidence.every((item) => item.rawMonthlyEvidence.length === 3), true);
assert.equal(allowed.crossQuarterAggregationApplied, true);
assert.equal(allowed.crossWindowAggregationApplied, false);
assert.equal(allowed.quarterSelectionAutoReordered, false);
assert.equal(allowed.recommendationGenerated, false);
assert.equal(allowed.actionGenerated, false);
assert.equal(allowed.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(allowed.authority);

const partialQ2Ledger = await ledgerFrom(...q3_2025, ...q4_2025, ...q1_2026, ...q2_2026.slice(0, 2));
const partialReview = await r12Mod.buildHistoricalRolling12OperatingReview(partialQ2Ledger);
const partial = windowByKey(partialReview, '2026-Q2-R12');
assert.equal(partial.sourceQuarterCount, 4);
assert.equal(partial.rawQuarterEvidence[3].quarterAggregationAllowed, false);
assert.equal(partial.rolling12AggregationAllowed, false);
assert.equal(partial.interpretationAllowed, false);
assert.equal(partial.rawEvidenceOnly, true);
assert.ok(partial.blockers.includes('quarterly_aggregation_blocked'));
assertAllMetricsWithheld(partial);

const caQ4 = await completeQuarter({ year: 2025, quarter: 4, seed: '25q4-ca', marketplace: 'CA', metrics: { spendMicros: 2_000_000, salesMicros: 5_000_000, orders: 2, acos: 0.4, roas: 2.5 } });
const marketplaceLedger = await ledgerFrom(...q3_2025, ...caQ4, ...q1_2026, ...q2_2026);
const marketplaceReview = await r12Mod.buildHistoricalRolling12OperatingReview(marketplaceLedger);
const mismatch = windowByKey(marketplaceReview, '2026-Q2-R12');
assert.equal(mismatch.rawQuarterEvidence.every((item) => item.quarterAggregationAllowed === true), true, 'Each quarter can be individually valid before Rolling-12 cross-quarter compatibility is evaluated');
assert.equal(mismatch.rolling12AggregationAllowed, false);
assert.ok(mismatch.blockers.includes('marketplace_mismatch_or_unknown'));
assertAllMetricsWithheld(mismatch);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-rolling-12-operating-review-v1',
  cadence: 'quarter_aligned',
  canonicalQuarterlyReviewReused: true,
  rollingWindowLengthMonths: 12,
  rollingWindowLengthQuarters: 4,
  crossYearWindowAllowed: true,
  insufficientHistoryBlocked: true,
  blockedQuarterCannotBeUpgraded: true,
  marketplaceMismatchBlocked: true,
  rolling12AcosRecomputedFromTotals: true,
  rolling12RoasRecomputedFromTotals: true,
  blockedMetricsWithheld: true,
  rawQuarterAndMonthlyEvidenceRetained: true,
  quarterSelectionAutoReordered: false,
  crossWindowAggregationApplied: false,
  normalizationApplied: false,
  recommendationGenerated: false,
  actionGenerated: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function windowByKey(review, key) { const found = review.windows.find((item) => item.windowKey === key); assert.ok(found, `Expected window ${key}`); return found; }
function assertAllMetricsWithheld(window) { for (const value of Object.values(window.metrics)) assert.equal(value, null); }
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
