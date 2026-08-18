import { canonicalJson } from './canonical-json.js';

export const CSV_OBSERVED_TARGETING_IDENTITY_SCHEMA_VERSION = 'csv-observed-targeting-identity-v1';

export async function buildCsvObservedTargetingIdentity(facts) {
  if (!Array.isArray(facts)) throw identityError('CSV_OBSERVED_IDENTITY_FACTS_REQUIRED');
  const context = deriveContext(facts);
  const groups = new Map();
  const targetingIdParents = new Map();

  for (const fact of facts) {
    const normalized = normalizeFact(fact);
    const groupKey = canonicalJson({
      advertiserAccountId: context.advertiserAccountId,
      profileId: context.profileId,
      campaignIdentity: normalized.campaignId || normalized.campaignName || null,
      adGroupIdentity: normalized.adGroupId || normalized.adGroupName || null,
      targetingIdentity: normalized.targetingId || normalized.targeting || null,
      matchType: normalized.targetingId ? null : normalized.matchType,
    });

    let group = groups.get(groupKey);
    if (!group) {
      group = emptyGroup(normalized);
      groups.set(groupKey, group);
    }
    collect(group, normalized);

    if (normalized.targetingId) {
      let parents = targetingIdParents.get(normalized.targetingId);
      if (!parents) {
        parents = new Set();
        targetingIdParents.set(normalized.targetingId, parents);
      }
      parents.add(canonicalJson({
        campaignId: normalized.campaignId,
        campaignName: normalized.campaignName,
        adGroupId: normalized.adGroupId,
        adGroupName: normalized.adGroupName,
      }));
    }
  }

  const identities = [];
  for (const group of groups.values()) {
    const evidence = finalizeEvidence(group, targetingIdParents);
    const identityBasis = Object.freeze({
      advertiserAccountId: context.advertiserAccountId,
      profileId: context.profileId,
      campaignId: singleOrNull(group.campaignIds),
      campaignName: singleOrNull(group.campaignNames),
      adGroupId: singleOrNull(group.adGroupIds),
      adGroupName: singleOrNull(group.adGroupNames),
      targetingId: singleOrNull(group.targetingIds),
      targeting: singleOrNull(group.targetingTexts),
      matchType: singleOrNull(group.matchTypes),
    });
    const localIdentityFingerprint = await sha256Hex(canonicalJson({
      schemaVersion: CSV_OBSERVED_TARGETING_IDENTITY_SCHEMA_VERSION,
      identityBasis,
    }));
    identities.push(Object.freeze({
      localIdentityFingerprint,
      observedIdentityState: deriveObservedIdentityState(identityBasis),
      confidence: deriveConfidence(identityBasis, evidence),
      identityBasis,
      evidence,
      searchTerms: Object.freeze([...group.searchTerms].sort()),
      normalizedSearchTerms: Object.freeze([...group.normalizedSearchTerms].sort()),
      sourceImportIds: Object.freeze([...group.sourceImportIds].sort()),
      reportDates: Object.freeze([...group.reportDates].sort()),
      authority: NON_AUTHORITY,
    }));
  }

  identities.sort((left, right) => left.localIdentityFingerprint.localeCompare(right.localIdentityFingerprint));
  const searchTermLinks = buildSearchTermLinks(identities);
  const ambiguousCount = identities.filter((item) => item.evidence.ambiguous).length;
  const resolvedIdCount = identities.filter((item) => item.observedIdentityState === 'resolved_id').length;

  return Object.freeze({
    schemaVersion: CSV_OBSERVED_TARGETING_IDENTITY_SCHEMA_VERSION,
    context,
    authority: NON_AUTHORITY,
    summary: Object.freeze({
      factCount: facts.length,
      identityCount: identities.length,
      resolvedIdCount,
      observedOnlyCount: identities.length - resolvedIdCount,
      ambiguousIdentityCount: ambiguousCount,
      searchTermLinkCount: searchTermLinks.length,
      canonicalAmazonIdentityResolved: false,
    }),
    identities: Object.freeze(identities),
    searchTermLinks: Object.freeze(searchTermLinks),
  });
}

