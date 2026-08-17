export const SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION = 'search-term-intelligence-v1';
export const SEARCH_TERM_MODEL_VERSION = 'search-term-preview-model-v1';
export const SEARCH_TERM_RULE_VERSION = 'search-term-rules-v1';

export const DEFAULT_SEARCH_TERM_RULES = Object.freeze({
  waste: Object.freeze({
    minClicks: 8,
    minSpendMicros: 1_000_000,
    maxPurchases: 0,
  }),
  harvest: Object.freeze({
    minClicks: 3,
    minPurchases: 2,
    maxAcos: 0.35,
  }),
});

export function deriveSearchTermMetrics(input = {}) {
  const impressions = nonNegative(input.impressions);
  const clicks = nonNegative(input.clicks);
  const purchases = nonNegative(input.purchases);
  const unitsSold = nonNegative(input.unitsSold);
  const costMicros = nonNegative(input.costMicros);
  const salesMicros = nonNegative(input.salesMicros);

  return Object.freeze({
    impressions,
    clicks,
    purchases,
    orders: purchases,
    unitsSold,
    costMicros,
    spendMicros: costMicros,
    salesMicros,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpcMicros: clicks > 0 ? costMicros / clicks : null,
    cvr: clicks > 0 ? purchases / clicks : null,
    acos: salesMicros > 0 ? costMicros / salesMicros : null,
    roas: costMicros > 0 ? salesMicros / costMicros : null,
  });
}

export function buildRecommendationAuthority({ env = {}, profileId = '', lineageValid = false } = {}) {
  const appEnv = text(env.APP_ENV).toLowerCase() || 'unknown';
  const authorityFlag = text(env.RECOMMENDATION_AUTHORITY_ENABLED).toLowerCase() === 'true';
  const profile = text(profileId);
  const syntheticProfile = /(^|[-_])(synth|synthetic|fixture|preview|dev)([-_]|$)/i.test(profile);
  const reasons = [];

  if (appEnv !== 'production') reasons.push('non_production_environment');
  if (!authorityFlag) reasons.push('recommendation_authority_disabled');
  if (!profile) reasons.push('profile_scope_required');
  if (syntheticProfile) reasons.push('synthetic_or_development_profile');
  if (!lineageValid) reasons.push('provenance_not_authoritative');

  const authoritative = appEnv === 'production'
    && authorityFlag
    && Boolean(profile)
    && !syntheticProfile
    && lineageValid;

  return Object.freeze({
    authoritative,
    mode: authoritative ? 'authoritative' : (appEnv === 'development' ? 'development_preview' : 'non_authoritative'),
    label: authoritative ? 'authoritative' : 'non-authoritative',
    reasons: Object.freeze(reasons),
    amazonMutationAuthorized: false,
  });
}

export function evaluateSearchTermDecision({ metrics, evidence, rules = DEFAULT_SEARCH_TERM_RULES } = {}) {
  const normalizedMetrics = deriveSearchTermMetrics(metrics);
  const normalizedEvidence = normalizeEvidence(evidence);
  const waste = scoreWaste(normalizedMetrics, rules.waste || DEFAULT_SEARCH_TERM_RULES.waste);
  const harvest = scoreHarvest(normalizedMetrics, rules.harvest || DEFAULT_SEARCH_TERM_RULES.harvest);
  const confidence = scoreConfidence(normalizedMetrics, normalizedEvidence);

  const recommendation = waste.eligible
    ? Object.freeze({
        family: 'waste',
        actionType: 'negative_keyword.create',
        score: waste.score,
        rationaleCode: waste.rationaleCode,
      })
    : harvest.eligible
      ? Object.freeze({
          family: 'harvest',
          actionType: 'keyword.create',
          score: harvest.score,
          rationaleCode: harvest.rationaleCode,
        })
      : null;

  return Object.freeze({
    metrics: normalizedMetrics,
    evidence: normalizedEvidence,
    confidence,
    scores: Object.freeze({ waste, harvest }),
    recommendation,
  });
}

