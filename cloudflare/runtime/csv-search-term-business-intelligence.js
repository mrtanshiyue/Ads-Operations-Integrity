import { deriveSearchTermMetrics } from './decision-intelligence.js';
import { analyzeCsvTermProfitability } from './csv-term-profitability-analysis.js';

export const CSV_SEARCH_TERM_BUSINESS_INTELLIGENCE_SCHEMA_VERSION = 'csv-search-term-business-intelligence-v1';

export const SEARCH_TERM_BUSINESS_CLASSIFICATIONS = Object.freeze({
  profitWinner: 'Profit Winners',
  scaleOpportunity: 'Scale Opportunities',
  wasteTerm: 'Waste Terms',
  watchlist: 'Watchlist',
});

export const ROOT_INTELLIGENCE_STATES = Object.freeze({
  profitable: 'profitable',
  toxic: 'toxic',
  mixed: 'mixed',
  protected: 'protected',
});

export const CANDIDATE_TYPES = Object.freeze({
  exactNegative: 'Exact Negative Candidate',
  phraseNegativeReview: 'Phrase Negative Review Candidate',
  harvest: 'Harvest Candidate',
  scale: 'Scale Candidate',
});

const DEFAULT_PRODUCTIZATION_RULES = Object.freeze({
  scale: Object.freeze({
    minPriorityScore: 80,
    minOrders: 3,
    minClicks: 5,
  }),
});

