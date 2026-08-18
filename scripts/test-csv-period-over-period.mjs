import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSV_PERIOD_ANALYSIS_SCHEMA_VERSION,
  CSV_TRAILING_PERIOD_DAYS,
  analyzeCsvPeriodOverPeriod,
} from '../cloudflare/runtime/csv-period-over-period-analysis.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'cloudflare', 'runtime', 'csv-period-over-period-analysis.js');
const builtPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'csv-analysis-engine', 'csv-period-over-period-analysis.js');
const [source, built] = await Promise.all([readFile(sourcePath, 'utf8'), readFile(builtPath, 'utf8')]);
assert.equal(built, source, 'Built period-over-period module must be byte-identical to canonical runtime source');

const facts = [];
for (let day = 1; day <= 14; day += 1) {
  const currentWeek = day >= 8;
  facts.push(fact(`2026-07-${String(day).padStart(2, '0')}`, {
    impressions: currentWeek ? 200 : 100,
    clicks: currentWeek ? 20 : 10,
    purchases: currentWeek ? 2 : 1,
    unitsSold: currentWeek ? 2 : 1,
    costMicros: currentWeek ? 2_000_000 : 1_000_000,
    salesMicros: currentWeek ? 10_000_000 : 5_000_000,
  }));
}
const dataQuality = {
  safeForNaiveAggregation: true,
  contiguousCoverage: true,
  mergedCoverage: [{ startDate: '2026-06-17', endDate: '2026-07-14' }],
};
const result = analyzeCsvPeriodOverPeriod(facts, { dataQuality });

assert.equal(result.schemaVersion, CSV_PERIOD_ANALYSIS_SCHEMA_VERSION);
assert.deepEqual(CSV_TRAILING_PERIOD_DAYS, [7, 14, 30, 60, 90]);
assert.deepEqual(result.observationRange, { startDate: '2026-07-01', endDate: '2026-07-14' });
assert.equal(result.summary.factCount, 14);
assert.equal(result.summary.trailingComparisonCount, 5);
assert.equal(result.summary.monthlySnapshotCount, 1);
assert.equal(result.summary.fullyCoveredTrailingComparisonCount, 2);
assert.equal(result.summary.incompleteTrailingComparisonCount, 3);
assert.equal(result.summary.blockedTrailingComparisonCount, 0);
assert.equal(result.summary.aggregationSafe, true);
assert.equal(result.summary.canonicalAmazonIdentityResolved, false);
assert.equal(result.summary.executionAuthorized, false);
assert.equal(result.summary.amazonMutationAuthorized, false);

