import { buildCsvSearchTermBusinessIntelligence } from './csv-search-term-business-intelligence.js';
import { buildCsvSearchTermLifecycle } from './csv-search-term-lifecycle.js';

export const CSV_INTELLIGENCE_PRODUCT_SURFACE_SCHEMA_VERSION = 'csv-intelligence-product-surface-v1';

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
  const currentFacts = items.map((item) => factFromItem(item, 'metrics', currentWindow?.endDate, payload, true));
  const previousFacts = items.map((item) => factFromItem(item, 'previousMetrics', previousWindow?.endDate, payload, false));
  const identityConfidence = deriveIdentityConfidence(payload);

  const businessIntelligence = buildCsvSearchTermBusinessIntelligence(currentFacts, {
    analysisWindow: currentWindow,
    identityConfidence,
  });
  const lifecycle = buildCsvSearchTermLifecycle({
    currentFacts,
    previousFacts,
    currentWindow,
    previousWindow,
  });

  return Object.freeze({
    schemaVersion: CSV_INTELLIGENCE_PRODUCT_SURFACE_SCHEMA_VERSION,
    authority: PRODUCT_SURFACE_AUTHORITY,
    businessIntelligence,
    historicalIntelligence: Object.freeze({
      schemaVersion: 'csv-historical-search-term-intelligence-v1',
      authority: PRODUCT_SURFACE_AUTHORITY,
      currentWindow,
      previousWindow,
      periodCapabilities: lifecycle.periodCapabilities,
      lifecycle,
      summary: Object.freeze({
        lifecycleTermCount: lifecycle.summary.analyzedTermCount,
        executionAuthorized: false,
        amazonMutationAuthorized: false,
      }),
    }),
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
  if (!Array.isArray(values)) return Object.freeze([]);
  return Object.freeze([...new Set(values.map(text).filter(Boolean))].sort());
}

function text(value) { return String(value ?? '').trim(); }
function nonNegative(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; }
function round4(value) { return Math.round(value * 10_000) / 10_000; }
function cleanDate(value) { const textValue = text(value); return /^\d{4}-\d{2}-\d{2}$/u.test(textValue) && !Number.isNaN(Date.parse(`${textValue}T00:00:00.000Z`)) ? textValue : null; }
function surfaceError(code) { const error = new Error(code); error.name = 'CsvIntelligenceProductSurfaceError'; error.code = code; return error; }
