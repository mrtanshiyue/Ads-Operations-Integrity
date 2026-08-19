-- Settlement / financial CSV production acceptance foundation.
-- Additive and domain-specific: search-term CSV authority/facts are not reused or widened.
-- Raw source bytes remain immutable in R2; normalized facts deliberately omit order location fields.

CREATE TABLE settlement_import_source_objects (
  import_id TEXT PRIMARY KEY,
  source_object_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL DEFAULT 'manual_csv_upload' CHECK (source_kind = 'manual_csv_upload'),
  r2_binding_key TEXT NOT NULL DEFAULT 'DATA_BUCKET' CHECK (r2_binding_key = 'DATA_BUCKET'),
  object_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes > 0),
  content_type TEXT,
  source_file_name TEXT NOT NULL CHECK (length(trim(source_file_name)) > 0),
  importer_user_id TEXT NOT NULL CHECK (length(trim(importer_user_id)) > 0),
  uploaded_at TEXT NOT NULL CHECK (length(trim(uploaded_at)) > 0),
  r2_etag TEXT,
  r2_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_settlement_import_source_sha256
ON settlement_import_source_objects(content_sha256, import_id);

CREATE TABLE settlement_import_batches (
  import_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'csv' CHECK (source_type = 'csv'),
  source_file_name TEXT NOT NULL CHECK (length(trim(source_file_name)) > 0),
  report_type TEXT NOT NULL CHECK (report_type = 'amazonSettlementTransaction'),
  marketplace TEXT,
  currency_code TEXT NOT NULL CHECK (length(trim(currency_code)) = 3),
  report_start_date TEXT NOT NULL,
  report_end_date TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes > 0),
  schema_version TEXT NOT NULL CHECK (schema_version = 'settlement-csv-import-v1'),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  accepted_rows INTEGER NOT NULL CHECK (accepted_rows >= 0),
  rejected_rows INTEGER NOT NULL CHECK (rejected_rows >= 0),
  duplicate_status TEXT NOT NULL DEFAULT 'unique' CHECK (duplicate_status IN ('unique','duplicate')),
  status TEXT NOT NULL CHECK (status IN ('validated','published','rejected')),
  validation_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(validation_summary_json)),
  uploaded_at TEXT NOT NULL CHECK (length(trim(uploaded_at)) > 0),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (report_start_date <= report_end_date),
  CHECK (accepted_rows + rejected_rows = row_count),
  CHECK ((status = 'published' AND rejected_rows = 0 AND published_at IS NOT NULL)
      OR (status <> 'published' AND published_at IS NULL))
);

CREATE UNIQUE INDEX uq_settlement_import_identity
ON settlement_import_batches(content_sha256, report_type, report_start_date, report_end_date);
CREATE INDEX idx_settlement_import_history ON settlement_import_batches(uploaded_at DESC, import_id);
CREATE INDEX idx_settlement_import_range ON settlement_import_batches(report_start_date, report_end_date);

CREATE TABLE settlement_import_errors (
  import_id TEXT NOT NULL,
  error_ordinal INTEGER NOT NULL CHECK (error_ordinal >= 0),
  source_row_ordinal INTEGER CHECK (source_row_ordinal IS NULL OR source_row_ordinal >= 0),
  error_code TEXT NOT NULL,
  column_key TEXT,
  safe_value_excerpt TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (import_id, error_ordinal),
  FOREIGN KEY (import_id) REFERENCES settlement_import_batches(import_id) ON DELETE CASCADE
);

