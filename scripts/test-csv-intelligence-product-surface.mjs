import assert from 'node:assert/strict';
import {
  CSV_INTELLIGENCE_PRODUCT_SURFACE_SCHEMA_VERSION,
  buildCsvIntelligenceProductSurface,
} from '../cloudflare/runtime/csv-intelligence-product-surface.js';
import { CANDIDATE_TYPES } from '../cloudflare/runtime/csv-search-term-business-intelligence.js';

const payload = {
  storeId: 'store-01',
  profile: {
    profileId: 'profile-01',
    countryCode: 'US',
    currencyCode: 'USD',
  },
  range: { startDate: '2026-06-01', endDate: '2026-06-30', days: 30 },
  comparisonRange: { startDate: '2026-05-02', endDate: '2026-05-31', days: 30 },
  filters: { limit: 50 },
  summary: {
    governancePersistenceAllowed: false,
    amazonMutationAuthorized: false,
  },
  items: [
    item({
      searchTerm: 'Reading Glasses Women',
      targetingIdentityState: 'resolved_id',
      provenanceValid: true,
      sourceImportIds: ['import-june-governed'],
      current: metrics(300, 10, 4, 4_000_000, 20_000_000),
      previous: metrics(140, 4, 1, 2_000_000, 5_000_000),
    }),
    item({
      searchTerm: 'Reading Glasses Lightweight',
      targetingIdentityState: 'resolved_id',
      provenanceValid: true,
      sourceImportIds: ['import-june-governed'],
      current: metrics(150, 3, 2, 1_000_000, 5_000_000),
      previous: metrics(120, 3, 1, 1_000_000, 2_000_000),
    }),
    item({
      searchTerm: 'Free Glasses Case',
      targetingIdentityState: 'unresolved',
      provenanceValid: false,
      sourceImportIds: ['import-june-legacy'],
      current: metrics(220, 12, 0, 6_000_000, 0),
      previous: metrics(100, 4, 0, 400_000, 0),
    }),
    item({
      searchTerm: 'Free Glasses Sample',
      targetingIdentityState: 'unresolved',
      provenanceValid: false,
      sourceImportIds: ['import-june-legacy'],
      current: metrics(200, 10, 0, 5_000_000, 0),
      previous: metrics(200, 10, 0, 2_000_000, 0),
    }),
    item({
      searchTerm: 'Reading Readers Generic',
      targetingIdentityState: 'unresolved',
      provenanceValid: true,
      sourceImportIds: ['import-june-governed'],
      current: metrics(80, 2, 0, 200_000, 0),
      previous: metrics(0, 0, 0, 0, 0),
    }),
  ],
};

const surface = buildCsvIntelligenceProductSurface(payload);
assert.equal(surface.schemaVersion, CSV_INTELLIGENCE_PRODUCT_SURFACE_SCHEMA_VERSION);
assert.equal(surface.authority.authoritative, false);
assert.equal(surface.authority.governancePersistenceAllowed, false);
assert.equal(surface.authority.executionAuthorized, false);
assert.equal(surface.authority.amazonMutationAuthorized, false);
assert.equal(surface.analysisScope.complete, true);
assert.equal(surface.analysisScope.candidateEmissionAuthorized, true);

const business = surface.businessIntelligence;
assert.equal(business.summary.analyzedTermCount, 5);
assert.equal(business.summary.scaleOpportunityCount, 1);
assert.equal(business.summary.profitWinnerCount, 1);
assert.equal(business.summary.wasteTermCount, 2);
assert.equal(business.summary.watchlistCount, 1);
assert.equal(business.identityConfidence.state, 'observed_csv_targeting_ids_partial');
assert.equal(business.identityConfidence.score, 0.4);
assert.equal(business.identityConfidence.canonicalAmazonIdentityResolved, false);

// Business classification remains available for ungoverned business data, but action candidates
// must fail closed unless every contributing term/import has exact/reconciled provenance.
assert.equal(business.summary.candidatePotentialCount, 6);
assert.equal(business.summary.governedCandidateCount, 3);
assert.equal(business.summary.suppressedByGovernanceCandidateCount, 3);
assert.equal(business.summary.emittedCandidateCount, 3);
assert.equal(business.summary.suppressedByScopeCandidateCount, 0);
assert.equal(business.summary.candidateEmissionAuthorized, true);
assert.equal(business.summary.exactNegativeCandidateCount, 0);
assert.equal(business.summary.phraseNegativeReviewCandidateCount, 0);
assert.equal(business.summary.harvestCandidateCount, 2);
assert.equal(business.summary.scaleCandidateCount, 1);
assert.equal(business.groups.wasteTerms.every((entry) => entry.recommendationGoverned === false), true);
assert.equal(business.rootIntelligence.toxicRoots.find((entry) => entry.root === 'free')?.recommendationGoverned, false);

const candidateTypes = new Set(business.candidates.map((candidate) => candidate.candidateType));
assert.ok(candidateTypes.has(CANDIDATE_TYPES.harvest));
assert.ok(candidateTypes.has(CANDIDATE_TYPES.scale));
assert.ok(!candidateTypes.has(CANDIDATE_TYPES.exactNegative));
assert.ok(!candidateTypes.has(CANDIDATE_TYPES.phraseNegativeReview));
for (const candidate of business.candidates) {
  assert.equal(candidate.evidence.recommendationGoverned, true);
  assert.equal(candidate.evidence.provenanceGate, 'exact_or_reconciled_source');
  assert.equal(candidate.executionAuthorized, false);
  assert.equal(candidate.amazonMutationAuthorized, false);
}

