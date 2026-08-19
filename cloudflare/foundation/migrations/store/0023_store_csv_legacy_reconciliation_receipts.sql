-- Truthful legacy CSV exact-source reconciliation contract.
--
-- Historical batches may predate the immutable R2 source-object contract introduced in 0021.
-- A reconciliation receipt records the raw historical file evidence and the deterministic
-- normalization that reproduces the immutable batch receipt without pretending the historical
-- raw bytes were a manual_csv_upload R2 object.

CREATE TABLE csv_import_reconciliation_receipts (
  reconciliation_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL UNIQUE,
  source_file_name TEXT NOT NULL CHECK (length(trim(source_file_name)) > 0),
  raw_content_sha256 TEXT NOT NULL CHECK (length(raw_content_sha256) = 64 AND raw_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  raw_content_bytes INTEGER NOT NULL CHECK (raw_content_bytes > 0),
  normalized_content_sha256 TEXT NOT NULL CHECK (length(normalized_content_sha256) = 64 AND normalized_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  normalized_content_bytes INTEGER NOT NULL CHECK (normalized_content_bytes > 0),
  normalization_transform TEXT NOT NULL CHECK (normalization_transform IN ('identity_v1','utf8_bom_strip_v1')),
  evidence_sha256 TEXT NOT NULL UNIQUE CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  actor_user_id TEXT NOT NULL CHECK (length(trim(actor_user_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  reconciled_at TEXT NOT NULL CHECK (length(trim(reconciled_at)) > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (import_id) REFERENCES csv_import_batches(import_id) ON DELETE RESTRICT
);

CREATE INDEX idx_csv_import_reconciliation_normalized_sha256
ON csv_import_reconciliation_receipts(normalized_content_sha256, import_id);

-- A reconciliation receipt is only valid for an already-classified legacy authority row, and its
-- normalized projection must reproduce the canonical immutable batch receipt exactly.
CREATE TRIGGER trg_csv_import_reconciliation_insert_guard
BEFORE INSERT ON csv_import_reconciliation_receipts
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_RECONCILIATION_LEGACY_AUTHORITY_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1
    FROM csv_import_authority a
    WHERE a.import_id = NEW.import_id
      AND a.provenance_class = 'legacy_batch_only'
  );

  SELECT RAISE(ABORT, 'CSV_IMPORT_RECONCILIATION_BATCH_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1
    FROM csv_import_batches b
    WHERE b.import_id = NEW.import_id
      AND b.source_file_name = NEW.source_file_name
      AND b.content_sha256 = NEW.normalized_content_sha256
      AND b.content_bytes = NEW.normalized_content_bytes
  );

  SELECT RAISE(ABORT, 'CSV_IMPORT_RECONCILIATION_TRANSFORM_INVALID')
  WHERE (
      NEW.normalization_transform = 'identity_v1'
      AND (
        NEW.raw_content_sha256 <> NEW.normalized_content_sha256
        OR NEW.raw_content_bytes <> NEW.normalized_content_bytes
      )
    )
    OR (
      NEW.normalization_transform = 'utf8_bom_strip_v1'
      AND NEW.raw_content_bytes <> NEW.normalized_content_bytes + 3
    );
END;

CREATE TRIGGER trg_csv_import_reconciliation_update_guard
BEFORE UPDATE ON csv_import_reconciliation_receipts
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_RECONCILIATION_IMMUTABLE');
END;

CREATE TRIGGER trg_csv_import_reconciliation_delete_guard
BEFORE DELETE ON csv_import_reconciliation_receipts
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_RECONCILIATION_IMMUTABLE');
END;

-- 0022 intentionally required an exact source-object receipt for both exact_source_object and
-- reconciled_exact_source. Split those proof paths now: new exact uploads keep the 0021 R2 proof,
-- while legacy reconciliation must point at an immutable reconciliation receipt.
DROP TRIGGER trg_csv_import_authority_insert_guard;
DROP TRIGGER trg_csv_import_authority_update_guard;

CREATE TRIGGER trg_csv_import_authority_insert_guard
BEFORE INSERT ON csv_import_authority
BEGIN
  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_BATCH_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1 FROM csv_import_batches b WHERE b.import_id = NEW.import_id
  );

  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_SOURCE_OBJECT_REQUIRED')
  WHERE NEW.provenance_class = 'exact_source_object'
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

  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_RECONCILIATION_REQUIRED')
  WHERE NEW.provenance_class = 'reconciled_exact_source'
    AND NOT EXISTS (
      SELECT 1
      FROM csv_import_batches b
      JOIN csv_import_reconciliation_receipts r ON r.import_id = b.import_id
      WHERE b.import_id = NEW.import_id
        AND r.normalized_content_sha256 = b.content_sha256
        AND r.normalized_content_bytes = b.content_bytes
        AND r.source_file_name = b.source_file_name
        AND json_extract(NEW.evidence_json, '$.reconciliationId') = r.reconciliation_id
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

  SELECT RAISE(ABORT, 'CSV_IMPORT_PROVENANCE_TRANSITION_INVALID')
  WHERE NEW.provenance_class <> OLD.provenance_class
    AND NOT (
      OLD.provenance_class = 'legacy_batch_only'
      AND NEW.provenance_class = 'reconciled_exact_source'
    );

  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_SOURCE_OBJECT_REQUIRED')
  WHERE NEW.provenance_class = 'exact_source_object'
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

  SELECT RAISE(ABORT, 'CSV_IMPORT_AUTHORITY_RECONCILIATION_REQUIRED')
  WHERE NEW.provenance_class = 'reconciled_exact_source'
    AND NOT EXISTS (
      SELECT 1
      FROM csv_import_batches b
      JOIN csv_import_reconciliation_receipts r ON r.import_id = b.import_id
      WHERE b.import_id = NEW.import_id
        AND r.normalized_content_sha256 = b.content_sha256
        AND r.normalized_content_bytes = b.content_bytes
        AND r.source_file_name = b.source_file_name
        AND json_extract(NEW.evidence_json, '$.reconciliationId') = r.reconciliation_id
    );
END;

PRAGMA optimize;