CREATE TABLE settlement_transaction_stage (
  import_id TEXT NOT NULL,
  source_row_ordinal INTEGER NOT NULL CHECK (source_row_ordinal >= 0),
  logical_row_key TEXT NOT NULL,
  canonical_row_json TEXT NOT NULL CHECK (json_valid(canonical_row_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (import_id, source_row_ordinal),
  UNIQUE (import_id, logical_row_key),
  FOREIGN KEY (import_id) REFERENCES settlement_import_batches(import_id) ON DELETE CASCADE
);

CREATE TABLE settlement_transactions (
  row_key TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL,
  posted_date TEXT NOT NULL,
  settlement_id TEXT,
  transaction_type TEXT NOT NULL CHECK (length(trim(transaction_type)) > 0),
  order_id TEXT,
  sku TEXT,
  description TEXT,
  quantity INTEGER,
  marketplace TEXT,
  account_type TEXT,
  fulfillment TEXT,
  tax_collection_model TEXT,
  product_sales_micros INTEGER NOT NULL DEFAULT 0,
  product_sales_tax_micros INTEGER NOT NULL DEFAULT 0,
  shipping_credits_micros INTEGER NOT NULL DEFAULT 0,
  shipping_credits_tax_micros INTEGER NOT NULL DEFAULT 0,
  gift_wrap_credits_micros INTEGER NOT NULL DEFAULT 0,
  gift_wrap_credits_tax_micros INTEGER NOT NULL DEFAULT 0,
  regulatory_fee_micros INTEGER NOT NULL DEFAULT 0,
  tax_on_regulatory_fee_micros INTEGER NOT NULL DEFAULT 0,
  promotional_rebates_micros INTEGER NOT NULL DEFAULT 0,
  promotional_rebates_tax_micros INTEGER NOT NULL DEFAULT 0,
  marketplace_withheld_tax_micros INTEGER NOT NULL DEFAULT 0,
  selling_fees_micros INTEGER NOT NULL DEFAULT 0,
  fba_fees_micros INTEGER NOT NULL DEFAULT 0,
  other_transaction_fees_micros INTEGER NOT NULL DEFAULT 0,
  other_micros INTEGER NOT NULL DEFAULT 0,
  total_micros INTEGER NOT NULL DEFAULT 0,
  transaction_status TEXT,
  transaction_release_at TEXT,
  currency_code TEXT NOT NULL CHECK (length(trim(currency_code)) = 3),
  source_import_id TEXT NOT NULL,
  source_row_ordinal INTEGER NOT NULL CHECK (source_row_ordinal >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_import_id, source_row_ordinal),
  FOREIGN KEY (source_import_id) REFERENCES settlement_import_batches(import_id) ON DELETE RESTRICT
);

CREATE INDEX idx_settlement_transactions_posted ON settlement_transactions(posted_date);
CREATE INDEX idx_settlement_transactions_settlement ON settlement_transactions(settlement_id, posted_date);
CREATE INDEX idx_settlement_transactions_order ON settlement_transactions(order_id, posted_date);
CREATE INDEX idx_settlement_transactions_sku ON settlement_transactions(sku, posted_date);
CREATE INDEX idx_settlement_transactions_import ON settlement_transactions(source_import_id, source_row_ordinal);

CREATE TABLE settlement_import_reconciliation_receipts (
  import_id TEXT PRIMARY KEY,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  component_sum_micros INTEGER NOT NULL,
  reported_total_micros INTEGER NOT NULL,
  difference_micros INTEGER NOT NULL,
  mismatch_rows INTEGER NOT NULL CHECK (mismatch_rows >= 0),
  status TEXT NOT NULL CHECK (status IN ('pass','fail')),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (difference_micros = component_sum_micros - reported_total_micros),
  CHECK ((status = 'pass' AND difference_micros = 0 AND mismatch_rows = 0)
      OR status = 'fail'),
  FOREIGN KEY (import_id) REFERENCES settlement_import_batches(import_id) ON DELETE RESTRICT
);

CREATE TABLE settlement_import_authority (
  import_id TEXT PRIMARY KEY,
  data_class TEXT NOT NULL CHECK (data_class IN ('unclassified','business','acceptance')),
  provenance_class TEXT NOT NULL CHECK (provenance_class = 'exact_source_object'),
  authority_version INTEGER NOT NULL DEFAULT 1 CHECK (authority_version >= 1),
  actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (import_id) REFERENCES settlement_import_batches(import_id) ON DELETE RESTRICT
);

CREATE INDEX idx_settlement_import_authority_class
ON settlement_import_authority(data_class, provenance_class, import_id);

CREATE TABLE settlement_import_authority_events (
  import_id TEXT NOT NULL,
  authority_version INTEGER NOT NULL CHECK (authority_version >= 1),
  data_class TEXT NOT NULL CHECK (data_class IN ('unclassified','business','acceptance')),
  provenance_class TEXT NOT NULL CHECK (provenance_class = 'exact_source_object'),
  actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (import_id, authority_version),
  FOREIGN KEY (import_id) REFERENCES settlement_import_batches(import_id) ON DELETE RESTRICT
);

CREATE INDEX idx_settlement_authority_events_recorded
ON settlement_import_authority_events(recorded_at DESC, import_id, authority_version DESC);

CREATE TRIGGER trg_settlement_source_object_update_guard
BEFORE UPDATE ON settlement_import_source_objects
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_SOURCE_OBJECT_IMMUTABLE');
END;

CREATE TRIGGER trg_settlement_source_object_delete_guard
BEFORE DELETE ON settlement_import_source_objects
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_SOURCE_OBJECT_IMMUTABLE');
END;

CREATE TRIGGER trg_settlement_batch_source_object_guard
BEFORE INSERT ON settlement_import_batches
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_SOURCE_OBJECT_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1 FROM settlement_import_source_objects s
    WHERE s.import_id = NEW.import_id
      AND s.content_sha256 = NEW.content_sha256
      AND s.content_bytes = NEW.content_bytes
      AND s.source_file_name = NEW.source_file_name
      AND s.uploaded_at = NEW.uploaded_at
  );
END;

CREATE TRIGGER trg_settlement_batch_seed_authority
AFTER INSERT ON settlement_import_batches
BEGIN
  INSERT INTO settlement_import_authority(
    import_id,data_class,provenance_class,authority_version,
    actor_user_id,reason,evidence_json,created_at,updated_at
  ) VALUES(
    NEW.import_id,'unclassified','exact_source_object',1,
    'system:settlement-import-source-object',
    'new_import_requires_explicit_data_classification',
    json_object('source','0024_seed','contentSha256',NEW.content_sha256),
    CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  );
END;

CREATE TRIGGER trg_settlement_batch_update_guard
BEFORE UPDATE ON settlement_import_batches
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_IMPORT_AUTHORITY_IMMUTABLE')
  WHERE OLD.source_type IS NOT NEW.source_type
     OR OLD.source_file_name IS NOT NEW.source_file_name
     OR OLD.report_type IS NOT NEW.report_type
     OR OLD.marketplace IS NOT NEW.marketplace
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

  SELECT RAISE(ABORT, 'SETTLEMENT_IMPORT_PUBLISHED_AT_IMMUTABLE')
  WHERE OLD.published_at IS NOT NULL AND OLD.published_at IS NOT NEW.published_at;

  SELECT RAISE(ABORT, 'SETTLEMENT_IMPORT_STATUS_TRANSITION_INVALID')
  WHERE OLD.status <> NEW.status
    AND NOT (OLD.status = 'validated' AND NEW.status = 'published');

  SELECT RAISE(ABORT, 'SETTLEMENT_RECONCILIATION_REQUIRED')
  WHERE OLD.status = 'validated' AND NEW.status = 'published'
    AND NOT EXISTS (
      SELECT 1 FROM settlement_import_reconciliation_receipts r
      WHERE r.import_id = NEW.import_id
        AND r.status = 'pass'
        AND r.row_count = NEW.accepted_rows
    );
END;

CREATE TRIGGER trg_settlement_stage_insert_guard
BEFORE INSERT ON settlement_transaction_stage
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_STAGE_NOT_VALIDATED')
  WHERE NOT EXISTS (
    SELECT 1 FROM settlement_import_batches b
    WHERE b.import_id = NEW.import_id
      AND b.status = 'validated'
      AND b.rejected_rows = 0
      AND b.duplicate_status = 'unique'
  );
  SELECT RAISE(ABORT, 'SETTLEMENT_STAGE_ROW_KEY_MISMATCH')
  WHERE json_type(NEW.canonical_row_json, '$.rowKey') <> 'text'
     OR json_extract(NEW.canonical_row_json, '$.rowKey') IS NOT NEW.logical_row_key;
  SELECT RAISE(ABORT, 'SETTLEMENT_STAGE_ORDINAL_MISMATCH')
  WHERE json_type(NEW.canonical_row_json, '$.sourceRowOrdinal') <> 'integer'
     OR CAST(json_extract(NEW.canonical_row_json, '$.sourceRowOrdinal') AS INTEGER) <> NEW.source_row_ordinal;
  SELECT RAISE(ABORT, 'SETTLEMENT_STAGE_LOCATION_DATA_FORBIDDEN')
  WHERE json_type(NEW.canonical_row_json, '$.orderCity') IS NOT NULL
     OR json_type(NEW.canonical_row_json, '$.orderState') IS NOT NULL
     OR json_type(NEW.canonical_row_json, '$.orderPostal') IS NOT NULL;
END;

CREATE TRIGGER trg_settlement_stage_update_guard
BEFORE UPDATE ON settlement_transaction_stage
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_STAGE_IMMUTABLE');
END;

CREATE TRIGGER trg_settlement_stage_delete_guard
BEFORE DELETE ON settlement_transaction_stage
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_STAGE_DELETE_BEFORE_PUBLISH')
  WHERE NOT EXISTS (
    SELECT 1 FROM settlement_import_batches b
    WHERE b.import_id = OLD.import_id AND b.status = 'published'
  );
END;

CREATE TRIGGER trg_settlement_fact_insert_guard
BEFORE INSERT ON settlement_transactions
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_FACT_SOURCE_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM settlement_import_batches b
    JOIN settlement_import_source_objects s ON s.import_id = b.import_id
    WHERE b.import_id = NEW.source_import_id
      AND b.status IN ('validated','published')
      AND NEW.posted_date BETWEEN b.report_start_date AND b.report_end_date
      AND s.content_sha256 = b.content_sha256
      AND s.content_bytes = b.content_bytes
      AND s.source_file_name = b.source_file_name
      AND s.uploaded_at = b.uploaded_at
  );
