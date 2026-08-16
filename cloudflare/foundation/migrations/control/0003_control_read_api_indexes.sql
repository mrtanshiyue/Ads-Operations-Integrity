-- Ads Operations Integrity - Control D1
-- Migration 0003: indexes for cursor-based control APIs and cross-store analytics.

CREATE INDEX idx_products_created_cursor
  ON products(created_at DESC, product_id DESC);

CREATE INDEX idx_keywords_created_cursor
  ON keyword_library(created_at DESC, keyword_id DESC);

CREATE INDEX idx_negative_keywords_created_cursor
  ON negative_keyword_library(created_at DESC, negative_keyword_id DESC);

CREATE INDEX idx_store_summary_store_date
  ON store_daily_summary(store_id, report_date, ad_product);

CREATE INDEX idx_product_summary_store_date
  ON product_daily_summary(store_id, report_date, ad_product, product_id);

CREATE INDEX idx_keyword_rollup_window_store
  ON keyword_performance_rollup(as_of_date, window_days, store_id, keyword_id);

PRAGMA optimize;
