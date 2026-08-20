import assert from 'node:assert/strict';
import {
  CANDIDATE_TYPES,
  CSV_SEARCH_TERM_BUSINESS_INTELLIGENCE_SCHEMA_VERSION,
  ROOT_INTELLIGENCE_STATES,
  SEARCH_TERM_BUSINESS_CLASSIFICATIONS,
  buildCsvSearchTermBusinessIntelligence,
} from '../cloudflare/runtime/csv-search-term-business-intelligence.js';

const common = {
  advertiserAccountId: 'adv-01',
  profileId: 'profile-01',
  marketplace: 'US',
  currencyCode: 'USD',
  reportDate: '2026-06-15',
};

const result = buildCsvSearchTermBusinessIntelligence([
  {
    ...common,
    sourceImportId: 'import-june-a',
    searchTerm: 'Reading Glasses Women',
    impressions: 300,
    clicks: 10,
    purchases: 4,
    unitsSold: 4,
    costMicros: 4_000_000,
    salesMicros: 20_000_000,
  },
  {
    ...common,
    sourceImportId: 'import-june-b',
    reportDate: '2026-06-16',
    searchTerm: 'Reading Glasses Lightweight',
    impressions: 150,
    clicks: 3,
    purchases: 2,
    unitsSold: 2,
    costMicros: 1_000_000,
    salesMicros: 5_000_000,
  },
  {
    ...common,
    sourceImportId: 'import-june-a',
    reportDate: '2026-06-17',
    searchTerm: 'Free Glasses Case',
    impressions: 220,
    clicks: 12,
    purchases: 0,
    unitsSold: 0,
    costMicros: 6_000_000,
    salesMicros: 0,
  },
  {
    ...common,
    sourceImportId: 'import-june-b',
    reportDate: '2026-06-18',
    searchTerm: 'Free Glasses Sample',
    impressions: 200,
    clicks: 10,
    purchases: 0,
    unitsSold: 0,
    costMicros: 5_000_000,
    salesMicros: 0,
  },
  {
    ...common,
    sourceImportId: 'import-june-b',
    reportDate: '2026-06-19',
    searchTerm: 'Reading Readers Generic',
    impressions: 80,
    clicks: 2,
    purchases: 0,
    unitsSold: 0,
    costMicros: 200_000,
    salesMicros: 0,
  },
]);

assert.equal(result.schemaVersion, CSV_SEARCH_TERM_BUSINESS_INTELLIGENCE_SCHEMA_VERSION);
assert.equal(result.authority.authoritative, false);
assert.equal(result.authority.governancePersistenceAllowed, false);
assert.equal(result.authority.executionAuthorized, false);
assert.equal(result.authority.amazonMutationAuthorized, false);
assert.deepEqual(result.analysisWindow, { startDate: '2026-06-15', endDate: '2026-06-19' });
assert.equal(result.identityConfidence.state, 'observed_csv_only');
assert.equal(result.identityConfidence.canonicalAmazonIdentityResolved, false);

assert.equal(result.summary.analyzedTermCount, 5);
assert.equal(result.summary.scaleOpportunityCount, 1);
assert.equal(result.summary.profitWinnerCount, 1);
assert.equal(result.summary.wasteTermCount, 2);
assert.equal(result.summary.watchlistCount, 1);

assert.equal(result.groups.scaleOpportunities[0].classificationLabel, SEARCH_TERM_BUSINESS_CLASSIFICATIONS.scaleOpportunity);
assert.equal(result.groups.profitWinners[0].classificationLabel, SEARCH_TERM_BUSINESS_CLASSIFICATIONS.profitWinner);
assert.equal(result.groups.wasteTerms[0].classificationLabel, SEARCH_TERM_BUSINESS_CLASSIFICATIONS.wasteTerm);
assert.equal(result.groups.watchlist[0].classificationLabel, SEARCH_TERM_BUSINESS_CLASSIFICATIONS.watchlist);

const toxicFree = result.rootIntelligence.toxicRoots.find((item) => item.root === 'free');
assert.ok(toxicFree, 'shared inefficient root must be toxic');
assert.ok(toxicFree.states.includes(ROOT_INTELLIGENCE_STATES.toxic));

const profitableReading = result.rootIntelligence.profitableRoots.find((item) => item.root === 'reading');
assert.ok(profitableReading, 'shared efficient root must be profitable');
assert.ok(profitableReading.states.includes(ROOT_INTELLIGENCE_STATES.profitable));

const protectedGlasses = result.rootIntelligence.protectedRoots.find((item) => item.root === 'glasses');
assert.ok(protectedGlasses, 'root containing profitable terms must be protected');
assert.ok(protectedGlasses.states.includes(ROOT_INTELLIGENCE_STATES.protected));
assert.ok(protectedGlasses.states.includes(ROOT_INTELLIGENCE_STATES.mixed));
assert.ok(result.rootIntelligence.mixedRoots.some((item) => item.root === 'glasses'));

assert.equal(result.summary.exactNegativeCandidateCount, 2);
assert.ok(result.summary.phraseNegativeReviewCandidateCount >= 1);
assert.equal(result.summary.harvestCandidateCount, 2);
assert.equal(result.summary.scaleCandidateCount, 1);

const requiredTypes = new Set(result.candidates.map((item) => item.candidateType));
for (const type of Object.values(CANDIDATE_TYPES)) assert.ok(requiredTypes.has(type), `candidate type missing: ${type}`);

for (const candidate of result.candidates) {
  assert.equal(candidate.requiresHumanReview, true);
  assert.equal(candidate.persistenceAuthorized, false);
  assert.equal(candidate.executionAuthorized, false);
  assert.equal(candidate.amazonMutationAuthorized, false);
  assert.equal(typeof candidate.evidence.spendMicros, 'number');
  assert.equal(typeof candidate.evidence.salesMicros, 'number');
  assert.equal(typeof candidate.evidence.orders, 'number');
  assert.equal(typeof candidate.evidence.clicks, 'number');
  assert.ok(Object.hasOwn(candidate.evidence, 'acos'));
  assert.ok(Object.hasOwn(candidate.evidence, 'cvr'));
  assert.deepEqual(candidate.evidence.analysisWindow, result.analysisWindow);
  assert.ok(Array.isArray(candidate.evidence.rootStates));
  assert.equal(candidate.evidence.identityConfidence.canonicalAmazonIdentityResolved, false);
  assert.ok(candidate.evidence.reason.length > 20);
}

const scale = result.candidates.find((item) => item.candidateType === CANDIDATE_TYPES.scale);
assert.equal(scale.value, 'reading glasses women');
assert.equal(scale.evidence.orders, 4);
assert.equal(scale.evidence.clicks, 10);
assert.equal(scale.evidence.acos, 0.2);
assert.equal(scale.evidence.cvr, 0.4);

console.log(JSON.stringify({
  ok: true,
  contract: CSV_SEARCH_TERM_BUSINESS_INTELLIGENCE_SCHEMA_VERSION,
  classifications: result.summary.analyzedTermCount,
  roots: result.rootIntelligence.roots.length,
  candidates: result.candidates.length,
  amazonMutationAuthorized: result.authority.amazonMutationAuthorized,
}, null, 2));
