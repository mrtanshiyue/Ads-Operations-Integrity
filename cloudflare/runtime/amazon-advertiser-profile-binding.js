import { canonicalJson } from './canonical-json.js';
import { parseAmazonId } from './amazon-numeric.js';
import { marketplaceContractForStore } from './amazon-profile-contract.js';

export const ADVERTISER_ACCOUNT_QUERY_CONTRACT = Object.freeze({
  sourceContract: 'amazon-ads-advertiser-account-query-v1',
  endpoint: '/adsApi/v1/query/advertiserAccounts',
  method: 'POST',
  semanticReadOnly: true,
  rawSchemaAuthorityRequired: true,
});

export const SPONSORED_ADS_PROFILE_AUTHORITY = 'amazon-ads-profiles-api-v2';

export class AdvertiserProfileBindingError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AdvertiserProfileBindingError';
    this.code = code;
  }
}

// Input records are normalized adapter output, not a claim about the raw Amazon response schema.
// A binding is impossible until the caller supplies official-schema-verified identifier namespaces.
export async function resolveCanonicalAdvertiserProfileBinding({
  store,
  observedAdvertiserAccountId,
  advertiserAccounts,
  profileCandidates,
  verifiedAdvertiserAccountIdentifierType,
  verifiedProfileIdentifierType,
}) {
  const observedId = requiredText(observedAdvertiserAccountId, 'ADVERTISER_PROFILE_BINDING_UNVERIFIED');
  const accountIdentifierType = requiredAuthorityType(verifiedAdvertiserAccountIdentifierType);
  const profileIdentifierType = requiredAuthorityType(verifiedProfileIdentifierType);
  if (!Array.isArray(advertiserAccounts) || !Array.isArray(profileCandidates)) {
    throw new AdvertiserProfileBindingError('ADVERTISER_PROFILE_BINDING_UNVERIFIED');
  }

  const accountMatches = advertiserAccounts.filter((account) => (
    String(account?.advertiserAccountId ?? '') === observedId
    && String(account?.advertiserAccountIdentifierType ?? '') === accountIdentifierType
  ));
  if (accountMatches.length === 0) throw new AdvertiserProfileBindingError('ADVERTISER_ACCOUNT_NOT_FOUND');
  if (accountMatches.length > 1) throw new AdvertiserProfileBindingError('ADVERTISER_ACCOUNT_AMBIGUOUS');

  const account = normalizeAuthoritativeAccount(accountMatches[0]);
  const identifiers = account.alternateIdentifiers.filter((identifier) => identifier.identifierType === profileIdentifierType);
  const uniqueProfileIds = [...new Set(identifiers.map((identifier) => identifier.identifierValue))];
  if (uniqueProfileIds.length === 0) throw new AdvertiserProfileBindingError('PROFILE_IDENTIFIER_NOT_FOUND');
  if (uniqueProfileIds.length > 1) throw new AdvertiserProfileBindingError('PROFILE_IDENTIFIER_AMBIGUOUS');

  const profileId = parseAmazonId(uniqueProfileIds[0]);
  const matchingProfiles = profileCandidates.filter((candidate) => {
    try { return parseAmazonId(candidate?.profile?.profileId) === profileId; } catch { return false; }
  });
  if (matchingProfiles.length === 0) throw new AdvertiserProfileBindingError('PROFILE_IDENTIFIER_NOT_FOUND');
  if (matchingProfiles.length > 1) throw new AdvertiserProfileBindingError('PROFILE_IDENTIFIER_AMBIGUOUS');

  const candidate = matchingProfiles[0];
  if (candidate?.sourceAuthority !== SPONSORED_ADS_PROFILE_AUTHORITY) {
    throw new AdvertiserProfileBindingError('ADVERTISER_PROFILE_BINDING_UNVERIFIED');
  }
  const profile = candidate.profile;
  const contract = marketplaceContractForStore(store);
  if (
    String(profile?.countryCode ?? '').toUpperCase() !== contract.countryCode
    || String(profile?.currencyCode ?? '').toUpperCase() !== contract.currencyCode
    || String(profile?.accountInfo?.marketplaceStringId ?? '') !== contract.marketplaceStringId
  ) {
    throw new AdvertiserProfileBindingError('PROFILE_MARKETPLACE_MISMATCH');
  }

  const accountType = String(profile?.accountInfo?.type ?? profile?.accountType ?? '').trim().toLowerCase();
  if (accountType !== 'seller' && accountType !== 'vendor') {
    throw new AdvertiserProfileBindingError('PROFILE_ACCOUNT_TYPE_UNSUPPORTED');
  }

  const evidenceCore = Object.freeze({
    contractVersion: 'CanonicalAdvertiserProfileBindingV1',
    advertiserAccountId: observedId,
    advertiserAccountIdentifierType: accountIdentifierType,
    profileId,
    identifierType: profileIdentifierType,
    marketplaceId: contract.marketplaceStringId,
    countryCode: contract.countryCode,
    currencyCode: contract.currencyCode,
    accountType,
    accountName: typeof profile?.accountInfo?.name === 'string' ? profile.accountInfo.name : null,
    sourceContract: account.sourceContract,
    sourceEndpoint: account.sourceEndpoint,
    sourceObservedAt: account.sourceObservedAt,
    relationCardinality: 'not_assumed',
    profileAuthority: SPONSORED_ADS_PROFILE_AUTHORITY,
  });
  const evidenceFingerprint = await sha256Hex(canonicalJson(evidenceCore));
  return Object.freeze({ ...evidenceCore, evidenceFingerprint });
}

function normalizeAuthoritativeAccount(account) {
  if (
    account?.sourceContract !== ADVERTISER_ACCOUNT_QUERY_CONTRACT.sourceContract
    || account?.sourceEndpoint !== ADVERTISER_ACCOUNT_QUERY_CONTRACT.endpoint
  ) {
    throw new AdvertiserProfileBindingError('ADVERTISER_PROFILE_BINDING_UNVERIFIED');
  }
  const sourceObservedAt = requiredTimestamp(account.sourceObservedAt);
  if (!Array.isArray(account?.alternateIdentifiers)) {
    throw new AdvertiserProfileBindingError('ADVERTISER_PROFILE_BINDING_UNVERIFIED');
  }
  const alternateIdentifiers = account.alternateIdentifiers.map((item) => Object.freeze({
    identifierType: requiredText(item?.identifierType, 'ADVERTISER_PROFILE_BINDING_UNVERIFIED'),
    identifierValue: parseAmazonId(item?.identifierValue),
  }));
  return Object.freeze({
    advertiserAccountId: requiredText(account.advertiserAccountId, 'ADVERTISER_PROFILE_BINDING_UNVERIFIED'),
    advertiserAccountIdentifierType: requiredText(account.advertiserAccountIdentifierType, 'ADVERTISER_PROFILE_BINDING_UNVERIFIED'),
    alternateIdentifiers: Object.freeze(alternateIdentifiers),
    sourceContract: account.sourceContract,
    sourceEndpoint: account.sourceEndpoint,
    sourceObservedAt,
  });
}

function requiredAuthorityType(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new AdvertiserProfileBindingError('ADVERTISER_PROFILE_BINDING_UNVERIFIED');
  return text;
}

function requiredText(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw new AdvertiserProfileBindingError(code);
  return value.trim();
}

function requiredTimestamp(value) {
  const text = requiredText(value, 'ADVERTISER_PROFILE_BINDING_UNVERIFIED');
  if (Number.isNaN(Date.parse(text))) throw new AdvertiserProfileBindingError('ADVERTISER_PROFILE_BINDING_UNVERIFIED');
  return text;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
