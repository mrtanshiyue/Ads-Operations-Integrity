import assert from 'node:assert/strict';
import {
  CSV_INTELLIGENCE_PRODUCT_SURFACE_SCHEMA_VERSION,
  buildCsvIntelligenceProductSurface,
} from '../cloudflare/runtime/csv-intelligence-product-surface.js';
import { CSV_RECOMMENDATION_INBOX_SCHEMA_VERSION } from '../cloudflare/runtime/csv-analytics-recommendation-inbox.js';

const payload = {
  storeId: 'store-01',
  profile: { profileId: 'profile-01', countryCode: 'US', currencyCode: 'USD' },
  range: { startDate: '2026-06-01', endDate: '2026-06-30', days: 30 },
  comparisonRange: { startDate: '2026-05-02', endDate: '2026-05-31', days: 30 },
  filters: { limit: 50 },
  items: [
    item('Reading Glasses Women', true, 'resolved_id', metrics(300, 10, 4, 4_000_000, 20_000_000), metrics(140, 4, 1, 2_000_000, 5_000_000), 'import-governed'),
    item('Reading Glasses Lightweight', true, 'resolved_id', metrics(150, 3, 2, 1_000_000, 5_000_000), metrics(120, 3, 1, 1_000_000, 2_000_000), 'import-governed'),
    item('Free Glasses Case', false, 'unresolved', metrics(220, 12, 0, 6_000_000, 0), metrics(100, 4, 0, 400_000, 0), 'import-legacy'),
    item('Free Glasses Sample', false, 'unresolved', metrics(200, 10, 0, 5_000_000, 0), metrics(200, 10, 0, 2_000_000, 0), 'import-legacy'),
    item('Reading Readers Generic', true, 'unresolved', metrics(80, 2, 0, 200_000, 0), metrics(0, 0, 0, 0, 0), 'import-governed'),
  ],
};

const surface = buildCsvIntelligenceProductSurface(payload);
assert.equal(surface.schemaVersion, CSV_INTELLIGENCE_PRODUCT_SURFACE_SCHEMA_VERSION);
assert.equal(surface.schemaVersion, 'csv-intelligence-product-surface-v3');
const inbox = surface.recommendationInbox;
assert.equal(inbox.schemaVersion, CSV_RECOMMENDATION_INBOX_SCHEMA_VERSION);
assert.equal(inbox.schemaVersion, 'csv-recommendation-inbox-v1');
assert.equal(inbox.authority.authoritative, false);
assert.equal(inbox.authority.governancePersistenceAllowed, false);
assert.equal(inbox.authority.executionAuthorized, false);
assert.equal(inbox.authority.amazonMutationAuthorized, false);
assert.equal(inbox.authority.canonicalAmazonIdentityResolved, false);
assert.equal(inbox.workflow.kind, 'human_review_only');
assert.equal(inbox.workflow.persistenceAuthorized, false);
assert.equal(inbox.workflow.executionAuthorized, false);
assert.equal(inbox.workflow.amazonMutationAuthorized, false);
assert.equal(inbox.workflow.futurePersistenceContract.actionEntity, 'optimization_actions');
assert.equal(inbox.workflow.futurePersistenceContract.eventEntity, 'optimization_action_events');
assert.equal(inbox.workflow.futurePersistenceContract.enabled, false);

assert.equal(inbox.analysisScope.complete, true);
assert.equal(inbox.analysisScope.financiallyComparable, true);
assert.equal(inbox.analysisScope.candidateEmissionAuthorized, true);
assert.equal(inbox.summary.candidatePotentialCount, 6);
assert.equal(inbox.summary.reviewCandidateCount, 3);
assert.equal(inbox.summary.blockedByGovernanceCount, 3);
assert.equal(inbox.summary.blockedByScopeCount, 0);
assert.equal(inbox.summary.observationContext.profitWinnerCount, 1);
assert.equal(inbox.summary.observationContext.scaleOpportunityCount, 1);
assert.equal(inbox.summary.observationContext.wasteTermCount, 2);
assert.equal(inbox.summary.observationContext.watchlistCount, 1);
assert.equal(inbox.summary.observationContext.lifecycleCounts.emergingWinner, 2);
assert.equal(inbox.summary.observationContext.lifecycleCounts.emergingWaste, 1);
assert.equal(inbox.summary.observationContext.lifecycleCounts.persistentWaste, 1);
assert.equal(inbox.summary.observationContext.lifecycleCounts.new, 1);

