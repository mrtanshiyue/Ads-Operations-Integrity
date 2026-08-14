-- Ads Operations Integrity - Control D1
-- Migration 0001: control-plane identity, RBAC, store registry, product/keyword governance,
-- cross-store rollups, settings, and audit.
-- IDs are application-generated UUID strings. Money is stored in integer micros (1 unit = 1e-6 currency unit).

PRAGMA foreign_keys = ON;

CREATE TABLE app_roles (
  role_key TEXT PRIMARY KEY,
  role_name TEXT NOT NULL,
  role_scope TEXT NOT NULL CHECK (role_scope IN ('global', 'store')),
  priority INTEGER NOT NULL DEFAULT 100,
  is_system INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE role_permissions (
  role_key TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_key, permission_key),
  FOREIGN KEY (role_key) REFERENCES app_roles(role_key) ON DELETE CASCADE
);

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  cf_access_sub TEXT UNIQUE,
  email TEXT NOT NULL,
  email_norm TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_global_roles (
  user_id TEXT NOT NULL,
  role_key TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_key),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (role_key) REFERENCES app_roles(role_key) ON DELETE RESTRICT,
  FOREIGN KEY (granted_by) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE stores (
  store_id TEXT PRIMARY KEY,
  store_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  marketplace_code TEXT NOT NULL DEFAULT 'US',
  amazon_region TEXT NOT NULL DEFAULT 'NA',
  d1_binding_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE store_members (
  store_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, user_id),
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (role_key) REFERENCES app_roles(role_key) ON DELETE RESTRICT
);

