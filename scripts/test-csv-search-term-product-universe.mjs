import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP,
  CSV_SEARCH_TERM_PRODUCT_UNIVERSE_SCHEMA_VERSION,
  buildCsvSearchTermProductUniverseFromRows,
} from '../cloudflare/runtime/csv-search-term-product-universe.js';
import { buildCsvIntelligenceProductSurface } from '../cloudflare/runtime/csv-intelligence-product-surface.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'cloudflare/runtime/csv-search-term-product-universe.js'), 'utf8');
const api = await readFile(path.join(root, 'cloudflare/runtime/csv-search-term-intelligence-api.js'), 'utf8');

assert.match(source, /GROUP BY f\.normalized_search_term/, 'Product universe must aggregate by normalized Search Term, not display-row identity');
assert.match(source, /JOIN csv_import_authority a ON a\.import_id=f\.source_import_id AND a\.data_class='business'/, 'Product universe must retain business-data classification gate');
assert.match(source, /a\.provenance_class NOT IN \('exact_source_object','reconciled_exact_source'\)/, 'Product universe must retain recommendation provenance gate');
assert.match(source, /COALESCE\(f\.targeting_identity_state,'unresolved'\) <> 'resolved_id'/, 'Mixed targeting identity must fail closed instead of using lexical MIN');
assert.match(source, /CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP \+ 1/, 'Universe query must observe one overflow row beyond the hard cap');
assert.match(api, /Promise\.all\(\[/, 'Display rows and product universe should be queried independently without serial latency');
assert.match(api, /queryCsvSearchTermProductUniverse\(route\.storeDb, sharedQuery\)/, 'Same-origin Search Term API must query the complete filtered product universe');
assert.match(api, /items: productUniverse\.productItems/, 'Product surface must use universe items, not paginated display rows');
assert.match(api, /productizationScope: productUniverse\.scope/, 'Product surface must receive explicit universe completeness/financial scope');
assert.doesNotMatch(api, /items:\s*items,\s*productizationScope:/, 'Paged display items must not masquerade as productization universe');

const governedHash = 'a'.repeat(64);
const baseRows = [
  row({
    term: 'reading glasses women',
    searchTerm: 'Reading Glasses Women',
    profileIds: 'profile-01',
    currencyCodes: 'USD',
    marketplaces: 'US',
    targetingIdentityState: 'resolved_id',
    current: [300, 10, 4, 4_000_000, 20_000_000],
    previous: [140, 4, 1, 2_000_000, 5_000_000],
    sourceImportIds: 'import-june-a',
    contentSha256s: governedHash,
    provenanceClasses: 'exact_source_object',
  }),
  row({
    term: 'free glasses case',
    searchTerm: 'Free Glasses Case',
    profileIds: 'profile-01',
    currencyCodes: 'USD',
    marketplaces: 'US',
    targetingIdentityState: 'unresolved',
    current: [220, 12, 0, 6_000_000, 0],
    previous: [100, 4, 0, 400_000, 0],
    sourceImportIds: 'import-june-b',
    contentSha256s: governedHash,
    provenanceClasses: 'reconciled_exact_source',
  }),
];

const complete = buildCsvSearchTermProductUniverseFromRows(baseRows, { profileId: 'profile-01' });
assert.equal(complete.schemaVersion, CSV_SEARCH_TERM_PRODUCT_UNIVERSE_SCHEMA_VERSION);
assert.equal(complete.scope.kind, 'complete_filtered_search_term_universe');
assert.equal(complete.scope.complete, true);
assert.equal(complete.scope.overflowObserved, false);
assert.equal(complete.scope.financiallyComparable, true);
assert.equal(complete.scope.candidateEmissionAuthorized, true);
assert.deepEqual(complete.scope.currencyCodes, ['USD']);
assert.deepEqual(complete.scope.marketplaces, ['US']);
assert.deepEqual(complete.scope.profileIds, ['profile-01']);
assert.equal(complete.items.length, 2);
assert.equal(complete.productItems.length, 2);
assert.equal(complete.productItems[0].evidence.csvProvenanceValid, true);
assert.equal(complete.productItems[1].entity.targetingIdentityState, 'unresolved');
assert.equal(complete.productItems[0].metrics.acos, 0.2);
assert.equal(complete.productItems[0].previousMetrics.orders, 1);

const financialMismatch = buildCsvSearchTermProductUniverseFromRows([
  baseRows[0],
  row({
    term: 'reading glasses euro',
    searchTerm: 'Reading Glasses Euro',
    profileIds: 'profile-eu',
    currencyCodes: 'EUR',
    marketplaces: 'DE',
    targetingIdentityState: 'resolved_id',
    current: [100, 4, 2, 1_000_000, 6_000_000],
    previous: [80, 3, 1, 900_000, 3_000_000],
    sourceImportIds: 'import-eu',
    contentSha256s: governedHash,
    provenanceClasses: 'exact_source_object',
  }),
]);
assert.equal(financialMismatch.scope.complete, true);
assert.equal(financialMismatch.scope.financiallyComparable, false);
assert.equal(financialMismatch.scope.candidateEmissionAuthorized, false);
assert.ok(financialMismatch.scope.reasons.includes('multiple_currency_codes'));
assert.ok(financialMismatch.scope.reasons.includes('multiple_marketplaces'));
assert.equal(financialMismatch.items.length, 2, 'Raw bounded universe remains inspectable');
assert.equal(financialMismatch.productItems.length, 0, 'Financial intelligence must receive no mixed-currency facts');

const missingCurrency = buildCsvSearchTermProductUniverseFromRows([
  { ...baseRows[0], currency_codes: '' },
]);
assert.equal(missingCurrency.scope.financiallyComparable, false);
assert.ok(missingCurrency.scope.reasons.includes('currency_code_missing'));
assert.equal(missingCurrency.productItems.length, 0);

const ungoverned = buildCsvSearchTermProductUniverseFromRows([
  { ...baseRows[1], invalid_provenance_count: 1, provenance_classes: 'legacy_batch_only' },
]);
assert.equal(ungoverned.scope.complete, true);
assert.equal(ungoverned.scope.candidateEmissionAuthorized, true, 'Universe completeness is independent from per-term provenance');
assert.equal(ungoverned.productItems[0].evidence.csvProvenanceValid, false, 'Candidate layer must still suppress ungoverned term evidence');

const overflowRows = Array.from({ length: CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP + 1 }, (_, index) => row({
  term: `term ${String(index).padStart(4, '0')}`,
  searchTerm: `Term ${index}`,
  profileIds: 'profile-01',
  currencyCodes: 'USD',
  marketplaces: 'US',
  targetingIdentityState: 'resolved_id',
  current: [10, 1, 0, 100_000, 0],
  previous: [0, 0, 0, 0, 0],
  sourceImportIds: 'import-june-a',
  contentSha256s: governedHash,
  provenanceClasses: 'exact_source_object',
}));
const overflow = buildCsvSearchTermProductUniverseFromRows(overflowRows);
assert.equal(overflow.scope.complete, false);
assert.equal(overflow.scope.overflowObserved, true);
assert.equal(overflow.scope.observedTermCount, CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP);
assert.equal(overflow.scope.candidateEmissionAuthorized, false);
assert.ok(overflow.scope.reasons.includes('search_term_universe_hard_cap_exceeded'));
assert.equal(overflow.productItems.length, CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP, 'Partial analytics remain available inside the bounded universe');

const productSurface = buildCsvIntelligenceProductSurface({
  profile: complete.profile,
  range: { startDate: '2026-06-01', endDate: '2026-06-30' },
  comparisonRange: { startDate: '2026-05-02', endDate: '2026-05-31' },
  filters: { limit: 1 },
  productizationScope: complete.scope,
  items: complete.productItems,
});
assert.equal(productSurface.analysisScope.complete, true, 'Explicit full universe must override display-page limit semantics');
assert.equal(productSurface.analysisScope.financiallyComparable, true);
assert.equal(productSurface.analysisScope.candidateEmissionAuthorized, true);
assert.equal(productSurface.analysisScope.kind, 'complete_filtered_search_term_universe');

const overflowSurface = buildCsvIntelligenceProductSurface({
  profile: overflow.profile,
  range: { startDate: '2026-06-01', endDate: '2026-06-30' },
  comparisonRange: { startDate: '2026-05-02', endDate: '2026-05-31' },
  filters: { limit: 50 },
  productizationScope: overflow.scope,
  items: overflow.productItems,
});
assert.equal(overflowSurface.analysisScope.complete, false);
assert.equal(overflowSurface.analysisScope.candidateEmissionAuthorized, false);
assert.equal(overflowSurface.businessIntelligence.candidates.length, 0);
assert.equal(overflowSurface.businessIntelligence.summary.candidateEmissionAuthorized, false);

const mismatchSurface = buildCsvIntelligenceProductSurface({
  profile: financialMismatch.profile,
  range: { startDate: '2026-06-01', endDate: '2026-06-30' },
  comparisonRange: { startDate: '2026-05-02', endDate: '2026-05-31' },
  filters: { limit: 50 },
  productizationScope: financialMismatch.scope,
  items: financialMismatch.productItems,
});
assert.equal(mismatchSurface.analysisScope.complete, true);
assert.equal(mismatchSurface.analysisScope.financiallyComparable, false);
assert.equal(mismatchSurface.analysisScope.candidateEmissionAuthorized, false);
assert.equal(mismatchSurface.businessIntelligence.summary.analyzedTermCount, 0);
assert.equal(mismatchSurface.historicalIntelligence.lifecycle.summary.analyzedTermCount, 0);
assert.equal(mismatchSurface.businessIntelligence.candidates.length, 0);

console.log(JSON.stringify({
  ok: true,
  contract: CSV_SEARCH_TERM_PRODUCT_UNIVERSE_SCHEMA_VERSION,
  completeTerms: complete.scope.observedTermCount,
  hardCap: CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP,
  overflowCandidates: overflowSurface.businessIntelligence.candidates.length,
  financialMismatchProductItems: financialMismatch.productItems.length,
  amazonMutationAuthorized: productSurface.authority.amazonMutationAuthorized,
}, null, 2));

function row({ term, searchTerm, profileIds, currencyCodes, marketplaces, targetingIdentityState, current, previous, sourceImportIds, contentSha256s, provenanceClasses }) {
  return {
    normalized_search_term: term,
    search_term: searchTerm,
    profile_ids: profileIds,
    currency_codes: currencyCodes,
    marketplaces,
    targeting_identity_state: targetingIdentityState,
    impressions: current[0],
    clicks: current[1],
    purchases: current[2],
    units_sold: current[2],
    cost_micros: current[3],
    sales_micros: current[4],
    previous_impressions: previous[0],
    previous_clicks: previous[1],
    previous_purchases: previous[2],
    previous_units_sold: previous[2],
    previous_cost_micros: previous[3],
    previous_sales_micros: previous[4],
    fact_row_count: 1,
    invalid_provenance_count: 0,
    source_import_ids: sourceImportIds,
    content_sha256s: contentSha256s,
    provenance_classes: provenanceClasses,
  };
}
