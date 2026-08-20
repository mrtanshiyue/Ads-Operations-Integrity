import { deriveSearchTermMetrics } from './decision-intelligence.js';
import { analyzeCsvTermProfitability } from './csv-term-profitability-analysis.js';

export const CSV_SEARCH_TERM_LIFECYCLE_SCHEMA_VERSION = 'csv-search-term-lifecycle-v1';

export const SEARCH_TERM_LIFECYCLE_STATES = Object.freeze({
  new: 'New',
  emergingWinner: 'Emerging Winner',
  stableWinner: 'Stable Winner',
  declining: 'Declining',
  emergingWaste: 'Emerging Waste',
  persistentWaste: 'Persistent Waste',
  recovered: 'Recovered',
  watchlist: 'Watchlist',
});

export const CSV_HISTORICAL_PERIOD_CAPABILITIES = Object.freeze({
  presets: Object.freeze(['month', 'last_month', '30d', '60d', '90d', 'custom']),
  comparisons: Object.freeze(['mom', 'period_over_period']),
});

const DEFAULT_LIFECYCLE_RULES = Object.freeze({
  decliningOrdersPct: -0.50,
  decliningAcosDelta: 0.10,
});

const NON_EXECUTABLE_AUTHORITY = Object.freeze({
  sourceKind: 'csv_import',
  authoritative: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function buildCsvSearchTermLifecycle({ currentFacts, previousFacts, analysisRules = {}, lifecycleRules = {}, currentWindow = null, previousWindow = null } = {}) {
  if (!Array.isArray(currentFacts)) throw lifecycleError('CSV_SEARCH_TERM_LIFECYCLE_CURRENT_FACTS_REQUIRED');
  if (!Array.isArray(previousFacts)) throw lifecycleError('CSV_SEARCH_TERM_LIFECYCLE_PREVIOUS_FACTS_REQUIRED');

  const currentAnalysis = analyzeCsvTermProfitability(currentFacts, { rules: analysisRules });
  const previousAnalysis = analyzeCsvTermProfitability(previousFacts, { rules: analysisRules });
  assertComparableContexts(currentAnalysis.context, previousAnalysis.context);

  const normalizedCurrentWindow = normalizeWindow(currentWindow) || deriveWindow(currentFacts);
  const normalizedPreviousWindow = normalizeWindow(previousWindow) || deriveWindow(previousFacts);
  const rules = normalizeLifecycleRules(lifecycleRules);
  const current = aggregateFactsByTerm(currentFacts);
  const previous = aggregateFactsByTerm(previousFacts);
  const currentClass = classificationMap(currentAnalysis);
  const previousClass = classificationMap(previousAnalysis);
  const allTerms = [...new Set([...current.keys(), ...previous.keys()])].sort();

  const items = allTerms.map((searchTerm) => {
    const currentRow = current.get(searchTerm) || emptyTerm(searchTerm);
    const previousRow = previous.get(searchTerm) || emptyTerm(searchTerm);
    const currentClassification = currentClass.get(searchTerm) || 'observe';
    const previousClassification = previousClass.get(searchTerm) || 'observe';
    const change = metricChange(currentRow.metrics, previousRow.metrics);
    const state = classifyLifecycle({
      current: currentRow.metrics,
      previous: previousRow.metrics,
      currentClassification,
      previousClassification,
      change,
      rules,
    });

    return Object.freeze({
      searchTerm,
      state,
      stateLabel: SEARCH_TERM_LIFECYCLE_STATES[state],
      currentClassification,
      previousClassification,
      currentMetrics: currentRow.metrics,
      previousMetrics: previousRow.metrics,
      change,
      currentWindow: normalizedCurrentWindow,
      previousWindow: normalizedPreviousWindow,
      sourceImportIds: Object.freeze({
        current: currentRow.sourceImportIds,
        previous: previousRow.sourceImportIds,
      }),
      reason: lifecycleReason(state),
      requiresHumanReview: true,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    });
  });

  const counts = {};
  for (const key of Object.keys(SEARCH_TERM_LIFECYCLE_STATES)) counts[key] = items.filter((item) => item.state === key).length;

  return Object.freeze({
    schemaVersion: CSV_SEARCH_TERM_LIFECYCLE_SCHEMA_VERSION,
    authority: NON_EXECUTABLE_AUTHORITY,
    context: mergeContexts(currentAnalysis.context, previousAnalysis.context),
    periodCapabilities: CSV_HISTORICAL_PERIOD_CAPABILITIES,
    currentWindow: normalizedCurrentWindow,
    previousWindow: normalizedPreviousWindow,
    rules,
    summary: Object.freeze({
      analyzedTermCount: items.length,
      lifecycleCounts: Object.freeze(counts),
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    items: Object.freeze(items),
  });
}

function classifyLifecycle({ current, previous, currentClassification, previousClassification, change, rules }) {
  const currentActive = hasActivity(current);
  const previousActive = hasActivity(previous);
  const currentProfit = currentClassification === 'profit';
  const previousProfit = previousClassification === 'profit';
  const currentWaste = currentClassification === 'waste';
  const previousWaste = previousClassification === 'waste';

  if (!previousActive && currentActive) return 'new';
  if (previousWaste && !currentWaste && current.orders > 0) return 'recovered';
  if (previousWaste && currentWaste) return 'persistentWaste';
  if (previousActive && !previousWaste && currentWaste) return 'emergingWaste';

  const materialDeterioration = previousProfit && currentProfit && (
    (change.ordersPct !== null && change.ordersPct <= rules.decliningOrdersPct)
    || (change.acosDelta !== null && change.acosDelta >= rules.decliningAcosDelta)
  );
  if (previousProfit && (!currentProfit || materialDeterioration)) return 'declining';
  if (previousProfit && currentProfit) return 'stableWinner';
  if (previousActive && !previousProfit && currentProfit) return 'emergingWinner';
  return 'watchlist';
}

function classificationMap(analysis) {
  const map = new Map();
  for (const item of analysis.profitTerms) map.set(item.searchTerm, 'profit');
  for (const item of analysis.wasteTerms) map.set(item.searchTerm, 'waste');
  return map;
}

function aggregateFactsByTerm(facts) {
  const rows = new Map();
  for (const fact of facts) {
    const searchTerm = normalizeSearchTerm(fact?.normalizedSearchTerm || fact?.searchTerm);
    if (!searchTerm) continue;
    let row = rows.get(searchTerm);
    if (!row) {
      row = { searchTerm, sourceImportIds: new Set(), impressions: 0, clicks: 0, orders: 0, unitsSold: 0, spendMicros: 0, salesMicros: 0 };
      rows.set(searchTerm, row);
    }
    if (cleanText(fact?.sourceImportId)) row.sourceImportIds.add(cleanText(fact.sourceImportId));
    row.impressions += nonNegative(fact?.impressions);
    row.clicks += nonNegative(fact?.clicks);
    row.orders += nonNegative(fact?.purchases ?? fact?.orders);
    row.unitsSold += nonNegative(fact?.unitsSold);
    row.spendMicros += nonNegative(fact?.costMicros ?? fact?.spendMicros);
    row.salesMicros += nonNegative(fact?.salesMicros);
  }

  for (const [key, row] of rows) {
    rows.set(key, Object.freeze({
      searchTerm: row.searchTerm,
      sourceImportIds: Object.freeze([...row.sourceImportIds].sort()),
      metrics: deriveSearchTermMetrics({
        impressions: row.impressions,
        clicks: row.clicks,
        purchases: row.orders,
        unitsSold: row.unitsSold,
        costMicros: row.spendMicros,
        salesMicros: row.salesMicros,
      }),
    }));
  }
  return rows;
}

function emptyTerm(searchTerm) {
  return Object.freeze({
    searchTerm,
    sourceImportIds: Object.freeze([]),
    metrics: deriveSearchTermMetrics({}),
  });
}

function metricChange(current, previous) {
  return Object.freeze({
    impressionsPct: percentChange(current.impressions, previous.impressions),
    clicksPct: percentChange(current.clicks, previous.clicks),
    spendPct: percentChange(current.spendMicros, previous.spendMicros),
    ordersPct: percentChange(current.orders, previous.orders),
    salesPct: percentChange(current.salesMicros, previous.salesMicros),
    acosDelta: nullableDelta(current.acos, previous.acos),
    roasDelta: nullableDelta(current.roas, previous.roas),
    cvrDelta: nullableDelta(current.cvr, previous.cvr),
    cpcPct: percentChange(current.cpcMicros, previous.cpcMicros),
  });
}

function assertComparableContexts(current, previous) {
  for (const key of ['advertiserAccountId', 'profileId', 'marketplace', 'currencyCode']) {
    const left = current?.[key] || null;
    const right = previous?.[key] || null;
    if (left && right && left !== right) throw lifecycleError(`CSV_SEARCH_TERM_LIFECYCLE_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_MISMATCH`);
  }
}

function mergeContexts(current, previous) {
  return Object.freeze({
    advertiserAccountId: current?.advertiserAccountId || previous?.advertiserAccountId || null,
    profileId: current?.profileId || previous?.profileId || null,
    marketplace: current?.marketplace || previous?.marketplace || null,
    currencyCode: current?.currencyCode || previous?.currencyCode || null,
    canonicalAmazonIdentityResolved: false,
  });
}

function normalizeLifecycleRules(value) {
  return Object.freeze({
    decliningOrdersPct: boundedNumber(value?.decliningOrdersPct, DEFAULT_LIFECYCLE_RULES.decliningOrdersPct, -1, 0),
    decliningAcosDelta: boundedNumber(value?.decliningAcosDelta, DEFAULT_LIFECYCLE_RULES.decliningAcosDelta, 0, 10),
  });
}

function normalizeWindow(value) {
  const startDate = cleanDate(value?.startDate);
  const endDate = cleanDate(value?.endDate);
  if (!startDate && !endDate) return null;
  if (!startDate || !endDate || startDate > endDate) throw lifecycleError('CSV_SEARCH_TERM_LIFECYCLE_WINDOW_INVALID');
  return Object.freeze({ startDate, endDate });
}

function deriveWindow(facts) {
  const dates = facts.map((fact) => cleanDate(fact?.reportDate)).filter(Boolean).sort();
  return Object.freeze({ startDate: dates[0] || null, endDate: dates[dates.length - 1] || null });
}

function hasActivity(metrics) {
  return metrics.impressions > 0 || metrics.clicks > 0 || metrics.spendMicros > 0 || metrics.orders > 0 || metrics.salesMicros > 0;
}

function lifecycleReason(state) {
  return {
    new: 'Search term appears in the current period with no observed activity in the previous comparison period.',
    emergingWinner: 'Search term moved from non-profit observation into the configured profitable state.',
    stableWinner: 'Search term remains profitable across both comparison periods without material deterioration.',
    declining: 'Previously profitable search term lost profitability or materially deteriorated in orders or ACoS.',
    emergingWaste: 'Search term newly crossed the configured waste threshold in the current period.',
    persistentWaste: 'Search term remains above the configured waste threshold across both periods.',
    recovered: 'Previously waste-classified search term now converts and no longer meets the waste threshold.',
    watchlist: 'No lifecycle transition currently meets the configured winner, waste, recovery, or decline rules.',
  }[state];
}

function percentChange(current, previous) {
  const a = Number(current);
  const b = Number(previous);
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? round4((a - b) / b) : null;
}
function nullableDelta(current, previous) { return current == null || previous == null ? null : round4(Number(current) - Number(previous)); }
function round4(value) { return Math.round(value * 10_000) / 10_000; }
function normalizeSearchTerm(value) { return cleanText(value).toLowerCase().replace(/\s+/gu, ' '); }
function cleanText(value) { return String(value ?? '').trim(); }
function nonNegative(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; }
function boundedNumber(value, fallback, min, max) { const number = Number(value); return Number.isFinite(number) && number >= min && number <= max ? number : fallback; }
function cleanDate(value) { const text = cleanText(value); return /^\d{4}-\d{2}-\d{2}$/u.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00.000Z`)) ? text : null; }
function lifecycleError(code) { const error = new Error(code); error.name = 'CsvSearchTermLifecycleError'; error.code = code; return error; }
