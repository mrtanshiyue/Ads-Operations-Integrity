import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSV_HIERARCHY_ANALYSIS_SCHEMA_VERSION,
  analyzeCsvHierarchyProfitability,
} from '../cloudflare/runtime/csv-hierarchy-profitability-analysis.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'cloudflare', 'runtime', 'csv-hierarchy-profitability-analysis.js');
const builtPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'csv-analysis-engine', 'csv-hierarchy-profitability-analysis.js');
const [source, built] = await Promise.all([readFile(sourcePath, 'utf8'), readFile(builtPath, 'utf8')]);
assert.equal(built, source, 'Built hierarchy module must be byte-identical to canonical runtime source');

const facts = [
  fact({ campaignId: 'c1', campaignName: 'Core Readers', adGroupId: 'g1', adGroupName: 'Core', targetingId: 't-profit', targeting: 'reading glasses', matchType: 'EXACT', searchTerm: 'reading glasses women', clicks: 10, purchases: 3, costMicros: 1_000_000, salesMicros: 10_000_000, sourceImportId: 'csv-content:a' }),
  fact({ campaignId: 'c1', campaignName: 'Core Readers', adGroupId: 'g1', adGroupName: 'Core', targetingId: 't-profit', targeting: 'reading glasses', matchType: 'EXACT', searchTerm: 'reading glasses men', clicks: 10, purchases: 3, costMicros: 1_000_000, salesMicros: 10_000_000, sourceImportId: 'csv-content:b' }),
  fact({ campaignId: 'c1', campaignName: 'Core Readers', adGroupId: 'g1', adGroupName: 'Core', targetingId: 't-waste', targeting: 'cheap readers', matchType: 'BROAD', searchTerm: 'cheap blue readers', clicks: 20, purchases: 0, costMicros: 4_000_000, salesMicros: 0, sourceImportId: 'csv-content:a' }),
  fact({ campaignId: 'c2', campaignName: 'Exploration', adGroupId: 'g-shared', adGroupName: 'Explore A', targetingId: 't-conflict', targeting: 'alpha target', matchType: 'PHRASE', searchTerm: 'alpha search', clicks: 4, purchases: 1, costMicros: 500_000, salesMicros: 2_000_000, sourceImportId: 'csv-content:a' }),
  fact({ campaignId: 'c3', campaignName: 'Discovery', adGroupId: 'g-shared', adGroupName: 'Explore B', targetingId: 't-conflict', targeting: 'beta target', matchType: 'PHRASE', searchTerm: 'beta search', clicks: 4, purchases: 1, costMicros: 500_000, salesMicros: 2_000_000, sourceImportId: 'csv-content:b' }),
];

