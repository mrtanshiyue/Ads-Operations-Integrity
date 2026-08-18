import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAmazonSearchTermCsv } from '../cloudflare/runtime/csv-search-term-import.js';
import {
  CSV_JOINT_ANALYSIS_SCHEMA_VERSION,
  analyzeCsvImportBatches,
} from '../cloudflare/runtime/csv-joint-report-analysis.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts', 'analyze-search-term-csv-files.mjs');
const header = [
  'Date',
  'Advertiser Account ID',
  'Campaign Name',
  'Ad Group Name',
  'Targeting',
  'Match Type',
  'Customer Search Term',
  'Impressions',
  'Clicks',
  'Spend',
  '7 Day Total Orders',
  '7 Day Total Sales',
  '7 Day Total Units',
  'Marketplace',
  'Profile ID',
  'Currency',
].join(',');

const csv1 = [
  header,
  '2026-08-01,adv-01,Campaign A,Group A,reading glasses,EXACT,Reading Glasses Women,50,5,2.00,2,10.00,2,US,profile-observed-01,USD',
  '2026-08-01,adv-01,Campaign A,Group A,free glasses,PHRASE,Free Glasses Case,70,6,3.00,0,0.00,0,US,profile-observed-01,USD',
].join('\n');
const csv2 = [
  header,
  '2026-08-02,adv-01,Campaign A,Group A,reading glasses,EXACT,Reading Glasses Women,50,5,2.00,2,10.00,2,US,profile-observed-01,USD',
  '2026-08-02,adv-01,Campaign A,Group A,free glasses,PHRASE,Free Glasses Case,70,6,3.00,0,0.00,0,US,profile-observed-01,USD',
  '2026-08-02,adv-01,Campaign B,Group B,free sample,PHRASE,Free Glasses Sample,80,8,4.00,0,0.00,0,US,profile-observed-01,USD',
].join('\n');

const [batch1, batch2] = await Promise.all([
  parseAmazonSearchTermCsv({ csvText: csv1, sourceFileName: 'report-2026-08-01.csv', uploadedAt: '2026-08-18T07:30:00.000Z' }),
  parseAmazonSearchTermCsv({ csvText: csv2, sourceFileName: 'report-2026-08-02.csv', uploadedAt: '2026-08-18T07:30:00.000Z' }),
]);
assert.equal(batch1.ok, true, JSON.stringify(batch1.errors));
assert.equal(batch2.ok, true, JSON.stringify(batch2.errors));

const result = await analyzeCsvImportBatches([batch1, batch2], { rules: { targetAcos: 0.35 } });
assert.equal(result.schemaVersion, CSV_JOINT_ANALYSIS_SCHEMA_VERSION);
assert.equal(result.source.kind, 'csv_import_set');
assert.equal(result.source.authority, 'non-authoritative');
assert.equal(result.source.batchCount, 2);
assert.equal(result.source.allImportsAccepted, true);
assert.equal(result.source.duplicateContentDetected, false);
assert.equal(result.source.overlappingDateWindowsDetected, false);
assert.equal(result.source.dateCoverageGapDetected, false);
assert.equal(result.source.naiveAggregationSafe, true);
assert.match(result.source.inputSetFingerprint, /^[a-f0-9]{64}$/);
assert.equal(result.source.canonicalAmazonIdentityResolved, false);
assert.equal(result.source.observedTargetingIdentityAvailable, true);
assert.equal(result.source.hierarchyProfitabilityAvailable, true);
assert.equal(result.source.periodOverPeriodAvailable, true);
assert.equal(result.source.governancePersistenceAllowed, false);
assert.equal(result.source.executionAuthorized, false);
assert.equal(result.source.amazonMutationAuthorized, false);
assert.deepEqual(result.range, { startDate: '2026-08-01', endDate: '2026-08-02' });
assert.equal(result.summary.batchCount, 2);
assert.equal(result.summary.factCount, 5);
assert.equal(result.summary.sourceRowCount, 5);
assert.equal(result.summary.profitTermCount, 1);
assert.equal(result.summary.wasteTermCount, 2);
assert.equal(result.summary.toxicRootCount, 1);
assert.equal(result.summary.exactNegativeCandidateCount, 2);
assert.equal(result.summary.phraseRootReviewCount, 1);
assert.equal(result.summary.harvestCandidateCount, 1);
assert.equal(result.summary.observedIdentityCount, 3);
assert.equal(result.summary.observedResolvedIdCount, 0);
assert.equal(result.summary.ambiguousObservedIdentityCount, 0);
assert.equal(result.summary.searchTermIdentityLinkCount, 3);
assert.equal(result.summary.campaignAggregateCount, 2);
assert.equal(result.summary.adGroupAggregateCount, 2);
assert.equal(result.summary.targetingAggregateCount, 3);
assert.equal(result.summary.ambiguousCampaignAggregateCount, 0);
assert.equal(result.summary.ambiguousAdGroupAggregateCount, 0);
assert.equal(result.summary.ambiguousTargetingAggregateCount, 0);
assert.equal(result.summary.trailingPeriodComparisonCount, 5);
assert.equal(result.summary.monthlySnapshotCount, 1);
assert.equal(result.summary.fullyCoveredTrailingComparisonCount, 0);
assert.equal(result.summary.overlapPairCount, 0);
assert.equal(result.summary.exactDuplicateWindowCount, 0);
assert.equal(result.summary.dateGapCount, 0);
assert.equal(result.summary.dateGapDayCount, 0);
assert.equal(result.summary.reportedWindowDayCount, 2);
assert.equal(result.summary.uniqueCoveredDayCount, 2);
assert.equal(result.summary.overlapExcessDayCount, 0);
assert.equal(result.summary.metrics.spendMicros, 14_000_000);
assert.equal(result.summary.metrics.salesMicros, 20_000_000);
assert.equal(result.summary.metrics.acos, 0.7);

