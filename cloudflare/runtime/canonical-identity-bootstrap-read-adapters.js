import { SPONSORED_ADS_PROFILE_AUTHORITY } from './amazon-advertiser-profile-binding.js';
import {
  AMAZON_ADS_SCOPE_HEADER,
  CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT,
  CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS,
} from './canonical-identity-read-harness.js';

export class CanonicalIdentityBootstrapReadAdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CanonicalIdentityBootstrapReadAdapterError';
    this.code = code;
  }
}

export function createCanonicalIdentityBootstrapReadAdapters(bootstrapTransport, options = {}) {
  if (!bootstrapTransport || typeof bootstrapTransport !== 'object') {
    throw new CanonicalIdentityBootstrapReadAdapterError('CANONICAL_IDENTITY_BOOTSTRAP_TRANSPORT_INVALID');
  }
  if (typeof bootstrapTransport.listProfiles !== 'function') {
    throw new CanonicalIdentityBootstrapReadAdapterError('CANONICAL_IDENTITY_PROFILE_TRANSPORT_INVALID');
  }
  if (typeof bootstrapTransport.fetchEntitySnapshot !== 'function') {
    throw new CanonicalIdentityBootstrapReadAdapterError('CANONICAL_IDENTITY_ENTITY_TRANSPORT_INVALID');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  const profileReader = Object.freeze({
    capability: Object.freeze({
      contractVersion: CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT,
      semanticReadOnly: true,
      sourceAuthority: SPONSORED_ADS_PROFILE_AUTHORITY,
      sideEffects: CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS,
    }),
    async listProfiles() {
      const profiles = await bootstrapTransport.listProfiles();
      if (!Array.isArray(profiles)) {
        throw new CanonicalIdentityBootstrapReadAdapterError('CANONICAL_IDENTITY_PROFILE_RESULT_INVALID');
      }
      return Object.freeze({ profiles });
    },
  });

  const entityReader = Object.freeze({
    capability: Object.freeze({
      contractVersion: CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT,
      semanticReadOnly: true,
      scopeHeader: AMAZON_ADS_SCOPE_HEADER,
      sideEffects: CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS,
    }),
    async listSponsoredProductsEntities({ profileId, scopeHeader }) {
      const canonicalProfileId = requiredText(profileId, 'CANONICAL_IDENTITY_ENTITY_PROFILE_ID_REQUIRED');
      if (scopeHeader !== AMAZON_ADS_SCOPE_HEADER) {
        throw new CanonicalIdentityBootstrapReadAdapterError('CANONICAL_IDENTITY_ENTITY_SCOPE_HEADER_INVALID');
      }
      const snapshot = await bootstrapTransport.fetchEntitySnapshot({ profileId:canonicalProfileId });
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new CanonicalIdentityBootstrapReadAdapterError('CANONICAL_IDENTITY_ENTITY_RESULT_INVALID');
      }
      const syncedAt = verifiedTimestamp(now());
      return Object.freeze({
        profileId: canonicalProfileId,
        syncedAt,
        campaigns: requireArray(snapshot.campaigns),
        adGroups: requireArray(snapshot.adGroups),
        keywords: requireArray(snapshot.keywords),
        targets: requireArray(snapshot.targets),
      });
    },
  });

  return Object.freeze({ profileReader, entityReader });
}

function requireArray(value) {
  if (!Array.isArray(value)) {
    throw new CanonicalIdentityBootstrapReadAdapterError('CANONICAL_IDENTITY_ENTITY_ROWS_INVALID');
  }
  return value;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CanonicalIdentityBootstrapReadAdapterError(code);
  return text;
}

function verifiedTimestamp(value) {
  const text = requiredText(value, 'CANONICAL_IDENTITY_ENTITY_SYNCED_AT_INVALID');
  if (Number.isNaN(Date.parse(text))) {
    throw new CanonicalIdentityBootstrapReadAdapterError('CANONICAL_IDENTITY_ENTITY_SYNCED_AT_INVALID');
  }
  return text;
}