END;

CREATE TRIGGER trg_settlement_fact_update_guard
BEFORE UPDATE ON settlement_transactions
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_FACT_IDENTITY_IMMUTABLE')
  WHERE OLD.row_key IS NOT NEW.row_key
     OR OLD.posted_at IS NOT NEW.posted_at
     OR OLD.posted_date IS NOT NEW.posted_date
     OR OLD.settlement_id IS NOT NEW.settlement_id
     OR OLD.transaction_type IS NOT NEW.transaction_type
     OR OLD.order_id IS NOT NEW.order_id
     OR OLD.sku IS NOT NEW.sku
     OR OLD.source_import_id IS NOT NEW.source_import_id
     OR OLD.source_row_ordinal IS NOT NEW.source_row_ordinal;

  SELECT RAISE(ABORT, 'SETTLEMENT_FACT_SOURCE_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM settlement_import_batches b
    JOIN settlement_import_source_objects s ON s.import_id = b.import_id
    WHERE b.import_id = NEW.source_import_id
      AND b.status IN ('validated','published')
      AND NEW.posted_date BETWEEN b.report_start_date AND b.report_end_date
      AND s.content_sha256 = b.content_sha256
      AND s.content_bytes = b.content_bytes
  );
END;

CREATE TRIGGER trg_settlement_reconciliation_insert_guard
BEFORE INSERT ON settlement_import_reconciliation_receipts
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_RECONCILIATION_BATCH_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1 FROM settlement_import_batches b
    WHERE b.import_id = NEW.import_id
      AND b.status = 'validated'
      AND b.rejected_rows = 0
      AND b.accepted_rows = NEW.row_count
  );
