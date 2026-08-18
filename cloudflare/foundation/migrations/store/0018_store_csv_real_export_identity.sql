-- CSV real Amazon Ads export compatibility.
-- Additive identity enrichment for localized daily Search Term exports.
-- Advertiser account IDs remain distinct from Amazon Ads profile IDs.

ALTER TABLE csv_import_batches ADD COLUMN advertiser_account_id TEXT;

ALTER TABLE csv_search_term_daily ADD COLUMN advertiser_account_id TEXT;
ALTER TABLE csv_search_term_daily ADD COLUMN portfolio_id TEXT;
ALTER TABLE csv_search_term_daily ADD COLUMN campaign_id TEXT;
ALTER TABLE csv_search_term_daily ADD COLUMN ad_group_id TEXT;
ALTER TABLE csv_search_term_daily ADD COLUMN targeting_id TEXT;
ALTER TABLE csv_search_term_daily
  ADD COLUMN targeting_identity_state TEXT NOT NULL DEFAULT 'name_only'
  CHECK (targeting_identity_state IN ('resolved_id','name_only','id_only','unresolved'));
ALTER TABLE csv_search_term_daily ADD COLUMN target_bid_micros INTEGER CHECK (target_bid_micros IS NULL OR target_bid_micros >= 0);
ALTER TABLE csv_search_term_daily ADD COLUMN targeting_type TEXT;
ALTER TABLE csv_search_term_daily ADD COLUMN targeting_state TEXT;

CREATE INDEX idx_csv_search_term_campaign_id
ON csv_search_term_daily(campaign_id, ad_group_id, report_date);
CREATE INDEX idx_csv_search_term_targeting_id
ON csv_search_term_daily(targeting_id, report_date);
CREATE INDEX idx_csv_import_advertiser_account
ON csv_import_batches(advertiser_account_id, uploaded_at DESC);

CREATE TRIGGER trg_csv_import_advertiser_account_immutable
BEFORE UPDATE OF advertiser_account_id ON csv_import_batches
WHEN OLD.advertiser_account_id IS NOT NEW.advertiser_account_id
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_ADVERTISER_ACCOUNT_IMMUTABLE');
END;

CREATE TRIGGER trg_csv_fact_real_identity_update_guard
BEFORE UPDATE ON csv_search_term_daily
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_FACT_REAL_IDENTITY_IMMUTABLE')
  WHERE OLD.advertiser_account_id IS NOT NEW.advertiser_account_id
     OR OLD.portfolio_id IS NOT NEW.portfolio_id
     OR OLD.campaign_id IS NOT NEW.campaign_id
     OR OLD.ad_group_id IS NOT NEW.ad_group_id
     OR OLD.targeting_id IS NOT NEW.targeting_id
     OR OLD.targeting_identity_state IS NOT NEW.targeting_identity_state;
END;

PRAGMA optimize;
