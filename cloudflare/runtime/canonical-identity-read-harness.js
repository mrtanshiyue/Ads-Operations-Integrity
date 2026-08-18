import {
  ADVERTISER_ACCOUNT_QUERY_CONTRACT,
  SPONSORED_ADS_PROFILE_AUTHORITY,
  resolveCanonicalAdvertiserProfileBinding,
} from './amazon-advertiser-profile-binding.js';
import { canonicalizeEntitySnapshot } from './amazon-entity-contract.js';
import { buildCanonicalCsvIdentityEvidence } from './canonical-csv-identity-evidence.js';

export const CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT = 'CanonicalIdentityReadAdapterV1';
export const AMAZON_ADS_SCOPE_HEADER = 'amazon-advertising-api-scope';
export const CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS = Object.freeze({
  amazonMutation: false,
  d1Write: false,
  r2Write: false,
  reportCreate: false,
  reportPoll: false,
  reportDownload: false,
  optimizationAction: false,
  executionPermit: false,
});

export class CanonicalIdentityReadHarnessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CanonicalIdentityReadHarnessError';
    this.code = code;
  }
}

// This is a core orchestration harness, not a live Amazon HTTP adapter.
// It refuses to invoke any dependency until the dependency advertises an explicit zero-side-effect capability.
export async function verifyCanonicalCsvIdentityReadOnly({
  store,
  observedAdvertiserAccountId,
  csvRows,
  advertiserAccountReader,
  profileReader,
  entityReader,
}) {
  const accountCapability = assertReadAdapter(advertiserAccountReader, 'queryAdvertiserAccounts', {
    requireSchemaAuthority: true,
  });
  const profileCapability = assertReadAdapter(profileReader, 'listProfiles');
  const entityCapability = assertReadAdapter(entityReader, 'listSponsoredProductsEntities');

  if (profileCapability.sourceAuthority !== SPONSORED_ADS_PROFILE_AUTHORITY) {
    throw new CanonicalIdentityReadHarnessError('CANONICAL_PROFILE_SOURCE_AUTHORITY_UNVERIFIED');
  }
  if (entityCapability.scopeHeader !== AMAZON_ADS_SCOPE_HEADER) {
    throw new CanonicalIdentityReadHarnessError('CANONICAL_ENTITY_SCOPE_AUTHORITY_UNVERIFIED');
  }

  const accountResult = await advertiserAccountReader.queryAdvertiserAccounts({
    store,
    observedAdvertiserAccountId,
    contract: ADVERTISER_ACCOUNT_QUERY_CONTRACT,
  });
  if (!Array.isArray(accountResult?.advertiserAccounts)) {
    throw new CanonicalIdentityReadHarnessError('ADVERTISER_ACCOUNT_READ_RESULT_INVALID');
  }

  const profileResult = await profileReader.listProfiles({ store });
  if (!Array.isArray(profileResult?.profiles)) {
    throw new CanonicalIdentityReadHarnessError('CANONICAL_PROFILE_READ_RESULT_INVALID');
  }
  const profileCandidates = profileResult.profiles.map((profile) => Object.freeze({
    sourceAuthority: profileCapability.sourceAuthority,
    profile,
  }));

  const binding = await resolveCanonicalAdvertiserProfileBinding({
    store,
    observedAdvertiserAccountId,
    advertiserAccounts: accountResult.advertiserAccounts,
    profileCandidates,
    verifiedAdvertiserAccountIdentifierType: accountCapability.verifiedAdvertiserAccountIdentifierType,
    verifiedProfileIdentifierType: accountCapability.verifiedProfileIdentifierType,
  });

  const entityResult = await entityReader.listSponsoredProductsEntities({
    store,
    profileId: binding.profileId,
    scopeHeader: AMAZON_ADS_SCOPE_HEADER,
  });
  if (!entityResult || typeof entityResult !== 'object' || Array.isArray(entityResult)) {
    throw new CanonicalIdentityReadHarnessError('CANONICAL_ENTITY_READ_RESULT_INVALID');
  }
  if (String(entityResult.profileId ?? '') !== binding.profileId) {
    throw new CanonicalIdentityReadHarnessError('CANONICAL_ENTITY_PROFILE_SCOPE_MISMATCH');
  }

  const entitySnapshot = await canonicalizeEntitySnapshot({
    profileId: binding.profileId,
    syncedAt: requiredText(entityResult.syncedAt, 'CANONICAL_ENTITY_SYNCED_AT_REQUIRED'),
    campaigns: entityResult.campaigns,
    adGroups: entityResult.adGroups,
    keywords: entityResult.keywords,
    targets: entityResult.targets,
  });

  const evidence = await buildCanonicalCsvIdentityEvidence({
    store,
    observedAdvertiserAccountId,
    advertiserAccounts: accountResult.advertiserAccounts,
    profileCandidates,
    verifiedAdvertiserAccountIdentifierType: accountCapability.verifiedAdvertiserAccountIdentifierType,
    verifiedProfileIdentifierType: accountCapability.verifiedProfileIdentifierType,
    csvRows,
    entitySnapshot,
  });

  return Object.freeze({
    ...evidence,
    readHarnessContract: CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT,
    entitySnapshotHash: entitySnapshot.snapshotHash,
    entitySnapshotCounts: entitySnapshot.counts,
    sideEffects: CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS,
  });
}

function assertReadAdapter(adapter, methodName, { requireSchemaAuthority = false } = {}) {
  if (!adapter || typeof adapter !== 'object' || typeof adapter[methodName] !== 'function') {
    throw new CanonicalIdentityReadHarnessError('CANONICAL_IDENTITY_READ_ADAPTER_INVALID');
  }
  const capability = adapter.capability;
  if (!capability || capability.contractVersion !== CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT) {
    throw new CanonicalIdentityReadHarnessError('CANONICAL_IDENTITY_READ_ADAPTER_INVALID');
  }
  if (capability.semanticReadOnly !== true) {
    throw new CanonicalIdentityReadHarnessError('CANONICAL_IDENTITY_READ_ADAPTER_NOT_READ_ONLY');
  }
  assertZeroSideEffects(capability.sideEffects);

  if (requireSchemaAuthority) {
    if (capability.schemaAuthorityVerified !== true) {
      throw new CanonicalIdentityReadHarnessError('ADVERTISER_ACCOUNT_SCHEMA_AUTHORITY_UNVERIFIED');
    }
    requiredText(
      capability.verifiedAdvertiserAccountIdentifierType,
      'ADVERTISER_ACCOUNT_SCHEMA_AUTHORITY_UNVERIFIED',
    );
    requiredText(
      capability.verifiedProfileIdentifierType,
      'ADVERTISER_ACCOUNT_SCHEMA_AUTHORITY_UNVERIFIED',
    );
  }
  return capability;
}

function assertZeroSideEffects(sideEffects) {
  if (!sideEffects || typeof sideEffects !== 'object' || Array.isArray(sideEffects)) {
    throw new CanonicalIdentityReadHarnessError('CANONICAL_IDENTITY_READ_SIDE_EFFECT_FORBIDDEN');
  }
  for (const key of Object.keys(CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS)) {
    if (sideEffects[key] !== false) {
      throw new CanonicalIdentityReadHarnessError('CANONICAL_IDENTITY_READ_SIDE_EFFECT_FORBIDDEN');
    }
  }
  for (const value of Object.values(sideEffects)) {
    if (value !== false) {
      throw new CanonicalIdentityReadHarnessError('CANONICAL_IDENTITY_READ_SIDE_EFFECT_FORBIDDEN');
    }
  }
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CanonicalIdentityReadHarnessError(code);
  return text;
}
