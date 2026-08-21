export const CSV_RECOMMENDATION_INBOX_SCHEMA_VERSION = 'csv-recommendation-inbox-v1';

const NON_EXECUTABLE_AUTHORITY = Object.freeze({
  sourceKind: 'csv_import',
  authoritative: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
  canonicalAmazonIdentityResolved: false,
});

const REVIEW_WORKFLOW = Object.freeze({
  kind: 'human_review_only',
  initialState: 'unreviewed',
  persistenceAuthorized: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
  futurePersistenceContract: Object.freeze({
    actionEntity: 'optimization_actions',
    eventEntity: 'optimization_action_events',
    enabled: false,
  }),
});

export function buildCsvRecommendationInbox({ businessIntelligence, historicalIntelligence, analysisScope } = {}) {
  const business = businessIntelligence && typeof businessIntelligence === 'object' ? businessIntelligence : {};
  const historical = historicalIntelligence && typeof historicalIntelligence === 'object' ? historicalIntelligence : {};
  const scope = analysisScope && typeof analysisScope === 'object' ? analysisScope : {};
  const candidates = Array.isArray(business.candidates) ? business.candidates : [];
  const roots = Array.isArray(business.rootIntelligence?.roots) ? business.rootIntelligence.roots : [];
  const lifecycleItems = Array.isArray(historical.lifecycle?.items) ? historical.lifecycle.items : [];
  const termItems = businessTermItems(business.groups);
  const termMap = new Map(termItems.map((item) => [normalizeTerm(item.searchTerm), item]));
  const lifecycleMap = new Map(lifecycleItems.map((item) => [normalizeTerm(item.searchTerm), item]));
  const rootMembership = buildRootMembership(roots);

  const items = candidates.map((candidate) => {
    const value = cleanText(candidate?.value);
    const normalizedValue = normalizeTerm(value);
    const phraseRoot = candidate?.matchScope === 'phrase_review'
      ? roots.find((root) => normalizeTerm(root?.root) === normalizedValue) || null
      : null;
    const impactedRoots = phraseRoot
      ? [phraseRoot]
      : (rootMembership.get(normalizedValue) || []);
    const impactedSearchTerms = phraseRoot
      ? uniqueTexts(phraseRoot.searchTerms)
      : (normalizedValue ? [normalizedValue] : []);
    const businessContext = impactedSearchTerms
      .map((term) => termMap.get(normalizeTerm(term)))
      .filter(Boolean)
      .map(compactBusinessContext);
    const lifecycleContext = impactedSearchTerms
      .map((term) => lifecycleMap.get(normalizeTerm(term)))
      .filter(Boolean)
      .map(compactLifecycleContext);
    const evidence = candidate?.evidence || {};

    return Object.freeze({
      inboxItemId: stableInboxId(candidate),
      itemClass: 'recommendation_candidate',
      candidateType: cleanText(candidate?.candidateType) || null,
      actionType: cleanText(candidate?.actionType) || null,
      matchScope: cleanText(candidate?.matchScope) || null,
      value: value || null,
      priority: priorityFromScore(candidate?.priorityScore),
      priorityScore: finiteNumber(candidate?.priorityScore, 0),
      reason: cleanText(evidence.reason) || null,
      impactedSearchTerms: Object.freeze(impactedSearchTerms),
      impactedRoots: Object.freeze(impactedRoots.map(compactRootContext)),
      businessContext: Object.freeze(businessContext),
      lifecycleContext: Object.freeze(lifecycleContext),
      evidenceSummary: Object.freeze({
        spendMicros: nonNegative(evidence.spendMicros),
        salesMicros: nonNegative(evidence.salesMicros),
        orders: nonNegative(evidence.orders),
        clicks: nonNegative(evidence.clicks),
        acos: nullableNumber(evidence.acos),
        cvr: nullableNumber(evidence.cvr),
        analysisWindow: normalizeWindow(evidence.analysisWindow),
        sourceImportIds: Object.freeze(uniqueTexts(evidence.sourceImportIds)),
        rootStates: Object.freeze(uniqueTexts(evidence.rootStates)),
        recommendationGoverned: evidence.recommendationGoverned === true,
        provenanceGate: cleanText(evidence.provenanceGate) || null,
        identityConfidence: compactIdentityConfidence(evidence.identityConfidence),
      }),
      review: Object.freeze({
        state: REVIEW_WORKFLOW.initialState,
        placeholder: true,
        humanReviewRequired: candidate?.requiresHumanReview !== false,
        persisted: false,
        persistenceAuthorized: false,
        futurePersistenceContract: REVIEW_WORKFLOW.futurePersistenceContract,
      }),
      authority: NON_EXECUTABLE_AUTHORITY,
    });
  }).sort(compareInboxItems);

  const businessSummary = business.summary || {};
  const rootSummary = summarizeRootStates(roots);
  const lifecycleCounts = normalizeCountMap(historical.lifecycle?.summary?.lifecycleCounts);
  const priorityCounts = Object.freeze(countBy(items, (item) => item.priority));
  const candidateTypeCounts = Object.freeze(countBy(items, (item) => item.candidateType || 'unknown'));

  return Object.freeze({
    schemaVersion: CSV_RECOMMENDATION_INBOX_SCHEMA_VERSION,
    authority: NON_EXECUTABLE_AUTHORITY,
    workflow: REVIEW_WORKFLOW,
    analysisScope: Object.freeze({
      complete: scope.complete === true,
      financiallyComparable: scope.financiallyComparable === true,
      candidateEmissionAuthorized: scope.candidateEmissionAuthorized === true,
      overflowObserved: scope.overflowObserved === true,
      reasons: Object.freeze(uniqueTexts(scope.reasons)),
    }),
    summary: Object.freeze({
      reviewCandidateCount: items.length,
      candidatePotentialCount: nonNegativeInt(businessSummary.candidatePotentialCount),
      blockedByGovernanceCount: nonNegativeInt(businessSummary.suppressedByGovernanceCandidateCount),
      blockedByScopeCount: nonNegativeInt(businessSummary.suppressedByScopeCandidateCount),
      priorityCounts,
      candidateTypeCounts,
      reviewStateCounts: Object.freeze({ unreviewed: items.length }),
      observationContext: Object.freeze({
        profitWinnerCount: nonNegativeInt(businessSummary.profitWinnerCount),
        scaleOpportunityCount: nonNegativeInt(businessSummary.scaleOpportunityCount),
        wasteTermCount: nonNegativeInt(businessSummary.wasteTermCount),
        watchlistCount: nonNegativeInt(businessSummary.watchlistCount),
        rootStateCounts: rootSummary,
        lifecycleCounts,
      }),
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    items: Object.freeze(items),
  });
}

function businessTermItems(groups) {
  const values = [
    ...(Array.isArray(groups?.profitWinners) ? groups.profitWinners : []),
    ...(Array.isArray(groups?.scaleOpportunities) ? groups.scaleOpportunities : []),
    ...(Array.isArray(groups?.wasteTerms) ? groups.wasteTerms : []),
    ...(Array.isArray(groups?.watchlist) ? groups.watchlist : []),
  ];
  const map = new Map();
  for (const item of values) {
    const term = normalizeTerm(item?.searchTerm);
    if (term && !map.has(term)) map.set(term, item);
  }
  return [...map.values()];
}

function buildRootMembership(roots) {
  const map = new Map();
  for (const root of roots) {
    for (const searchTerm of Array.isArray(root?.searchTerms) ? root.searchTerms : []) {
      const term = normalizeTerm(searchTerm);
      if (!term) continue;
      const current = map.get(term) || [];
      current.push(root);
      map.set(term, current);
    }
  }
  return map;
}

function compactBusinessContext(item) {
  return Object.freeze({
    searchTerm: normalizeTerm(item?.searchTerm) || null,
    classification: cleanText(item?.classification) || null,
    classificationLabel: cleanText(item?.classificationLabel) || null,
    priorityScore: finiteNumber(item?.priorityScore, 0),
    recommendationGoverned: item?.recommendationGoverned === true,
    reason: cleanText(item?.reason) || null,
  });
}

function compactRootContext(root) {
  return Object.freeze({
    root: cleanText(root?.root) || null,
    primaryState: cleanText(root?.primaryState) || null,
    states: Object.freeze(uniqueTexts(root?.states)),
    termCount: nonNegativeInt(root?.termCount),
    profitTermCount: nonNegativeInt(root?.profitTermCount),
    wasteTermCount: nonNegativeInt(root?.wasteTermCount),
    profitProtectionApplied: root?.profitProtectionApplied === true,
    recommendationGoverned: root?.recommendationGoverned === true,
  });
}

function compactLifecycleContext(item) {
  return Object.freeze({
    searchTerm: normalizeTerm(item?.searchTerm) || null,
    state: cleanText(item?.state) || null,
    stateLabel: cleanText(item?.stateLabel) || null,
    currentClassification: cleanText(item?.currentClassification) || null,
    previousClassification: cleanText(item?.previousClassification) || null,
    reason: cleanText(item?.reason) || null,
    change: Object.freeze({
      ordersPct: nullableNumber(item?.change?.ordersPct),
      salesPct: nullableNumber(item?.change?.salesPct),
      spendPct: nullableNumber(item?.change?.spendPct),
      acosDelta: nullableNumber(item?.change?.acosDelta),
      roasDelta: nullableNumber(item?.change?.roasDelta),
      cvrDelta: nullableNumber(item?.change?.cvrDelta),
    }),
  });
}

function compactIdentityConfidence(value) {
  return Object.freeze({
    state: cleanText(value?.state) || 'observed_csv_identity_unknown',
    score: nullableNumber(value?.score),
    canonicalAmazonIdentityResolved: false,
  });
}

function summarizeRootStates(roots) {
  const counts = { profitable: 0, toxic: 0, mixed: 0, protected: 0 };
  for (const root of roots) {
    for (const state of uniqueTexts(root?.states)) {
      if (Object.prototype.hasOwnProperty.call(counts, state)) counts[state] += 1;
    }
  }
  return Object.freeze(counts);
}

function normalizeCountMap(value) {
  const result = {};
  if (!value || typeof value !== 'object') return Object.freeze(result);
  for (const [key, count] of Object.entries(value)) result[key] = nonNegativeInt(count);
  return Object.freeze(result);
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = cleanText(keyOf(item)) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function stableInboxId(candidate) {
  const action = cleanText(candidate?.actionType) || 'review';
  const scope = cleanText(candidate?.matchScope) || 'scope';
  const value = normalizeTerm(candidate?.value) || 'unknown';
  return `csv-inbox:${action}:${scope}:${value}`;
}

function priorityFromScore(value) {
  const score = finiteNumber(value, 0);
  if (score >= 90) return 'critical';
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

function compareInboxItems(left, right) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return (rank[left.priority] ?? 4) - (rank[right.priority] ?? 4)
    || right.priorityScore - left.priorityScore
    || String(left.candidateType || '').localeCompare(String(right.candidateType || ''))
    || String(left.value || '').localeCompare(String(right.value || ''));
}

function normalizeWindow(value) {
  const startDate = cleanDate(value?.startDate);
  const endDate = cleanDate(value?.endDate);
  if (!startDate || !endDate || startDate > endDate) return null;
  return Object.freeze({ startDate, endDate });
}

function cleanDate(value) {
  const normalized = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) && !Number.isNaN(Date.parse(`${normalized}T00:00:00.000Z`))
    ? normalized
    : null;
}

function uniqueTexts(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(cleanText).filter(Boolean))].sort();
}

function normalizeTerm(value) {
  return cleanText(value).toLowerCase().replace(/\s+/gu, ' ');
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
