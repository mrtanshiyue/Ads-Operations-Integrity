import { buildCsvSearchTermBusinessIntelligence } from './csv-search-term-business-intelligence.js';
import { buildCsvSearchTermLifecycle } from './csv-search-term-lifecycle.js';
import { buildCsvRecommendationInbox } from './csv-analytics-recommendation-inbox.js';

export const CSV_INTELLIGENCE_PRODUCT_SURFACE_SCHEMA_VERSION = 'csv-intelligence-product-surface-v3';

const PRODUCT_SURFACE_AUTHORITY = Object.freeze({
  sourceKind: 'csv_import',
  authoritative: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function buildCsvIntelligenceProductSurface(payload) {
  if (!payload || typeof payload !== 'object') throw surfaceError('CSV_INTELLIGENCE_PRODUCT_PAYLOAD_REQUIRED');
  const items = Array.isArray(payload.items) ? payload.items : [];
  const currentWindow = normalizeWindow(payload.range);
  const previousWindow = normalizeWindow(payload.comparisonRange);
  const analysisScope = deriveAnalysisScope(payload, items);
  const currentFacts = items.map((item) => factFromItem(item, 'metrics', currentWindow?.endDate, payload, true));
  const previousFacts = items.map((item) => factFromItem(item, 'previousMetrics', previousWindow?.endDate, payload, false));
  const identityConfidence = deriveIdentityConfidence(payload);

  const rawBusinessIntelligence = buildCsvSearchTermBusinessIntelligence(currentFacts, {
    analysisWindow: currentWindow,
    identityConfidence,
  });
  const businessIntelligence = constrainBusinessCandidates(rawBusinessIntelligence, analysisScope);
  const rawLifecycle = buildCsvSearchTermLifecycle({
    currentFacts,
    previousFacts,
    currentWindow,
    previousWindow,
  });
  const lifecycle = Object.freeze({ ...rawLifecycle, analysisScope });
  const historicalIntelligence = Object.freeze({
    schemaVersion: 'csv-historical-search-term-intelligence-v2',
    authority: PRODUCT_SURFACE_AUTHORITY,
    analysisScope,
    currentWindow,
    previousWindow,
    periodCapabilities: lifecycle.periodCapabilities,
    lifecycle,
    summary: Object.freeze({
      lifecycleTermCount: lifecycle.summary.analyzedTermCount,
      completeScope: analysisScope.complete,
      financiallyComparable: analysisScope.financiallyComparable,
      candidateEmissionAuthorized: analysisScope.candidateEmissionAuthorized,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
  });
  const recommendationInbox = buildCsvRecommendationInbox({
    businessIntelligence,
    historicalIntelligence,
    analysisScope,
  });

  return Object.freeze({
    schemaVersion: CSV_INTELLIGENCE_PRODUCT_SURFACE_SCHEMA_VERSION,
    authority: PRODUCT_SURFACE_AUTHORITY,
    analysisScope,
    businessIntelligence,
    historicalIntelligence,
    recommendationInbox,
  });
}

function constrainBusinessCandidates(raw, analysisScope) {
  if (analysisScope.candidateEmissionAuthorized) {
    return Object.freeze({
      ...raw,
      analysisScope,
      summary: Object.freeze({
        ...raw.summary,
        emittedCandidateCount: raw.candidates.length,
        suppressedByScopeCandidateCount: 0,
        candidateEmissionAuthorized: true,
      }),
    });
  }
  const suppressedByScopeCandidateCount = raw.candidates.length;
  return Object.freeze({
    ...raw,
    analysisScope,
    candidates: Object.freeze([]),
    summary: Object.freeze({
      ...raw.summary,
      emittedCandidateCount: 0,
      suppressedByScopeCandidateCount,
      exactNegativeCandidateCount: 0,
      phraseNegativeReviewCandidateCount: 0,
      harvestCandidateCount: 0,
      scaleCandidateCount: 0,
      candidateEmissionAuthorized: false,
    }),
  });
}

function deriveAnalysisScope(payload, items) {
  const requestedLimit = positiveIntOrNull(payload?.filters?.limit);
  const explicit = payload?.productizationScope && typeof payload.productizationScope === 'object'
    ? payload.productizationScope
    : null;
  const explicitComplete = explicit?.complete;
  const complete = explicitComplete === true
    || (explicitComplete !== false && requestedLimit !== null && items.length < requestedLimit);
  const financiallyComparable = explicit?.financiallyComparable !== false;
  const candidateEmissionAuthorized = complete && financiallyComparable && explicit?.candidateEmissionAuthorized !== false;
  return Object.freeze({
    kind: text(explicit?.kind) || 'filtered_response_universe',
    complete,
    financiallyComparable,
    itemCount: items.length,
    requestedLimit,
    hardCap: positiveIntOrNull(explicit?.hardCap),
    observedTermCount: positiveIntOrZero(explicit?.observedTermCount, items.length),
    overflowObserved: explicit?.overflowObserved === true,
    candidateEmissionAuthorized,
    currencyCodes: Object.freeze(uniqueTexts(explicit?.currencyCodes)),
    marketplaces: Object.freeze(uniqueTexts(explicit?.marketplaces)),
    profileIds: Object.freeze(uniqueTexts(explicit?.profileIds)),
    reasons: Object.freeze(uniqueTexts(explicit?.reasons)),
    completenessRule: explicitComplete == null ? 'complete_only_when_item_count_is_below_requested_limit' : 'explicit_scope_contract',
    incompleteBehavior: text(explicit?.incompleteBehavior) || 'analytics_visible_candidates_fail_closed',
    financialMismatchBehavior: text(explicit?.financialMismatchBehavior) || 'financial_intelligence_suppressed',
  });
}

function factFromItem(item, metricsKey, reportDate, payload, currentPeriod) {
  const metrics = item?.[metricsKey] || {};
  return Object.freeze({
    searchTerm: text(item?.entity?.searchTerm) || text(item?.entity?.normalizedSearchTerm),
    normalizedSearchTerm: text(item?.entity?.normalizedSearchTerm) || text(item?.entity?.searchTerm),
    profileId: text(payload?.profile?.profileId) || null,
    marketplace: text(payload?.profile?.countryCode) || null,
    currencyCode: text(payload?.profile?.currencyCode) || null,
    reportDate: reportDate || null,
    impressions: nonNegative(metrics.impressions),
    clicks: nonNegative(metrics.clicks),
    purchases: nonNegative(metrics.orders ?? metrics.purchases),
    unitsSold: nonNegative(metrics.unitsSold),
    costMicros: nonNegative(metrics.spendMicros ?? metrics.costMicros),
    salesMicros: nonNegative(metrics.salesMicros),
    sourceImportIds: currentPeriod ? uniqueTexts(item?.evidence?.sourceImportIds) : Object.freeze([]),
    recommendationGoverned: currentPeriod ? item?.evidence?.csvProvenanceValid === true : undefined,
  });
}

function deriveIdentityConfidence(payload) {
  const itemStates = (Array.isArray(payload?.items) ? payload.items : [])
    .map((item) => text(item?.entity?.targetingIdentityState || item?.evidence?.targetingIdentityState))
    .filter(Boolean);
  const resolvedFromItems = itemStates.filter((state) => state === 'resolved_id').length;
  const unresolvedFromItems = itemStates.filter((state) => state !== 'resolved_id').length;
  const resolved = itemStates.length > 0 ? resolvedFromItems : nonNegative(payload?.summary?.csvResolvedTargetingItemCount);
  const unresolved = itemStates.length > 0 ? unresolvedFromItems : nonNegative(payload?.summary?.csvUnresolvedTargetingItemCount);
  const observed = resolved + unresolved;
  if (observed === 0) {
    return Object.freeze({
      state: 'observed_csv_identity_unknown',
      score: null,
      canonicalAmazonIdentityResolved: false,
    });
  }
  const score = round4(resolved / observed);
  return Object.freeze({
    state: score === 1 ? 'observed_csv_targeting_ids_resolved' : (score === 0 ? 'observed_csv_targeting_ids_unresolved' : 'observed_csv_targeting_ids_partial'),
    score,
    canonicalAmazonIdentityResolved: false,
  });
}

function normalizeWindow(value) {
  const startDate = cleanDate(value?.startDate);
  const endDate = cleanDate(value?.endDate);
  if (!startDate && !endDate) return null;
  if (!startDate || !endDate || startDate > endDate) throw surfaceError('CSV_INTELLIGENCE_PRODUCT_WINDOW_INVALID');
  return Object.freeze({ startDate, endDate });
}

function uniqueTexts(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(text).filter(Boolean))].sort();
}

function positiveIntOrNull(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function positiveIntOrZero(value, fallback = 0) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : fallback; }
function text(value) { return String(value ?? '').trim(); }
function nonNegative(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; }
function round4(value) { return Math.round(value * 10_000) / 10_000; }
function cleanDate(value) { const textValue = text(value); return /^\d{4}-\d{2}-\d{2}$/u.test(textValue) && !Number.isNaN(Date.parse(`${textValue}T00:00:00.000Z`)) ? textValue : null; }
function surfaceError(code) { const error = new Error(code); error.name = 'CsvIntelligenceProductSurfaceError'; error.code = code; return error; }
