import { deriveSearchTermMetrics } from './decision-intelligence.js';

export const CSV_HIERARCHY_ANALYSIS_SCHEMA_VERSION = 'csv-hierarchy-profitability-v1';

const DEFAULT_TARGET_ACOS = 0.35;
const NON_AUTHORITY = Object.freeze({
  mode: 'csv_hierarchy_observation_only',
  authoritative: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function analyzeCsvHierarchyProfitability(facts, options = {}) {
  if (!Array.isArray(facts)) throw hierarchyError('CSV_HIERARCHY_FACTS_REQUIRED');
  const targetAcos = boundedPositive(options.targetAcos, DEFAULT_TARGET_ACOS);
  const reliability = deriveReliability(options.dataQuality);
  const indexes = buildIdentityIndexes(facts);
  const campaigns = new Map();
  const adGroups = new Map();
  const targetings = new Map();

  for (const fact of facts) {
    const campaign = observedIdentityPart(fact?.campaignId, fact?.campaignName, 'campaign');
    const adGroup = observedIdentityPart(fact?.adGroupId, fact?.adGroupName, 'ad_group');
    const targeting = observedTargetingPart(fact);
    const campaignKey = `campaign:${campaign.key}`;
    const adGroupKey = `${campaignKey}/ad_group:${adGroup.key}`;
    const targetingKey = `${adGroupKey}/targeting:${targeting.key}`;

    addFact(campaigns, campaignKey, 'campaign', fact, {
      campaign,
      adGroup: null,
      targeting: null,
    });
    addFact(adGroups, adGroupKey, 'ad_group', fact, {
      campaign,
      adGroup,
      targeting: null,
    });
    addFact(targetings, targetingKey, 'targeting', fact, {
      campaign,
      adGroup,
      targeting,
    });
  }

  const campaignRows = finalizeRows(campaigns, targetAcos, reliability, indexes);
  const adGroupRows = finalizeRows(adGroups, targetAcos, reliability, indexes);
  const targetingRows = finalizeRows(targetings, targetAcos, reliability, indexes);

  return Object.freeze({
    schemaVersion: CSV_HIERARCHY_ANALYSIS_SCHEMA_VERSION,
    authority: NON_AUTHORITY,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    targetAcos,
    reliability,
    summary: Object.freeze({
      factCount: facts.length,
      campaignCount: campaignRows.length,
      adGroupCount: adGroupRows.length,
      targetingCount: targetingRows.length,
      ambiguousCampaignCount: campaignRows.filter((item) => item.observedIdentity.ambiguous).length,
      ambiguousAdGroupCount: adGroupRows.filter((item) => item.observedIdentity.ambiguous).length,
      ambiguousTargetingCount: targetingRows.filter((item) => item.observedIdentity.ambiguous).length,
      aggregationSafe: reliability.aggregationSafe,
      periodComplete: reliability.periodComplete,
      canonicalAmazonIdentityResolved: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    campaigns: Object.freeze(campaignRows),
    adGroups: Object.freeze(adGroupRows),
    targetings: Object.freeze(targetingRows),
  });
}

function buildIdentityIndexes(facts) {
  const campaignNamesById = new Map();
  const adGroupNamesById = new Map();
  const adGroupParentsById = new Map();
  const targetingTextsById = new Map();
  const targetingParentsById = new Map();

  for (const fact of facts) {
    const campaignId = clean(fact?.campaignId);
    const campaignName = clean(fact?.campaignName);
    const adGroupId = clean(fact?.adGroupId);
    const adGroupName = clean(fact?.adGroupName);
    const targetingId = clean(fact?.targetingId);
    const targetingText = clean(fact?.targeting);
    const campaign = observedIdentityPart(campaignId, campaignName, 'campaign');
    const adGroup = observedIdentityPart(adGroupId, adGroupName, 'ad_group');
    const campaignKey = `campaign:${campaign.key}`;
    const adGroupKey = `${campaignKey}/ad_group:${adGroup.key}`;

    addIndexValue(campaignNamesById, campaignId, normalizeText(campaignName));
    addIndexValue(adGroupNamesById, adGroupId, normalizeText(adGroupName));
    addIndexValue(adGroupParentsById, adGroupId, campaignKey);
    addIndexValue(targetingTextsById, targetingId, normalizeText(targetingText));
    addIndexValue(targetingParentsById, targetingId, adGroupKey);
  }
  return { campaignNamesById, adGroupNamesById, adGroupParentsById, targetingTextsById, targetingParentsById };
}

function addFact(map, key, level, fact, identity) {
  let aggregate = map.get(key);
  if (!aggregate) {
    aggregate = {
      key,
      level,
      identity,
      variants: {
        campaignNames: new Set(),
        adGroupNames: new Set(),
        targetingTexts: new Set(),
        matchTypes: new Set(),
      },
      searchTerms: new Set(),
      sourceImportIds: new Set(),
      impressions: 0,
      clicks: 0,
      purchases: 0,
      unitsSold: 0,
      costMicros: 0,
      salesMicros: 0,
      factCount: 0,
    };
    map.set(key, aggregate);
  }
  aggregate.factCount += 1;
  addSet(aggregate.variants.campaignNames, fact?.campaignName);
  addSet(aggregate.variants.adGroupNames, fact?.adGroupName);
  addSet(aggregate.variants.targetingTexts, fact?.targeting);
  addSet(aggregate.variants.matchTypes, upper(fact?.matchType));
  addSet(aggregate.searchTerms, normalizeText(fact?.normalizedSearchTerm || fact?.searchTerm));
  addSet(aggregate.sourceImportIds, fact?.sourceImportId);
  aggregate.impressions += nonNegative(fact?.impressions);
  aggregate.clicks += nonNegative(fact?.clicks);
  aggregate.purchases += nonNegative(fact?.purchases);
  aggregate.unitsSold += nonNegative(fact?.unitsSold);
  aggregate.costMicros += nonNegative(fact?.costMicros ?? fact?.spendMicros);
  aggregate.salesMicros += nonNegative(fact?.salesMicros);
}

function finalizeRows(map, targetAcos, reliability, indexes) {
  return [...map.values()].map((aggregate) => {
    const metrics = deriveSearchTermMetrics(aggregate);
    const observedIdentity = identityQuality(aggregate, indexes);
    return Object.freeze({
      level: aggregate.level,
      observedKey: aggregate.key,
      identity: freezeIdentity(aggregate.identity),
      observedIdentity,
      performanceBand: performanceBand(metrics, targetAcos),
      targetAcos,
      acosDeltaToTarget: metrics.acos === null ? null : round4(metrics.acos - targetAcos),
      adContributionMicros: metrics.salesMicros - metrics.spendMicros,
      profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
      metrics,
      factCount: aggregate.factCount,
      searchTermCount: aggregate.searchTerms.size,
      sourceImportCount: aggregate.sourceImportIds.size,
      searchTerms: Object.freeze([...aggregate.searchTerms].sort()),
      sourceImportIds: Object.freeze([...aggregate.sourceImportIds].sort()),
      observedVariants: Object.freeze({
        campaignNames: Object.freeze([...aggregate.variants.campaignNames].sort()),
        adGroupNames: Object.freeze([...aggregate.variants.adGroupNames].sort()),
        targetingTexts: Object.freeze([...aggregate.variants.targetingTexts].sort()),
        matchTypes: Object.freeze([...aggregate.variants.matchTypes].sort()),
      }),
      reliability,
      requiresHumanReview: true,
      persistenceAuthorized: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    });
  }).sort(compareRows);
}

function identityQuality(aggregate, indexes) {
  const conflictCodes = [];
  const campaignId = aggregate.identity.campaign?.id || null;
  const adGroupId = aggregate.identity.adGroup?.id || null;
  const targetingId = aggregate.identity.targeting?.id || null;
  if (campaignId && setSize(indexes.campaignNamesById, campaignId) > 1) conflictCodes.push('campaign_id_multiple_names');
  if (adGroupId && setSize(indexes.adGroupNamesById, adGroupId) > 1) conflictCodes.push('ad_group_id_multiple_names');
  if (adGroupId && setSize(indexes.adGroupParentsById, adGroupId) > 1) conflictCodes.push('ad_group_id_multiple_campaign_parents');
  if (targetingId && setSize(indexes.targetingTextsById, targetingId) > 1) conflictCodes.push('targeting_id_multiple_texts');
  if (targetingId && setSize(indexes.targetingParentsById, targetingId) > 1) conflictCodes.push('targeting_id_multiple_ad_group_parents');
  const ambiguous = conflictCodes.length > 0;
  const state = targetingId || adGroupId || campaignId ? 'observed_id' : hasObservedText(aggregate.identity) ? 'observed_name_or_text' : 'unresolved';
  return Object.freeze({
    state,
    ambiguous,
    confidence: ambiguous ? 'blocked' : (state === 'unresolved' ? 'low' : 'observed_only'),
    conflictCodes: Object.freeze(conflictCodes),
    canonicalAmazonIdentityResolved: false,
  });
}

function observedIdentityPart(idValue, nameValue, prefix) {
  const id = clean(idValue);
  const name = clean(nameValue);
  const normalizedName = normalizeText(name);
  return Object.freeze({
    id,
    name,
    key: id ? `id:${id}` : (normalizedName ? `name:${normalizedName}` : `${prefix}:unresolved`),
  });
}

function observedTargetingPart(fact) {
  const id = clean(fact?.targetingId);
  const text = clean(fact?.targeting);
  const normalizedText = normalizeText(text);
  const matchType = upper(fact?.matchType);
  return Object.freeze({
    id,
    text,
    matchType,
    key: id ? `id:${id}` : (normalizedText ? `text:${normalizedText}|match:${matchType || 'UNSPECIFIED'}` : `targeting:unresolved|match:${matchType || 'UNSPECIFIED'}`),
  });
}

function freezeIdentity(identity) {
  return Object.freeze({
    campaign: identity.campaign ? Object.freeze({ id: identity.campaign.id, name: identity.campaign.name }) : null,
    adGroup: identity.adGroup ? Object.freeze({ id: identity.adGroup.id, name: identity.adGroup.name }) : null,
    targeting: identity.targeting ? Object.freeze({ id: identity.targeting.id, text: identity.targeting.text, matchType: identity.targeting.matchType }) : null,
    canonicalAmazonIdentityResolved: false,
  });
}

function deriveReliability(dataQuality) {
  const aggregationSafe = dataQuality?.safeForNaiveAggregation !== false;
  const periodComplete = dataQuality?.contiguousCoverage !== false;
  const state = !aggregationSafe ? 'blocked_overlap_or_invalid_window' : (!periodComplete ? 'incomplete_period' : 'observed');
  return Object.freeze({
    state,
    aggregationSafe,
    periodComplete,
    analyticalDecisionUse: !aggregationSafe ? 'blocked' : (periodComplete ? 'review_only' : 'review_with_period_gap'),
    requiresHumanReview: true,
  });
}

function performanceBand(metrics, targetAcos) {
  if (metrics.spendMicros <= 0 && metrics.salesMicros <= 0) return 'no_spend';
  if (metrics.salesMicros <= 0 && metrics.spendMicros > 0) return 'spend_without_sales';
  if (metrics.acos !== null && metrics.acos <= targetAcos) return 'at_or_below_target_acos';
  if (metrics.acos !== null) return 'above_target_acos';
  return 'observe';
}

function compareRows(left, right) {
  return right.metrics.spendMicros - left.metrics.spendMicros
    || right.metrics.salesMicros - left.metrics.salesMicros
    || left.observedKey.localeCompare(right.observedKey);
}

function hasObservedText(identity) {
  return Boolean(identity.campaign?.name || identity.adGroup?.name || identity.targeting?.text);
}

function addIndexValue(map, key, value) {
  if (!key || !value) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function setSize(map, key) {
  return map.get(key)?.size || 0;
}

function addSet(set, value) {
  const text = clean(value);
  if (text) set.add(text);
}

function boundedPositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 10 ? number : fallback;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeText(value) {
  return clean(value)?.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ') || '';
}

function upper(value) {
  return clean(value)?.toUpperCase() || null;
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

function hierarchyError(code) {
  const error = new Error(code);
  error.name = 'CsvHierarchyProfitabilityError';
  error.code = code;
  return error;
}
