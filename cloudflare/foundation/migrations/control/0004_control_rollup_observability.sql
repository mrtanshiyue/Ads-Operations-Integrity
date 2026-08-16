-- Ads Operations Integrity - Control D1
-- Migration 0004: cross-store rollup run ledger and watermarks.
-- Keeps BI freshness/data-quality observable without storing raw report payloads in Control D1.

PRAGMA foreign_keys = ON;

CREATE TABLE rollup_runs (
  rollup_run_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  rollup_type TEXT NOT NULL CHECK (rollup_type IN ('store_daily','product_daily','keyword_window')),
  partition_key TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,
  as_of_date TEXT,
  window_days INTEGER CHECK (window_days IS NULL OR window_days IN (7,14,30,60,90,180,365)),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  source_rows INTEGER CHECK (source_rows IS NULL OR source_rows >= 0),
  summary_rows INTEGER CHECK (summary_rows IS NULL OR summary_rows >= 0),
  unmapped_rows INTEGER NOT NULL DEFAULT 0 CHECK (unmapped_rows >= 0),
  ambiguous_rows INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous_rows >= 0),
  error_code TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE
);

CREATE TABLE rollup_watermarks (
  store_id TEXT NOT NULL,
  rollup_type TEXT NOT NULL CHECK (rollup_type IN ('store_daily','product_daily','keyword_window')),
  partition_key TEXT NOT NULL DEFAULT '',
  last_success_date TEXT,
  last_success_as_of_date TEXT,
  last_success_run_id TEXT,
  summary_rows INTEGER,
  unmapped_rows INTEGER NOT NULL DEFAULT 0 CHECK (unmapped_rows >= 0),
  ambiguous_rows INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous_rows >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (store_id, rollup_type, partition_key),
  FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
  FOREIGN KEY (last_success_run_id) REFERENCES rollup_runs(rollup_run_id) ON DELETE SET NULL
);

CREATE INDEX idx_rollup_runs_store_type_started
  ON rollup_runs(store_id, rollup_type, started_at DESC);
CREATE INDEX idx_rollup_runs_status_started
  ON rollup_runs(status, started_at DESC);
CREATE INDEX idx_rollup_watermarks_type_updated
  ON rollup_watermarks(rollup_type, updated_at DESC);

PRAGMA optimize;
