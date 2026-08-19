-- CSV classification and provenance authority.
-- Data classification is deliberately separate from provenance classification.
-- Existing imports are not inferred or backfilled: they remain fail-closed until an explicit,
-- auditable authority write is performed after this migration.

CREATE TABLE csv_import_authority (
  import_id TEXT PRIMARY KEY,
  data_class TEXT NOT NULL CHECK (data_class IN ('unclassified','business','acceptance')),
  provenance_class TEXT NOT NULL CHECK (provenance_class IN ('legacy_batch_only','exact_source_object','reconciled_exact_source')),
  authority_version INTEGER NOT NULL DEFAULT 1 CHECK (authority_version >= 1),
  actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (import_id) REFERENCES csv_import_batches(import_id) ON DELETE RESTRICT
);

CREATE INDEX idx_csv_import_authority_data_class
ON csv_import_authority(data_class, provenance_class, import_id);

CREATE TABLE csv_import_authority_events (
  import_id TEXT NOT NULL,
  authority_version INTEGER NOT NULL CHECK (authority_version >= 1),
  data_class TEXT NOT NULL CHECK (data_class IN ('unclassified','business','acceptance')),
  provenance_class TEXT NOT NULL CHECK (provenance_class IN ('legacy_batch_only','exact_source_object','reconciled_exact_source')),
  actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (import_id, authority_version),
  FOREIGN KEY (import_id) REFERENCES csv_import_batches(import_id) ON DELETE RESTRICT
);

CREATE INDEX idx_csv_import_authority_events_recorded
ON csv_import_authority_events(recorded_at DESC, import_id, authority_version DESC);

-- Exact/reconciled provenance can only be asserted when the immutable source-object receipt
-- still agrees byte-for-byte with the immutable batch authority.
CREATE TRIGGER trg_csv_import_authority_insert_guard
BEFORE INSERT ON csv_import_authority
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_BATCH_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1 FROM csv_import_batches b WHERE b.import_id = NEW.import_id
  );

  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_SOURCE_OBJECT_REQUIRED')
  WHERE NEW.provenance_class IN ('exact_source_object','reconciled_exact_source')
    AND NOT EXISTS (
      SELECT 1
      FROM csv_import_batches b
      JOIN csv_import_source_objects s ON s.import_id = b.import_id
      WHERE b.import_id = NEW.import_id
        AND s.content_sha256 = b.content_sha256
        AND s.content_bytes = b.content_bytes
        AND s.source_file_name = b.source_file_name
        AND s.uploaded_at = b.uploaded_at
    );
END;

CREATE TRIGGER trg_csv_import_authority_update_guard
BEFORE UPDATE ON csv_import_authority
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_IDENTITY_IMMUTABLE')
  WHERE OLD.import_id IS NOT NEW.import_id
     OR OLD.created_at IS NOT NEW.created_at;

  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_VERSION_INVALID')
  WHERE NEW.authority_version <> OLD.authority_version + 1;

  -- Provenance is monotonic. Classification may be corrected, but every correction is versioned.
  SELECT RAISE(ABORT, 'CSV_IMPORT_PROVENANCE_TRANSITION_INVALID')
  WHERE NEW.provenance_class <> OLD.provenance_class
    AND NOT (
      OLD.provenance_class = 'legacy_batch_only'
      AND NEW.provenance_class = 'reconciled_exact_source'
    );

  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_SOURCE_OBJECT_REQUIRED')
  WHERE NEW.provenance_class IN ('exact_source_object','reconciled_exact_source')
    AND NOT EXISTS (
      SELECT 1
      FROM csv_import_batches b
      JOIN csv_import_source_objects s ON s.import_id = b.import_id
      WHERE b.import_id = NEW.import_id
        AND s.content_sha256 = b.content_sha256
        AND s.content_bytes = b.content_bytes
        AND s.source_file_name = b.source_file_name
        AND s.uploaded_at = b.uploaded_at
    );
END;