export async function buildRecommendationPreview({
  storeId,
  profileId,
  analysisWindow,
  entity,
  metrics,
  evidence,
  env = {},
  rules = DEFAULT_SEARCH_TERM_RULES,
} = {}) {
  const decision = evaluateSearchTermDecision({ metrics, evidence, rules });
  const authority = buildRecommendationAuthority({
    env,
    profileId,
    lineageValid: decision.evidence.lineageValid,
  });

  if (!decision.recommendation) {
    return Object.freeze({
      schemaVersion: SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
      modelVersion: SEARCH_TERM_MODEL_VERSION,
      ruleVersion: SEARCH_TERM_RULE_VERSION,
      authority,
      decision,
      recommendation: null,
      fingerprint: null,
    });
  }

  const target = buildActionTarget(decision.recommendation, entity);
  const fingerprintInput = {
    schemaVersion: SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
    modelVersion: SEARCH_TERM_MODEL_VERSION,
    ruleVersion: SEARCH_TERM_RULE_VERSION,
    storeId: text(storeId),
    profileId: text(profileId),
    entityType: 'search_term',
    entityId: text(entity?.entityId || entity?.normalizedSearchTerm || entity?.searchTerm),
    actionType: decision.recommendation.actionType,
    before: target.before,
    proposed: target.proposed,
    analysisWindow: normalizeWindow(analysisWindow),
    sourceFactIdentity: decision.evidence.sourceFactIdentity,
  };
  const fingerprint = await deterministicFingerprint(fingerprintInput);

  return Object.freeze({
    schemaVersion: SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
    modelVersion: SEARCH_TERM_MODEL_VERSION,
    ruleVersion: SEARCH_TERM_RULE_VERSION,
    authority,
    decision,
    fingerprint,
    recommendation: Object.freeze({
      ...decision.recommendation,
      entityType: 'search_term',
      entityId: fingerprintInput.entityId,
      before: target.before,
      proposed: target.proposed,
      explanation: buildExplanation(decision),
      persistenceAuthorized: authority.authoritative,
      executionAuthorized: false,
    }),
  });
}

