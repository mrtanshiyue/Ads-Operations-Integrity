-- Productization / CSV real-data track.
-- Formal, source-neutral CSV authority for Amazon Ads console Search Term exports.
-- This migration is additive: the existing Amazon report_jobs ingestion path remains unchanged.

CREATE TABLE csv_import_batches (
  import_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'csv' CHECK (source_type = 'csv'),
  source_file_name TEXT NOT NULL,
  report_type TEXT NOT NULL CHECK (report_type = 'spSearchTerm'),
  marketplace TEXT,
  profile_id TEXT,
  currency_code TEXT,
  report_start_date TEXT NOT NULL,
  report_end_date TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
  schema_version TEXT NOT NULL CHECK (schema_version = 'csv-import-v1'),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  accepted_rows INTEGER NOT NULL CHECK (accepted_rows >= 0),
  rejected_rows INTEGER NOT NULL CHECK (rejected_rows >= 0),
  duplicate_status TEXT NOT NULL DEFAULT 'unique' CHECK (duplicate_status IN ('unique','duplicate')),
  status TEXT NOT NULL CHECK (status IN ('validated','published','rejected')),
  validation_summary_json TEXT NOT NULL CHECK (json_valid(validation_summary_json)),
  uploaded_at TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (report_start_date <= report_end_date),
  CHECK (accepted_rows + rejected_rows = row_count),
  CHECK ((status = 'published' AND rejected_rows = 0 AND published_at IS NOT NULL)
      OR (status <> 'published' AND published_at IS NULL))
);

-- Per-store D1 already scopes the store. A byte-identical report for the same type/range is one import authority.
CREATE UNIQUE INDEX uq_csv_import_identity
ON csv_import_batches(content_sha256, report_type, report_start_date, report_end_date);
CREATE INDEX idx_csv_import_history ON csv_import_batches(uploaded_at DESC, import_id);
CREATE INDEX idx_csv_import_range ON csv_import_batches(report_start_date, report_end_date, report_type);

CREATE TABLE csv_import_errors (
  import_id TEXT NOT NULL,
  error_ordinal INTEGER NOT NULL CHECK (error_ordinal >= 0),
  source_row_ordinal INTEGER CHECK (source_row_ordinal IS NULL OR source_row_ordinal >= 0),
  error_code TEXT NOT NULL,
  column_key TEXT,
  safe_value_excerpt TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (import_id, error_ordinal),
  FOREIGN KEY (import_id) REFERENCES csv_import_batches(import_id) ON DELETE CASCADE
);