CREATE TRIGGER trg_csv_import_authority_no_delete
BEFORE DELETE ON csv_import_authority
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_csv_import_authority_insert_event
AFTER INSERT ON csv_import_authority
BEGIN
  INSERT INTO csv_import_authority_events(
    import_id, authority_version, data_class, provenance_class,
    actor_user_id, reason, evidence_json, recorded_at
  ) VALUES(
    NEW.import_id, NEW.authority_version, NEW.data_class, NEW.provenance_class,
    NEW.actor_user_id, NEW.reason, NEW.evidence_json, NEW.updated_at
  );
END;

CREATE TRIGGER trg_csv_import_authority_update_event
AFTER UPDATE ON csv_import_authority
BEGIN
  INSERT INTO csv_import_authority_events(
    import_id, authority_version, data_class, provenance_class,
    actor_user_id, reason, evidence_json, recorded_at
  ) VALUES(
    NEW.import_id, NEW.authority_version, NEW.data_class, NEW.provenance_class,
    NEW.actor_user_id, NEW.reason, NEW.evidence_json, NEW.updated_at
  );
END;

CREATE TRIGGER trg_csv_import_authority_event_update_guard
BEFORE UPDATE ON csv_import_authority_events
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_EVENT_IMMUTABLE');
END;

CREATE TRIGGER trg_csv_import_authority_event_delete_guard
BEFORE DELETE ON csv_import_authority_events
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_EVENT_IMMUTABLE');
END;

-- 0021 guarantees that every batch inserted after that migration already has an exact immutable
-- source receipt. New imports therefore receive objective provenance automatically, while their
-- business/acceptance classification remains explicitly fail-closed until classified.
CREATE TRIGGER trg_csv_import_batch_seed_authority
AFTER INSERT ON csv_import_batches
BEGIN
  INSERT INTO csv_import_authority(
    import_id, data_class, provenance_class, authority_version,
    actor_user_id, reason, evidence_json, created_at, updated_at
  ) VALUES(
    NEW.import_id,
    'unclassified',
    'exact_source_object',
    1,
    'system:csv-import-source-object',
    'new_import_requires_explicit_data_classification',
    json_object('source','0022_seed','contentSha256',NEW.content_sha256),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );
END;

-- Read-side contracts. Missing authority rows and unclassified rows are intentionally absent.
CREATE VIEW csv_business_search_term_daily AS
SELECT f.*
FROM csv_search_term_daily f
JOIN csv_import_authority a ON a.import_id = f.source_import_id
WHERE a.data_class = 'business';

CREATE VIEW csv_governed_search_term_daily AS
SELECT f.*
FROM csv_search_term_daily f
JOIN csv_import_authority a ON a.import_id = f.source_import_id
WHERE a.data_class = 'business'
  AND a.provenance_class IN ('exact_source_object','reconciled_exact_source');

-- Seal the direct advisory-review write bypass at the database boundary. Application checks are
-- still expected for useful HTTP errors, but no client/path can persist a CSV review unless every
-- referenced import has governed authority.
CREATE TRIGGER trg_advisory_review_csv_authority_guard
BEFORE INSERT ON advisory_review_records
WHEN NEW.source_kind = 'csv_import'
BEGIN
  SELECT RAISE(ABORT, 'CSV_ADVISORY_REVIEW_AUTHORITY_REQUIRED')
  WHERE json_type(NEW.source_evidence_json, '$.sourceImportIds') IS NOT 'array'
     OR COALESCE(json_array_length(NEW.source_evidence_json, '$.sourceImportIds'), 0) = 0;

  SELECT RAISE(ABORT, 'CSV_ADVISORY_REVIEW_AUTHORITY_REQUIRED')
  WHERE EXISTS (
    SELECT 1
    FROM json_each(NEW.source_evidence_json, '$.sourceImportIds') j
    LEFT JOIN csv_import_authority a ON a.import_id = CAST(j.value AS TEXT)
    WHERE j.type <> 'text'
       OR a.import_id IS NULL
       OR a.data_class <> 'business'
       OR a.provenance_class NOT IN ('exact_source_object','reconciled_exact_source')
  );
END;

PRAGMA optimize;