const seven = result.trailingComparisons.find((item) => item.days === 7);
assert.ok(seven);
assert.deepEqual([seven.current.startDate, seven.current.endDate], ['2026-07-08', '2026-07-14']);
assert.deepEqual([seven.previous.startDate, seven.previous.endDate], ['2026-07-01', '2026-07-07']);
assert.equal(seven.current.coverage.coverageRatio, 1);
assert.equal(seven.previous.coverage.coverageRatio, 1);
assert.equal(seven.reliability.state, 'observed');
assert.equal(seven.reliability.analyticalDecisionUse, 'review_only');
assert.equal(seven.current.metrics.spendMicros, 14_000_000);
assert.equal(seven.previous.metrics.spendMicros, 7_000_000);
assert.equal(seven.current.metrics.salesMicros, 70_000_000);
assert.equal(seven.previous.metrics.salesMicros, 35_000_000);
assert.equal(seven.current.metrics.orders, 14);
assert.equal(seven.previous.metrics.orders, 7);
assert.equal(seven.current.adContributionMicros, 56_000_000);
assert.equal(seven.current.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(seven.change.spendPct, 1);
assert.equal(seven.change.salesPct, 1);
assert.equal(seven.change.ordersPct, 1);
assert.equal(seven.change.clicksPct, 1);
assert.equal(seven.change.impressionsPct, 1);
assert.equal(seven.change.acosDelta, 0);
assert.equal(seven.change.roasDelta, 0);
assert.equal(seven.change.cvrDelta, 0);
assert.equal(seven.change.cpcPct, 0);
assert.equal(seven.requiresHumanReview, true);
assert.equal(seven.persistenceAuthorized, false);
assert.equal(seven.executionAuthorized, false);
assert.equal(seven.amazonMutationAuthorized, false);

const fourteen = result.trailingComparisons.find((item) => item.days === 14);
assert.equal(fourteen.reliability.state, 'observed');
assert.equal(fourteen.current.coverage.coverageRatio, 1);
assert.equal(fourteen.previous.coverage.coverageRatio, 1);
assert.equal(fourteen.previous.metrics.spendMicros, 0);
assert.equal(fourteen.change.spendPct, null, 'percent change from zero baseline must not invent infinity');

const thirty = result.trailingComparisons.find((item) => item.days === 30);
assert.equal(thirty.reliability.state, 'incomplete_coverage');
assert.equal(thirty.reliability.analyticalDecisionUse, 'review_with_partial_coverage');
assert.equal(thirty.current.coverage.coveredDayCount, 28);
assert.equal(thirty.current.coverage.expectedDayCount, 30);
assert.equal(thirty.current.coverage.coverageRatio, 0.9333);
assert.equal(thirty.previous.coverage.coverageRatio, 0);

const july = result.monthlySnapshots[0];
assert.equal(july.month, '2026-07');
assert.deepEqual([july.startDate, july.endDate], ['2026-07-01', '2026-07-31']);
assert.equal(july.coverage.coveredDayCount, 14);
assert.equal(july.coverage.expectedDayCount, 31);
assert.equal(july.coverage.coverageRatio, 0.4516);
assert.equal(july.monthComplete, false);
assert.equal(july.reliability.state, 'incomplete_coverage');
assert.equal(july.comparisonToPreviousMonth, null);
assert.equal(july.persistenceAuthorized, false);
assert.equal(july.executionAuthorized, false);
assert.equal(july.amazonMutationAuthorized, false);

const blocked = analyzeCsvPeriodOverPeriod(facts, {
  dataQuality: { ...dataQuality, safeForNaiveAggregation: false },
});
assert.equal(blocked.summary.blockedTrailingComparisonCount, 5);
assert.ok(blocked.trailingComparisons.every((item) => item.reliability.state === 'blocked_overlap_or_invalid_window'));
assert.ok(blocked.trailingComparisons.every((item) => item.reliability.analyticalDecisionUse === 'blocked'));
assert.ok(blocked.monthlySnapshots.every((item) => item.reliability.state === 'blocked_overlap_or_invalid_window'));

const reversed = analyzeCsvPeriodOverPeriod([...facts].reverse(), { dataQuality });
assert.deepEqual(reversed, result, 'period-over-period output must be input-order independent');

const empty = analyzeCsvPeriodOverPeriod([], { dataQuality: { safeForNaiveAggregation: true, mergedCoverage: [] } });
assert.equal(empty.summary.factCount, 0);
assert.equal(empty.summary.trailingComparisonCount, 0);
assert.equal(empty.summary.monthlySnapshotCount, 0);
assert.deepEqual(empty.trailingComparisons, []);
assert.deepEqual(empty.monthlySnapshots, []);

assert.equal(result.authority.authoritative, false);
assert.equal(result.authority.governancePersistenceAllowed, false);
assert.equal(result.authority.executionAuthorized, false);
assert.equal(result.authority.amazonMutationAuthorized, false);

console.log(JSON.stringify({
  ok: true,
  contract: CSV_PERIOD_ANALYSIS_SCHEMA_VERSION,
  trailingDays: CSV_TRAILING_PERIOD_DAYS,
  fullyCoveredComparisons: result.summary.fullyCoveredTrailingComparisonCount,
  incompleteComparisons: result.summary.incompleteTrailingComparisonCount,
  monthlySnapshots: result.summary.monthlySnapshotCount,
  overlapBlocksDecisionUse: true,
  zeroBaselinePctChangeIsNull: true,
  inputOrderIndependent: true,
  persistenceAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function fact(reportDate, overrides = {}) {
  return {
    rowKey: `row:${reportDate}`,
    reportDate,
    impressions: 0,
    clicks: 0,
    purchases: 0,
    unitsSold: 0,
    costMicros: 0,
    salesMicros: 0,
    ...overrides,
  };
}
