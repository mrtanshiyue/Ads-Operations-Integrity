-- Canonical advertiser account -> Sponsored Ads profile binding evidence.
-- Append-only receipts preserve authoritative observations without assuming 1:1 cardinality.

PRAGMA foreign_keys = ON;

CREATE TABLE amazon_advertiser_profile_binding_receipts (
  evidence_fingerprint TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL CHECK (contract_version = 'CanonicalAdvertiserProfileBindingV1'),
  advertiser_account_identifier_type TEXT NOT NULL CHECK (length(trim(advertiser_account_identifier_type)) > 0),
  advertiser_account_id TEXT NOT NULL CHECK (length(trim(advertiser_account_id)) > 0),
  profile_identifier_type TEXT NOT NULL CHECK (length(trim(profile_identifier_type)) > 0),
  profile_id TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('seller','vendor')),
  account_name TEXT,
  source_contract TEXT NOT NULL CHECK (length(trim(source_contract)) > 0),
  source_endpoint TEXT NOT NULL CHECK (length(trim(source_endpoint)) > 0),
  source_observed_at TEXT NOT NULL CHECK (length(trim(source_observed_at)) > 0),
  relation_cardinality TEXT NOT NULL CHECK (relation_cardinality = 'not_assumed'),
  profile_authority TEXT NOT NULL CHECK (profile_authority = 'amazon-ads-profiles-api-v2'),
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT
);

CREATE INDEX idx_advertiser_profile_binding_account
ON amazon_advertiser_profile_binding_receipts(
  advertiser_account_identifier_type,
  advertiser_account_id,
  source_observed_at DESC
);

CREATE INDEX idx_advertiser_profile_binding_profile
ON amazon_advertiser_profile_binding_receipts(profile_id, source_observed_at DESC);

CREATE TRIGGER trg_advertiser_profile_binding_insert_guard
BEFORE INSERT ON amazon_advertiser_profile_binding_receipts
BEGIN
  SELECT RAISE(ABORT, 'ADVERTISER_PROFILE_BINDING_FINGERPRINT_INVALID')
    WHERE length(NEW.evidence_fingerprint) <> 64
       OR NEW.evidence_fingerprint GLOB '*[^0-9a-f]*';
  SELECT RAISE(ABORT, 'ADVERTISER_PROFILE_BINDING_PROFILE_RECEIPT_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1
      FROM amazon_profiles p
      WHERE p.profile_id = NEW.profile_id
        AND p.status = 'active'
        AND p.marketplace_id = NEW.marketplace_id
        AND p.country_code = NEW.country_code
        AND p.currency_code = NEW.currency_code
        AND p.account_type = NEW.account_type
    );
END;

CREATE TRIGGER trg_advertiser_profile_binding_update_guard
BEFORE UPDATE ON amazon_advertiser_profile_binding_receipts
BEGIN
  SELECT RAISE(ABORT, 'ADVERTISER_PROFILE_BINDING_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER trg_advertiser_profile_binding_delete_guard
BEFORE DELETE ON amazon_advertiser_profile_binding_receipts
BEGIN
  SELECT RAISE(ABORT, 'ADVERTISER_PROFILE_BINDING_RECEIPT_IMMUTABLE');
END;

PRAGMA optimize;
