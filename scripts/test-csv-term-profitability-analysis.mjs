import assert from 'node:assert/strict';
import {
  CSV_TERM_ANALYSIS_SCHEMA_VERSION,
  analyzeCsvTermProfitability,
} from '../cloudflare/runtime/csv-term-profitability-analysis.js';

const common = {
  advertiserAccountId: 'adv-01',
  profileId: 'profile-observed-01',
  marketplace: 'US',
  currencyCode: 'USD',
};

const result = analyzeCsvTermProfitability([
  {
    ...common,
    sourceImportId: 'import-a',
    searchTerm: 'Reading Glasses Women',
    impressions: 100,
    clicks: 10,
    purchases: 4,
    unitsSold: 4,
    costMicros: 4_000_000,
    salesMicros: 20_000_000,
  },
  {
    ...common,
    sourceImportId: 'import-b',
    searchTerm: 'reading   glasses lightweight',
    impressions: 90,
    clicks: 8,
    purchases: 3,
    unitsSold: 3,
    costMicros: 3_000_000,
    salesMicros: 15_000_000,
  },
  {
    ...common,
    sourceImportId: 'import-a',
    searchTerm: 'Free Glasses Case',
    impressions: 140,
    clicks: 12,
    purchases: 0,
    unitsSold: 0,
    costMicros: 6_000_000,
    salesMicros: 0,
  },
  {
    ...common,
    sourceImportId: 'import-b',
    searchTerm: 'free glasses sample',
    impressions: 120,
    clicks: 10,
    purchases: 0,
    unitsSold: 0,
    costMicros: 5_000_000,
    salesMicros: 0,
  },
]);

assert.equal(result.schemaVersion, CSV_TERM_ANALYSIS_SCHEMA_VERSION);
assert.equal(result.authority.mode, 'csv_advisory_only');
assert.equal(result.authority.authoritative, false);
assert.equal(result.authority.governancePersistenceAllowed, false);
assert.equal(result.authority.executionAuthorized, false);
assert.equal(result.authority.amazonMutationAuthorized, false);
assert.equal(result.context.advertiserAccountId, 'adv-01');
assert.equal(result.context.profileId, 'profile-observed-01');
assert.deepEqual(result.context.sourceImportIds, ['import-a', 'import-b']);
assert.equal(result.context.canonicalAmazonIdentityResolved, false);

assert.equal(result.summary.analyzedTermCount, 4);
assert.equal(result.summary.profitTermCount, 2);
assert.equal(result.summary.wasteTermCount, 2);
assert.equal(result.summary.toxicRootCount, 1);
assert.equal(result.summary.profitableRootCount, 1);
assert.equal(result.summary.exactNegativeCandidateCount, 2);
assert.equal(result.summary.phraseRootReviewCount, 1);
assert.equal(result.summary.harvestCandidateCount, 2);
assert.equal(result.summary.metrics.spendMicros, 18_000_000);
assert.equal(result.summary.metrics.salesMicros, 35_000_000);
assert.ok(Math.abs(result.summary.metrics.acos - (18 / 35)) < 1e-12);

assert.deepEqual(
  result.wasteTerms.map((item) => item.searchTerm).sort(),
  ['free glasses case', 'free glasses sample'],
);
assert.deepEqual(
  result.profitTerms.map((item) => item.searchTerm).sort(),
  ['reading glasses lightweight', 'reading glasses women'],
);

const toxicFree = result.toxicRoots.find((item) => item.root === 'free');
assert.ok(toxicFree, 'shared waste root must be classified as toxic');
assert.equal(toxicFree.termCount, 2);
assert.equal(toxicFree.profitTermCount, 0);
assert.equal(toxicFree.wasteTermCount, 2);
assert.equal(toxicFree.metrics.purchases, 0);
assert.equal(toxicFree.metrics.spendMicros, 11_000_000);

const profitableReading = result.profitableRoots.find((item) => item.root === 'reading');
assert.ok(profitableReading, 'shared converting root must be classified as profitable');
assert.equal(profitableReading.termCount, 2);
assert.equal(profitableReading.metrics.purchases, 7);
assert.equal(profitableReading.metrics.acos, 0.2);

const exactNegatives = result.negativeSuggestions.filter((item) => item.matchScope === 'exact');
const phraseReviews = result.negativeSuggestions.filter((item) => item.matchScope === 'phrase_review');
assert.equal(exactNegatives.length, 2);
assert.deepEqual(exactNegatives.map((item) => item.value).sort(), ['free glasses case', 'free glasses sample']);
assert.equal(phraseReviews.length, 1);
assert.equal(phraseReviews[0].value, 'free');
for (const suggestion of [...result.negativeSuggestions, ...result.harvestSuggestions]) {
  assert.equal(suggestion.requiresHumanReview, true);
  assert.equal(suggestion.persistenceAuthorized, false);
  assert.equal(suggestion.executionAuthorized, false);
  assert.equal(suggestion.amazonMutationAuthorized, false);
}

