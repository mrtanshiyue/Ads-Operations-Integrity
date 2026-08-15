import { canonicalJson } from './canonical-json.js';
import { parseAmazonId, exactDecimalToMicros } from './amazon-numeric.js';

export const SP_ENTITY_LIST_CONTRACTS = Object.freeze({
  campaign: Object.freeze({ entityType: 'campaign', endpoint: '/sp/campaigns/list', method: 'POST' }),
  ad_group: Object.freeze({ entityType: 'ad_group', endpoint: '/sp/adGroups/list', method: 'POST' }),
  keyword: Object.freeze({ entityType: 'keyword', endpoint: '/sp/keywords/list', method: 'POST' }),
  target: Object.freeze({ entityType: 'target', endpoint: '/sp/targets/list', method: 'POST' }),
});

export class EntityContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EntityContractError';
    this.code = code;
  }
}

export function entityListContract(entityType) {
  const contract = SP_ENTITY_LIST_CONTRACTS[entityType];
  if (!contract) throw new EntityContractError('ENTITY_TYPE_UNSUPPORTED');
  return contract;
}

export async function canonicalizeCampaign({ source, profileId, syncedAt }) {
  const entity = {
    entityType: 'campaign',
    campaignId: parseAmazonId(source?.campaignId),
    profileId: parseAmazonId(profileId),
    // Phase A does not establish Portfolio producer authority. Do not create an FK to an unmirrored portfolio.
    portfolioId: null,
    adProduct: 'SPONSORED_PRODUCTS',
    name: requiredSourceText(source?.name, 'CAMPAIGN_NAME_REQUIRED'),
    state: sourceState(source?.state),
    targetingType: optionalSourceText(source?.targetingType),
    biddingStrategy: optionalSourceText(source?.biddingStrategy),
    dailyBudgetMicros: optionalMoneyMicros(source?.dailyBudget),
    startDate: optionalIsoDate(source?.startDate, 'CAMPAIGN_START_DATE_INVALID'),
    endDate: optionalIsoDate(source?.endDate, 'CAMPAIGN_END_DATE_INVALID'),
    // V1 has no independent Amazon source-update authority for campaigns.
    sourceUpdatedAt: null,
    syncedAt: requiredSnapshotTimestamp(syncedAt),
  };
  return freezeWithPayloadHash(entity);
}

export async function canonicalizeAdGroup({ source, profileId, syncedAt }) {
  const entity = {
    entityType: 'ad_group',
    adGroupId: parseAmazonId(source?.adGroupId),
    profileId: parseAmazonId(profileId),
    campaignId: parseAmazonId(source?.campaignId),
    name: requiredSourceText(source?.name, 'AD_GROUP_NAME_REQUIRED'),
    state: sourceState(source?.state),
    defaultBidMicros: optionalMoneyMicros(source?.defaultBid),
    sourceUpdatedAt: officialExtendedSourceTimestamp(source?.extendedData),
    syncedAt: requiredSnapshotTimestamp(syncedAt),
  };
  return freezeWithPayloadHash(entity);
}

export async function canonicalizeKeyword({ source, profileId, syncedAt }) {
  const keywordText = requiredSourceText(source?.keywordText, 'KEYWORD_TEXT_REQUIRED');
  const entity = {
    entityType: 'keyword',
    keywordId: parseAmazonId(source?.keywordId),
    profileId: parseAmazonId(profileId),
    campaignId: parseAmazonId(source?.campaignId),
    adGroupId: parseAmazonId(source?.adGroupId),
    keywordText,
    normalizedKeyword: normalizeKeyword(keywordText),
    matchType: requiredSourceText(source?.matchType, 'KEYWORD_MATCH_TYPE_REQUIRED').toUpperCase(),
    state: sourceState(source?.state),
    bidMicros: optionalMoneyMicros(source?.bid),
    sourceUpdatedAt: officialExtendedSourceTimestamp(source?.extendedData),
    syncedAt: requiredSnapshotTimestamp(syncedAt),
  };
  return freezeWithPayloadHash(entity);
}

export async function canonicalizeTarget({ source, profileId, syncedAt }) {
  const expression = canonicalTargetExpression(source?.expression);
  const entity = {
    entityType: 'target',
    targetId: parseAmazonId(source?.targetId),
    profileId: parseAmazonId(profileId),
    campaignId: parseAmazonId(source?.campaignId),
    adGroupId: parseAmazonId(source?.adGroupId),
    targetType: optionalSourceText(source?.expressionType),
    expressionJson: canonicalJson(expression),
    expressionText: expression.map((item) => canonicalJson(item)).join(' | '),
    state: sourceState(source?.state),
    bidMicros: optionalMoneyMicros(source?.bid),
    // V1 has no independent Amazon source-update authority for targets.
    sourceUpdatedAt: null,
    syncedAt: requiredSnapshotTimestamp(syncedAt),
  };
  return freezeWithPayloadHash(entity);
}