const NON_AUTHORITY = Object.freeze({
  mode: 'csv_observed_identity_only',
  authoritative: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

function deriveContext(facts) {
  const advertiserAccountIds = unique(facts.map((fact) => clean(fact?.advertiserAccountId)));
  const profileIds = unique(facts.map((fact) => clean(fact?.profileId)));
  const marketplaces = unique(facts.map((fact) => clean(fact?.marketplace)));
  const currencyCodes = unique(facts.map((fact) => clean(fact?.currencyCode)?.toUpperCase()));
  if (advertiserAccountIds.length > 1) throw identityError('CSV_OBSERVED_IDENTITY_MIXED_ADVERTISER_SCOPE');
  if (profileIds.length > 1) throw identityError('CSV_OBSERVED_IDENTITY_MIXED_PROFILE_SCOPE');
  if (marketplaces.length > 1) throw identityError('CSV_OBSERVED_IDENTITY_MIXED_MARKETPLACE_SCOPE');
  if (currencyCodes.length > 1) throw identityError('CSV_OBSERVED_IDENTITY_MIXED_CURRENCY_SCOPE');
  return Object.freeze({
    advertiserAccountId: advertiserAccountIds[0] || null,
    profileId: profileIds[0] || null,
    marketplace: marketplaces[0] || null,
    currencyCode: currencyCodes[0] || null,
    canonicalAmazonIdentityResolved: false,
  });
}

function normalizeFact(fact = {}) {
  const searchTerm = clean(fact.searchTerm);
  const normalizedSearchTerm = normalizeBusinessText(fact.normalizedSearchTerm || searchTerm);
  return Object.freeze({
    advertiserAccountId: clean(fact.advertiserAccountId),
    profileId: clean(fact.profileId),
    campaignId: clean(fact.campaignId),
    campaignName: clean(fact.campaignName),
    adGroupId: clean(fact.adGroupId),
    adGroupName: clean(fact.adGroupName),
    targetingId: clean(fact.targetingId),
    targeting: normalizeBusinessText(fact.targeting),
    targetingIdentityState: clean(fact.targetingIdentityState),
    matchType: clean(fact.matchType)?.toUpperCase() || null,
    searchTerm,
    normalizedSearchTerm,
    sourceImportId: clean(fact.sourceImportId),
    reportDate: clean(fact.reportDate),
  });
}

function emptyGroup(fact) {
  return {
    campaignIds: new Set(), campaignNames: new Set(), adGroupIds: new Set(), adGroupNames: new Set(),
    targetingIds: new Set(), targetingTexts: new Set(), matchTypes: new Set(), targetingIdentityStates: new Set(),
    searchTerms: new Set(), normalizedSearchTerms: new Set(), sourceImportIds: new Set(), reportDates: new Set(),
    rowCount: 0,
    seedTargetingId: fact.targetingId,
  };
}

function collect(group, fact) {
  add(group.campaignIds, fact.campaignId);
  add(group.campaignNames, fact.campaignName);
  add(group.adGroupIds, fact.adGroupId);
  add(group.adGroupNames, fact.adGroupName);
  add(group.targetingIds, fact.targetingId);
  add(group.targetingTexts, fact.targeting);
  add(group.matchTypes, fact.matchType);
  add(group.targetingIdentityStates, fact.targetingIdentityState);
  add(group.searchTerms, fact.searchTerm);
  add(group.normalizedSearchTerms, fact.normalizedSearchTerm);
  add(group.sourceImportIds, fact.sourceImportId);
  add(group.reportDates, fact.reportDate);
  group.rowCount += 1;
}

function finalizeEvidence(group, targetingIdParents) {
  const targetingId = singleOrNull(group.targetingIds);
  const parentObservationCount = targetingId ? (targetingIdParents.get(targetingId)?.size || 0) : 0;
  const conflicts = [];
  if (group.campaignIds.size > 1) conflicts.push('campaign_id_conflict');
  if (group.adGroupIds.size > 1) conflicts.push('ad_group_id_conflict');
  if (group.targetingIds.size > 1) conflicts.push('targeting_id_conflict');
  if (group.targetingTexts.size > 1) conflicts.push('targeting_text_conflict');
  if (group.matchTypes.size > 1) conflicts.push('match_type_conflict');
  if (targetingId && parentObservationCount > 1) conflicts.push('targeting_id_parent_conflict');
  return Object.freeze({
    rowCount: group.rowCount,
    campaignIdObservationCount: group.campaignIds.size,
    adGroupIdObservationCount: group.adGroupIds.size,
    targetingIdObservationCount: group.targetingIds.size,
    targetingTextObservationCount: group.targetingTexts.size,
    sourceImportCount: group.sourceImportIds.size,
    reportDateCount: group.reportDates.size,
    parentObservationCount,
    parserIdentityStates: Object.freeze([...group.targetingIdentityStates].sort()),
    ambiguous: conflicts.length > 0,
    conflictCodes: Object.freeze(conflicts.sort()),
  });
}

function deriveObservedIdentityState(identity) {
  if (identity.targetingId && identity.targeting) return 'resolved_id';
  if (identity.targetingId) return 'id_only';
  if (identity.targeting) return 'name_only';
  return 'unresolved';
}

function deriveConfidence(identity, evidence) {
  if (evidence.ambiguous) return Object.freeze({ band: 'blocked', score: 0, reason: 'conflicting_observed_identity' });
  let score = 0;
  if (identity.campaignId) score += 0.2;
  if (identity.adGroupId) score += 0.2;
  if (identity.targetingId) score += 0.35;
  if (identity.targeting) score += 0.15;
  if (identity.matchType) score += 0.05;
  if (evidence.sourceImportCount > 1 || evidence.reportDateCount > 1) score += 0.05;
  score = Math.min(1, Math.round(score * 100) / 100);
  return Object.freeze({
    band: score >= 0.8 ? 'high_observed' : (score >= 0.5 ? 'medium_observed' : 'low_observed'),
    score,
    reason: 'csv_observation_quality_only',
  });
}

function buildSearchTermLinks(identities) {
  const links = [];
  for (const identity of identities) {
    for (const normalizedSearchTerm of identity.normalizedSearchTerms) {
      links.push(Object.freeze({
        normalizedSearchTerm,
        localIdentityFingerprint: identity.localIdentityFingerprint,
        observedIdentityState: identity.observedIdentityState,
        identityAmbiguous: identity.evidence.ambiguous,
        canonicalAmazonIdentityResolved: false,
      }));
    }
  }
  return links.sort((left, right) => left.normalizedSearchTerm.localeCompare(right.normalizedSearchTerm)
    || left.localIdentityFingerprint.localeCompare(right.localIdentityFingerprint));
}

function singleOrNull(set) {
  return set.size === 1 ? [...set][0] : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function add(set, value) {
  if (value) set.add(value);
}

function normalizeBusinessText(value) {
  return clean(value)?.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ') || null;
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function identityError(code) {
  const error = new Error(code);
  error.name = 'CsvObservedTargetingIdentityError';
  error.code = code;
  return error;
}