const protectedRootResult = analyzeCsvTermProfitability([
  {
    ...common,
    searchTerm: 'glasses profitable',
    impressions: 100,
    clicks: 10,
    purchases: 4,
    costMicros: 2_000_000,
    salesMicros: 10_000_000,
  },
  {
    ...common,
    searchTerm: 'glasses waste one',
    impressions: 150,
    clicks: 12,
    purchases: 0,
    costMicros: 8_000_000,
    salesMicros: 0,
  },
  {
    ...common,
    searchTerm: 'glasses waste two',
    impressions: 150,
    clicks: 12,
    purchases: 0,
    costMicros: 8_000_000,
    salesMicros: 0,
  },
]);
const protectedGlasses = protectedRootResult.protectedRoots.find((item) => item.root === 'glasses');
assert.ok(protectedGlasses, 'root containing a profitable Search Term must enter the profit-protection set');
assert.equal(protectedGlasses.profitTermCount, 1);
assert.equal(protectedGlasses.wasteTermCount, 2);
assert.equal(protectedGlasses.profitProtectionApplied, true);
assert.notEqual(protectedGlasses.classification, 'toxic');
assert.equal(
  protectedRootResult.negativeSuggestions.some((item) => item.matchScope === 'phrase_review' && item.value === 'glasses'),
  false,
  'a root containing a profitable Search Term must never become a phrase-negative review candidate',
);

const strictProfit = analyzeCsvTermProfitability([
  {
    ...common,
    searchTerm: 'reading glasses women',
    impressions: 100,
    clicks: 10,
    purchases: 4,
    costMicros: 4_000_000,
    salesMicros: 20_000_000,
  },
], { rules: { targetAcos: 0.15 } });
assert.equal(strictProfit.summary.profitTermCount, 0, 'custom ACoS target must change profit classification deterministically');

assert.throws(
  () => analyzeCsvTermProfitability([
    { ...common, searchTerm: 'one', currencyCode: 'USD' },
    { ...common, searchTerm: 'two', currencyCode: 'EUR' },
  ]),
  (error) => error?.code === 'CSV_TERM_ANALYSIS_MIXED_CURRENCY_SCOPE',
);
assert.throws(
  () => analyzeCsvTermProfitability([
    { ...common, searchTerm: 'one', advertiserAccountId: 'adv-01' },
    { ...common, searchTerm: 'two', advertiserAccountId: 'adv-02' },
  ]),
  (error) => error?.code === 'CSV_TERM_ANALYSIS_MIXED_ADVERTISER_SCOPE',
);

const reordered = analyzeCsvTermProfitability([
  {
    ...common,
    searchTerm: 'Free Glasses Case',
    impressions: 140,
    clicks: 12,
    purchases: 0,
    costMicros: 6_000_000,
    salesMicros: 0,
  },
  {
    ...common,
    searchTerm: 'Reading Glasses Women',
    impressions: 100,
    clicks: 10,
    purchases: 4,
    costMicros: 4_000_000,
    salesMicros: 20_000_000,
  },
]);
const reorderedAgain = analyzeCsvTermProfitability([
  {
    ...common,
    searchTerm: 'Reading Glasses Women',
    impressions: 100,
    clicks: 10,
    purchases: 4,
    costMicros: 4_000_000,
    salesMicros: 20_000_000,
  },
  {
    ...common,
    searchTerm: 'Free Glasses Case',
    impressions: 140,
    clicks: 12,
    purchases: 0,
    costMicros: 6_000_000,
    salesMicros: 0,
  },
]);
assert.deepEqual(reordered.summary, reorderedAgain.summary, 'analysis summary must be input-order independent');
assert.deepEqual(reordered.negativeSuggestions, reorderedAgain.negativeSuggestions, 'suggestions must be deterministic');
assert.deepEqual(reordered.harvestSuggestions, reorderedAgain.harvestSuggestions, 'harvest output must be deterministic');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-term-profitability-analysis-v2-profit-root-protection',
  profitTerms: result.summary.profitTermCount,
  wasteTerms: result.summary.wasteTermCount,
  toxicRoots: result.summary.toxicRootCount,
  profitableRoots: result.summary.profitableRootCount,
  protectedRootSafety: true,
  exactNegativeCandidates: result.summary.exactNegativeCandidateCount,
  phraseRootReviews: result.summary.phraseRootReviewCount,
  harvestCandidates: result.summary.harvestCandidateCount,
  amazonMutationAuthorized: false,
}, null, 2));