export async function canonicalizeEntitySnapshot({ profileId, syncedAt, campaigns, adGroups, keywords, targets }) {
  const canonicalProfileId = parseAmazonId(profileId);
  const snapshotSyncedAt = requiredSnapshotTimestamp(syncedAt);
  const canonicalCampaigns = await Promise.all(requireArray(campaigns, 'CAMPAIGN_SNAPSHOT_INVALID').map((source) => canonicalizeCampaign({ source, profileId: canonicalProfileId, syncedAt: snapshotSyncedAt })));
  const canonicalAdGroups = await Promise.all(requireArray(adGroups, 'AD_GROUP_SNAPSHOT_INVALID').map((source) => canonicalizeAdGroup({ source, profileId: canonicalProfileId, syncedAt: snapshotSyncedAt })));
  const canonicalKeywords = await Promise.all(requireArray(keywords, 'KEYWORD_SNAPSHOT_INVALID').map((source) => canonicalizeKeyword({ source, profileId: canonicalProfileId, syncedAt: snapshotSyncedAt })));
  const canonicalTargets = await Promise.all(requireArray(targets, 'TARGET_SNAPSHOT_INVALID').map((source) => canonicalizeTarget({ source, profileId: canonicalProfileId, syncedAt: snapshotSyncedAt })));

  const snapshot = {
    profileId: canonicalProfileId,
    syncedAt: snapshotSyncedAt,
    campaigns: canonicalCampaigns,
    adGroups: canonicalAdGroups,
    keywords: canonicalKeywords,
    targets: canonicalTargets,
  };
  validateEntitySnapshotHierarchy(snapshot);
  const counts = Object.freeze({
    campaign: canonicalCampaigns.length,
    ad_group: canonicalAdGroups.length,
    keyword: canonicalKeywords.length,
    target: canonicalTargets.length,
  });
  const snapshotHash = await sha256Hex(canonicalJson([
    'amazon-entity-snapshot-v1',
    canonicalProfileId,
    snapshotSyncedAt,
    canonicalCampaigns,
    canonicalAdGroups,
    canonicalKeywords,
    canonicalTargets,
  ]));
  return Object.freeze({
    ...snapshot,
    campaigns: Object.freeze(canonicalCampaigns),
    adGroups: Object.freeze(canonicalAdGroups),
    keywords: Object.freeze(canonicalKeywords),
    targets: Object.freeze(canonicalTargets),
    counts,
    snapshotHash,
  });
}

export function validateEntitySnapshotHierarchy(snapshot) {
  const profileId = parseAmazonId(snapshot?.profileId);
  const campaignById = uniqueBy(snapshot?.campaigns, 'campaignId', 'DUPLICATE_CAMPAIGN_ID');
  const adGroupById = uniqueBy(snapshot?.adGroups, 'adGroupId', 'DUPLICATE_AD_GROUP_ID');
  uniqueBy(snapshot?.keywords, 'keywordId', 'DUPLICATE_KEYWORD_ID');
  uniqueBy(snapshot?.targets, 'targetId', 'DUPLICATE_TARGET_ID');

  for (const campaign of snapshot.campaigns || []) {
    if (campaign.profileId !== profileId) throw new EntityContractError('CAMPAIGN_PROFILE_MISMATCH');
    if (campaign.syncedAt !== snapshot.syncedAt) throw new EntityContractError('ENTITY_SNAPSHOT_SYNCED_AT_MISMATCH');
  }
  for (const adGroup of snapshot.adGroups || []) {
    if (adGroup.profileId !== profileId) throw new EntityContractError('AD_GROUP_PROFILE_MISMATCH');
    if (adGroup.syncedAt !== snapshot.syncedAt) throw new EntityContractError('ENTITY_SNAPSHOT_SYNCED_AT_MISMATCH');
    const campaign = campaignById.get(adGroup.campaignId);
    if (!campaign || campaign.profileId !== profileId) throw new EntityContractError('AD_GROUP_CAMPAIGN_HIERARCHY_MISMATCH');
  }
  for (const keyword of snapshot.keywords || []) {
    if (keyword.profileId !== profileId) throw new EntityContractError('KEYWORD_PROFILE_MISMATCH');
    if (keyword.syncedAt !== snapshot.syncedAt) throw new EntityContractError('ENTITY_SNAPSHOT_SYNCED_AT_MISMATCH');
    const adGroup = adGroupById.get(keyword.adGroupId);
    if (!adGroup || adGroup.profileId !== profileId || adGroup.campaignId !== keyword.campaignId) {
      throw new EntityContractError('KEYWORD_HIERARCHY_MISMATCH');
    }
  }
  for (const target of snapshot.targets || []) {
    if (target.profileId !== profileId) throw new EntityContractError('TARGET_PROFILE_MISMATCH');
    if (target.syncedAt !== snapshot.syncedAt) throw new EntityContractError('ENTITY_SNAPSHOT_SYNCED_AT_MISMATCH');
    const adGroup = adGroupById.get(target.adGroupId);
    if (!adGroup || adGroup.profileId !== profileId || adGroup.campaignId !== target.campaignId) {
      throw new EntityContractError('TARGET_HIERARCHY_MISMATCH');
    }
  }
  return true;
}