const NON_EXECUTABLE_AUTHORITY = Object.freeze({
  sourceKind: 'csv_import',
  authoritative: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function buildCsvSearchTermBusinessIntelligence(facts, options = {}) {
  if (!Array.isArray(facts)) throw businessError('CSV_SEARCH_TERM_BUSINESS_FACTS_REQUIRED');

  const base = analyzeCsvTermProfitability(facts, { rules: options.analysisRules || options.rules || {} });
  const rules = normalizeProductizationRules(options.productizationRules || options.rules?.productization || {});
  const analysisWindow = normalizeAnalysisWindow(options.analysisWindow) || deriveAnalysisWindow(facts);
  const identityConfidence = normalizeIdentityConfidence(options.identityConfidence);
  const aggregates = aggregateFactsByTerm(facts);
  const profitByTerm = new Map(base.profitTerms.map((item) => [item.searchTerm, item]));
  const wasteByTerm = new Map(base.wasteTerms.map((item) => [item.searchTerm, item]));
  const roots = buildRootIntelligence(base);
  const rootStatesByTerm = buildRootStatesByTerm(roots);

  const terms = [...aggregates.values()].map((aggregate) => {
    const profit = profitByTerm.get(aggregate.searchTerm) || null;
    const waste = wasteByTerm.get(aggregate.searchTerm) || null;
    const metrics = aggregate.metrics;
    const scaleEligible = Boolean(profit)
      && profit.priorityScore >= rules.scale.minPriorityScore
      && metrics.orders >= rules.scale.minOrders
      && metrics.clicks >= rules.scale.minClicks;
    const classification = waste
      ? 'wasteTerm'
      : scaleEligible
        ? 'scaleOpportunity'
        : profit
          ? 'profitWinner'
          : 'watchlist';
    const rootStates = rootStatesByTerm.get(aggregate.searchTerm) || Object.freeze([]);
    return Object.freeze({
      searchTerm: aggregate.searchTerm,
      observedVariants: aggregate.observedVariants,
      classification,
      classificationLabel: SEARCH_TERM_BUSINESS_CLASSIFICATIONS[classification],
      priorityScore: waste?.priorityScore ?? profit?.priorityScore ?? 0,
      metrics,
      sourceImportIds: aggregate.sourceImportIds,
      rootStates,
      analysisWindow,
      identityConfidence,
      reason: classificationReason(classification),
    });
  }).sort(compareBusinessTerm);

  const termByName = new Map(terms.map((item) => [item.searchTerm, item]));
  const candidates = [
    ...base.negativeSuggestions.map((suggestion) => {
      if (suggestion.matchScope === 'phrase_review') {
        const root = roots.find((item) => item.root === suggestion.value) || null;
        return candidateRecord({
          candidateType: CANDIDATE_TYPES.phraseNegativeReview,
          actionType: 'negative_keyword.review_phrase',
          matchScope: 'phrase_review',
          value: suggestion.value,
          priorityScore: suggestion.priorityScore,
          metrics: suggestion.metrics,
          analysisWindow,
          rootStates: root?.states || Object.freeze([ROOT_INTELLIGENCE_STATES.toxic]),
          identityConfidence,
          sourceImportIds: Object.freeze([]),
          reason: 'Shared root shows repeated inefficient spend; phrase-level blocking requires human review because root scope can affect multiple search terms.',
        });
      }
      const term = termByName.get(suggestion.value) || null;
      return candidateRecord({
        candidateType: CANDIDATE_TYPES.exactNegative,
        actionType: 'negative_keyword.review_exact',
        matchScope: 'exact',
        value: suggestion.value,
        priorityScore: suggestion.priorityScore,
        metrics: suggestion.metrics,
        analysisWindow,
        rootStates: term?.rootStates || Object.freeze([]),
        identityConfidence,
        sourceImportIds: term?.sourceImportIds || Object.freeze([]),
        reason: 'Search term crossed the configured waste threshold with spend and clicks but no acceptable conversion outcome.',
      });
    }),
    ...base.harvestSuggestions.map((suggestion) => {
      const term = termByName.get(suggestion.value) || null;
      return candidateRecord({
        candidateType: CANDIDATE_TYPES.harvest,
        actionType: 'keyword.review_harvest',
        matchScope: 'exact_review',
        value: suggestion.value,
        priorityScore: suggestion.priorityScore,
        metrics: suggestion.metrics,
        analysisWindow,
        rootStates: term?.rootStates || Object.freeze([]),
        identityConfidence,
        sourceImportIds: term?.sourceImportIds || Object.freeze([]),
        reason: 'Search term is converting within the configured profitability threshold and is eligible for human-reviewed keyword harvesting.',
      });
    }),
    ...terms.filter((item) => item.classification === 'scaleOpportunity').map((item) => candidateRecord({
      candidateType: CANDIDATE_TYPES.scale,
      actionType: 'keyword.review_scale',
      matchScope: 'operator_review',
      value: item.searchTerm,
      priorityScore: item.priorityScore,
      metrics: item.metrics,
      analysisWindow,
      rootStates: item.rootStates,
      identityConfidence,
      sourceImportIds: item.sourceImportIds,
      reason: 'Profitable search term also has sufficient order, click, and priority evidence to justify a human-reviewed scale decision.',
    })),
  ].sort(compareCandidate);

  const groups = Object.freeze({
    profitWinners: Object.freeze(terms.filter((item) => item.classification === 'profitWinner')),
    scaleOpportunities: Object.freeze(terms.filter((item) => item.classification === 'scaleOpportunity')),
    wasteTerms: Object.freeze(terms.filter((item) => item.classification === 'wasteTerm')),
    watchlist: Object.freeze(terms.filter((item) => item.classification === 'watchlist')),
  });

  const rootIntelligence = Object.freeze({
    roots: Object.freeze(roots),
    profitableRoots: Object.freeze(roots.filter((item) => item.states.includes(ROOT_INTELLIGENCE_STATES.profitable))),
    toxicRoots: Object.freeze(roots.filter((item) => item.states.includes(ROOT_INTELLIGENCE_STATES.toxic))),
    mixedRoots: Object.freeze(roots.filter((item) => item.states.includes(ROOT_INTELLIGENCE_STATES.mixed))),
    protectedRoots: Object.freeze(roots.filter((item) => item.states.includes(ROOT_INTELLIGENCE_STATES.protected))),
  });

  return Object.freeze({
    schemaVersion: CSV_SEARCH_TERM_BUSINESS_INTELLIGENCE_SCHEMA_VERSION,
    authority: NON_EXECUTABLE_AUTHORITY,
    context: base.context,
    analysisWindow,
    identityConfidence,
    rules: Object.freeze({ base: base.rules, productization: rules }),
    summary: Object.freeze({
      analyzedTermCount: terms.length,
      profitWinnerCount: groups.profitWinners.length,
      scaleOpportunityCount: groups.scaleOpportunities.length,
      wasteTermCount: groups.wasteTerms.length,
      watchlistCount: groups.watchlist.length,
      profitableRootCount: rootIntelligence.profitableRoots.length,
      toxicRootCount: rootIntelligence.toxicRoots.length,
      mixedRootCount: rootIntelligence.mixedRoots.length,
      protectedRootCount: rootIntelligence.protectedRoots.length,
      exactNegativeCandidateCount: candidates.filter((item) => item.candidateType === CANDIDATE_TYPES.exactNegative).length,
      phraseNegativeReviewCandidateCount: candidates.filter((item) => item.candidateType === CANDIDATE_TYPES.phraseNegativeReview).length,
      harvestCandidateCount: candidates.filter((item) => item.candidateType === CANDIDATE_TYPES.harvest).length,
      scaleCandidateCount: candidates.filter((item) => item.candidateType === CANDIDATE_TYPES.scale).length,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    groups,
    rootIntelligence,
    candidates: Object.freeze(candidates),
  });
}

function aggregateFactsByTerm(facts) {
  const rows = new Map();
  for (const fact of facts) {
    const searchTerm = normalizeSearchTerm(fact?.normalizedSearchTerm || fact?.searchTerm);
    if (!searchTerm) continue;
    let row = rows.get(searchTerm);
    if (!row) {
      row = {
        searchTerm,
        variants: new Set(),
        sourceImportIds: new Set(),
        impressions: 0,
        clicks: 0,
        orders: 0,
        unitsSold: 0,
        spendMicros: 0,
        salesMicros: 0,
      };
      rows.set(searchTerm, row);
    }
    if (cleanText(fact?.searchTerm)) row.variants.add(cleanText(fact.searchTerm));
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
      observedVariants: Object.freeze([...row.variants].sort()),
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

function buildRootIntelligence(base) {
  const byRoot = new Map();
  for (const root of [...base.profitableRoots, ...base.toxicRoots, ...base.protectedRoots]) {
    const current = byRoot.get(root.root);
    if (!current) byRoot.set(root.root, root);
    else if (root.profitProtectionApplied && !current.profitProtectionApplied) byRoot.set(root.root, root);
  }

  return [...byRoot.values()].map((root) => {
    const states = [];
    if (root.classification === 'profitable') states.push(ROOT_INTELLIGENCE_STATES.profitable);
    if (root.classification === 'toxic') states.push(ROOT_INTELLIGENCE_STATES.toxic);
    if (root.profitTermCount > 0 && root.wasteTermCount > 0) states.push(ROOT_INTELLIGENCE_STATES.mixed);
    if (root.profitProtectionApplied) states.push(ROOT_INTELLIGENCE_STATES.protected);
    return Object.freeze({
      root: root.root,
      termCount: root.termCount,
      profitTermCount: root.profitTermCount,
      wasteTermCount: root.wasteTermCount,
      searchTerms: root.searchTerms,
      states: Object.freeze(states),
      primaryState: primaryRootState(states),
      priorityScore: root.priorityScore,
      metrics: root.metrics,
      profitProtectionApplied: Boolean(root.profitProtectionApplied),
    });
  }).sort((left, right) => right.priorityScore - left.priorityScore || left.root.localeCompare(right.root));
}

function buildRootStatesByTerm(roots) {
  const map = new Map();
  for (const root of roots) {
    for (const term of root.searchTerms || []) {
      const current = map.get(term) || new Set();
      for (const state of root.states) current.add(state);
      map.set(term, current);
    }
  }
  for (const [term, states] of map) map.set(term, Object.freeze([...states].sort()));
  return map;
}

function candidateRecord({ candidateType, actionType, matchScope, value, priorityScore, metrics, analysisWindow, rootStates, identityConfidence, sourceImportIds, reason }) {
  return Object.freeze({
    candidateType,
    actionType,
    matchScope,
    value,
    priorityScore: finiteNumber(priorityScore, 0),
    requiresHumanReview: true,
    persistenceAuthorized: false,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
    evidence: Object.freeze({
      spendMicros: nonNegative(metrics?.spendMicros ?? metrics?.costMicros),
      salesMicros: nonNegative(metrics?.salesMicros),
      orders: nonNegative(metrics?.orders ?? metrics?.purchases),
      clicks: nonNegative(metrics?.clicks),
      acos: nullableNumber(metrics?.acos),
      cvr: nullableNumber(metrics?.cvr),
      analysisWindow,
      rootStates: Object.freeze([...(rootStates || [])]),
      identityConfidence,
      sourceImportIds: Object.freeze([...(sourceImportIds || [])]),
      reason,
    }),
  });
}

function normalizeProductizationRules(value) {
  return Object.freeze({
    scale: Object.freeze({
      minPriorityScore: boundedNumber(value?.scale?.minPriorityScore, DEFAULT_PRODUCTIZATION_RULES.scale.minPriorityScore, 0, 100),
      minOrders: positiveInt(value?.scale?.minOrders, DEFAULT_PRODUCTIZATION_RULES.scale.minOrders),
      minClicks: positiveInt(value?.scale?.minClicks, DEFAULT_PRODUCTIZATION_RULES.scale.minClicks),
    }),
  });
}

function normalizeIdentityConfidence(value) {
  if (value && typeof value === 'object') {
    return Object.freeze({
      state: cleanText(value.state) || 'observed_csv_only',
      score: nullableNumber(value.score),
      canonicalAmazonIdentityResolved: false,
    });
  }
  return Object.freeze({
    state: cleanText(value) || 'observed_csv_only',
    score: null,
    canonicalAmazonIdentityResolved: false,
  });
}

function normalizeAnalysisWindow(value) {
  const startDate = cleanDate(value?.startDate);
  const endDate = cleanDate(value?.endDate);
  if (!startDate && !endDate) return null;
  if (!startDate || !endDate || startDate > endDate) throw businessError('CSV_SEARCH_TERM_BUSINESS_ANALYSIS_WINDOW_INVALID');
  return Object.freeze({ startDate, endDate });
}

function deriveAnalysisWindow(facts) {
  const dates = facts.map((fact) => cleanDate(fact?.reportDate)).filter(Boolean).sort();
  if (!dates.length) return Object.freeze({ startDate: null, endDate: null });
  return Object.freeze({ startDate: dates[0], endDate: dates[dates.length - 1] });
}

function primaryRootState(states) {
  if (states.includes(ROOT_INTELLIGENCE_STATES.toxic)) return ROOT_INTELLIGENCE_STATES.toxic;
  if (states.includes(ROOT_INTELLIGENCE_STATES.protected)) return ROOT_INTELLIGENCE_STATES.protected;
  if (states.includes(ROOT_INTELLIGENCE_STATES.mixed)) return ROOT_INTELLIGENCE_STATES.mixed;
  if (states.includes(ROOT_INTELLIGENCE_STATES.profitable)) return ROOT_INTELLIGENCE_STATES.profitable;
  return null;
}

function classificationReason(classification) {
  return {
    profitWinner: 'Profitable converting term that meets the configured profit threshold but is below the scale-opportunity evidence threshold.',
    scaleOpportunity: 'Profitable converting term with sufficient priority, order, and click evidence for a human-reviewed scale decision.',
    wasteTerm: 'Term crossed the configured waste threshold and should enter negative-keyword review.',
    watchlist: 'Term does not yet meet a profit, scale, or waste decision threshold and remains observational.',
  }[classification];
}

function compareBusinessTerm(left, right) {
  const rank = { wasteTerm: 0, scaleOpportunity: 1, profitWinner: 2, watchlist: 3 };
  return (rank[left.classification] - rank[right.classification])
    || (right.priorityScore - left.priorityScore)
    || left.searchTerm.localeCompare(right.searchTerm);
}

function compareCandidate(left, right) {
  const rank = {
    [CANDIDATE_TYPES.exactNegative]: 0,
    [CANDIDATE_TYPES.phraseNegativeReview]: 1,
    [CANDIDATE_TYPES.scale]: 2,
    [CANDIDATE_TYPES.harvest]: 3,
  };
  return (rank[left.candidateType] - rank[right.candidateType])
    || (right.priorityScore - left.priorityScore)
    || left.value.localeCompare(right.value);
}

function normalizeSearchTerm(value) { return cleanText(value).toLowerCase().replace(/\s+/gu, ' '); }
function cleanText(value) { return String(value ?? '').trim(); }
function nonNegative(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; }
function finiteNumber(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function nullableNumber(value) { const number = Number(value); return value == null || !Number.isFinite(number) ? null : number; }
function positiveInt(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
function boundedNumber(value, fallback, min, max) { const number = Number(value); return Number.isFinite(number) && number >= min && number <= max ? number : fallback; }
function cleanDate(value) { const text = cleanText(value); return /^\d{4}-\d{2}-\d{2}$/u.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00.000Z`)) ? text : null; }
function businessError(code) { const error = new Error(code); error.name = 'CsvSearchTermBusinessIntelligenceError'; error.code = code; return error; }
