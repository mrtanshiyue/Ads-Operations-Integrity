-- Persistent CSV data plane: bind each authoritative manual CSV import to exact immutable R2 bytes.
-- Additive only: csv_import_batches remains the canonical import authority.

CREATE TABLE csv_import_source_objects (
  import_id TEXT PRIMARY KEY,
  source_object_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL DEFAULT 'manual_csv_upload' CHECK (source_kind = 'manual_csv_upload'),
  r2_binding_key TEXT NOT NULL DEFAULT 'DATA_BUCKET' CHECK (r2_binding_key = 'DATA_BUCKET'),
  object_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  content_bytes INTEGER NOT NULL CHECK (content_bytes > 0),
  content_type TEXT,
  source_file_name TEXT NOT NULL,
  importer_user_id TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  r2_etag TEXT,
  r2_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_csv_import_source_sha256
ON csv_import_source_objects(content_sha256, import_id);

CREATE TRIGGER trg_csv_import_source_object_update_guard
BEFORE UPDATE ON csv_import_source_objects
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_SOURCE_OBJECT_IMMUTABLE');
END;

CREATE TRIGGER trg_csv_import_source_object_delete_guard
BEFORE DELETE ON csv_import_source_objects
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_SOURCE_OBJECT_IMMUTABLE');
END;

-- Every new D1 import authority created after this migration must already have an immutable
-- source-object receipt in the same D1 transactional batch. Existing historical rows are untouched.
CREATE TRIGGER trg_csv_import_batch_source_object_guard
BEFORE INSERT ON csv_import_batches
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_SOURCE_OBJECT_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1
    FROM csv_import_source_objects s
    WHERE s.import_id = NEW.import_id
      AND s.content_sha256 = NEW.content_sha256
      AND s.content_bytes = NEW.content_bytes
      AND s.source_file_name = NEW.source_file_name
      AND s.uploaded_at = NEW.uploaded_at
  );
END;

-- Facts cannot be created or rebound unless the D1 authority and immutable R2 receipt agree.
CREATE TRIGGER trg_csv_fact_source_object_insert_guard
BEFORE INSERT ON csv_search_term_daily
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_FACT_SOURCE_OBJECT_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1
    FROM csv_import_batches b
    JOIN csv_import_source_objects s ON s.import_id = b.import_id
    WHERE b.import_id = NEW.source_import_id
      AND s.content_sha256 = b.content_sha256
      AND s.content_bytes = b.content_bytes
      AND s.source_file_name = b.source_file_name
      AND s.uploaded_at = b.uploaded_at
  );
END;

CREATE TRIGGER trg_csv_fact_source_object_update_guard
BEFORE UPDATE ON csv_search_term_daily
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_FACT_SOURCE_OBJECT_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1
    FROM csv_import_batches b
    JOIN csv_import_source_objects s ON s.import_id = b.import_id
    WHERE b.import_id = NEW.source_import_id
      AND s.content_sha256 = b.content_sha256
      AND s.content_bytes = b.content_bytes
      AND s.source_file_name = b.source_file_name
      AND s.uploaded_at = b.uploaded_at
  );
END;

PRAGMA optimize;
