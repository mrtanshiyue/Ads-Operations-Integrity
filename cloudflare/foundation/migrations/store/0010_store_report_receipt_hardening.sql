-- Phase E - report lifecycle receipts must be complete, state-aligned, and non-synthetic.
-- This hardens producer receipts without changing the legacy queued reservation shape.

CREATE TRIGGER trg_report_jobs_initial_receipt_guard
BEFORE INSERT ON report_jobs
BEGIN
  SELECT RAISE(ABORT, 'REPORT_JOB_INITIAL_RECEIPT_FORBIDDEN')
    WHERE NEW.amazon_report_id IS NOT NULL
       OR NEW.amazon_created_at IS NOT NULL
       OR NEW.r2_object_key IS NOT NULL
       OR NEW.content_sha256 IS NOT NULL
       OR NEW.content_bytes IS NOT NULL
       OR NEW.r2_initial_version IS NOT NULL
       OR NEW.r2_initial_etag IS NOT NULL
       OR NEW.downloaded_at IS NOT NULL
       OR NEW.raw_row_count IS NOT NULL
       OR NEW.row_count IS NOT NULL
       OR NEW.ingested_at IS NOT NULL;
END;

CREATE TRIGGER trg_report_jobs_receipt_completeness_guard
BEFORE UPDATE ON report_jobs
BEGIN
  SELECT RAISE(ABORT, 'REPORT_JOB_AMAZON_IDENTITY_PARTIAL')
    WHERE (CASE WHEN NEW.amazon_report_id IS NULL OR NEW.amazon_report_id = '' THEN 0 ELSE 1 END)
       <> (CASE WHEN NEW.amazon_created_at IS NULL OR NEW.amazon_created_at = '' THEN 0 ELSE 1 END);

  SELECT RAISE(ABORT, 'REPORT_JOB_AMAZON_IDENTITY_STATUS_INVALID')
    WHERE NEW.amazon_report_id IS NOT NULL
      AND NEW.amazon_report_id <> ''
      AND NEW.status NOT IN ('processing','ready','downloaded','ingested','failed','cancelled');

  SELECT RAISE(ABORT, 'REPORT_JOB_R2_EXPECTED_AUTHORITY_PARTIAL')
    WHERE (
      (CASE WHEN NEW.r2_object_key IS NULL OR NEW.r2_object_key = '' THEN 0 ELSE 1 END) +
      (CASE WHEN NEW.content_sha256 IS NULL OR NEW.content_sha256 = '' THEN 0 ELSE 1 END) +
      (CASE WHEN NEW.content_bytes IS NULL THEN 0 ELSE 1 END)
    ) NOT IN (0, 3);

  SELECT RAISE(ABORT, 'REPORT_JOB_R2_OBJECT_KEY_INVALID')
    WHERE NEW.r2_object_key IS NOT NULL AND NEW.r2_object_key = '';

  SELECT RAISE(ABORT, 'REPORT_JOB_CONTENT_SHA256_INVALID')
    WHERE NEW.content_sha256 IS NOT NULL
      AND (
        length(NEW.content_sha256) <> 64 OR
        NEW.content_sha256 GLOB '*[^0-9a-f]*'
      );

  SELECT RAISE(ABORT, 'REPORT_JOB_CONTENT_BYTES_INVALID')
    WHERE NEW.content_bytes IS NOT NULL
      AND (typeof(NEW.content_bytes) <> 'integer' OR NEW.content_bytes < 0);

  SELECT RAISE(ABORT, 'REPORT_JOB_R2_EXPECTED_AUTHORITY_STATUS_INVALID')
    WHERE NEW.r2_object_key IS NOT NULL
      AND NEW.r2_object_key <> ''
      AND NEW.status NOT IN ('ready','downloaded','ingested','failed','cancelled');

  SELECT RAISE(ABORT, 'REPORT_JOB_R2_INITIAL_RECEIPT_PARTIAL')
    WHERE (
      (CASE WHEN NEW.r2_initial_version IS NULL OR NEW.r2_initial_version = '' THEN 0 ELSE 1 END) +
      (CASE WHEN NEW.r2_initial_etag IS NULL OR NEW.r2_initial_etag = '' THEN 0 ELSE 1 END) +
      (CASE WHEN NEW.downloaded_at IS NULL OR NEW.downloaded_at = '' THEN 0 ELSE 1 END)
    ) NOT IN (0, 3);

  SELECT RAISE(ABORT, 'REPORT_JOB_R2_INITIAL_WITHOUT_EXPECTED_AUTHORITY')
    WHERE NEW.r2_initial_version IS NOT NULL
      AND NEW.r2_initial_version <> ''
      AND (
        NEW.r2_object_key IS NULL OR NEW.r2_object_key = '' OR
        NEW.content_sha256 IS NULL OR NEW.content_sha256 = '' OR
        NEW.content_bytes IS NULL
      );

  SELECT RAISE(ABORT, 'REPORT_JOB_R2_INITIAL_RECEIPT_STATUS_INVALID')
    WHERE NEW.r2_initial_version IS NOT NULL
      AND NEW.r2_initial_version <> ''
      AND NEW.status NOT IN ('downloaded','ingested','failed');

  SELECT RAISE(ABORT, 'REPORT_JOB_RAW_ROW_COUNT_INVALID')
    WHERE NEW.raw_row_count IS NOT NULL
      AND (typeof(NEW.raw_row_count) <> 'integer' OR NEW.raw_row_count < 0);

  SELECT RAISE(ABORT, 'REPORT_JOB_RAW_ROW_COUNT_STATUS_INVALID')
    WHERE NEW.raw_row_count IS NOT NULL
      AND NEW.status NOT IN ('downloaded','ingested','failed');

  SELECT RAISE(ABORT, 'REPORT_JOB_INGESTION_RECEIPT_PARTIAL')
    WHERE (CASE WHEN NEW.row_count IS NULL THEN 0 ELSE 1 END)
       <> (CASE WHEN NEW.ingested_at IS NULL OR NEW.ingested_at = '' THEN 0 ELSE 1 END);

  SELECT RAISE(ABORT, 'REPORT_JOB_ROW_COUNT_INVALID')
    WHERE NEW.row_count IS NOT NULL
      AND (typeof(NEW.row_count) <> 'integer' OR NEW.row_count < 0);

  SELECT RAISE(ABORT, 'REPORT_JOB_INGESTION_RECEIPT_STATUS_INVALID')
    WHERE NEW.row_count IS NOT NULL AND NEW.status <> 'ingested';
END;

PRAGMA optimize;
