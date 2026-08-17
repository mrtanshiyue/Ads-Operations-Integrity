export const SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION = 'search-term-intelligence-v1';
export const SEARCH_TERM_MODEL_VERSION = 'search-term-preview-model-v3';
export const SEARCH_TERM_RULE_VERSION = 'search-term-rules-v2';

export const DEFAULT_SEARCH_TERM_RULES = Object.freeze({
  quality: Object.freeze({
    minImpressions: 50,
    minClicks: 3,
    minSpendMicros: 500_000,
    minConfidenceScore: 0.30,
    suppressStale: true,
    suppressInvalidLineage: true,
    harvestDeteriorationOrdersPct: -0.50,
    harvestDeteriorationAcosPp: 10,
  }),
  observation: Object.freeze({
    highAcos: 0.60,
    highAcosMinClicks: 8,
    highAcosMinSpendMicros: 1_000_000,
    lowConversionCvr: 0.05,
    lowConversionMinClicks: 12,
  }),
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

export function evaluateSearchTermDecision({ metrics, evidence, freshness, trend = null, rules = DEFAULT_SEARCH_TERM_RULES } = {}) {
  const normalizedMetrics = deriveSearchTermMetrics(metrics);
  const normalizedEvidence = normalizeEvidence(evidence);
  const normalizedFreshness = normalizeFreshness(freshness);
  const waste = scoreWaste(normalizedMetrics, rules.waste || DEFAULT_SEARCH_TERM_RULES.waste);
  const harvest = scoreHarvest(normalizedMetrics, rules.harvest || DEFAULT_SEARCH_TERM_RULES.harvest);
  const confidence = scoreConfidence(normalizedMetrics, normalizedEvidence, normalizedFreshness);

  const candidate = waste.eligible
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

  const quality = evaluateRecommendationQuality({
    candidate,
    metrics: normalizedMetrics,
    evidence: normalizedEvidence,
    freshness: normalizedFreshness,
    confidence,
    trend,
    rule: rules.quality || DEFAULT_SEARCH_TERM_RULES.quality,
    observationRule: rules.observation || DEFAULT_SEARCH_TERM_RULES.observation,
  });
  const recommendation = quality.suppression ? null : candidate;

  return Object.freeze({
    metrics: normalizedMetrics,
    evidence: normalizedEvidence,
    freshness: normalizedFreshness,
    confidence,
    scores: Object.freeze({ waste, harvest }),
    quality,
    suppression: quality.suppression,
    observation: quality.observation,
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
  freshness,
  trend = null,
  env = {},
  rules = DEFAULT_SEARCH_TERM_RULES,
} = {}) {
  const decision = evaluateSearchTermDecision({ metrics, evidence, freshness, trend, rules });
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
      trend: freezeObject(trend),
      recommendation: null,
      fingerprint: null,
      suppression: decision.suppression,
      observation: decision.observation,
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
    trend: freezeObject(trend),
    fingerprint,
    suppression: null,
    observation: decision.observation,
    recommendation: Object.freeze({
      ...decision.recommendation,
      entityType: 'search_term',
      entityId: fingerprintInput.entityId,
      before: target.before,
      proposed: target.proposed,
      explanation: buildExplanation(decision, trend),
      persistenceAuthorized: authority.authoritative,
      governancePersistenceAllowed: true,
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

function scoreConfidence(metrics, evidence, freshness) {
  const sample = 0.45 * Math.min(1, metrics.clicks / 20)
    + 0.30 * Math.min(1, metrics.purchases / 5)
    + 0.25 * Math.min(1, metrics.impressions / 500);
  const lineageFactor = evidence.lineageValid ? 1 : 0.35;
  const freshnessFactor = freshness.confidenceFactor;
  const score = round4(sample * lineageFactor * freshnessFactor);
  return Object.freeze({
    score,
    band: score >= 0.75 ? 'high' : (score >= 0.45 ? 'medium' : 'low'),
    sampleScore: round4(sample),
    lineageFactor,
    freshnessFactor,
  });
}

function evaluateRecommendationQuality({ candidate, metrics, evidence, freshness, confidence, trend, rule, observationRule }) {
  const minImpressions = positiveInt(rule.minImpressions, 50);
  const minClicks = positiveInt(rule.minClicks, 3);
  const minSpendMicros = positiveInt(rule.minSpendMicros, 500_000);
  const minConfidenceScore = boundedNumber(rule.minConfidenceScore, 0.30, 0, 1);
  const suppressStale = rule.suppressStale !== false;
  const suppressInvalidLineage = rule.suppressInvalidLineage !== false;
  const harvestDeteriorationOrdersPct = boundedNumber(rule.harvestDeteriorationOrdersPct, -0.50, -1, 0);
  const harvestDeteriorationAcosPp = positiveNumber(rule.harvestDeteriorationAcosPp, 10);
  const trendSignal = classifyTrendSignal(trend);
  let suppression = null;

  if (candidate) {
    if (suppressInvalidLineage && !evidence.lineageValid) {
      suppression = qualitySuppression('invalid_lineage', 'Recommendation suppressed because source lineage is not authoritative enough for governance.', 'provenance');
    } else if (suppressStale && freshness.state === 'stale') {
      suppression = qualitySuppression('stale_data', 'Recommendation suppressed because the latest report date is stale.', 'freshness');
    } else if (metrics.impressions < minImpressions || metrics.clicks < minClicks || metrics.spendMicros < minSpendMicros) {
      suppression = qualitySuppression('insufficient_sample', 'Recommendation suppressed because the minimum sample or spend threshold is not met.', 'sample');
    } else if (confidence.score < minConfidenceScore) {
      suppression = qualitySuppression('low_confidence', 'Recommendation suppressed because confidence is below the governance threshold.', 'confidence');
    } else if (
      candidate.family === 'harvest'
      && finiteNumber(trend?.delta?.ordersPct) !== null
      && finiteNumber(trend?.delta?.acosPp) !== null
      && Number(trend.delta.ordersPct) <= harvestDeteriorationOrdersPct
      && Number(trend.delta.acosPp) >= harvestDeteriorationAcosPp
    ) {
      suppression = qualitySuppression('trend_deterioration', 'Harvest recommendation suppressed because conversion volume deteriorated while ACoS worsened materially.', 'trend');
    }
  }

  const observation = classifyObservation({ candidate, suppression, metrics, trendSignal, rule: observationRule });
  return Object.freeze({
    eligibleForGovernance: Boolean(candidate) && !suppression,
    suppression,
    observation,
    trendSignal,
    thresholds: Object.freeze({
      minImpressions,
      minClicks,
      minSpendMicros,
      minConfidenceScore,
      suppressStale,
      suppressInvalidLineage,
      harvestDeteriorationOrdersPct,
      harvestDeteriorationAcosPp,
    }),
  });
}

function classifyObservation({ candidate, suppression, metrics, trendSignal, rule }) {
  if (suppression) {
    return Object.freeze({ code: suppression.code, severity: suppression.code === 'stale_data' ? 'warning' : 'info', trendSignal });
  }
  if (candidate) return Object.freeze({ code: 'candidate_ready', severity: 'actionable', trendSignal });

  const highAcos = positiveNumber(rule.highAcos, 0.60);
  const highAcosMinClicks = positiveInt(rule.highAcosMinClicks, 8);
  const highAcosMinSpendMicros = positiveInt(rule.highAcosMinSpendMicros, 1_000_000);
  const lowConversionCvr = positiveNumber(rule.lowConversionCvr, 0.05);
  const lowConversionMinClicks = positiveInt(rule.lowConversionMinClicks, 12);

  if (
    metrics.purchases > 0
    && metrics.clicks >= highAcosMinClicks
    && metrics.spendMicros >= highAcosMinSpendMicros
    && metrics.acos !== null
    && metrics.acos > highAcos
  ) {
    return Object.freeze({
      code: 'high_acos_observe',
      severity: 'warning',
      trendSignal,
      reason: 'High ACoS is observable but does not map to an automatic governance action in the current non-executable contract.',
    });
  }
  if (metrics.purchases > 0 && metrics.clicks >= lowConversionMinClicks && metrics.cvr !== null && metrics.cvr < lowConversionCvr) {
    return Object.freeze({
      code: 'low_conversion_observe',
      severity: 'warning',
      trendSignal,
      reason: 'Low conversion is observable but requires operator analysis rather than an automatic action proposal.',
    });
  }
  if (metrics.impressions < 50 || metrics.clicks < 3 || metrics.spendMicros < 500_000) {
    return Object.freeze({ code: 'insufficient_data', severity: 'info', trendSignal });
  }
  return Object.freeze({ code: 'threshold_not_met', severity: 'info', trendSignal });
}

function classifyTrendSignal(trend) {
  const delta = trend?.delta || {};
  const ordersPct = finiteNumber(delta.ordersPct);
  const acosPp = finiteNumber(delta.acosPp);
  const cvrPp = finiteNumber(delta.cvrPp);
  if (ordersPct === null && acosPp === null && cvrPp === null) return 'unknown';
  if ((ordersPct !== null && ordersPct <= -0.30) || (acosPp !== null && acosPp >= 10) || (cvrPp !== null && cvrPp <= -2)) return 'deteriorating';
  if ((ordersPct !== null && ordersPct >= 0.25) || (acosPp !== null && acosPp <= -10) || (cvrPp !== null && cvrPp >= 2)) return 'recovering';
  return 'stable';
}

function qualitySuppression(code, reason, dimension) {
  return Object.freeze({ code, reason, dimension, governancePersistenceAllowed: false });
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
    latestReportDate: isoDate(evidence.latestReportDate),
    factUpdatedAt: nullableText(evidence.factUpdatedAt),
    sourceFactIdentity: Object.freeze({
      sourceReportJobIds: Object.freeze(sourceReportJobIds),
      amazonReportIds: Object.freeze(amazonReportIds),
      r2ObjectKeys: Object.freeze(r2ObjectKeys),
      contentSha256s: Object.freeze(contentSha256s),
    }),
  });
}

function normalizeFreshness(value = {}) {
  const allowed = new Set(['fresh', 'aging', 'stale', 'unknown']);
  const stateCandidate = text(value.state).toLowerCase();
  const state = allowed.has(stateCandidate) ? stateCandidate : 'unknown';
  const defaultFactor = {
    fresh: 1,
    aging: 0.8,
    stale: 0.5,
    unknown: 0.65,
  }[state];
  const suppliedFactor = Number(value.confidenceFactor);
  const confidenceFactor = Number.isFinite(suppliedFactor)
    ? Math.max(0.25, Math.min(1, suppliedFactor))
    : defaultFactor;
  return Object.freeze({
    state,
    latestReportDate: isoDate(value.latestReportDate),
    factUpdatedAt: nullableText(value.factUpdatedAt),
    profileSyncedAt: nullableText(value.profileSyncedAt),
    ageDays: finiteNonNegativeOrNull(value.ageDays),
    confidenceFactor: round4(confidenceFactor),
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

function buildExplanation(decision, trend) {
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
    freshness: decision.freshness,
    quality: decision.quality,
    trend: freezeObject(trend),
  });
}

function normalizeWindow(value = {}) {
  const startDate = text(value.startDate);
  const endDate = text(value.endDate);
  const validDates = /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    && /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    && endDate >= startDate;
  const days = validDates
    ? Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1
    : null;
  return Object.freeze({ startDate, endDate, days });
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
function nullableText(value) { const out = text(value); return out || null; }
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
function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function finiteNonNegativeOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function isoDate(value) {
  const out = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
}
function freezeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value || null;
  return Object.freeze({ ...value });
}
function round2(value) { return Math.round(value * 100) / 100; }
function round4(value) { return Math.round(value * 10000) / 10000; }
function bytesToHex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(''); }