assert.equal(result.dataQuality.schemaVersion, 'csv-window-quality-v1');
assert.equal(result.dataQuality.qualityState, 'clean_contiguous');
assert.equal(result.dataQuality.safeForNaiveAggregation, true);
assert.equal(result.dataQuality.contiguousCoverage, true);
assert.equal(result.dataQuality.requiresHumanReview, false);
assert.equal(result.dataQuality.authority.authoritative, false);
assert.equal(result.dataQuality.authority.governancePersistenceAllowed, false);
assert.equal(result.dataQuality.authority.executionAuthorized, false);
assert.equal(result.dataQuality.authority.amazonMutationAuthorized, false);

assert.equal(result.observedIdentity.authority.authoritative, false);
assert.equal(result.observedIdentity.authority.canonicalAmazonIdentityResolved, false);
assert.equal(result.observedIdentity.summary.identityCount, 3);
assert.equal(result.observedIdentity.summary.searchTermLinkCount, 3);
assert.ok(result.observedIdentity.identities.every((item) => item.observedIdentityState === 'name_only'));
assert.ok(result.observedIdentity.identities.every((item) => item.authority.amazonMutationAuthorized === false));

assert.equal(result.hierarchy.schemaVersion, 'csv-hierarchy-profitability-v1');
assert.equal(result.hierarchy.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(result.hierarchy.reliability.state, 'observed');
assert.equal(result.hierarchy.reliability.aggregationSafe, true);
assert.equal(result.hierarchy.reliability.periodComplete, true);
assert.equal(result.hierarchy.summary.campaignCount, 2);
assert.equal(result.hierarchy.summary.adGroupCount, 2);
assert.equal(result.hierarchy.summary.targetingCount, 3);
assert.equal(result.hierarchy.summary.canonicalAmazonIdentityResolved, false);
assert.equal(result.hierarchy.authority.authoritative, false);
assert.equal(result.hierarchy.authority.canonicalAmazonIdentityResolved, false);
assert.equal(result.hierarchy.authority.amazonMutationAuthorized, false);
assert.ok(result.hierarchy.targetings.every((item) => item.requiresHumanReview === true));
assert.ok(result.hierarchy.targetings.every((item) => item.persistenceAuthorized === false));
assert.ok(result.hierarchy.targetings.every((item) => item.executionAuthorized === false));
assert.ok(result.hierarchy.targetings.every((item) => item.amazonMutationAuthorized === false));
assert.ok(result.hierarchy.targetings.every((item) => item.identity.canonicalAmazonIdentityResolved === false));
const campaignA = result.hierarchy.campaigns.find((item) => item.identity.campaign?.name === 'Campaign A');
assert.ok(campaignA);
assert.equal(campaignA.metrics.spendMicros, 10_000_000);
assert.equal(campaignA.metrics.salesMicros, 20_000_000);
assert.equal(campaignA.metrics.acos, 0.5);
assert.equal(campaignA.performanceBand, 'above_target_acos');
assert.equal(campaignA.adContributionMicros, 10_000_000);
const campaignB = result.hierarchy.campaigns.find((item) => item.identity.campaign?.name === 'Campaign B');
assert.ok(campaignB);
assert.equal(campaignB.performanceBand, 'spend_without_sales');
assert.equal(campaignB.adContributionMicros, -4_000_000);

assert.equal(result.periods.schemaVersion, 'csv-period-over-period-v1');
assert.deepEqual(result.periods.observationRange, { startDate: '2026-08-01', endDate: '2026-08-02' });
assert.equal(result.periods.summary.trailingComparisonCount, 5);
assert.equal(result.periods.summary.monthlySnapshotCount, 1);
assert.equal(result.periods.summary.fullyCoveredTrailingComparisonCount, 0);
assert.equal(result.periods.summary.incompleteTrailingComparisonCount, 5);
assert.equal(result.periods.summary.blockedTrailingComparisonCount, 0);
assert.equal(result.periods.authority.authoritative, false);
assert.equal(result.periods.authority.governancePersistenceAllowed, false);
assert.equal(result.periods.authority.executionAuthorized, false);
assert.equal(result.periods.authority.amazonMutationAuthorized, false);
const seven = result.periods.trailingComparisons.find((item) => item.days === 7);
assert.ok(seven);
assert.equal(seven.current.metrics.spendMicros, 14_000_000);
assert.equal(seven.current.metrics.salesMicros, 20_000_000);
assert.equal(seven.current.coverage.coveredDayCount, 2);
assert.equal(seven.current.coverage.expectedDayCount, 7);
assert.equal(seven.current.coverage.coverageRatio, 0.2857);
assert.equal(seven.previous.coverage.coverageRatio, 0);
assert.equal(seven.reliability.state, 'incomplete_coverage');
assert.equal(seven.reliability.analyticalDecisionUse, 'review_with_partial_coverage');
assert.equal(seven.persistenceAuthorized, false);
assert.equal(seven.executionAuthorized, false);
assert.equal(seven.amazonMutationAuthorized, false);
const august = result.periods.monthlySnapshots[0];
assert.equal(august.month, '2026-08');
assert.equal(august.coverage.coveredDayCount, 2);
assert.equal(august.coverage.expectedDayCount, 31);
assert.equal(august.coverage.coverageRatio, 0.0645);
assert.equal(august.monthComplete, false);
assert.equal(august.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');

assert.deepEqual(
  result.analysis.negativeSuggestions.filter((item) => item.matchScope === 'exact').map((item) => item.value).sort(),
  ['free glasses case', 'free glasses sample'],
);
assert.equal(result.analysis.negativeSuggestions.find((item) => item.matchScope === 'phrase_review')?.value, 'free');

const reversed = await analyzeCsvImportBatches([batch2, batch1], { rules: { targetAcos: 0.35 } });
assert.equal(reversed.source.inputSetFingerprint, result.source.inputSetFingerprint, 'input-set fingerprint must be order independent');
assert.deepEqual(reversed.summary, result.summary, 'joint summary must be input-order independent');
assert.deepEqual(reversed.imports, result.imports, 'import receipts must use deterministic content-hash ordering');
assert.deepEqual(reversed.dataQuality, result.dataQuality, 'date-window diagnostics must be input-order independent');
assert.deepEqual(reversed.observedIdentity, result.observedIdentity, 'observed identity graph must be input-order independent');
assert.deepEqual(reversed.hierarchy, result.hierarchy, 'hierarchy profitability must be input-order independent');
assert.deepEqual(reversed.periods, result.periods, 'period-over-period analysis must be input-order independent');

await assert.rejects(() => analyzeCsvImportBatches([batch1, batch1]), (error) => error?.code === 'CSV_JOINT_ANALYSIS_DUPLICATE_CONTENT');
await assert.rejects(() => analyzeCsvImportBatches([{ ...batch1, ok: false }]), (error) => error?.code === 'CSV_JOINT_ANALYSIS_IMPORT_REJECTED');

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ads-ops-csv-joint-'));
try {
  const file1 = path.join(tempDir, 'one.csv');
  const file2 = path.join(tempDir, 'two.csv');
  await writeFile(file1, csv1, 'utf8');
  await writeFile(file2, csv2, 'utf8');
  const cliRun = spawnSync(process.execPath, [cli, file1, file2, '--target-acos=0.35', '--uploaded-at=2026-08-18T07:30:00.000Z'], { cwd: root, encoding: 'utf8' });
  assert.equal(cliRun.status, 0, cliRun.stderr);
  assert.equal(cliRun.stderr, '');
  const cliResult = JSON.parse(cliRun.stdout);
  assert.equal(cliResult.schemaVersion, CSV_JOINT_ANALYSIS_SCHEMA_VERSION);
  assert.equal(cliResult.summary.batchCount, 2);
  assert.equal(cliResult.summary.factCount, 5);
  assert.equal(cliResult.summary.observedIdentityCount, 3);
  assert.equal(cliResult.summary.targetingAggregateCount, 3);
  assert.equal(cliResult.summary.trailingPeriodComparisonCount, 5);
  assert.equal(cliResult.summary.monthlySnapshotCount, 1);
  assert.equal(cliResult.summary.overlapPairCount, 0);
  assert.equal(cliResult.summary.dateGapCount, 0);
  assert.equal(cliResult.source.inputSetFingerprint, result.source.inputSetFingerprint);
  assert.equal(cliResult.source.naiveAggregationSafe, true);
  assert.equal(cliResult.source.periodOverPeriodAvailable, true);
  assert.equal(cliResult.dataQuality.qualityState, 'clean_contiguous');
  assert.equal(cliResult.hierarchy.reliability.state, 'observed');
  assert.equal(cliResult.hierarchy.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
  assert.equal(cliResult.periods.schemaVersion, 'csv-period-over-period-v1');
  assert.equal(cliResult.periods.summary.incompleteTrailingComparisonCount, 5);
  assert.equal(cliResult.observedIdentity.authority.canonicalAmazonIdentityResolved, false);
  assert.equal(cliResult.source.amazonMutationAuthorized, false);

  const duplicateRun = spawnSync(process.execPath, [cli, file1, file1], { cwd: root, encoding: 'utf8' });
  assert.equal(duplicateRun.status, 1);
  const duplicateError = JSON.parse(duplicateRun.stderr);
  assert.equal(duplicateError.error, 'CSV_JOINT_ANALYSIS_DUPLICATE_CONTENT');

  const helpRun = spawnSync(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(helpRun.status, 0, helpRun.stderr);
  assert.match(helpRun.stdout, /reads local CSV files and writes JSON to stdout only/i);
  assert.match(helpRun.stdout, /does not call Amazon Ads, Cloudflare, D1, R2/i);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-joint-report-analysis-v2-observed-identity-window-quality-hierarchy-periods',
  batchCount: result.summary.batchCount,
  factCount: result.summary.factCount,
  observedIdentityCount: result.summary.observedIdentityCount,
  targetingAggregateCount: result.summary.targetingAggregateCount,
  trailingPeriodComparisonCount: result.summary.trailingPeriodComparisonCount,
  monthlySnapshotCount: result.summary.monthlySnapshotCount,
  searchTermIdentityLinkCount: result.summary.searchTermIdentityLinkCount,
  windowQuality: result.dataQuality.qualityState,
  hierarchyReliability: result.hierarchy.reliability.state,
  sevenDayReliability: seven.reliability.state,
  naiveAggregationSafe: result.source.naiveAggregationSafe,
  inputSetFingerprint: result.source.inputSetFingerprint,
  duplicateContentRejected: true,
  inputOrderIndependent: true,
  cliReadOnly: true,
  canonicalAmazonIdentityResolved: false,
  amazonMutationAuthorized: false,
}, null, 2));