export async function deterministicFingerprint(value) {
  const canonical = canonicalJson(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return bytesToHex(new Uint8Array(digest));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function scoreWaste(metrics, rule) {
  const minClicks = positiveInt(rule.minClicks, 8);
  const minSpendMicros = positiveInt(rule.minSpendMicros, 1_000_000);
  const maxPurchases = nonNegative(rule.maxPurchases);
  const eligible = metrics.clicks >= minClicks
    && metrics.costMicros >= minSpendMicros
    && metrics.purchases <= maxPurchases;
  const clickPressure = Math.min(1, metrics.clicks / Math.max(minClicks * 2, 1));
  const spendPressure = Math.min(1, metrics.costMicros / Math.max(minSpendMicros * 2, 1));
  const zeroOrderPressure = metrics.purchases === 0 ? 1 : 0;
  return Object.freeze({
    eligible,
    score: round2(100 * (0.35 * clickPressure + 0.45 * spendPressure + 0.20 * zeroOrderPressure)),
    rationaleCode: eligible ? 'spend_without_orders' : 'waste_threshold_not_met',
    thresholds: Object.freeze({ minClicks, minSpendMicros, maxPurchases }),
  });
}

function scoreHarvest(metrics, rule) {
  const minClicks = positiveInt(rule.minClicks, 3);
  const minPurchases = positiveInt(rule.minPurchases, 2);
  const maxAcos = positiveNumber(rule.maxAcos, 0.35);
  const acosEligible = metrics.acos !== null && metrics.acos <= maxAcos;
  const eligible = metrics.clicks >= minClicks && metrics.purchases >= minPurchases && acosEligible;
  const orderPressure = Math.min(1, metrics.purchases / Math.max(minPurchases * 2, 1));
  const conversionPressure = Math.min(1, (metrics.cvr || 0) / 0.2);
  const efficiencyPressure = metrics.acos === null ? 0 : Math.min(1, maxAcos / Math.max(metrics.acos, 0.01));
  return Object.freeze({
    eligible,
    score: round2(100 * (0.4 * orderPressure + 0.3 * conversionPressure + 0.3 * efficiencyPressure)),
    rationaleCode: eligible ? 'converting_search_term' : 'harvest_threshold_not_met',
    thresholds: Object.freeze({ minClicks, minPurchases, maxAcos }),
  });
}

function scoreConfidence(metrics, evidence) {
  const sample = 0.45 * Math.min(1, metrics.clicks / 20)
    + 0.30 * Math.min(1, metrics.purchases / 5)
    + 0.25 * Math.min(1, metrics.impressions / 500);
  const lineageFactor = evidence.lineageValid ? 1 : 0.35;
  const score = round4(sample * lineageFactor);
  return Object.freeze({
    score,
    band: score >= 0.75 ? 'high' : (score >= 0.45 ? 'medium' : 'low'),
    sampleScore: round4(sample),
    lineageFactor,
  });
}

function normalizeEvidence(evidence = {}) {
  const sourceReportJobIds = uniqueTexts(evidence.sourceReportJobIds);
  const amazonReportIds = uniqueTexts(evidence.amazonReportIds);
  const r2ObjectKeys = uniqueTexts(evidence.r2ObjectKeys);
  const contentSha256s = uniqueTexts(evidence.contentSha256s).map((value) => value.toLowerCase());
  const invalidDigest = contentSha256s.some((value) => !/^[a-f0-9]{64}$/.test(value));
  const factRowCount = nonNegative(evidence.factRowCount);
  const invalidLineageCount = nonNegative(evidence.invalidLineageCount);
  const lineageValid = Boolean(evidence.lineageValid)
    && factRowCount > 0
    && invalidLineageCount === 0
    && sourceReportJobIds.length > 0
    && amazonReportIds.length > 0
    && r2ObjectKeys.length > 0
    && contentSha256s.length > 0
    && !invalidDigest;

  return Object.freeze({
    lineageValid,
    factRowCount,
    invalidLineageCount,
    sourceReportJobIds: Object.freeze(sourceReportJobIds),
    amazonReportIds: Object.freeze(amazonReportIds),
    r2ObjectKeys: Object.freeze(r2ObjectKeys),
    contentSha256s: Object.freeze(contentSha256s),
    sourceFactIdentity: Object.freeze({
      sourceReportJobIds: Object.freeze(sourceReportJobIds),
      amazonReportIds: Object.freeze(amazonReportIds),
      r2ObjectKeys: Object.freeze(r2ObjectKeys),
      contentSha256s: Object.freeze(contentSha256s),
    }),
  });
}

function buildActionTarget(recommendation, entity = {}) {
  const searchTerm = text(entity.searchTerm || entity.normalizedSearchTerm);
  if (recommendation.family === 'waste') {
    return {
      before: Object.freeze({ negativeKeywordExists: false }),
      proposed: Object.freeze({ keywordText: searchTerm, matchType: 'EXACT' }),
    };
  }
  return {
    before: Object.freeze({ harvestedKeywordExists: false }),
    proposed: Object.freeze({ keywordText: searchTerm, matchType: 'EXACT', bidMicros: null }),
  };
}

function buildExplanation(decision) {
  const metrics = decision.metrics;
  const recommendation = decision.recommendation;
  if (!recommendation) return null;
  return Object.freeze({
    code: recommendation.rationaleCode,
    summary: recommendation.family === 'waste'
      ? 'Search term crossed the preview waste thresholds without enough order evidence.'
      : 'Search term crossed the preview harvest thresholds with conversion and efficiency evidence.',
    metrics: Object.freeze({
      impressions: metrics.impressions,
      clicks: metrics.clicks,
      orders: metrics.orders,
      spendMicros: metrics.spendMicros,
      salesMicros: metrics.salesMicros,
      acos: metrics.acos,
      roas: metrics.roas,
      cvr: metrics.cvr,
      cpcMicros: metrics.cpcMicros,
    }),
    confidence: decision.confidence,
  });
}

function normalizeWindow(value = {}) {
  return Object.freeze({
    startDate: text(value.startDate),
    endDate: text(value.endDate),
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      const child = value[key];
      if (child !== undefined) acc[key] = canonicalize(child);
      return acc;
    }, {});
  }
  return value;
}

function uniqueTexts(values) {
  const source = Array.isArray(values) ? values : String(values || '').split(',');
  return [...new Set(source.map(text).filter(Boolean))].sort();
}
function text(value) { return String(value ?? '').trim(); }
function nonNegative(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function round2(value) { return Math.round(value * 100) / 100; }
function round4(value) { return Math.round(value * 10000) / 10000; }
function bytesToHex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(''); }