const clean = analyzeCsvHierarchyProfitability(facts, {
  targetAcos: 0.35,
  dataQuality: { safeForNaiveAggregation: true, contiguousCoverage: true },
});
assert.equal(clean.schemaVersion, CSV_HIERARCHY_ANALYSIS_SCHEMA_VERSION);
assert.equal(clean.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(clean.targetAcos, 0.35);
assert.equal(clean.reliability.state, 'observed');
assert.equal(clean.reliability.aggregationSafe, true);
assert.equal(clean.reliability.periodComplete, true);
assert.equal(clean.summary.factCount, 5);
assert.equal(clean.summary.campaignCount, 3);
assert.equal(clean.summary.adGroupCount, 3);
assert.equal(clean.summary.targetingCount, 4);
assert.equal(clean.summary.ambiguousCampaignCount, 0);
assert.equal(clean.summary.ambiguousAdGroupCount, 2);
assert.equal(clean.summary.ambiguousTargetingCount, 2);
assert.equal(clean.summary.canonicalAmazonIdentityResolved, false);
assert.equal(clean.summary.executionAuthorized, false);
assert.equal(clean.summary.amazonMutationAuthorized, false);

const profit = clean.targetings.find((item) => item.identity.targeting?.id === 't-profit');
assert.ok(profit);
assert.equal(profit.metrics.spendMicros, 2_000_000);
assert.equal(profit.metrics.salesMicros, 20_000_000);
assert.equal(profit.metrics.orders, 6);
assert.equal(profit.metrics.acos, 0.1);
assert.equal(profit.performanceBand, 'at_or_below_target_acos');
assert.equal(profit.acosDeltaToTarget, -0.25);
assert.equal(profit.adContributionMicros, 18_000_000);
assert.equal(profit.searchTermCount, 2);
assert.equal(profit.sourceImportCount, 2);
assert.equal(profit.observedIdentity.ambiguous, false);
assert.equal(profit.observedIdentity.canonicalAmazonIdentityResolved, false);

const waste = clean.targetings.find((item) => item.identity.targeting?.id === 't-waste');
assert.ok(waste);
assert.equal(waste.performanceBand, 'spend_without_sales');
assert.equal(waste.metrics.spendMicros, 4_000_000);
assert.equal(waste.metrics.salesMicros, 0);
assert.equal(waste.adContributionMicros, -4_000_000);

const conflictTargets = clean.targetings.filter((item) => item.identity.targeting?.id === 't-conflict');
assert.equal(conflictTargets.length, 2);
assert.ok(conflictTargets.every((item) => item.observedIdentity.ambiguous === true));
assert.ok(conflictTargets.every((item) => item.observedIdentity.confidence === 'blocked'));
assert.ok(conflictTargets.every((item) => item.observedIdentity.conflictCodes.includes('targeting_id_multiple_texts')));
assert.ok(conflictTargets.every((item) => item.observedIdentity.conflictCodes.includes('targeting_id_multiple_ad_group_parents')));

const sharedAdGroups = clean.adGroups.filter((item) => item.identity.adGroup?.id === 'g-shared');
assert.equal(sharedAdGroups.length, 2);
assert.ok(sharedAdGroups.every((item) => item.observedIdentity.ambiguous === true));
assert.ok(sharedAdGroups.every((item) => item.observedIdentity.conflictCodes.includes('ad_group_id_multiple_names')));
assert.ok(sharedAdGroups.every((item) => item.observedIdentity.conflictCodes.includes('ad_group_id_multiple_campaign_parents')));

for (const row of [...clean.campaigns, ...clean.adGroups, ...clean.targetings]) {
  assert.equal(row.requiresHumanReview, true);
  assert.equal(row.persistenceAuthorized, false);
  assert.equal(row.executionAuthorized, false);
  assert.equal(row.amazonMutationAuthorized, false);
  assert.equal(row.identity.canonicalAmazonIdentityResolved, false);
}
assert.equal(clean.authority.authoritative, false);
assert.equal(clean.authority.canonicalAmazonIdentityResolved, false);
assert.equal(clean.authority.governancePersistenceAllowed, false);
assert.equal(clean.authority.executionAuthorized, false);
assert.equal(clean.authority.amazonMutationAuthorized, false);

const blocked = analyzeCsvHierarchyProfitability(facts, {
  targetAcos: 0.35,
  dataQuality: { safeForNaiveAggregation: false, contiguousCoverage: true },
});
assert.equal(blocked.reliability.state, 'blocked_overlap_or_invalid_window');
assert.equal(blocked.reliability.aggregationSafe, false);
assert.equal(blocked.reliability.analyticalDecisionUse, 'blocked');
assert.ok(blocked.targetings.every((item) => item.reliability.state === 'blocked_overlap_or_invalid_window'));

const gap = analyzeCsvHierarchyProfitability(facts, {
  dataQuality: { safeForNaiveAggregation: true, contiguousCoverage: false },
});
assert.equal(gap.reliability.state, 'incomplete_period');
assert.equal(gap.reliability.aggregationSafe, true);
assert.equal(gap.reliability.periodComplete, false);
assert.equal(gap.reliability.analyticalDecisionUse, 'review_with_period_gap');

const reversed = analyzeCsvHierarchyProfitability([...facts].reverse(), {
  targetAcos: 0.35,
  dataQuality: { safeForNaiveAggregation: true, contiguousCoverage: true },
});
assert.deepEqual(reversed, clean, 'hierarchy profitability output must be input-order independent');

console.log(JSON.stringify({
  ok: true,
  contract: CSV_HIERARCHY_ANALYSIS_SCHEMA_VERSION,
  campaignCount: clean.summary.campaignCount,
  adGroupCount: clean.summary.adGroupCount,
  targetingCount: clean.summary.targetingCount,
  ambiguousAdGroupCount: clean.summary.ambiguousAdGroupCount,
  ambiguousTargetingCount: clean.summary.ambiguousTargetingCount,
  overlapReliabilityBlocked: true,
  periodGapMarkedIncomplete: true,
  profitabilityBasis: clean.profitabilityBasis,
  canonicalAmazonIdentityResolved: false,
  amazonMutationAuthorized: false,
}, null, 2));

function fact(overrides) {
  return {
    advertiserAccountId: 'adv-1',
    profileId: 'profile-1',
    marketplace: 'US',
    currencyCode: 'USD',
    campaignId: null,
    campaignName: null,
    adGroupId: null,
    adGroupName: null,
    targetingId: null,
    targeting: null,
    matchType: null,
    searchTerm: null,
    normalizedSearchTerm: String(overrides.searchTerm || '').toLowerCase(),
    impressions: 100,
    clicks: 0,
    purchases: 0,
    unitsSold: 0,
    costMicros: 0,
    salesMicros: 0,
    sourceImportId: 'csv-content:fixture',
    ...overrides,
  };
}