END;

CREATE TRIGGER trg_settlement_reconciliation_update_guard
BEFORE UPDATE ON settlement_import_reconciliation_receipts
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_RECONCILIATION_IMMUTABLE');
END;

CREATE TRIGGER trg_settlement_reconciliation_delete_guard
BEFORE DELETE ON settlement_import_reconciliation_receipts
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_RECONCILIATION_IMMUTABLE');
END;

CREATE TRIGGER trg_settlement_authority_insert_guard
BEFORE INSERT ON settlement_import_authority
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_AUTHORITY_SOURCE_OBJECT_REQUIRED')
  WHERE NEW.provenance_class = 'exact_source_object'
    AND NOT EXISTS (
      SELECT 1
      FROM settlement_import_batches b
      JOIN settlement_import_source_objects s ON s.import_id = b.import_id
      WHERE b.import_id = NEW.import_id
        AND s.content_sha256 = b.content_sha256
        AND s.content_bytes = b.content_bytes
        AND s.source_file_name = b.source_file_name
        AND s.uploaded_at = b.uploaded_at
    );
END;

CREATE TRIGGER trg_settlement_authority_update_guard
BEFORE UPDATE ON settlement_import_authority
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_AUTHORITY_IDENTITY_IMMUTABLE')
  WHERE OLD.import_id IS NOT NEW.import_id
     OR OLD.created_at IS NOT NEW.created_at;

  SELECT RAISE(ABORT, 'SETTLEMENT_AUTHORITY_VERSION_INVALID')
  WHERE NEW.authority_version <> OLD.authority_version + 1;

  SELECT RAISE(ABORT, 'SETTLEMENT_PROVENANCE_IMMUTABLE')
  WHERE NEW.provenance_class <> OLD.provenance_class;

  SELECT RAISE(ABORT, 'SETTLEMENT_AUTHORITY_SOURCE_OBJECT_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1
    FROM settlement_import_batches b
    JOIN settlement_import_source_objects s ON s.import_id = b.import_id
    WHERE b.import_id = NEW.import_id
      AND s.content_sha256 = b.content_sha256
      AND s.content_bytes = b.content_bytes
      AND s.source_file_name = b.source_file_name
      AND s.uploaded_at = b.uploaded_at
  );
