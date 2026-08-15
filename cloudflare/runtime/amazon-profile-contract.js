import { parseAmazonId } from './amazon-numeric.js';

const MARKETPLACES = Object.freeze({
  US: Object.freeze({
    marketplaceCode: 'US',
    countryCode: 'US',
    currencyCode: 'USD',
    marketplaceStringId: 'ATVPDKIKX0DER',
    region: 'NA',
    apiHost: 'advertising-api.amazon.com',
  }),
});

export class ProfileContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProfileContractError';
    this.code = code;
  }
}

export function marketplaceContractForStore(store) {
  const marketplaceCode = String(store?.marketplace_code ?? '').trim().toUpperCase();
  const amazonRegion = String(store?.amazon_region ?? '').trim().toUpperCase();
  const contract = MARKETPLACES[marketplaceCode];
  if (!contract) throw new ProfileContractError('STORE_MARKETPLACE_UNSUPPORTED');
  if (amazonRegion !== contract.region) throw new ProfileContractError('STORE_AMAZON_REGION_MISMATCH');
  return contract;
}

export function resolveCanonicalProfile(store, profiles) {
  const contract = marketplaceContractForStore(store);
  if (!Array.isArray(profiles)) throw new ProfileContractError('AMAZON_PROFILES_RESPONSE_INVALID');

  const marketplaceMatches = profiles.filter((profile) => {
    const info = profile?.accountInfo || {};
    return String(profile?.countryCode ?? '').toUpperCase() === contract.countryCode
      && String(profile?.currencyCode ?? '').toUpperCase() === contract.currencyCode
      && String(info.marketplaceStringId ?? '') === contract.marketplaceStringId;
  });

  const valid = marketplaceMatches.filter((profile) => {
    const type = accountType(profile);
    return type === 'seller' || type === 'vendor';
  });

  if (valid.length === 0) {
    if (marketplaceMatches.length > 0) throw new ProfileContractError('PROFILE_ACCOUNT_TYPE_UNSUPPORTED');
    throw new ProfileContractError('CANONICAL_PROFILE_NOT_FOUND');
  }
  if (valid.length > 1) throw new ProfileContractError('CANONICAL_PROFILE_AMBIGUOUS');

  const profile = valid[0];
  return Object.freeze({
    profileId: parseAmazonId(profile.profileId),
    marketplaceId: contract.marketplaceStringId,
    countryCode: contract.countryCode,
    currencyCode: contract.currencyCode,
    region: contract.region,
    apiHost: contract.apiHost,
    accountType: accountType(profile),
    timezone: typeof profile.timezone === 'string' && profile.timezone ? profile.timezone : null,
    accountName: typeof profile.accountInfo?.name === 'string' ? profile.accountInfo.name : null,
  });
}

function accountType(profile) {
  return String(profile?.accountInfo?.type ?? profile?.accountType ?? '').trim().toLowerCase();
}