CREATE TABLE csv_search_term_stage (
  import_id TEXT NOT NULL,
  source_row_ordinal INTEGER NOT NULL CHECK (source_row_ordinal >= 0),
  logical_row_key TEXT NOT NULL,
  canonical_row_json TEXT NOT NULL CHECK (json_valid(canonical_row_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (import_id, source_row_ordinal),
  UNIQUE (import_id, logical_row_key),
  FOREIGN KEY (import_id) REFERENCES csv_import_batches(import_id) ON DELETE CASCADE
);

-- Source-neutral operational facts. Amazon IDs are optional because Ads Console exports may expose only names.
-- Downstream product pages can use these facts without pretending that name-based identities are Amazon API IDs.
CREATE TABLE csv_search_term_daily (
  row_key TEXT PRIMARY KEY,
  report_date TEXT NOT NULL,
  portfolio_name TEXT,
  campaign_name TEXT NOT NULL,
  ad_group_name TEXT NOT NULL,
  targeting TEXT NOT NULL,
  match_type TEXT,
  search_term TEXT NOT NULL,
  normalized_search_term TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  purchases INTEGER NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  units_sold INTEGER NOT NULL DEFAULT 0 CHECK (units_sold >= 0),
  sales_micros INTEGER NOT NULL DEFAULT 0 CHECK (sales_micros >= 0),
  marketplace TEXT,
  profile_id TEXT,
  currency_code TEXT,
  source_import_id TEXT NOT NULL,
  source_row_ordinal INTEGER NOT NULL CHECK (source_row_ordinal >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_import_id) REFERENCES csv_import_batches(import_id) ON DELETE RESTRICT
);
CREATE INDEX idx_csv_search_term_date ON csv_search_term_daily(report_date);
CREATE INDEX idx_csv_search_term_campaign ON csv_search_term_daily(campaign_name, ad_group_name, report_date);
CREATE INDEX idx_csv_search_term_search ON csv_search_term_daily(normalized_search_term, report_date);
CREATE INDEX idx_csv_search_term_import ON csv_search_term_daily(source_import_id, source_row_ordinal);

CREATE TRIGGER trg_csv_import_batch_update_guard
BEFORE UPDATE ON csv_import_batches
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_IMMUTABLE')
  WHERE OLD.source_type IS NOT NEW.source_type
     OR OLD.source_file_name IS NOT NEW.source_file_name
     OR OLD.report_type IS NOT NEW.report_type
     OR OLD.marketplace IS NOT NEW.marketplace
     OR OLD.profile_id IS NOT NEW.profile_id
     OR OLD.currency_code IS NOT NEW.currency_code
     OR OLD.report_start_date IS NOT NEW.report_start_date
     OR OLD.report_end_date IS NOT NEW.report_end_date
     OR OLD.content_sha256 IS NOT NEW.content_sha256
     OR OLD.content_bytes IS NOT NEW.content_bytes
     OR OLD.schema_version IS NOT NEW.schema_version
     OR OLD.row_count IS NOT NEW.row_count
     OR OLD.accepted_rows IS NOT NEW.accepted_rows
     OR OLD.rejected_rows IS NOT NEW.rejected_rows
     OR OLD.duplicate_status IS NOT NEW.duplicate_status
     OR OLD.validation_summary_json IS NOT NEW.validation_summary_json
     OR OLD.uploaded_at IS NOT NEW.uploaded_at;

  SELECT RAISE(ABORT, 'CSV_IMPORT_PUBLISHED_AT_IMMUTABLE')
  WHERE OLD.published_at IS NOT NULL AND OLD.published_at IS NOT NEW.published_at;

  SELECT RAISE(ABORT, 'CSV_IMPORT_STATUS_TRANSITION_INVALID')
  WHERE OLD.status <> NEW.status
    AND NOT (OLD.status = 'validated' AND NEW.status = 'published');
END;

CREATE TRIGGER trg_csv_stage_insert_guard
BEFORE INSERT ON csv_search_term_stage
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_STAGE_NOT_VALIDATED')
  WHERE NOT EXISTS (
    SELECT 1 FROM csv_import_batches b
    WHERE b.import_id = NEW.import_id
      AND b.status = 'validated'
      AND b.rejected_rows = 0
      AND b.duplicate_status = 'unique'
  );
  SELECT RAISE(ABORT, 'CSV_IMPORT_STAGE_ROW_KEY_MISMATCH')
  WHERE json_type(NEW.canonical_row_json, '$.rowKey') <> 'text'
     OR json_extract(NEW.canonical_row_json, '$.rowKey') IS NOT NEW.logical_row_key;
  SELECT RAISE(ABORT, 'CSV_IMPORT_STAGE_ORDINAL_MISMATCH')
  WHERE json_type(NEW.canonical_row_json, '$.sourceRowOrdinal') <> 'integer'
     OR CAST(json_extract(NEW.canonical_row_json, '$.sourceRowOrdinal') AS INTEGER) <> NEW.source_row_ordinal;
END;

CREATE TRIGGER trg_csv_stage_update_guard
BEFORE UPDATE ON csv_search_term_stage
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_STAGE_IMMUTABLE');
END;

CREATE TRIGGER trg_csv_stage_delete_guard
BEFORE DELETE ON csv_search_term_stage
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_STAGE_DELETE_BEFORE_PUBLISH')
  WHERE NOT EXISTS (
    SELECT 1 FROM csv_import_batches b
    WHERE b.import_id = OLD.import_id AND b.status = 'published'
  );
END;

CREATE TRIGGER trg_csv_fact_insert_guard
BEFORE INSERT ON csv_search_term_daily
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_FACT_SOURCE_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM csv_import_batches b
    WHERE b.import_id = NEW.source_import_id
      AND b.status IN ('validated','published')
      AND NEW.report_date BETWEEN b.report_start_date AND b.report_end_date
  );
END;

CREATE TRIGGER trg_csv_fact_update_guard
BEFORE UPDATE ON csv_search_term_daily
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_FACT_IDENTITY_IMMUTABLE')
  WHERE OLD.row_key IS NOT NEW.row_key
     OR OLD.report_date IS NOT NEW.report_date
     OR OLD.portfolio_name IS NOT NEW.portfolio_name
     OR OLD.campaign_name IS NOT NEW.campaign_name
     OR OLD.ad_group_name IS NOT NEW.ad_group_name
     OR OLD.targeting IS NOT NEW.targeting
     OR OLD.match_type IS NOT NEW.match_type
     OR OLD.search_term IS NOT NEW.search_term
     OR OLD.normalized_search_term IS NOT NEW.normalized_search_term;
  SELECT RAISE(ABORT, 'CSV_IMPORT_FACT_SOURCE_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM csv_import_batches b
    WHERE b.import_id = NEW.source_import_id
      AND b.status IN ('validated','published')
      AND NEW.report_date BETWEEN b.report_start_date AND b.report_end_date
  );
END;

PRAGMA optimize;
