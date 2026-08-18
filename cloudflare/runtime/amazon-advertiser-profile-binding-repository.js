import {
  ADVERTISER_ACCOUNT_QUERY_CONTRACT,
  SPONSORED_ADS_PROFILE_AUTHORITY,
} from './amazon-advertiser-profile-binding.js';

const CONTRACT_VERSION = 'CanonicalAdvertiserProfileBindingV1';
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export class AdvertiserProfileBindingRepositoryError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'AdvertiserProfileBindingRepositoryError';
    this.code = code;
    this.cause = cause;
  }
}

export async function persistCanonicalAdvertiserProfileBindingReceipt({
  repository,
  binding,
  recordedAt,
}) {
  if (!repository || typeof repository.loadBindingReceipt !== 'function' || typeof repository.insertBindingReceipt !== 'function') {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_REPOSITORY_INVALID');
  }
  const row = bindingReceiptRow(binding, recordedAt);
  let existing = await repository.loadBindingReceipt(row.evidence_fingerprint);
  if (existing) {
    assertSameReceipt(existing, row);
    return Object.freeze({ reused:true, receipt:Object.freeze({ ...existing }) });
  }

  try {
    await repository.insertBindingReceipt(row);
  } catch (error) {
    existing = await repository.loadBindingReceipt(row.evidence_fingerprint);
    if (existing) {
      assertSameReceipt(existing, row);
      return Object.freeze({ reused:true, receipt:Object.freeze({ ...existing }) });
    }
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_RECEIPT_PERSIST_FAILED', error);
  }

  existing = await repository.loadBindingReceipt(row.evidence_fingerprint);
  if (!existing) {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_RECEIPT_MISSING');
  }
  assertSameReceipt(existing, row);
  return Object.freeze({ reused:false, receipt:Object.freeze({ ...existing }) });
}

export function bindingReceiptRow(binding, recordedAt) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_RECEIPT_INVALID');
  }
  const evidenceFingerprint = requiredText(binding.evidenceFingerprint, 'ADVERTISER_PROFILE_BINDING_FINGERPRINT_REQUIRED');
  if (!FINGERPRINT_PATTERN.test(evidenceFingerprint)) {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_FINGERPRINT_INVALID');
  }
  if (binding.contractVersion !== CONTRACT_VERSION) {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_CONTRACT_UNSUPPORTED');
  }
  if (binding.sourceContract !== ADVERTISER_ACCOUNT_QUERY_CONTRACT.sourceContract
      || binding.sourceEndpoint !== ADVERTISER_ACCOUNT_QUERY_CONTRACT.endpoint) {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_SOURCE_UNVERIFIED');
  }
  if (binding.relationCardinality !== 'not_assumed') {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_CARDINALITY_ASSUMPTION_FORBIDDEN');
  }
  if (binding.profileAuthority !== SPONSORED_ADS_PROFILE_AUTHORITY) {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_PROFILE_AUTHORITY_UNVERIFIED');
  }
  const accountType = requiredText(binding.accountType, 'ADVERTISER_PROFILE_BINDING_ACCOUNT_TYPE_REQUIRED').toLowerCase();
  if (accountType !== 'seller' && accountType !== 'vendor') {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_ACCOUNT_TYPE_UNSUPPORTED');
  }

  return Object.freeze({
    evidence_fingerprint: evidenceFingerprint,
    contract_version: CONTRACT_VERSION,
    advertiser_account_identifier_type: requiredText(
      binding.advertiserAccountIdentifierType,
      'ADVERTISER_PROFILE_BINDING_ACCOUNT_IDENTIFIER_TYPE_REQUIRED',
    ),
    advertiser_account_id: requiredText(binding.advertiserAccountId, 'ADVERTISER_PROFILE_BINDING_ACCOUNT_ID_REQUIRED'),
    profile_identifier_type: requiredText(binding.identifierType, 'ADVERTISER_PROFILE_BINDING_PROFILE_IDENTIFIER_TYPE_REQUIRED'),
    profile_id: requiredText(binding.profileId, 'ADVERTISER_PROFILE_BINDING_PROFILE_ID_REQUIRED'),
    marketplace_id: requiredText(binding.marketplaceId, 'ADVERTISER_PROFILE_BINDING_MARKETPLACE_ID_REQUIRED'),
    country_code: requiredText(binding.countryCode, 'ADVERTISER_PROFILE_BINDING_COUNTRY_CODE_REQUIRED').toUpperCase(),
    currency_code: requiredText(binding.currencyCode, 'ADVERTISER_PROFILE_BINDING_CURRENCY_CODE_REQUIRED').toUpperCase(),
    account_type: accountType,
    account_name: optionalText(binding.accountName),
    source_contract: binding.sourceContract,
    source_endpoint: binding.sourceEndpoint,
    source_observed_at: requiredText(binding.sourceObservedAt, 'ADVERTISER_PROFILE_BINDING_SOURCE_OBSERVED_AT_REQUIRED'),
    relation_cardinality: 'not_assumed',
    profile_authority: SPONSORED_ADS_PROFILE_AUTHORITY,
    recorded_at: requiredText(recordedAt, 'ADVERTISER_PROFILE_BINDING_RECORDED_AT_REQUIRED'),
  });
}

