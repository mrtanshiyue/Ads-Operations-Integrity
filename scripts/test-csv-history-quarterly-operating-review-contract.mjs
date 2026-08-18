import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const relative = 'assets/cloudflare-native-csv-history-quarterly-operating-review-v1.js';
const source = await readFile(path.join(distRoot, relative), 'utf8');
const indexHtml = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const historyTag = '<script type="module" src="assets/cloudflare-native-csv-history-ledger-v1.js?v=1.4.0"></script>';
const quarterlyTag = '<script type="module" src="assets/cloudflare-native-csv-history-quarterly-operating-review-v1.js?v=1.0.0"></script>';
const receiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexHtml.split(quarterlyTag).length - 1, 1, 'Quarterly operating review must be injected exactly once');
assert.ok(indexHtml.indexOf(historyTag) < indexHtml.indexOf(quarterlyTag), 'Quarterly review must load after history ledger');
assert.ok(indexHtml.indexOf(quarterlyTag) < indexHtml.indexOf(receiptTag), 'Quarterly review must load before historical comparison receipt workflow');
assert.match(source, /csv-history-quarterly-operating-review-v1/);
assert.match(source, /Quarterly Operating Review/);
assert.match(source, /all three exact calendar months pass the evidence gate/);
assert.match(source, /same-month duplicate evidence/);
assert.match(source, /Raw monthly evidence remains visible/);
assert.match(source, /Ad Contribution = Sales - Ad Spend only; it is not Net Profit/);
assert.match(source, /crossQuarterAggregationApplied: false/);
assert.match(source, /sameMonthAggregationApplied: false/);
assert.match(source, /businessRowDeduplicationApplied: false/);
assert.match(source, /overlapCollapseApplied: false/);
assert.match(source, /gapRepairApplied: false/);
assert.match(source, /partialPeriodsHidden: false/);
assert.match(source, /missingMonthsHidden: false/);

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
  assert.equal(pattern.test(source), false, `Quarterly operating review must remain explicit-local and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?quarterEngine=${Date.now()}`);
const quarterly = await import(`${pathToFileURL(path.join(distRoot, relative)).href}?quarter=${Date.now()}`);

assert.equal(quarterly.CSV_HISTORY_QUARTERLY_OPERATING_REVIEW_SCHEMA_VERSION, 'csv-history-quarterly-operating-review-v1');
assert.equal(quarterly.CSV_HISTORY_QUARTERLY_OPERATING_REVIEW_UI_VERSION, '1.0.0');
assert.equal(typeof quarterly.buildHistoricalQuarterlyOperatingReview, 'function');

const january = await fixture({
  hashChar: 'a', month: '2026-01', startDate: '2026-01-01', endDate: '2026-01-31', expectedDayCount: 31, coveredDayCount: 31,
  metrics: { spendMicros: 3_000_000, salesMicros: 9_000_000, orders: 3, acos: 1 / 3, roas: 3 },
});
const february = await fixture({
  hashChar: 'b', month: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28', expectedDayCount: 28, coveredDayCount: 28,
  metrics: { spendMicros: 4_000_000, salesMicros: 8_000_000, orders: 4, acos: 0.5, roas: 2 },
});
const march = await fixture({
  hashChar: 'c', month: '2026-03', startDate: '2026-03-01', endDate: '2026-03-31', expectedDayCount: 31, coveredDayCount: 31,
  metrics: { spendMicros: 5_000_000, salesMicros: 13_000_000, orders: 5, acos: 5 / 13, roas: 2.6 },
});
const completeLedger = await ledgerFrom(january, february, march);
const completeReview = await quarterly.buildHistoricalQuarterlyOperatingReview(completeLedger);