const historical = surface.historicalIntelligence;
assert.deepEqual(historical.currentWindow, { startDate: '2026-06-01', endDate: '2026-06-30' });
assert.deepEqual(historical.previousWindow, { startDate: '2026-05-02', endDate: '2026-05-31' });
assert.deepEqual(historical.periodCapabilities.presets, ['month', 'last_month', '30d', '60d', '90d', 'custom']);
assert.deepEqual(historical.periodCapabilities.comparisons, ['mom', 'period_over_period']);
const lifecycle = new Map(historical.lifecycle.items.map((entry) => [entry.searchTerm, entry.state]));
assert.equal(lifecycle.get('reading glasses women'), 'emergingWinner');
assert.equal(lifecycle.get('reading glasses lightweight'), 'emergingWinner');
assert.equal(lifecycle.get('free glasses case'), 'emergingWaste');
assert.equal(lifecycle.get('free glasses sample'), 'persistentWaste');
assert.equal(lifecycle.get('reading readers generic'), 'new');
assert.equal(historical.authority.executionAuthorized, false);
assert.equal(historical.authority.amazonMutationAuthorized, false);
assert.equal(historical.summary.completeScope, true);

// When the response universe hits the requested limit, completeness is not proven. Keep analytics
// visible but fail closed on all productization candidates so partial term/root evidence cannot
// masquerade as an exhaustive decision set.
const truncatedSurface = buildCsvIntelligenceProductSurface({
  ...payload,
  filters: { ...payload.filters, limit: payload.items.length },
});
assert.equal(truncatedSurface.analysisScope.complete, false);
assert.equal(truncatedSurface.analysisScope.candidateEmissionAuthorized, false);
assert.equal(truncatedSurface.businessIntelligence.summary.candidateEmissionAuthorized, false);
assert.equal(truncatedSurface.businessIntelligence.candidates.length, 0);
assert.equal(
  truncatedSurface.businessIntelligence.summary.suppressedByScopeCandidateCount,
  business.candidates.length,
);
assert.equal(truncatedSurface.businessIntelligence.summary.exactNegativeCandidateCount, 0);
assert.equal(truncatedSurface.businessIntelligence.summary.phraseNegativeReviewCandidateCount, 0);
assert.equal(truncatedSurface.businessIntelligence.summary.harvestCandidateCount, 0);
assert.equal(truncatedSurface.businessIntelligence.summary.scaleCandidateCount, 0);
assert.equal(truncatedSurface.historicalIntelligence.summary.completeScope, false);
assert.equal(truncatedSurface.historicalIntelligence.lifecycle.items.length, historical.lifecycle.items.length);

const emptySurface = buildCsvIntelligenceProductSurface({
  profile: { profileId: null, countryCode: null, currencyCode: null },
  range: { startDate: '2026-06-01', endDate: '2026-06-30' },
  comparisonRange: { startDate: '2026-05-02', endDate: '2026-05-31' },
  filters: { limit: 50 },
  items: [],
});
assert.equal(emptySurface.analysisScope.complete, true);
assert.equal(emptySurface.businessIntelligence.summary.analyzedTermCount, 0);
assert.equal(emptySurface.historicalIntelligence.lifecycle.summary.analyzedTermCount, 0);

console.log(JSON.stringify({
  ok: true,
  contract: CSV_INTELLIGENCE_PRODUCT_SURFACE_SCHEMA_VERSION,
  businessSummary: business.summary,
  lifecycleCounts: historical.lifecycle.summary.lifecycleCounts,
  truncatedScopeCandidateCount: truncatedSurface.businessIntelligence.candidates.length,
  amazonMutationAuthorized: surface.authority.amazonMutationAuthorized,
}, null, 2));

function item({ searchTerm, targetingIdentityState, provenanceValid, sourceImportIds, current, previous }) {
  const normalizedSearchTerm = searchTerm.toLowerCase();
  return {
    entity: {
      entityId: `row:${normalizedSearchTerm.replace(/\s+/gu, '-')}`,
      searchTerm,
      normalizedSearchTerm,
      targetingIdentityState,
      identityResolved: false,
    },
    metrics: current,
    previousMetrics: previous,
    evidence: {
      sourceKind: 'csv_import',
      dataClass: 'business',
      sourceImportIds,
      csvProvenanceValid: provenanceValid,
      identityResolved: false,
    },
  };
}

function metrics(impressions, clicks, orders, spendMicros, salesMicros) {
  return {
    impressions,
    clicks,
    orders,
    unitsSold: orders,
    spendMicros,
    salesMicros,
    ctr: impressions ? clicks / impressions : null,
    cpcMicros: clicks ? spendMicros / clicks : null,
    cvr: clicks ? orders / clicks : null,
    acos: salesMicros ? spendMicros / salesMicros : null,
    roas: spendMicros ? salesMicros / spendMicros : null,
  };
}