END;

CREATE TRIGGER trg_settlement_authority_no_delete
BEFORE DELETE ON settlement_import_authority
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_AUTHORITY_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_settlement_authority_insert_event
AFTER INSERT ON settlement_import_authority
BEGIN
  INSERT INTO settlement_import_authority_events(
    import_id,authority_version,data_class,provenance_class,
    actor_user_id,reason,evidence_json,recorded_at
  ) VALUES(
    NEW.import_id,NEW.authority_version,NEW.data_class,NEW.provenance_class,
    NEW.actor_user_id,NEW.reason,NEW.evidence_json,NEW.updated_at
  );
END;

CREATE TRIGGER trg_settlement_authority_update_event
AFTER UPDATE ON settlement_import_authority
BEGIN
  INSERT INTO settlement_import_authority_events(
    import_id,authority_version,data_class,provenance_class,
    actor_user_id,reason,evidence_json,recorded_at
  ) VALUES(
    NEW.import_id,NEW.authority_version,NEW.data_class,NEW.provenance_class,
    NEW.actor_user_id,NEW.reason,NEW.evidence_json,NEW.updated_at
  );
END;

CREATE TRIGGER trg_settlement_authority_event_update_guard
BEFORE UPDATE ON settlement_import_authority_events
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_AUTHORITY_EVENT_IMMUTABLE');
END;

CREATE TRIGGER trg_settlement_authority_event_delete_guard
BEFORE DELETE ON settlement_import_authority_events
BEGIN
  SELECT RAISE(ABORT, 'SETTLEMENT_AUTHORITY_EVENT_IMMUTABLE');
END;

CREATE VIEW settlement_business_transactions AS
SELECT f.*
FROM settlement_transactions f
JOIN settlement_import_authority a ON a.import_id = f.source_import_id
WHERE a.data_class = 'business';

CREATE VIEW settlement_governed_transactions AS
SELECT f.*
FROM settlement_transactions f
JOIN settlement_import_authority a ON a.import_id = f.source_import_id
WHERE a.data_class = 'business'
  AND a.provenance_class = 'exact_source_object';

PRAGMA optimize;