assert.equal(completeReview.schemaVersion, 'csv-history-quarterly-operating-review-v1');
assert.equal(completeReview.ledgerFingerprint, completeLedger.ledgerFingerprint);
assert.equal(completeReview.quarterCount, 1);
assert.equal(completeReview.aggregationAllowedQuarterCount, 1);
assert.equal(completeReview.aggregationBlockedQuarterCount, 0);
assert.equal(completeReview.sourceMonthlyEvidenceCount, 3);
assert.equal(completeReview.crossQuarterAggregationApplied, false);
assert.equal(completeReview.sameMonthAggregationApplied, false);
assert.equal(completeReview.normalizationApplied, false);
assert.equal(completeReview.businessRowDeduplicationApplied, false);
assert.equal(completeReview.overlapCollapseApplied, false);
assert.equal(completeReview.gapRepairApplied, false);
assert.equal(completeReview.partialPeriodsHidden, false);
assert.equal(completeReview.missingMonthsHidden, false);
assert.equal(completeReview.rawEvidenceRetainedWhenBlocked, true);
assert.equal(completeReview.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(completeReview.authority);

const q1 = completeReview.quarters[0];
assert.equal(q1.quarter, '2026-Q1');
assert.equal(q1.quarterStartDate, '2026-01-01');
assert.equal(q1.quarterEndDate, '2026-03-31');
assert.deepEqual(q1.expectedMonths, ['2026-01', '2026-02', '2026-03']);
assert.deepEqual(q1.observedMonths, ['2026-01', '2026-02', '2026-03']);
assert.deepEqual(q1.missingMonths, []);
assert.deepEqual(q1.duplicateEvidenceMonths, []);
assert.equal(q1.sourceEvidenceCount, 3);
assert.equal(q1.quarterAggregationAllowed, true);
assert.equal(q1.aggregationWithheld, false);
assert.equal(q1.interpretationAllowed, true);
assert.equal(q1.rawEvidenceOnly, false);
assert.deepEqual(q1.blockers, []);
assert.ok(Object.values(q1.checks).every(Boolean), 'Every quarter gate must pass for complete Jan/Feb/Mar evidence');
assert.equal(q1.marketplace, 'US');
assert.equal(q1.currencyCode, 'USD');
assert.equal(q1.metrics.spendMicros, 12_000_000);
assert.equal(q1.metrics.salesMicros, 30_000_000);
assert.equal(q1.metrics.orders, 12);
assert.equal(q1.metrics.adContributionMicros, 18_000_000);
assert.equal(q1.metrics.acos, 0.4);
assert.equal(q1.metrics.roas, 2.5);
assert.equal(q1.rawMonthlyEvidence.length, 3);
assert.equal(q1.rawEvidenceRetained, true);
assert.equal(q1.sameMonthAggregationApplied, false);
assert.equal(q1.normalizationApplied, false);
assert.equal(q1.businessRowDeduplicationApplied, false);
assert.equal(q1.overlapCollapseApplied, false);
assert.equal(q1.gapRepairApplied, false);
assert.equal(q1.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(q1.authority);
for (const item of q1.rawMonthlyEvidence) {
  assert.equal(item.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
  assert.equal(item.metrics.adContributionMicros, item.metrics.salesMicros - item.metrics.spendMicros);
  assertAuthorityFalse(item.authority);
}

const missingLedger = await ledgerFrom(january, march);
const missingReview = await quarterly.buildHistoricalQuarterlyOperatingReview(missingLedger);
const missingQ1 = missingReview.quarters[0];
assert.equal(missingQ1.quarterAggregationAllowed, false);
assert.equal(missingQ1.rawEvidenceOnly, true);
assert.deepEqual(missingQ1.missingMonths, ['2026-02']);
assert.ok(missingQ1.blockers.includes('missing_or_duplicate_month_evidence'));
assert.ok(missingQ1.blockers.includes('expected_month_evidence_not_exact'));
assertMetricsWithheld(missingQ1.metrics);
assert.equal(missingQ1.rawMonthlyEvidence.length, 2, 'Missing-month quarter must retain the two supplied evidence rows');

const partialFebruary = await fixture({
  hashChar: 'd', month: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28', expectedDayCount: 28, coveredDayCount: 14,
});
const partialReview = await quarterly.buildHistoricalQuarterlyOperatingReview(await ledgerFrom(january, partialFebruary, march));
const partialQ1 = partialReview.quarters[0];
assert.equal(partialQ1.quarterAggregationAllowed, false);
assert.ok(partialQ1.blockers.includes('partial_month_coverage'));
assertMetricsWithheld(partialQ1.metrics);
assert.equal(partialQ1.rawMonthlyEvidence.length, 3, 'Partial evidence must remain visible rather than being hidden');

const duplicateJanuary = await fixture({
  hashChar: 'e', month: '2026-01', startDate: '2026-01-01', endDate: '2026-01-31', expectedDayCount: 31, coveredDayCount: 31,
  metrics: { spendMicros: 9_000_000, salesMicros: 19_000_000, orders: 9, acos: 9 / 19, roas: 19 / 9 },
});
const duplicateReview = await quarterly.buildHistoricalQuarterlyOperatingReview(await ledgerFrom(january, duplicateJanuary, february, march));
const duplicateQ1 = duplicateReview.quarters[0];
assert.equal(duplicateQ1.quarterAggregationAllowed, false);
assert.deepEqual(duplicateQ1.duplicateEvidenceMonths, ['2026-01']);
assert.ok(duplicateQ1.blockers.includes('missing_or_duplicate_month_evidence'));
assert.ok(duplicateQ1.blockers.includes('historical_window_overlap_detected'));
assertMetricsWithheld(duplicateQ1.metrics);
assert.equal(duplicateQ1.rawMonthlyEvidence.length, 4, 'Same-month immutable evidence must remain separate and visible');
assert.equal(duplicateQ1.sameMonthAggregationApplied, false);
assert.equal(duplicateQ1.overlapCollapseApplied, false);

const ambiguousFebruary = await fixture({
  hashChar: 'f', month: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28', expectedDayCount: 28, coveredDayCount: 28,
  ambiguousIdentityCount: 1,
});
const ambiguousReview = await quarterly.buildHistoricalQuarterlyOperatingReview(await ledgerFrom(january, ambiguousFebruary, march));
const ambiguousQ1 = ambiguousReview.quarters[0];
assert.equal(ambiguousQ1.quarterAggregationAllowed, false);
assert.ok(ambiguousQ1.blockers.includes('ambiguous_observed_identity'));
assertMetricsWithheld(ambiguousQ1.metrics);

const canadaMarch = await fixture({
  hashChar: '1', month: '2026-03', startDate: '2026-03-01', endDate: '2026-03-31', expectedDayCount: 31, coveredDayCount: 31,
  marketplace: 'CA', currencyCode: 'CAD',
});
const marketReview = await quarterly.buildHistoricalQuarterlyOperatingReview(await ledgerFrom(january, february, canadaMarch));
const marketQ1 = marketReview.quarters[0];
assert.equal(marketQ1.quarterAggregationAllowed, false);
assert.ok(marketQ1.blockers.includes('marketplace_mismatch_or_unknown'));
assert.ok(marketQ1.blockers.includes('currency_mismatch_or_unknown'));
assert.equal(marketQ1.marketplace, null);
assert.equal(marketQ1.currencyCode, null);
assertMetricsWithheld(marketQ1.metrics);

const nonContiguousFebruary = await fixture({
  hashChar: '2', month: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28', expectedDayCount: 28, coveredDayCount: 28,
  contiguousCoverage: false,
});
const contiguityReview = await quarterly.buildHistoricalQuarterlyOperatingReview(await ledgerFrom(january, nonContiguousFebruary, march));
assert.equal(contiguityReview.quarters[0].quarterAggregationAllowed, false);
assert.ok(contiguityReview.quarters[0].blockers.includes('non_contiguous_monthly_coverage'));
assertMetricsWithheld(contiguityReview.quarters[0].metrics);

const unsafeFebruary = await fixture({
  hashChar: '3', month: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28', expectedDayCount: 28, coveredDayCount: 28,
  safeForNaiveAggregation: false,
});
const unsafeReview = await quarterly.buildHistoricalQuarterlyOperatingReview(await ledgerFrom(january, unsafeFebruary, march));
assert.equal(unsafeReview.quarters[0].quarterAggregationAllowed, false);
assert.ok(unsafeReview.quarters[0].blockers.includes('unsafe_monthly_quality_state'));
assertMetricsWithheld(unsafeReview.quarters[0].metrics);

const q2April = await fixture({ hashChar: '4', month: '2026-04', startDate: '2026-04-01', endDate: '2026-04-30', expectedDayCount: 30, coveredDayCount: 30 });
const q2May = await fixture({ hashChar: '5', month: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31', expectedDayCount: 31, coveredDayCount: 31 });
const q2June = await fixture({ hashChar: '6', month: '2026-06', startDate: '2026-06-01', endDate: '2026-06-30', expectedDayCount: 30, coveredDayCount: 30 });
const twoQuarterReview = await quarterly.buildHistoricalQuarterlyOperatingReview(await ledgerFrom(january, february, march, q2April, q2May, q2June));
assert.equal(twoQuarterReview.quarterCount, 2);
assert.equal(twoQuarterReview.aggregationAllowedQuarterCount, 2);
assert.deepEqual(twoQuarterReview.quarters.map((item) => item.quarter), ['2026-Q1', '2026-Q2']);
assert.equal(twoQuarterReview.crossQuarterAggregationApplied, false, 'Quarter rows must remain independent; no cross-quarter total is created');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-quarterly-operating-review-v1',
  completeCalendarQuarterAggregates: true,
  naturalMonthLengthsAccepted: true,
  quarterMetricsDerivedFromTotals: true,
  missingMonthBlocked: true,
  partialMonthBlocked: true,
  sameMonthDuplicateEvidenceBlockedAndRetained: true,
  historicalOverlapBlocked: true,
  ambiguousIdentityBlocked: true,
  marketplaceMismatchBlocked: true,
  currencyMismatchBlocked: true,
  nonContiguousCoverageBlocked: true,
  unsafeMonthlyQualityBlocked: true,
  blockedQuarterMetricsWithheld: true,
  rawMonthlyEvidenceRetained: true,
  crossQuarterAggregationApplied: false,
  sameMonthAggregationApplied: false,
  normalizationApplied: false,
  businessRowDeduplicationApplied: false,
  overlapCollapseApplied: false,
  gapRepairApplied: false,
  partialPeriodsHidden: false,
  missingMonthsHidden: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

async function ledgerFrom(...analyses) {
  let ledger = await engine.createCsvHistoryLedger(analyses[0]);
  for (const analysis of analyses.slice(1)) ledger = await engine.mergeCsvHistoryLedger(ledger, analysis);
  return ledger;
}

function assertMetricsWithheld(metrics) {
  for (const key of ['spendMicros', 'salesMicros', 'orders', 'acos', 'roas', 'adContributionMicros']) {
    assert.equal(metrics[key], null, `Blocked quarter metric ${key} must be withheld`);
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
  metrics = { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
  marketplace = 'US',
  currencyCode = 'USD',
  ambiguousIdentityCount = 0,
  contiguousCoverage = true,
  safeForNaiveAggregation = true,
  qualityState = 'single_window',
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
      authority, qualityState, safeForNaiveAggregation, contiguousCoverage,
      summary: { overlapPairCount: 0, gapCount: 0 },
    },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: {
      authority,
      summary: { monthlySnapshotCount: 1, aggregationSafe: safeForNaiveAggregation, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false },
      monthlySnapshots: [{
        periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount, factCount: 10,
        metrics,
        adContributionMicros: metrics.salesMicros - metrics.spendMicros,
        profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
        coverage: { expectedDayCount, coveredDayCount, coverageRatio: coveredDayCount / expectedDayCount, complete },
        reliability: { state: complete ? 'complete_coverage' : 'incomplete_coverage', aggregationSafe: safeForNaiveAggregation, coverageComplete: complete, analyticalDecisionUse: complete ? 'observed_review_only' : 'review_with_partial_coverage' },
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