export function createD1AdvertiserProfileBindingReceiptRepository(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new AdvertiserProfileBindingRepositoryError('ADVERTISER_PROFILE_BINDING_D1_UNAVAILABLE');
  }
  return Object.freeze({
    async loadBindingReceipt(evidenceFingerprint) {
      return db.prepare(`
        SELECT evidence_fingerprint, contract_version,
               advertiser_account_identifier_type, advertiser_account_id,
               profile_identifier_type, profile_id,
               marketplace_id, country_code, currency_code,
               account_type, account_name,
               source_contract, source_endpoint, source_observed_at,
               relation_cardinality, profile_authority, recorded_at
        FROM amazon_advertiser_profile_binding_receipts
        WHERE evidence_fingerprint = ?1
        LIMIT 1
      `).bind(evidenceFingerprint).first();
    },

    async insertBindingReceipt(row) {
      return db.prepare(`
        INSERT INTO amazon_advertiser_profile_binding_receipts(
          evidence_fingerprint, contract_version,
          advertiser_account_identifier_type, advertiser_account_id,
          profile_identifier_type, profile_id,
          marketplace_id, country_code, currency_code,
          account_type, account_name,
          source_contract, source_endpoint, source_observed_at,
          relation_cardinality, profile_authority, recorded_at
        ) VALUES(
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
          ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
        )
      `).bind(
        row.evidence_fingerprint,
        row.contract_version,
        row.advertiser_account_identifier_type,
        row.advertiser_account_id,
        row.profile_identifier_type,
        row.profile_id,
        row.marketplace_id,
        row.country_code,
        row.currency_code,
        row.account_type,
        row.account_name,
        row.source_contract,
        row.source_endpoint,
        row.source_observed_at,
        row.relation_cardinality,
        row.profile_authority,
        row.recorded_at,
      ).run();
    },

    async listBindingReceiptsByAdvertiserAccount({ advertiserAccountIdentifierType, advertiserAccountId }) {
      return db.prepare(`
        SELECT evidence_fingerprint, contract_version,
               advertiser_account_identifier_type, advertiser_account_id,
               profile_identifier_type, profile_id,
               marketplace_id, country_code, currency_code,
               account_type, account_name,
               source_contract, source_endpoint, source_observed_at,
               relation_cardinality, profile_authority, recorded_at
        FROM amazon_advertiser_profile_binding_receipts
        WHERE advertiser_account_identifier_type = ?1
          AND advertiser_account_id = ?2
        ORDER BY source_observed_at DESC, evidence_fingerprint ASC
      `).bind(advertiserAccountIdentifierType, advertiserAccountId).all();
    },
  });
}

function assertSameReceipt(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if ((actual?.[key] ?? null) !== (value ?? null)) {
      throw new AdvertiserProfileBindingRepositoryError(`ADVERTISER_PROFILE_BINDING_RECEIPT_CONFLICT:${key}`);
    }
  }
  return true;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new AdvertiserProfileBindingRepositoryError(code);
  return text;
}

function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}
