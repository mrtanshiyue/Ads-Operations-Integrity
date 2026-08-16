-- Phase E prototype - report authority and durable sync intent receipts.

ALTER TABLE sync_runs ADD COLUMN intent_fingerprint TEXT;
ALTER TABLE report_jobs ADD COLUMN r2_initial_version TEXT;
ALTER TABLE report_jobs ADD COLUMN r2_initial_etag TEXT;
ALTER TABLE report_jobs ADD COLUMN raw_row_count INTEGER CHECK (raw_row_count IS NULL OR raw_row_count >= 0);

CREATE INDEX idx_sync_runs_intent_fingerprint ON sync_runs(intent_fingerprint);

CREATE TRIGGER trg_sync_runs_update_guard
BEFORE UPDATE ON sync_runs
BEGIN
  SELECT RAISE(ABORT, 'SYNC_INTENT_FINGERPRINT_IMMUTABLE')
    WHERE OLD.intent_fingerprint IS NOT NEW.intent_fingerprint;
  SELECT RAISE(ABORT, 'SYNC_CANONICAL_PROFILE_IMMUTABLE')
    WHERE OLD.profile_id IS NOT NULL AND OLD.profile_id IS NOT NEW.profile_id;
  SELECT RAISE(ABORT, 'SYNC_CANONICAL_PROFILE_ASSIGNMENT_INVALID')
    WHERE OLD.profile_id IS NULL
      AND NEW.profile_id IS NOT NULL
      AND NOT (OLD.status = 'queued' AND NEW.status = 'running');
  SELECT RAISE(ABORT, 'SYNC_RUNNING_REQUIRES_CANONICAL_PROFILE')
    WHERE OLD.status = 'queued' AND NEW.status = 'running' AND NEW.profile_id IS NULL;
  SELECT RAISE(ABORT, 'SYNC_RUN_STATUS_TRANSITION_INVALID')
    WHERE OLD.status <> NEW.status AND NOT (
      (OLD.status = 'queued' AND NEW.status IN ('running','failed','cancelled')) OR
      (OLD.status = 'running' AND NEW.status IN ('succeeded','partial','failed','cancelled'))
    );
END;

CREATE TRIGGER trg_report_jobs_initial_status
BEFORE INSERT ON report_jobs
WHEN NEW.status <> 'queued'
BEGIN
  SELECT RAISE(ABORT, 'REPORT_JOB_INITIAL_STATUS_INVALID');
END;

