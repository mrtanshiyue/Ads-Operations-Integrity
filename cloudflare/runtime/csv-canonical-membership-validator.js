import { parseAmazonId } from './amazon-numeric.js';

export const CSV_CANONICAL_MEMBERSHIP_STATUSES = Object.freeze([
  'verified',
  'not_found',
  'hierarchy_mismatch',
  'profile_mismatch',
  'ambiguous',
  'csv_unresolved',
]);

export class CsvCanonicalMembershipError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CsvCanonicalMembershipError';
    this.code = code;
  }
}

export function validateCsvCanonicalMembership({ profileId, rows, snapshot }) {
  const canonicalProfileId = parseAmazonId(profileId);
  if (!Array.isArray(rows) || !snapshot || typeof snapshot !== 'object') {
    throw new CsvCanonicalMembershipError('CSV_CANONICAL_MEMBERSHIP_INPUT_INVALID');
  }
  const campaignIndex = multiIndex(snapshot.campaigns, 'campaignId');
  const adGroupIndex = multiIndex(snapshot.adGroups, 'adGroupId');
  const keywordIndex = multiIndex(snapshot.keywords, 'keywordId');
  const targetIndex = multiIndex(snapshot.targets, 'targetId');

  return Object.freeze(rows.map((row, rowIndex) => Object.freeze(validateRow({
    row, rowIndex, canonicalProfileId, campaignIndex, adGroupIndex, keywordIndex, targetIndex,
  }))));
}

function validateRow({ row, rowIndex, canonicalProfileId, campaignIndex, adGroupIndex, keywordIndex, targetIndex }) {
  const campaignId = optionalId(row?.campaign_id ?? row?.campaignId);
  const adGroupId = optionalId(row?.ad_group_id ?? row?.adGroupId);
  const targetingId = optionalId(row?.targeting_id ?? row?.targetingId);
  const base = { rowIndex, campaignId, adGroupId, targetingId };

  if (!targetingId) return { ...base, status: 'csv_unresolved', entityType: null };
  if (!campaignId || !adGroupId) return { ...base, status: 'not_found', entityType: !campaignId ? 'campaign' : 'ad_group' };

  const campaign = uniqueMatch(campaignIndex.get(campaignId));
  if (campaign.status) return { ...base, status: campaign.status, entityType: 'campaign' };
  if (campaign.value.profileId !== canonicalProfileId) return { ...base, status: 'profile_mismatch', entityType: 'campaign' };

  const adGroup = uniqueMatch(adGroupIndex.get(adGroupId));
  if (adGroup.status) return { ...base, status: adGroup.status, entityType: 'ad_group' };
  if (adGroup.value.profileId !== canonicalProfileId) return { ...base, status: 'profile_mismatch', entityType: 'ad_group' };
  if (adGroup.value.campaignId !== campaignId) return { ...base, status: 'hierarchy_mismatch', entityType: 'ad_group' };

  const keywordMatches = keywordIndex.get(targetingId) || [];
  const targetMatches = targetIndex.get(targetingId) || [];
  if (keywordMatches.length + targetMatches.length === 0) return { ...base, status: 'not_found', entityType: 'targeting' };
  if (keywordMatches.length + targetMatches.length > 1) return { ...base, status: 'ambiguous', entityType: 'targeting' };

  const entityType = keywordMatches.length === 1 ? 'keyword' : 'target';
  const entity = keywordMatches[0] || targetMatches[0];
  if (entity.profileId !== canonicalProfileId) return { ...base, status: 'profile_mismatch', entityType };
  if (entity.campaignId !== campaignId || entity.adGroupId !== adGroupId) {
    return { ...base, status: 'hierarchy_mismatch', entityType };
  }
  return { ...base, status: 'verified', entityType };
}

function optionalId(value) {
  if (value == null || value === '') return null;
  try { return parseAmazonId(value); } catch { return null; }
}

function multiIndex(rows, key) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = optionalId(row?.[key]);
    if (!id) continue;
    const list = map.get(id) || [];
    list.push(row);
    map.set(id, list);
  }
  return map;
}

function uniqueMatch(matches) {
  if (!matches || matches.length === 0) return { status: 'not_found' };
  if (matches.length > 1) return { status: 'ambiguous' };
  return { value: matches[0] };
}
