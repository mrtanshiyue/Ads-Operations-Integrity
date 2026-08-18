import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const uiRelative = 'assets/cloudflare-native-csv-hierarchy-drilldown-v1.js';
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const hierarchyTag = '<script type="module" src="assets/cloudflare-native-csv-hierarchy-quality-v1.js?v=1.0.0"></script>';
const drilldownTag = '<script type="module" src="assets/cloudflare-native-csv-hierarchy-drilldown-v1.js?v=1.0.0"></script>';
const periodTag = '<script type="module" src="assets/cloudflare-native-csv-period-ui-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(drilldownTag).length - 1, 1, 'Hierarchy drilldown must be injected exactly once');
assert.ok(indexSource.indexOf(hierarchyTag) < indexSource.indexOf(drilldownTag), 'Hierarchy drilldown must load after hierarchy/quality UI');
assert.ok(indexSource.indexOf(drilldownTag) < indexSource.indexOf(periodTag), 'Hierarchy drilldown must load before period UI');
assert.match(uiSource, /Campaign → Ad Group → Targeting Drilldown/);
assert.match(uiSource, /Targeting search/);
assert.match(uiSource, /Performance/);
assert.match(uiSource, /Ad contribution ↓/);
assert.match(uiSource, /Targeting A–Z/);
assert.match(uiSource, /Identity conflicts/);
assert.match(uiSource, /Search terms/);
assert.match(uiSource, /Ad contribution = Sales - Ad Spend only; it is not net profit/);
assert.match(uiSource, /not canonical Amazon identity/i);
assert.match(uiSource, /browser_local_hierarchy_drilldown_only/);
assert.match(uiSource, /CSV_HIERARCHY_DRILLDOWN_SOURCE_RECEIPT_MISMATCH/);
assert.match(uiSource, /CSV_HIERARCHY_DRILLDOWN_AUTHORITY_ESCALATION_BLOCKED/);

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
]) assert.equal(pattern.test(uiSource), false, `Hierarchy drilldown must remain transport/storage/execution free: ${pattern}`);

const mod = await import(`${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`);
assert.equal(mod.CSV_HIERARCHY_DRILLDOWN_SCHEMA_VERSION, 'csv-hierarchy-drilldown-v1');
assert.equal(mod.CSV_HIERARCHY_DRILLDOWN_UI_VERSION, '1.0.0');
assert.equal(typeof mod.buildCsvHierarchyDrilldown, 'function');