CREATE TRIGGER trg_report_jobs_update_guard
BEFORE UPDATE ON report_jobs
BEGIN
  SELECT RAISE(ABORT, 'REPORT_JOB_RUN_ID_IMMUTABLE')
    WHERE OLD.run_id IS NOT NULL AND OLD.run_id IS NOT NEW.run_id;
  SELECT RAISE(ABORT, 'REPORT_JOB_PROFILE_ID_IMMUTABLE')
    WHERE OLD.profile_id IS NOT NULL AND OLD.profile_id IS NOT NEW.profile_id;
  SELECT RAISE(ABORT, 'REPORT_JOB_AD_PRODUCT_IMMUTABLE')
    WHERE OLD.ad_product IS NOT NULL AND OLD.ad_product IS NOT NEW.ad_product;
  SELECT RAISE(ABORT, 'REPORT_JOB_REPORT_TYPE_IMMUTABLE')
    WHERE OLD.report_type IS NOT NULL AND OLD.report_type IS NOT NEW.report_type;
  SELECT RAISE(ABORT, 'REPORT_JOB_START_DATE_IMMUTABLE')
    WHERE OLD.start_date IS NOT NULL AND OLD.start_date IS NOT NEW.start_date;
  SELECT RAISE(ABORT, 'REPORT_JOB_END_DATE_IMMUTABLE')
    WHERE OLD.end_date IS NOT NULL AND OLD.end_date IS NOT NEW.end_date;
  SELECT RAISE(ABORT, 'REPORT_JOB_IDEMPOTENCY_KEY_IMMUTABLE')
    WHERE OLD.idempotency_key IS NOT NULL AND OLD.idempotency_key IS NOT NEW.idempotency_key;
  SELECT RAISE(ABORT, 'REPORT_JOB_REQUEST_FINGERPRINT_IMMUTABLE')
    WHERE OLD.request_fingerprint IS NOT NULL AND OLD.request_fingerprint IS NOT NEW.request_fingerprint;
  SELECT RAISE(ABORT, 'REPORT_JOB_REQUEST_JSON_IMMUTABLE')
    WHERE OLD.request_json IS NOT NULL AND OLD.request_json IS NOT NEW.request_json;
  SELECT RAISE(ABORT, 'REPORT_JOB_AMAZON_REPORT_ID_IMMUTABLE')
    WHERE OLD.amazon_report_id IS NOT NULL AND OLD.amazon_report_id IS NOT NEW.amazon_report_id;
  SELECT RAISE(ABORT, 'REPORT_JOB_AMAZON_CREATED_AT_IMMUTABLE')
    WHERE OLD.amazon_created_at IS NOT NULL AND OLD.amazon_created_at IS NOT NEW.amazon_created_at;
  SELECT RAISE(ABORT, 'REPORT_JOB_R2_OBJECT_KEY_IMMUTABLE')
    WHERE OLD.r2_object_key IS NOT NULL AND OLD.r2_object_key IS NOT NEW.r2_object_key;
  SELECT RAISE(ABORT, 'REPORT_JOB_CONTENT_SHA256_IMMUTABLE')
    WHERE OLD.content_sha256 IS NOT NULL AND OLD.content_sha256 IS NOT NEW.content_sha256;
  SELECT RAISE(ABORT, 'REPORT_JOB_CONTENT_BYTES_IMMUTABLE')
    WHERE OLD.content_bytes IS NOT NULL AND OLD.content_bytes IS NOT NEW.content_bytes;
  SELECT RAISE(ABORT, 'REPORT_JOB_R2_INITIAL_VERSION_IMMUTABLE')
    WHERE OLD.r2_initial_version IS NOT NULL AND OLD.r2_initial_version IS NOT NEW.r2_initial_version;
  SELECT RAISE(ABORT, 'REPORT_JOB_R2_INITIAL_ETAG_IMMUTABLE')
    WHERE OLD.r2_initial_etag IS NOT NULL AND OLD.r2_initial_etag IS NOT NEW.r2_initial_etag;
  SELECT RAISE(ABORT, 'REPORT_JOB_RAW_ROW_COUNT_IMMUTABLE')
    WHERE OLD.raw_row_count IS NOT NULL AND OLD.raw_row_count IS NOT NEW.raw_row_count;
  SELECT RAISE(ABORT, 'REPORT_JOB_ROW_COUNT_IMMUTABLE')
    WHERE OLD.row_count IS NOT NULL AND OLD.row_count IS NOT NEW.row_count;
  SELECT RAISE(ABORT, 'REPORT_JOB_DOWNLOADED_AT_IMMUTABLE')
    WHERE OLD.downloaded_at IS NOT NULL AND OLD.downloaded_at IS NOT NEW.downloaded_at;
  SELECT RAISE(ABORT, 'REPORT_JOB_INGESTED_AT_IMMUTABLE')
    WHERE OLD.ingested_at IS NOT NULL AND OLD.ingested_at IS NOT NEW.ingested_at;

  SELECT RAISE(ABORT, 'REPORT_JOB_STATUS_TRANSITION_INVALID')
    WHERE OLD.status <> NEW.status AND NOT (
      (OLD.status = 'queued' AND NEW.status IN ('requested','failed','cancelled')) OR
      (OLD.status = 'requested' AND NEW.status IN ('processing','failed')) OR
      (OLD.status = 'processing' AND NEW.status IN ('ready','failed','cancelled')) OR
      (OLD.status = 'ready' AND NEW.status IN ('downloaded','failed','cancelled')) OR
      (OLD.status = 'downloaded' AND NEW.status IN ('ingested','failed'))
    );

  SELECT RAISE(ABORT, 'REPORT_JOB_AMAZON_REPORT_RECEIPT_REQUIRED')
    WHERE NEW.status IN ('processing','ready','downloaded','ingested')
      AND (NEW.amazon_report_id IS NULL OR NEW.amazon_report_id = '' OR NEW.amazon_created_at IS NULL OR NEW.amazon_created_at = '');
  SELECT RAISE(ABORT, 'REPORT_JOB_RAW_AUTHORITY_REQUIRED')
    WHERE NEW.status IN ('downloaded','ingested')
      AND (
        NEW.r2_object_key IS NULL OR NEW.r2_object_key = '' OR
        NEW.content_sha256 IS NULL OR NEW.content_sha256 = '' OR
        NEW.content_bytes IS NULL OR
        NEW.r2_initial_version IS NULL OR NEW.r2_initial_version = '' OR
        NEW.r2_initial_etag IS NULL OR NEW.r2_initial_etag = '' OR
        NEW.downloaded_at IS NULL OR NEW.downloaded_at = ''
      );
  SELECT RAISE(ABORT, 'REPORT_JOB_INGESTION_RECEIPT_REQUIRED')
    WHERE NEW.status = 'ingested'
      AND (NEW.raw_row_count IS NULL OR NEW.row_count IS NULL OR NEW.ingested_at IS NULL OR NEW.ingested_at = '');
END;

PRAGMA optimize;
