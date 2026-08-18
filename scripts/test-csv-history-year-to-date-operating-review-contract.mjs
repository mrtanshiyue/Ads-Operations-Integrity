import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const assetRelative = 'assets/cloudflare-native-csv-history-year-to-date-operating-review-v1.js';
const assetSource = await readFile(path.join(distRoot, assetRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const qoqVerificationTag = '<script type="module" src="assets/cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-verification-v1.js?v=1.0.0"></script>';
const ytdTag = '<script type="module" src="assets/cloudflare-native-csv-history-year-to-date-operating-review-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(ytdTag).length - 1, 1, 'YTD operating review asset must be injected exactly once');
assert.ok(indexSource.indexOf(qoqVerificationTag) < indexSource.indexOf(ytdTag), 'YTD operating review must load after canonical QoQ receipt verification');
assert.ok(indexSource.indexOf(ytdTag) < indexSource.indexOf(monthlyReceiptTag), 'YTD operating review must load before legacy monthly receipt workflow');
assert.match(assetSource, /csv-history-year-to-date-operating-review-v1/);
assert.match(assetSource, /Year-to-Date Operating Review/);
assert.match(assetSource, /Quarter-aligned YTD only/);
assert.match(assetSource, /validated_natural_quarters_q1_through_selected_quarter/);
assert.match(assetSource, /observed_natural_quarter_endpoints_no_auto_fill_or_reorder/);
assert.match(assetSource, /Partial or blocked quarters are never promoted into YTD metrics/);
assert.match(assetSource, /Ad Contribution = Sales - Ad Spend only; it is not Net Profit/);
assert.match(assetSource, /sameMonthAggregationApplied: false/);
assert.match(assetSource, /normalizationApplied: false/);
assert.match(assetSource, /businessRowDeduplicationApplied: false/);
assert.match(assetSource, /overlapCollapseApplied: false/);
assert.match(assetSource, /gapRepairApplied: false/);
assert.match(assetSource, /quarterSelectionAutoReordered: false/);

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
  assert.equal(pattern.test(assetSource), false, `YTD operating review must remain explicit-local and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?ytdEngine=${Date.now()}`);
const ytdMod = await import(`${pathToFileURL(path.join(distRoot, assetRelative)).href}?ytd=${Date.now()}`);

assert.equal(ytdMod.CSV_HISTORY_YEAR_TO_DATE_OPERATING_REVIEW_SCHEMA_VERSION, 'csv-history-year-to-date-operating-review-v1');
assert.equal(ytdMod.CSV_HISTORY_YEAR_TO_DATE_OPERATING_REVIEW_UI_VERSION, '1.0.0');
assert.equal(typeof ytdMod.buildHistoricalYearToDateOperatingReview, 'function');

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
const review = await ytdMod.buildHistoricalYearToDateOperatingReview(ledger);
assert.equal(review.schemaVersion, 'csv-history-year-to-date-operating-review-v1');
assert.equal(review.ledgerFingerprint, ledger.ledgerFingerprint);
assert.equal(review.aggregationBasis, 'validated_natural_quarters_q1_through_selected_quarter');
assert.equal(review.selectionPolicy, 'observed_natural_quarter_endpoints_no_auto_fill_or_reorder');
assert.equal(review.yearCount, 1);
assert.equal(review.periodCount, 2);
assert.equal(review.aggregationAllowedPeriodCount, 2);
assert.equal(review.aggregationBlockedPeriodCount, 0);
assert.equal(review.sourceQuarterCount, 2);
assert.equal(review.quarterlyReviewSchemaVersion, 'csv-history-quarterly-operating-review-v1');
assert.equal(review.rawEvidenceRetainedWhenBlocked, true);
assert.equal(review.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(review.authority);

const ytdQ1 = period(review, '2026-YTD-Q1');
assert.equal(ytdQ1.ytdAggregationAllowed, true);
assert.equal(ytdQ1.crossQuarterAggregationApplied, false);
assert.deepEqual(ytdQ1.expectedQuarterKeys, ['2026-Q1']);
assert.deepEqual(ytdQ1.missingQuarterKeys, []);
assert.equal(ytdQ1.metrics.spendMicros, 12_000_000);
assert.equal(ytdQ1.metrics.salesMicros, 30_000_000);
assert.equal(ytdQ1.metrics.orders, 9);
assert.equal(ytdQ1.metrics.adContributionMicros, 18_000_000);
assert.equal(ytdQ1.metrics.acos, 12_000_000 / 30_000_000);
assert.equal(ytdQ1.metrics.roas, 30_000_000 / 12_000_000);

const ytdQ2 = period(review, '2026-YTD-Q2');
assert.equal(ytdQ2.ytdAggregationAllowed, true);
assert.equal(ytdQ2.aggregationWithheld, false);
assert.equal(ytdQ2.interpretationAllowed, true);
assert.equal(ytdQ2.rawEvidenceOnly, false);
assert.equal(ytdQ2.periodStartDate, '2026-01-01');
assert.equal(ytdQ2.periodEndDate, '2026-06-30');
assert.deepEqual(ytdQ2.expectedQuarterKeys, ['2026-Q1', '2026-Q2']);
assert.deepEqual(ytdQ2.observedQuarterKeys, ['2026-Q1', '2026-Q2']);
assert.deepEqual(ytdQ2.missingQuarterKeys, []);
assert.deepEqual(ytdQ2.duplicateQuarterKeys, []);
assert.equal(ytdQ2.sourceQuarterCount, 2);
assert.equal(ytdQ2.crossQuarterAggregationApplied, true);
assert.equal(ytdQ2.quarterSelectionAutoReordered, false);
assert.equal(ytdQ2.metrics.spendMicros, 27_000_000);
assert.equal(ytdQ2.metrics.salesMicros, 66_000_000);
assert.equal(ytdQ2.metrics.orders, 21);
assert.equal(ytdQ2.metrics.adContributionMicros, 39_000_000);
assert.equal(ytdQ2.metrics.acos, 27_000_000 / 66_000_000, 'YTD ACoS must be recomputed from YTD totals, never averaged from quarter ACoS');
assert.equal(ytdQ2.metrics.roas, 66_000_000 / 27_000_000, 'YTD ROAS must be recomputed from YTD totals, never averaged from quarter ROAS');
assert.equal(ytdQ2.sourceInputSetFingerprints.length, 6);
assert.equal(new Set(ytdQ2.sourceInputSetFingerprints).size, 6);
assert.equal(ytdQ2.sourceContentSha256s.length, 6);
assert.equal(new Set(ytdQ2.sourceContentSha256s).size, 6);
assert.equal(ytdQ2.rawQuarterEvidence.length, 2);
assert.equal(ytdQ2.rawQuarterEvidence[0].rawMonthlyEvidence.length, 3);
assert.equal(ytdQ2.rawQuarterEvidence[1].rawMonthlyEvidence.length, 3);
assert.equal(ytdQ2.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(ytdQ2.authority);

const partialQ2Ledger = await ledgerFrom(...q1, ...q2.slice(0, 2));
const partialReview = await ytdMod.buildHistoricalYearToDateOperatingReview(partialQ2Ledger);
const partialYtdQ2 = period(partialReview, '2026-YTD-Q2');
assert.equal(partialYtdQ2.ytdAggregationAllowed, false);
assert.equal(partialYtdQ2.aggregationWithheld, true);
assert.equal(partialYtdQ2.interpretationAllowed, false);
assert.equal(partialYtdQ2.rawEvidenceOnly, true);
assert.ok(partialYtdQ2.blockers.includes('quarterly_aggregation_blocked'));
assert.equal(partialYtdQ2.rawQuarterEvidence.length, 2);
assert.equal(partialYtdQ2.rawQuarterEvidence[1].quarterAggregationAllowed, false);
for (const value of Object.values(partialYtdQ2.metrics)) assert.equal(value, null, 'Blocked YTD period must withhold all six metrics');
assertAuthorityFalse(partialYtdQ2.authority);

const q2OnlyLedger = await ledgerFrom(...q2);
const q2OnlyReview = await ytdMod.buildHistoricalYearToDateOperatingReview(q2OnlyLedger);
assert.equal(q2OnlyReview.periodCount, 1);
const missingPriorQuarter = period(q2OnlyReview, '2026-YTD-Q2');
assert.equal(missingPriorQuarter.ytdAggregationAllowed, false);
assert.deepEqual(missingPriorQuarter.missingQuarterKeys, ['2026-Q1']);
assert.ok(missingPriorQuarter.blockers.includes('missing_or_duplicate_quarter_evidence'));
assert.equal(missingPriorQuarter.rawQuarterEvidence.length, 1);
assert.equal(missingPriorQuarter.rawQuarterEvidence[0].quarter, '2026-Q2');
for (const value of Object.values(missingPriorQuarter.metrics)) assert.equal(value, null);

const caQ2 = await completeQuarter({
  year: 2026,
  quarter: 2,
  hashChars: ['1', '2', '3'],
  marketplace: 'CA',
  metrics: { spendMicros: 5_000_000, salesMicros: 12_000_000, orders: 4, acos: 5 / 12, roas: 2.4 },
});
const marketplaceMismatchLedger = await ledgerFrom(...q1, ...caQ2);
const marketplaceMismatchReview = await ytdMod.buildHistoricalYearToDateOperatingReview(marketplaceMismatchLedger);
const marketplaceMismatch = period(marketplaceMismatchReview, '2026-YTD-Q2');
assert.equal(marketplaceMismatch.rawQuarterEvidence.every((item) => item.quarterAggregationAllowed === true), true, 'Each quarter may be individually valid before cross-quarter YTD compatibility is evaluated');
assert.equal(marketplaceMismatch.ytdAggregationAllowed, false);
assert.ok(marketplaceMismatch.blockers.includes('marketplace_mismatch_or_unknown'));
for (const value of Object.values(marketplaceMismatch.metrics)) assert.equal(value, null);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-year-to-date-operating-review-v1',
  basis: 'validated_natural_quarters_q1_through_selected_quarter',
  canonicalQuarterlyGateReused: true,
  q1AndQ2YtdAllowed: true,
  ytdAcosRecomputedFromTotals: true,
  ytdRoasRecomputedFromTotals: true,
  partialQuarterBlocksYtd: true,
  missingPriorQuarterBlocksYtd: true,
  crossQuarterMarketplaceMismatchBlocksYtd: true,
  blockedMetricsWithheld: true,
  rawQuarterAndMonthlyEvidenceRetained: true,
  quarterSelectionAutoReordered: false,
  sameMonthAggregationApplied: false,
  normalizationApplied: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function period(review, key) {
  const found = review.periods.find((item) => item.periodKey === key);
  assert.ok(found, `Expected YTD period ${key}`);
  return found;
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