assert.equal(inbox.items.length, 3);
assert.equal(inbox.items.some((entry) => entry.value === 'free glasses case'), false, 'legacy provenance waste term must not enter Recommendation Inbox');
assert.equal(inbox.items.some((entry) => entry.value === 'free glasses sample'), false, 'legacy provenance waste term must not enter Recommendation Inbox');
for (const entry of inbox.items) {
  assert.equal(entry.itemClass, 'recommendation_candidate');
  assert.equal(entry.review.state, 'unreviewed');
  assert.equal(entry.review.placeholder, true);
  assert.equal(entry.review.persisted, false);
  assert.equal(entry.review.persistenceAuthorized, false);
  assert.equal(entry.review.futurePersistenceContract.enabled, false);
  assert.equal(entry.evidenceSummary.recommendationGoverned, true);
  assert.equal(entry.evidenceSummary.provenanceGate, 'exact_or_reconciled_source');
  assert.equal(entry.authority.executionAuthorized, false);
  assert.equal(entry.authority.amazonMutationAuthorized, false);
  assert.ok(entry.reason, 'review candidate must retain evidence explanation');
  assert.ok(entry.impactedSearchTerms.length >= 1, 'review candidate must expose impacted search terms');
  assert.ok(entry.lifecycleContext.length >= 1, 'term recommendation must expose lifecycle context');
}

const scale = inbox.items.find((entry) => entry.actionType === 'keyword.review_scale');
assert.ok(scale, 'scale review candidate must be present');
assert.equal(scale.value, 'reading glasses women');
assert.equal(scale.lifecycleContext[0].state, 'emergingWinner');
assert.equal(scale.businessContext[0].classification, 'scaleOpportunity');
assert.equal(scale.evidenceSummary.analysisWindow.startDate, '2026-06-01');
assert.equal(scale.evidenceSummary.analysisWindow.endDate, '2026-06-30');
assert.equal(scale.evidenceSummary.identityConfidence.canonicalAmazonIdentityResolved, false);

const truncated = buildCsvIntelligenceProductSurface({
  ...payload,
  filters: { limit: payload.items.length },
});
assert.equal(truncated.analysisScope.complete, false);
assert.equal(truncated.recommendationInbox.analysisScope.candidateEmissionAuthorized, false);
assert.equal(truncated.recommendationInbox.items.length, 0);
assert.equal(truncated.recommendationInbox.summary.reviewCandidateCount, 0);
assert.equal(truncated.recommendationInbox.summary.blockedByScopeCount, 3);
assert.equal(truncated.recommendationInbox.summary.executionAuthorized, false);
assert.equal(truncated.recommendationInbox.summary.amazonMutationAuthorized, false);

const empty = buildCsvIntelligenceProductSurface({
  profile: { profileId: null, countryCode: null, currencyCode: null },
  range: { startDate: '2026-06-01', endDate: '2026-06-30' },
  comparisonRange: { startDate: '2026-05-02', endDate: '2026-05-31' },
  filters: { limit: 50 },
  items: [],
});
assert.equal(empty.recommendationInbox.items.length, 0);
assert.equal(empty.recommendationInbox.summary.reviewCandidateCount, 0);
assert.equal(empty.recommendationInbox.summary.blockedByGovernanceCount, 0);
assert.equal(empty.recommendationInbox.summary.blockedByScopeCount, 0);

console.log(JSON.stringify({
  ok: true,
  contract: CSV_RECOMMENDATION_INBOX_SCHEMA_VERSION,
  reviewCandidateCount: inbox.summary.reviewCandidateCount,
  blockedByGovernanceCount: inbox.summary.blockedByGovernanceCount,
  blockedByScopeCount: inbox.summary.blockedByScopeCount,
  executionAuthorized: inbox.summary.executionAuthorized,
  amazonMutationAuthorized: inbox.summary.amazonMutationAuthorized,
}, null, 2));

function item(searchTerm, provenanceValid, targetingIdentityState, current, previous, sourceImportId) {
  return {
    entity: {
      entityId: `row:${searchTerm.toLowerCase().replace(/\s+/gu, '-')}`,
      searchTerm,
      normalizedSearchTerm: searchTerm.toLowerCase(),
      targetingIdentityState,
      identityResolved: false,
    },
    metrics: current,
    previousMetrics: previous,
    evidence: {
      sourceKind: 'csv_import',
      dataClass: 'business',
      sourceImportIds: [sourceImportId],
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