const result = fixture();
const defaultModel = mod.buildCsvHierarchyDrilldown(result);
assert.equal(defaultModel.authority.authoritative, false);
assert.equal(defaultModel.authority.canonicalAmazonIdentityResolved, false);
assert.equal(defaultModel.authority.governancePersistenceAllowed, false);
assert.equal(defaultModel.authority.executionAuthorized, false);
assert.equal(defaultModel.authority.amazonMutationAuthorized, false);
assert.equal(defaultModel.source.receiptHashSetVerified, true);
assert.equal(defaultModel.summary.campaignCount, 2);
assert.equal(defaultModel.selection.campaignKey, 'campaign:id:c1');
assert.equal(defaultModel.summary.selectedCampaignAdGroupCount, 2);
assert.equal(defaultModel.selection.adGroupKey, 'campaign:id:c1/ad_group:id:g1');
assert.equal(defaultModel.summary.selectedAdGroupTargetingCount, 3);
assert.equal(defaultModel.targetings.length, 3);
assert.equal(defaultModel.targetings[0].observedKey, 'campaign:id:c1/ad_group:id:g1/targeting:id:t2', 'Default sort must be spend descending');
assert.deepEqual(defaultModel.breadcrumbs.map((item) => item.level), ['campaign', 'ad_group', 'targeting']);
assert.equal(defaultModel.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');

const secondCampaign = mod.buildCsvHierarchyDrilldown(result, { campaignKey: 'campaign:id:c2' });
assert.equal(secondCampaign.selection.campaignKey, 'campaign:id:c2');
assert.equal(secondCampaign.summary.selectedCampaignAdGroupCount, 1);
assert.equal(secondCampaign.adGroups[0].observedKey, 'campaign:id:c2/ad_group:id:g3');
assert.equal(secondCampaign.targetings.length, 1);

const secondAdGroup = mod.buildCsvHierarchyDrilldown(result, {
  campaignKey: 'campaign:id:c1',
  adGroupKey: 'campaign:id:c1/ad_group:id:g2',
});
assert.equal(secondAdGroup.summary.selectedAdGroupTargetingCount, 1);
assert.equal(secondAdGroup.targetings[0].identity.targeting.text, 'computer readers');

const toxicSearch = mod.buildCsvHierarchyDrilldown(result, {
  campaignKey: 'campaign:id:c1',
  adGroupKey: 'campaign:id:c1/ad_group:id:g1',
  targetingSearch: 'cheap readers',
});
assert.equal(toxicSearch.targetings.length, 1);
assert.equal(toxicSearch.targetings[0].observedKey, 'campaign:id:c1/ad_group:id:g1/targeting:id:t2');

const efficientBand = mod.buildCsvHierarchyDrilldown(result, {
  campaignKey: 'campaign:id:c1',
  adGroupKey: 'campaign:id:c1/ad_group:id:g1',
  performanceBand: 'at_or_below_target_acos',
});
assert.equal(efficientBand.targetings.length, 1);
assert.equal(efficientBand.targetings[0].observedKey, 'campaign:id:c1/ad_group:id:g1/targeting:id:t1');

const salesSorted = mod.buildCsvHierarchyDrilldown(result, {
  campaignKey: 'campaign:id:c1',
  adGroupKey: 'campaign:id:c1/ad_group:id:g1',
  sort: 'sales_desc',
});
assert.equal(salesSorted.targetings[0].observedKey, 'campaign:id:c1/ad_group:id:g1/targeting:id:t1');
const contributionSorted = mod.buildCsvHierarchyDrilldown(result, {
  campaignKey: 'campaign:id:c1',
  adGroupKey: 'campaign:id:c1/ad_group:id:g1',
  sort: 'contribution_desc',
});
assert.equal(contributionSorted.targetings[0].observedKey, 'campaign:id:c1/ad_group:id:g1/targeting:id:t1');
const acosSorted = mod.buildCsvHierarchyDrilldown(result, {
  campaignKey: 'campaign:id:c1',
  adGroupKey: 'campaign:id:c1/ad_group:id:g1',
  sort: 'acos_desc',
});
assert.equal(acosSorted.targetings[0].observedKey, 'campaign:id:c1/ad_group:id:g1/targeting:id:t3');
const alphaSorted = mod.buildCsvHierarchyDrilldown(result, {
  campaignKey: 'campaign:id:c1',
  adGroupKey: 'campaign:id:c1/ad_group:id:g1',
  sort: 'name_asc',
});
assert.deepEqual(alphaSorted.targetings.map((item) => item.identity.targeting.text), ['blue light readers', 'cheap readers', 'reading glasses']);

const invalidSelection = mod.buildCsvHierarchyDrilldown(result, { campaignKey: 'missing', adGroupKey: 'missing', targetingKey: 'missing' });
assert.equal(invalidSelection.selection.campaignKey, 'campaign:id:c1');
assert.equal(invalidSelection.selection.adGroupKey, 'campaign:id:c1/ad_group:id:g1');
assert.ok(invalidSelection.selection.targetingKey);

assert.throws(
  () => mod.buildCsvHierarchyDrilldown({ ...result, source: { ...result.source, executionAuthorized: true } }),
  (error) => error?.code === 'CSV_HIERARCHY_DRILLDOWN_AUTHORITY_ESCALATION_BLOCKED',
  'Drilldown must fail closed if execution authority appears',
);
assert.throws(
  () => mod.buildCsvHierarchyDrilldown({ ...result, source: { ...result.source, kind: 'amazon_api' } }),
  (error) => error?.code === 'CSV_HIERARCHY_DRILLDOWN_SOURCE_KIND_INVALID',
  'Drilldown must reject non-CSV source kinds',
);
assert.throws(
  () => mod.buildCsvHierarchyDrilldown({ ...result, source: { ...result.source, contentSha256s: ['e'.repeat(64), result.source.contentSha256s[1]] } }),
  (error) => error?.code === 'CSV_HIERARCHY_DRILLDOWN_SOURCE_RECEIPT_MISMATCH',
  'Drilldown must reject source/receipt hash drift',
);
assert.throws(
  () => mod.buildCsvHierarchyDrilldown({ ...result, hierarchy: null }),
  (error) => error?.code === 'CSV_HIERARCHY_DRILLDOWN_HIERARCHY_REQUIRED',
  'Drilldown requires canonical local hierarchy analysis output',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-hierarchy-drilldown-v1',
  campaignNavigation: true,
  adGroupNavigation: true,
  targetingSearch: true,
  performanceBandFilter: true,
  deterministicTargetingSorts: true,
  identityConflictEvidence: true,
  searchTermEvidence: true,
  receiptHashSetVerified: true,
  canonicalAmazonIdentityResolved: false,
  persistenceAuthorized: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function fixture() {
  const hash1 = 'b'.repeat(64);
  const hash2 = 'c'.repeat(64);
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  const reliability = { state: 'observed', aggregationSafe: true, periodComplete: true, analyticalDecisionUse: 'review_only', requiresHumanReview: true };
  const campaigns = [
    row('campaign', 'campaign:id:c1', { campaign: { id: 'c1', name: 'Core Readers' }, adGroup: null, targeting: null }, 20, 80, 12, 0.25, 4, 60, 'at_or_below_target_acos', reliability),
    row('campaign', 'campaign:id:c2', { campaign: { id: 'c2', name: 'Discovery' }, adGroup: null, targeting: null }, 8, 10, 1, 0.8, 1.25, 2, 'above_target_acos', reliability),
  ];
  const adGroups = [
    row('ad_group', 'campaign:id:c1/ad_group:id:g1', { campaign: { id: 'c1', name: 'Core Readers' }, adGroup: { id: 'g1', name: 'Exact Core' }, targeting: null }, 14, 70, 10, 0.2, 5, 56, 'at_or_below_target_acos', reliability),
    row('ad_group', 'campaign:id:c1/ad_group:id:g2', { campaign: { id: 'c1', name: 'Core Readers' }, adGroup: { id: 'g2', name: 'Broad Test' }, targeting: null }, 6, 10, 2, 0.6, 1.67, 4, 'above_target_acos', reliability),
    row('ad_group', 'campaign:id:c2/ad_group:id:g3', { campaign: { id: 'c2', name: 'Discovery' }, adGroup: { id: 'g3', name: 'Discovery Auto' }, targeting: null }, 8, 10, 1, 0.8, 1.25, 2, 'above_target_acos', reliability),
  ];
  const targetings = [
    row('targeting', 'campaign:id:c1/ad_group:id:g1/targeting:id:t1', { campaign: { id: 'c1', name: 'Core Readers' }, adGroup: { id: 'g1', name: 'Exact Core' }, targeting: { id: 't1', text: 'reading glasses', matchType: 'EXACT' } }, 4, 40, 6, 0.1, 10, 36, 'at_or_below_target_acos', reliability, ['reading glasses women', 'reading glasses men']),
    row('targeting', 'campaign:id:c1/ad_group:id:g1/targeting:id:t2', { campaign: { id: 'c1', name: 'Core Readers' }, adGroup: { id: 'g1', name: 'Exact Core' }, targeting: { id: 't2', text: 'cheap readers', matchType: 'BROAD' } }, 7, 0, 0, null, 0, -7, 'spend_without_sales', reliability, ['cheap readers']),
    row('targeting', 'campaign:id:c1/ad_group:id:g1/targeting:id:t3', { campaign: { id: 'c1', name: 'Core Readers' }, adGroup: { id: 'g1', name: 'Exact Core' }, targeting: { id: 't3', text: 'blue light readers', matchType: 'PHRASE' } }, 3, 4, 1, 0.75, 1.33, 1, 'above_target_acos', reliability, ['blue light readers']),
    row('targeting', 'campaign:id:c1/ad_group:id:g2/targeting:id:t4', { campaign: { id: 'c1', name: 'Core Readers' }, adGroup: { id: 'g2', name: 'Broad Test' }, targeting: { id: 't4', text: 'computer readers', matchType: 'BROAD' } }, 6, 10, 2, 0.6, 1.67, 4, 'above_target_acos', reliability, ['computer readers']),
    row('targeting', 'campaign:id:c2/ad_group:id:g3/targeting:id:t5', { campaign: { id: 'c2', name: 'Discovery' }, adGroup: { id: 'g3', name: 'Discovery Auto' }, targeting: { id: 't5', text: 'close-match', matchType: 'AUTO' } }, 8, 10, 1, 0.8, 1.25, 2, 'above_target_acos', reliability, ['eyeglasses readers']),
  ];
  targetings[2] = Object.freeze({ ...targetings[2], observedIdentity: Object.freeze({ state: 'observed_id', ambiguous: true, confidence: 'blocked', conflictCodes: Object.freeze(['targeting_id_multiple_texts']), canonicalAmazonIdentityResolved: false }) });

  return {
    source: {
      kind: 'csv_import_set', batchCount: 2, inputSetFingerprint: 'a'.repeat(64), contentSha256s: [hash1, hash2],
      canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false,
    },
    range: { startDate: '2026-08-01', endDate: '2026-08-14' },
    imports: [{ contentSha256: hash1 }, { contentSha256: hash2 }],
    dataQuality: { authority },
    hierarchy: {
      authority,
      profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
      targetAcos: 0.35,
      reliability,
      summary: { campaignCount: 2, adGroupCount: 3, targetingCount: 5, ambiguousCampaignCount: 0, ambiguousAdGroupCount: 0, ambiguousTargetingCount: 1 },
      campaigns, adGroups, targetings,
    },
  };
}

function row(level, observedKey, identity, spend, sales, orders, acos, roas, contribution, performanceBand, reliability, searchTerms = []) {
  return Object.freeze({
    level,
    observedKey,
    identity: Object.freeze({ ...identity, canonicalAmazonIdentityResolved: false }),
    observedIdentity: Object.freeze({ state: 'observed_id', ambiguous: false, confidence: 'observed_only', conflictCodes: Object.freeze([]), canonicalAmazonIdentityResolved: false }),
    performanceBand,
    targetAcos: 0.35,
    adContributionMicros: contribution * 1_000_000,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    metrics: Object.freeze({ spendMicros: spend * 1_000_000, salesMicros: sales * 1_000_000, orders, clicks: orders * 4, acos, roas, cvr: orders ? 0.25 : 0 }),
    factCount: 1,
    searchTermCount: searchTerms.length,
    sourceImportCount: 1,
    searchTerms: Object.freeze(searchTerms),
    sourceImportIds: Object.freeze(['import-1']),
    observedVariants: Object.freeze({ campaignNames: Object.freeze([]), adGroupNames: Object.freeze([]), targetingTexts: Object.freeze([identity.targeting?.text].filter(Boolean)), matchTypes: Object.freeze([identity.targeting?.matchType].filter(Boolean)) }),
    reliability,
    requiresHumanReview: true,
    persistenceAuthorized: false,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
  });
}
