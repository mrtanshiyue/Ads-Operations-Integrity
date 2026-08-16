-- Ads Operations Integrity - Per-store D1
-- Migration 0004: indexes for cursor-based entity APIs and search-term analytics.

CREATE INDEX idx_campaigns_synced_cursor
  ON campaigns(synced_at DESC, campaign_id DESC);

CREATE INDEX idx_ad_groups_synced_cursor
  ON ad_groups(synced_at DESC, ad_group_id DESC);

CREATE INDEX idx_keywords_synced_cursor
  ON keywords(synced_at DESC, keyword_id DESC);

CREATE INDEX idx_targets_synced_cursor
  ON targets(synced_at DESC, target_id DESC);

CREATE INDEX idx_search_term_daily_profile_date
  ON search_term_daily(profile_id, report_date, campaign_id, ad_group_id);

CREATE INDEX idx_search_term_daily_adgroup_date
  ON search_term_daily(ad_group_id, report_date, normalized_search_term);

PRAGMA optimize;
