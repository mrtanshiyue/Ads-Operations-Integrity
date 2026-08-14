-- Ads Operations Integrity - Per-store D1
-- Migration 0001: Amazon Ads entity mirror, ingestion control, daily facts, and optimization action ledger.
-- One physical database is provisioned per Amazon store.
-- IDs are stored as TEXT to preserve Amazon identifiers exactly. Money uses integer micros.

PRAGMA foreign_keys = ON;

CREATE TABLE amazon_profiles (
  profile_id TEXT PRIMARY KEY,
  marketplace_id TEXT,
  country_code TEXT,
  currency_code TEXT,
  timezone TEXT,
  account_name TEXT,
  account_type TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE portfolios (
  portfolio_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT,
  state TEXT,
  budget_micros INTEGER CHECK (budget_micros IS NULL OR budget_micros >= 0),
  currency_code TEXT,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT
);

CREATE TABLE campaigns (
  campaign_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  portfolio_id TEXT,
  ad_product TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  targeting_type TEXT,
  bidding_strategy TEXT,
  daily_budget_micros INTEGER CHECK (daily_budget_micros IS NULL OR daily_budget_micros >= 0),
  start_date TEXT,
  end_date TEXT,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(portfolio_id) ON DELETE SET NULL
);

CREATE TABLE ad_groups (
  ad_group_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  default_bid_micros INTEGER CHECK (default_bid_micros IS NULL OR default_bid_micros >= 0),
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT
);

CREATE TABLE keywords (
  keyword_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  keyword_text TEXT NOT NULL,
  normalized_keyword TEXT NOT NULL,
  match_type TEXT NOT NULL,
  state TEXT NOT NULL,
  bid_micros INTEGER CHECK (bid_micros IS NULL OR bid_micros >= 0),
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (ad_group_id) REFERENCES ad_groups(ad_group_id) ON DELETE RESTRICT
);

CREATE TABLE targets (
  target_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  target_type TEXT,
  expression_json TEXT NOT NULL,
  expression_text TEXT,
  state TEXT NOT NULL,
  bid_micros INTEGER CHECK (bid_micros IS NULL OR bid_micros >= 0),
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (ad_group_id) REFERENCES ad_groups(ad_group_id) ON DELETE RESTRICT
);

CREATE TABLE product_ads (
  ad_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  asin TEXT,
  sku TEXT,
  state TEXT NOT NULL,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (ad_group_id) REFERENCES ad_groups(ad_group_id) ON DELETE RESTRICT
);

CREATE TABLE negative_keywords (
  negative_keyword_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT,
  keyword_text TEXT NOT NULL,
  normalized_keyword TEXT NOT NULL,
  match_type TEXT NOT NULL,
  state TEXT,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (ad_group_id) REFERENCES ad_groups(ad_group_id) ON DELETE RESTRICT
);

CREATE TABLE negative_targets (
  negative_target_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT,
  expression_json TEXT NOT NULL,
  expression_text TEXT,
  state TEXT,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_hash TEXT,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (ad_group_id) REFERENCES ad_groups(ad_group_id) ON DELETE RESTRICT
);

CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY,
  profile_id TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled','manual','recovery','backfill')),
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
  requested_by TEXT,
  started_at TEXT,
  completed_at TEXT,
  stats_json TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE SET NULL
);

CREATE TABLE report_jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT,
  profile_id TEXT NOT NULL,
  amazon_report_id TEXT UNIQUE,
  ad_product TEXT NOT NULL,
  report_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','requested','processing','ready','downloaded','ingested','failed','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  request_json TEXT,
  r2_object_key TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER CHECK (content_bytes IS NULL OR content_bytes >= 0),
  row_count INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  amazon_created_at TEXT,
  downloaded_at TEXT,
  ingested_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES sync_runs(run_id) ON DELETE SET NULL,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT
);

CREATE TABLE sync_watermarks (
  profile_id TEXT NOT NULL,
  dataset_key TEXT NOT NULL,
  watermark_date TEXT,
  watermark_cursor TEXT,
  last_success_run_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, dataset_key),
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE CASCADE,
  FOREIGN KEY (last_success_run_id) REFERENCES sync_runs(run_id) ON DELETE SET NULL
);

CREATE TABLE data_quality_issues (
  issue_id TEXT PRIMARY KEY,
  run_id TEXT,
  report_job_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  issue_code TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details_json TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES sync_runs(run_id) ON DELETE SET NULL,
  FOREIGN KEY (report_job_id) REFERENCES report_jobs(job_id) ON DELETE SET NULL
);

PRAGMA optimize;
