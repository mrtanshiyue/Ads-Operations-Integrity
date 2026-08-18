import { deriveSearchTermMetrics } from './decision-intelligence.js';

export const CSV_TERM_ANALYSIS_SCHEMA_VERSION = 'csv-term-profitability-analysis-v2';

export const DEFAULT_CSV_TERM_ANALYSIS_RULES = Object.freeze({
  targetAcos: 0.35,
  profit: Object.freeze({
    minClicks: 3,
    minPurchases: 2,
  }),
  waste: Object.freeze({
    minClicks: 8,
    minSpendMicros: 1_000_000,
    maxPurchases: 0,
  }),
  toxicRoot: Object.freeze({
    minTerms: 2,
    minClicks: 12,
    minSpendMicros: 2_000_000,
    maxAcos: 0.70,
    protectProfitableTerms: true,
  }),
  profitableRoot: Object.freeze({
    minTerms: 2,
    minClicks: 5,
    minPurchases: 3,
  }),
});

export function analyzeCsvTermProfitability(facts, options = {}) {
  if (!Array.isArray(facts)) throw analysisError('CSV_TERM_ANALYSIS_FACTS_REQUIRED');
  const rules = normalizeRules(options.rules || {});
  const context = deriveContext(facts);
  const termMap = new Map();

  for (const fact of facts) {
    const normalizedSearchTerm = normalizeSearchTerm(fact?.normalizedSearchTerm || fact?.searchTerm);
    if (!normalizedSearchTerm) continue;
    let aggregate = termMap.get(normalizedSearchTerm);
    if (!aggregate) {
      aggregate = emptyAggregate(normalizedSearchTerm);
      termMap.set(normalizedSearchTerm, aggregate);
    }
    aggregate.variants.add(cleanText(fact?.searchTerm) || normalizedSearchTerm);
    aggregate.impressions += nonNegative(fact?.impressions);
    aggregate.clicks += nonNegative(fact?.clicks);
    aggregate.purchases += nonNegative(fact?.purchases);
    aggregate.unitsSold += nonNegative(fact?.unitsSold);
    aggregate.costMicros += nonNegative(fact?.costMicros ?? fact?.spendMicros);
    aggregate.salesMicros += nonNegative(fact?.salesMicros);
    if (cleanText(fact?.sourceImportId)) aggregate.sourceImportIds.add(cleanText(fact.sourceImportId));
  }

  const terms = [...termMap.values()]
    .map((aggregate) => finalizeTermAggregate(aggregate, rules))
    .sort(compareByPriorityThenName);
  const rootMap = buildRootAggregates(terms);
  const roots = [...rootMap.values()]
    .map((aggregate) => finalizeRootAggregate(aggregate, rules))
    .sort(compareByPriorityThenName);

  const profitTerms = terms.filter((item) => item.classification === 'profit');
  const wasteTerms = terms.filter((item) => item.classification === 'waste');
  const toxicRoots = roots.filter((item) => item.classification === 'toxic');
  const profitableRoots = roots.filter((item) => item.classification === 'profitable');
  const protectedRoots = roots.filter((item) => item.profitProtectionApplied);
  const negativeSuggestions = [
    ...wasteTerms.map((item) => Object.freeze({
      suggestionType: 'negative_keyword',
      matchScope: 'exact',
      value: item.searchTerm,
      rationaleCode: 'spend_without_orders',
      priorityScore: item.priorityScore,
      metrics: item.metrics,
      sourceTermCount: 1,
      requiresHumanReview: true,
      persistenceAuthorized: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    })),
    ...toxicRoots.map((item) => Object.freeze({
      suggestionType: 'negative_keyword',
      matchScope: 'phrase_review',
      value: item.root,
      rationaleCode: 'toxic_root_pattern',
      priorityScore: item.priorityScore,
      metrics: item.metrics,
      sourceTermCount: item.termCount,
      requiresHumanReview: true,
      persistenceAuthorized: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    })),
  ].sort(compareSuggestion);
  const harvestSuggestions = profitTerms.map((item) => Object.freeze({
    suggestionType: 'keyword_harvest',
    matchScope: 'exact_review',
    value: item.searchTerm,
    rationaleCode: 'efficient_converting_search_term',
    priorityScore: item.priorityScore,
    metrics: item.metrics,
    requiresHumanReview: true,
    persistenceAuthorized: false,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
  })).sort(compareSuggestion);
  const totalMetrics = metricsForAggregate(terms.reduce((acc, item) => addMetrics(acc, item.metrics), zeroMetrics()));

  return Object.freeze({
    schemaVersion: CSV_TERM_ANALYSIS_SCHEMA_VERSION,
    authority: Object.freeze({
      mode: 'csv_advisory_only',
      authoritative: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    context,
    rules,
    summary: Object.freeze({
      factCount: facts.length,
      analyzedTermCount: terms.length,
      analyzedRootCount: roots.length,
      profitTermCount: profitTerms.length,
      wasteTermCount: wasteTerms.length,
      toxicRootCount: toxicRoots.length,
      profitableRootCount: profitableRoots.length,
      protectedRootCount: protectedRoots.length,
      exactNegativeCandidateCount: wasteTerms.length,
      phraseRootReviewCount: toxicRoots.length,
      harvestCandidateCount: harvestSuggestions.length,
      metrics: totalMetrics,
    }),
    profitTerms: Object.freeze(profitTerms),
    wasteTerms: Object.freeze(wasteTerms),
    toxicRoots: Object.freeze(toxicRoots),
    profitableRoots: Object.freeze(profitableRoots),
    protectedRoots: Object.freeze(protectedRoots),
    negativeSuggestions: Object.freeze(negativeSuggestions),
    harvestSuggestions: Object.freeze(harvestSuggestions),
  });
}

function deriveContext(facts) {
  const advertiserAccountIds = uniqueTexts(facts.map((fact) => fact?.advertiserAccountId));
  const profileIds = uniqueTexts(facts.map((fact) => fact?.profileId));
  const marketplaces = uniqueTexts(facts.map((fact) => fact?.marketplace));
  const currencyCodes = uniqueTexts(facts.map((fact) => cleanText(fact?.currencyCode)?.toUpperCase()));
  const sourceImportIds = uniqueTexts(facts.map((fact) => fact?.sourceImportId));

  if (advertiserAccountIds.length > 1) throw analysisError('CSV_TERM_ANALYSIS_MIXED_ADVERTISER_SCOPE');
  if (profileIds.length > 1) throw analysisError('CSV_TERM_ANALYSIS_MIXED_PROFILE_SCOPE');
  if (marketplaces.length > 1) throw analysisError('CSV_TERM_ANALYSIS_MIXED_MARKETPLACE_SCOPE');
  if (currencyCodes.length > 1) throw analysisError('CSV_TERM_ANALYSIS_MIXED_CURRENCY_SCOPE');

  return Object.freeze({
    advertiserAccountId: advertiserAccountIds[0] || null,
    profileId: profileIds[0] || null,
    marketplace: marketplaces[0] || null,
    currencyCode: currencyCodes[0] || null,
    sourceImportIds: Object.freeze(sourceImportIds),
    canonicalAmazonIdentityResolved: false,
  });
}

function buildRootAggregates(terms) {
  const roots = new Map();
  for (const term of terms) {
    for (const root of new Set(tokenize(term.searchTerm))) {
      let aggregate = roots.get(root);
      if (!aggregate) {
        aggregate = {
          root,
          termCount: 0,
          profitTermCount: 0,
          wasteTermCount: 0,
          searchTerms: new Set(),
          metrics: zeroMetrics(),
        };
        roots.set(root, aggregate);
      }
      aggregate.termCount += 1;
      if (term.classification === 'profit') aggregate.profitTermCount += 1;
      if (term.classification === 'waste') aggregate.wasteTermCount += 1;
      aggregate.searchTerms.add(term.searchTerm);
      aggregate.metrics = addMetrics(aggregate.metrics, term.metrics);
    }
  }
  return roots;
}

function finalizeTermAggregate(aggregate, rules) {
  const metrics = metricsForAggregate(aggregate);
  const profitEligible = metrics.clicks >= rules.profit.minClicks
    && metrics.purchases >= rules.profit.minPurchases
    && metrics.acos !== null
    && metrics.acos <= rules.targetAcos;
  const wasteEligible = metrics.clicks >= rules.waste.minClicks
    && metrics.spendMicros >= rules.waste.minSpendMicros
    && metrics.purchases <= rules.waste.maxPurchases;
  const classification = wasteEligible ? 'waste' : (profitEligible ? 'profit' : 'observe');
  const priorityScore = classification === 'waste'
    ? wastePriority(metrics, rules)
    : classification === 'profit'
      ? profitPriority(metrics, rules)
      : 0;

  return Object.freeze({
    searchTerm: aggregate.searchTerm,
    observedVariants: Object.freeze([...aggregate.variants].sort()),
    classification,
    priorityScore,
    metrics,
    sourceImportIds: Object.freeze([...aggregate.sourceImportIds].sort()),
  });
}

function finalizeRootAggregate(aggregate, rules) {
  const metrics = metricsForAggregate(aggregate.metrics);
  const profitProtectionApplied = rules.toxicRoot.protectProfitableTerms && aggregate.profitTermCount > 0;
  const toxic = !profitProtectionApplied
    && aggregate.termCount >= rules.toxicRoot.minTerms
    && metrics.clicks >= rules.toxicRoot.minClicks
    && metrics.spendMicros >= rules.toxicRoot.minSpendMicros
    && (metrics.purchases === 0 || (metrics.acos !== null && metrics.acos >= rules.toxicRoot.maxAcos));
  const profitable = aggregate.termCount >= rules.profitableRoot.minTerms
    && metrics.clicks >= rules.profitableRoot.minClicks
    && metrics.purchases >= rules.profitableRoot.minPurchases
    && metrics.acos !== null
    && metrics.acos <= rules.targetAcos;
  const classification = toxic ? 'toxic' : (profitable ? 'profitable' : 'observe');
  const priorityScore = classification === 'toxic'
    ? toxicRootPriority(aggregate.termCount, metrics, rules)
    : classification === 'profitable'
      ? profitableRootPriority(aggregate.termCount, metrics, rules)
      : 0;

  return Object.freeze({
    root: aggregate.root,
    termCount: aggregate.termCount,
    profitTermCount: aggregate.profitTermCount,
    wasteTermCount: aggregate.wasteTermCount,
    searchTerms: Object.freeze([...aggregate.searchTerms].sort()),
    classification,
    priorityScore,
    profitProtectionApplied,
    metrics,
  });
}

function normalizeRules(overrides) {
  return Object.freeze({
    targetAcos: boundedPositive(overrides.targetAcos, DEFAULT_CSV_TERM_ANALYSIS_RULES.targetAcos),
    profit: Object.freeze({
      minClicks: positiveInt(overrides.profit?.minClicks, DEFAULT_CSV_TERM_ANALYSIS_RULES.profit.minClicks),
      minPurchases: positiveInt(overrides.profit?.minPurchases, DEFAULT_CSV_TERM_ANALYSIS_RULES.profit.minPurchases),
    }),
    waste: Object.freeze({
      minClicks: positiveInt(overrides.waste?.minClicks, DEFAULT_CSV_TERM_ANALYSIS_RULES.waste.minClicks),
      minSpendMicros: positiveInt(overrides.waste?.minSpendMicros, DEFAULT_CSV_TERM_ANALYSIS_RULES.waste.minSpendMicros),
      maxPurchases: nonNegative(overrides.waste?.maxPurchases ?? DEFAULT_CSV_TERM_ANALYSIS_RULES.waste.maxPurchases),
    }),
    toxicRoot: Object.freeze({
      minTerms: positiveInt(overrides.toxicRoot?.minTerms, DEFAULT_CSV_TERM_ANALYSIS_RULES.toxicRoot.minTerms),
      minClicks: positiveInt(overrides.toxicRoot?.minClicks, DEFAULT_CSV_TERM_ANALYSIS_RULES.toxicRoot.minClicks),
      minSpendMicros: positiveInt(overrides.toxicRoot?.minSpendMicros, DEFAULT_CSV_TERM_ANALYSIS_RULES.toxicRoot.minSpendMicros),
      maxAcos: boundedPositive(overrides.toxicRoot?.maxAcos, DEFAULT_CSV_TERM_ANALYSIS_RULES.toxicRoot.maxAcos),
      protectProfitableTerms: overrides.toxicRoot?.protectProfitableTerms !== false,
    }),
    profitableRoot: Object.freeze({
      minTerms: positiveInt(overrides.profitableRoot?.minTerms, DEFAULT_CSV_TERM_ANALYSIS_RULES.profitableRoot.minTerms),
      minClicks: positiveInt(overrides.profitableRoot?.minClicks, DEFAULT_CSV_TERM_ANALYSIS_RULES.profitableRoot.minClicks),
      minPurchases: positiveInt(overrides.profitableRoot?.minPurchases, DEFAULT_CSV_TERM_ANALYSIS_RULES.profitableRoot.minPurchases),
    }),
  });
}

function metricsForAggregate(value) {
  return deriveSearchTermMetrics({
    impressions: value.impressions,
    clicks: value.clicks,
    purchases: value.purchases,
    unitsSold: value.unitsSold,
    costMicros: value.costMicros ?? value.spendMicros,
    salesMicros: value.salesMicros,
  });
}

function emptyAggregate(searchTerm) {
  return {
    searchTerm,
    variants: new Set(),
    sourceImportIds: new Set(),
    impressions: 0,
    clicks: 0,
    purchases: 0,
    unitsSold: 0,
    costMicros: 0,
    salesMicros: 0,
  };
}

function zeroMetrics() {
  return { impressions: 0, clicks: 0, purchases: 0, unitsSold: 0, costMicros: 0, salesMicros: 0 };
}

function addMetrics(left, right) {
  return {
    impressions: nonNegative(left.impressions) + nonNegative(right.impressions),
    clicks: nonNegative(left.clicks) + nonNegative(right.clicks),
    purchases: nonNegative(left.purchases ?? left.orders) + nonNegative(right.purchases ?? right.orders),
    unitsSold: nonNegative(left.unitsSold) + nonNegative(right.unitsSold),
    costMicros: nonNegative(left.costMicros ?? left.spendMicros) + nonNegative(right.costMicros ?? right.spendMicros),
    salesMicros: nonNegative(left.salesMicros) + nonNegative(right.salesMicros),
  };
}

function wastePriority(metrics, rules) {
  const clickPressure = Math.min(1, metrics.clicks / Math.max(rules.waste.minClicks * 2, 1));
  const spendPressure = Math.min(1, metrics.spendMicros / Math.max(rules.waste.minSpendMicros * 2, 1));
  return round2(100 * (0.45 * clickPressure + 0.55 * spendPressure));
}

function profitPriority(metrics, rules) {
  const orderPressure = Math.min(1, metrics.purchases / Math.max(rules.profit.minPurchases * 2, 1));
  const efficiencyPressure = metrics.acos === null ? 0 : Math.min(1, rules.targetAcos / Math.max(metrics.acos, 0.01));
  const conversionPressure = Math.min(1, (metrics.cvr || 0) / 0.20);
  return round2(100 * (0.4 * orderPressure + 0.35 * efficiencyPressure + 0.25 * conversionPressure));
}

function toxicRootPriority(termCount, metrics, rules) {
  const termPressure = Math.min(1, termCount / Math.max(rules.toxicRoot.minTerms * 2, 1));
  const clickPressure = Math.min(1, metrics.clicks / Math.max(rules.toxicRoot.minClicks * 2, 1));
  const spendPressure = Math.min(1, metrics.spendMicros / Math.max(rules.toxicRoot.minSpendMicros * 2, 1));
  const inefficiencyPressure = metrics.purchases === 0
    ? 1
    : Math.min(1, (metrics.acos || 0) / Math.max(rules.toxicRoot.maxAcos, 0.01));
  return round2(100 * (0.2 * termPressure + 0.25 * clickPressure + 0.35 * spendPressure + 0.2 * inefficiencyPressure));
}

function profitableRootPriority(termCount, metrics, rules) {
  const termPressure = Math.min(1, termCount / Math.max(rules.profitableRoot.minTerms * 2, 1));
  const orderPressure = Math.min(1, metrics.purchases / Math.max(rules.profitableRoot.minPurchases * 2, 1));
  const efficiencyPressure = metrics.acos === null ? 0 : Math.min(1, rules.targetAcos / Math.max(metrics.acos, 0.01));
  return round2(100 * (0.25 * termPressure + 0.4 * orderPressure + 0.35 * efficiencyPressure));
}

function tokenize(value) {
  return normalizeSearchTerm(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function normalizeSearchTerm(value) {
  return cleanText(value)?.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ') || '';
}

function uniqueTexts(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))].sort();
}

function compareByPriorityThenName(left, right) {
  return (right.priorityScore - left.priorityScore)
    || String(left.searchTerm || left.root).localeCompare(String(right.searchTerm || right.root));
}

function compareSuggestion(left, right) {
  return (right.priorityScore - left.priorityScore)
    || left.matchScope.localeCompare(right.matchScope)
    || left.value.localeCompare(right.value);
}

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function nonNegative(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function boundedPositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 100 ? number : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function analysisError(code) {
  const error = new Error(code);
  error.name = 'CsvTermProfitabilityAnalysisError';
  error.code = code;
  return error;
}
