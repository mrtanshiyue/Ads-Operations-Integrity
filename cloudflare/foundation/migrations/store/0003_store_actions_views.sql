-- Ads Operations Integrity - Per-store D1
-- Migration 0003: optimization action ledger, query indexes, and efficiency views.

CREATE TABLE optimization_actions (
  action_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'rule',
  rule_key TEXT,
  before_json TEXT,
  proposed_json TEXT NOT NULL,
  rationale_json TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','applying','applied','failed','reverted')),
  created_by TEXT,
  approved_by TEXT,
  external_request_id TEXT,
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT
);

CREATE TABLE optimization_action_events (
  event_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  details_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (action_id) REFERENCES optimization_actions(action_id) ON DELETE CASCADE
);

CREATE INDEX idx_campaigns_profile_state ON campaigns(profile_id, state, ad_product);
CREATE INDEX idx_ad_groups_campaign ON ad_groups(campaign_id, state);
CREATE INDEX idx_keywords_adgroup_term ON keywords(ad_group_id, normalized_keyword, match_type);
CREATE INDEX idx_targets_adgroup ON targets(ad_group_id, state);
CREATE INDEX idx_product_ads_asin ON product_ads(profile_id, asin, sku);
CREATE INDEX idx_negative_keywords_term ON negative_keywords(profile_id, normalized_keyword, match_type);
CREATE INDEX idx_report_jobs_status ON report_jobs(status, created_at);
CREATE INDEX idx_report_jobs_dates ON report_jobs(profile_id, report_type, start_date, end_date);
CREATE INDEX idx_sync_runs_status ON sync_runs(status, created_at);
CREATE INDEX idx_dq_run ON data_quality_issues(run_id, severity);
CREATE INDEX idx_campaign_daily_date ON campaign_daily(report_date, campaign_id);
CREATE INDEX idx_ad_group_daily_date ON ad_group_daily(report_date, ad_group_id);
CREATE INDEX idx_keyword_daily_date ON keyword_daily(report_date, keyword_id);
CREATE INDEX idx_keyword_daily_campaign ON keyword_daily(campaign_id, report_date);
CREATE INDEX idx_target_daily_date ON target_daily(report_date, target_id);
CREATE INDEX idx_search_term_daily_term ON search_term_daily(normalized_search_term, report_date);
CREATE INDEX idx_search_term_daily_campaign ON search_term_daily(campaign_id, report_date);
CREATE INDEX idx_search_term_daily_cost ON search_term_daily(report_date, cost_micros DESC);
CREATE INDEX idx_advertised_product_daily_asin ON advertised_product_daily(advertised_asin, report_date);
CREATE INDEX idx_purchased_product_daily_asin ON purchased_product_daily(purchased_asin, report_date);
CREATE INDEX idx_placement_daily_campaign ON placement_daily(campaign_id, report_date);
CREATE INDEX idx_actions_entity ON optimization_actions(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_actions_status ON optimization_actions(status, created_at);

CREATE VIEW v_campaign_daily_efficiency AS
SELECT
  profile_id, report_date, ad_product, campaign_id,
  impressions, clicks, cost_micros, purchases, units_sold, sales_micros,
  CASE WHEN impressions > 0 THEN (100.0 * clicks / impressions) END AS ctr_pct,
  CASE WHEN clicks > 0 THEN (1.0 * cost_micros / clicks) END AS cpc_micros,
  CASE WHEN clicks > 0 THEN (100.0 * purchases / clicks) END AS cvr_pct,
  CASE WHEN sales_micros > 0 THEN (100.0 * cost_micros / sales_micros) END AS acos_pct,
  CASE WHEN cost_micros > 0 THEN (1.0 * sales_micros / cost_micros) END AS roas
FROM campaign_daily;

CREATE VIEW v_keyword_daily_efficiency AS
SELECT
  profile_id, report_date, ad_product, campaign_id, ad_group_id, keyword_id,
  impressions, clicks, cost_micros, purchases, units_sold, sales_micros,
  CASE WHEN impressions > 0 THEN (100.0 * clicks / impressions) END AS ctr_pct,
  CASE WHEN clicks > 0 THEN (1.0 * cost_micros / clicks) END AS cpc_micros,
  CASE WHEN clicks > 0 THEN (100.0 * purchases / clicks) END AS cvr_pct,
  CASE WHEN sales_micros > 0 THEN (100.0 * cost_micros / sales_micros) END AS acos_pct,
  CASE WHEN cost_micros > 0 THEN (1.0 * sales_micros / cost_micros) END AS roas
FROM keyword_daily;

CREATE VIEW v_search_term_daily_efficiency AS
SELECT
  row_key, profile_id, report_date, ad_product, campaign_id, ad_group_id, keyword_id, target_id,
  search_term, normalized_search_term, match_type,
  impressions, clicks, cost_micros, purchases, units_sold, sales_micros,
  CASE WHEN impressions > 0 THEN (100.0 * clicks / impressions) END AS ctr_pct,
  CASE WHEN clicks > 0 THEN (1.0 * cost_micros / clicks) END AS cpc_micros,
  CASE WHEN clicks > 0 THEN (100.0 * purchases / clicks) END AS cvr_pct,
  CASE WHEN sales_micros > 0 THEN (100.0 * cost_micros / sales_micros) END AS acos_pct,
  CASE WHEN cost_micros > 0 THEN (1.0 * sales_micros / cost_micros) END AS roas
FROM search_term_daily;

PRAGMA optimize;