CREATE TABLE products (
  product_id TEXT PRIMARY KEY,
  model_code TEXT NOT NULL UNIQUE,
  model_name TEXT,
  brand TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  attributes_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE product_store_map (
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  seller_sku TEXT NOT NULL,
  asin TEXT,
  parent_asin TEXT,
  listing_status TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, product_id, seller_sku),
  UNIQUE (store_id, seller_sku),
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

CREATE TABLE keyword_library (
  keyword_id TEXT PRIMARY KEY,
  keyword_text TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  language_code TEXT NOT NULL DEFAULT 'en-US',
  intent_class TEXT,
  semantic_cluster TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active','watch','retired')),
  source_type TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (normalized_term, language_code),
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE keyword_product_map (
  keyword_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  relevance_score INTEGER CHECK (relevance_score IS NULL OR (relevance_score BETWEEN 0 AND 1000)),
  priority INTEGER NOT NULL DEFAULT 100,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (keyword_id, product_id),
  FOREIGN KEY (keyword_id) REFERENCES keyword_library(keyword_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

CREATE TABLE keyword_store_policy (
  store_id TEXT NOT NULL,
  keyword_id TEXT NOT NULL,
  policy_status TEXT NOT NULL DEFAULT 'active' CHECK (policy_status IN ('active','watch','blocked','retired')),
  min_bid_micros INTEGER CHECK (min_bid_micros IS NULL OR min_bid_micros >= 0),
  max_bid_micros INTEGER CHECK (max_bid_micros IS NULL OR max_bid_micros >= 0),
  target_acos_bps INTEGER CHECK (target_acos_bps IS NULL OR target_acos_bps >= 0),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, keyword_id),
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  FOREIGN KEY (keyword_id) REFERENCES keyword_library(keyword_id) ON DELETE CASCADE
);

CREATE TABLE negative_keyword_library (
  negative_keyword_id TEXT PRIMARY KEY,
  keyword_text TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type IN ('EXACT','PHRASE')),
  reason_code TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (normalized_term, match_type),
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE negative_store_scope (
  store_id TEXT NOT NULL,
  negative_keyword_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, negative_keyword_id),
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  FOREIGN KEY (negative_keyword_id) REFERENCES negative_keyword_library(negative_keyword_id) ON DELETE CASCADE
);

CREATE TABLE negative_product_scope (
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  negative_keyword_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, product_id, negative_keyword_id),
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE,
  FOREIGN KEY (negative_keyword_id) REFERENCES negative_keyword_library(negative_keyword_id) ON DELETE CASCADE
);

CREATE TABLE optimization_rules (
  rule_id TEXT PRIMARY KEY,
  rule_key TEXT NOT NULL UNIQUE,
  rule_name TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global','store','product')),
  store_id TEXT,
  product_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 100,
  config_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value_json TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0 CHECK (is_secret = 0),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE store_sync_status (
  store_id TEXT PRIMARY KEY,
  sync_status TEXT NOT NULL DEFAULT 'never' CHECK (sync_status IN ('never','idle','running','degraded','failed','paused')),
  active_run_id TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error_code TEXT,
  lag_minutes INTEGER CHECK (lag_minutes IS NULL OR lag_minutes >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE
);

CREATE TABLE store_daily_summary (
  store_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  ad_product TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  purchases INTEGER NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  units_sold INTEGER NOT NULL DEFAULT 0 CHECK (units_sold >= 0),
  sales_micros INTEGER NOT NULL DEFAULT 0 CHECK (sales_micros >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, report_date, ad_product),
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE
);

CREATE TABLE product_daily_summary (
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  ad_product TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  purchases INTEGER NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  units_sold INTEGER NOT NULL DEFAULT 0 CHECK (units_sold >= 0),
  sales_micros INTEGER NOT NULL DEFAULT 0 CHECK (sales_micros >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, product_id, report_date, ad_product),
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

CREATE TABLE keyword_performance_rollup (
  store_id TEXT NOT NULL,
  keyword_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  window_days INTEGER NOT NULL CHECK (window_days IN (7,14,30,60,90,180,365)),
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  purchases INTEGER NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  units_sold INTEGER NOT NULL DEFAULT 0 CHECK (units_sold >= 0),
  sales_micros INTEGER NOT NULL DEFAULT 0 CHECK (sales_micros >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, keyword_id, as_of_date, window_days),
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  FOREIGN KEY (keyword_id) REFERENCES keyword_library(keyword_id) ON DELETE CASCADE
);

CREATE TABLE audit_log (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_user_id TEXT,
  store_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  request_id TEXT,
  cf_ray TEXT,
  details_json TEXT,
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE SET NULL
);

CREATE INDEX idx_users_access_sub ON users(cf_access_sub);
CREATE INDEX idx_store_members_user ON store_members(user_id, store_id);
CREATE INDEX idx_product_store_asin ON product_store_map(store_id, asin);
CREATE INDEX idx_keyword_library_term ON keyword_library(normalized_term);
CREATE INDEX idx_keyword_product_product ON keyword_product_map(product_id, priority);
CREATE INDEX idx_store_summary_date ON store_daily_summary(report_date, store_id);
CREATE INDEX idx_product_summary_date ON product_daily_summary(report_date, store_id, product_id);
CREATE INDEX idx_keyword_rollup_date ON keyword_performance_rollup(as_of_date, window_days, store_id);
CREATE INDEX idx_audit_occurred ON audit_log(occurred_at DESC);
CREATE INDEX idx_audit_store ON audit_log(store_id, occurred_at DESC);

CREATE VIEW v_store_daily_efficiency AS
SELECT
  store_id,
  report_date,
  ad_product,
  impressions,
  clicks,
  cost_micros,
  purchases,
  units_sold,
  sales_micros,
  CASE WHEN impressions > 0 THEN (100.0 * clicks / impressions) END AS ctr_pct,
  CASE WHEN clicks > 0 THEN (1.0 * cost_micros / clicks) END AS cpc_micros,
  CASE WHEN clicks > 0 THEN (100.0 * purchases / clicks) END AS cvr_pct,
  CASE WHEN sales_micros > 0 THEN (100.0 * cost_micros / sales_micros) END AS acos_pct,
  CASE WHEN cost_micros > 0 THEN (1.0 * sales_micros / cost_micros) END AS roas
FROM store_daily_summary;

INSERT INTO app_roles(role_key, role_name, role_scope, priority, is_system) VALUES
  ('owner', 'Owner', 'global', 1, 1),
  ('admin', 'Admin', 'global', 10, 1),
  ('operator', 'Operator', 'store', 30, 1),
  ('analyst', 'Analyst', 'store', 50, 1),
  ('viewer', 'Viewer', 'store', 90, 1);

INSERT INTO role_permissions(role_key, permission_key) VALUES
  ('owner','system.manage'), ('owner','users.manage'), ('owner','stores.manage'), ('owner','products.manage'),
  ('owner','keywords.manage'), ('owner','rules.manage'), ('owner','analytics.read'), ('owner','ads.read'),
  ('owner','ads.write'), ('owner','sync.run'), ('owner','sync.read'), ('owner','audit.read'),
  ('admin','users.manage'), ('admin','stores.manage'), ('admin','products.manage'), ('admin','keywords.manage'),
  ('admin','rules.manage'), ('admin','analytics.read'), ('admin','ads.read'), ('admin','ads.write'),
  ('admin','sync.run'), ('admin','sync.read'), ('admin','audit.read'),
  ('operator','products.manage'), ('operator','keywords.manage'), ('operator','analytics.read'),
  ('operator','ads.read'), ('operator','ads.write'), ('operator','sync.run'), ('operator','sync.read'),
  ('analyst','analytics.read'), ('analyst','ads.read'), ('analyst','sync.read'),
  ('viewer','analytics.read'), ('viewer','ads.read');

PRAGMA optimize;