export function buildEntityStageRows({ runId, snapshot }) {
  const rows = [];
  for (const [entityType, entities] of [
    ['campaign', snapshot.campaigns],
    ['ad_group', snapshot.adGroups],
    ['keyword', snapshot.keywords],
    ['target', snapshot.targets],
  ]) {
    entities.forEach((entity, ordinal) => {
      rows.push(Object.freeze({
        runId: requiredSourceText(runId, 'SYNC_RUN_ID_REQUIRED'),
        profileId: snapshot.profileId,
        entityType,
        sourceRowOrdinal: ordinal,
        entityId: entityIdForType(entityType, entity),
        canonicalEntityJson: canonicalJson(entity),
      }));
    });
  }
  return Object.freeze(rows);
}

function entityIdForType(entityType, entity) {
  if (entityType === 'campaign') return entity.campaignId;
  if (entityType === 'ad_group') return entity.adGroupId;
  if (entityType === 'keyword') return entity.keywordId;
  if (entityType === 'target') return entity.targetId;
  throw new EntityContractError('ENTITY_TYPE_UNSUPPORTED');
}

async function freezeWithPayloadHash(entity) {
  const sourcePayload = { ...entity };
  delete sourcePayload.syncedAt;
  const payloadHash = await sha256Hex(canonicalJson(sourcePayload));
  return Object.freeze({ ...entity, payloadHash });
}

function officialExtendedSourceTimestamp(extendedData) {
  if (!extendedData || typeof extendedData !== 'object' || Array.isArray(extendedData)) return null;
  const value = extendedData.lastUpdateDateTime ?? extendedData.lastUpdateDate ?? null;
  if (value == null) return null;
  const text = requiredSourceText(value, 'SOURCE_UPDATED_AT_INVALID');
  if (text.length > 100 || /[\u0000-\u001f]/u.test(text)) throw new EntityContractError('SOURCE_UPDATED_AT_INVALID');
  return text;
}

function optionalMoneyMicros(value) {
  if (value == null) return null;
  return String(exactDecimalToMicros(value));
}

function optionalSourceText(value) {
  if (value == null || value === '') return null;
  return requiredSourceText(value, 'SOURCE_TEXT_INVALID');
}

function requiredSourceText(value, code) {
  if (typeof value !== 'string') throw new EntityContractError(code);
  const text = value.trim();
  if (!text) throw new EntityContractError(code);
  if (text.length > 10000 || /\u0000/u.test(text)) throw new EntityContractError(code);
  return text;
}

function sourceState(value) {
  return requiredSourceText(value, 'ENTITY_STATE_REQUIRED').toUpperCase();
}

function normalizeKeyword(value) {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function canonicalTargetExpression(value) {
  if (!Array.isArray(value) || value.length === 0) throw new EntityContractError('TARGET_EXPRESSION_INVALID');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new EntityContractError('TARGET_EXPRESSION_ITEM_INVALID');
    return JSON.parse(canonicalJson(item));
  });
}

function optionalIsoDate(value, code) {
  if (value == null || value === '') return null;
  const text = requiredSourceText(value, code);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new EntityContractError(code);
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new EntityContractError(code);
  return text;
}

function requiredSnapshotTimestamp(value) {
  return requiredSourceText(value, 'SNAPSHOT_SYNCED_AT_REQUIRED');
}

function requireArray(value, code) {
  if (!Array.isArray(value)) throw new EntityContractError(code);
  return value;
}

function uniqueBy(rows, key, duplicateCode) {
  const map = new Map();
  for (const row of rows || []) {
    const id = row?.[key];
    if (!id) throw new EntityContractError('ENTITY_ID_REQUIRED');
    if (map.has(id)) throw new EntityContractError(duplicateCode);
    map.set(id, row);
  }
  return map;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
