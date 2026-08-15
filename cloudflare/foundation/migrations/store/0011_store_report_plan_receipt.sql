-- Phase E - freeze the whole server-owned report plan before any report job reservation.
-- Existing rows remain NULL; no historical report plan authority is synthesized.

ALTER TABLE sync_runs ADD COLUMN report_plan_fingerprint TEXT;
ALTER TABLE sync_runs ADD COLUMN report_plan_job_count INTEGER;

CREATE TRIGGER trg_sync_runs_report_plan_initial_guard
BEFORE INSERT ON sync_runs
BEGIN
  SELECT RAISE(ABORT, 'REPORT_PLAN_INITIAL_RECEIPT_FORBIDDEN')
    WHERE NEW.report_plan_fingerprint IS NOT NULL
       OR NEW.report_plan_job_count IS NOT NULL;
END;

CREATE TRIGGER trg_sync_runs_report_plan_update_guard
BEFORE UPDATE ON sync_runs
BEGIN
  SELECT RAISE(ABORT, 'REPORT_PLAN_RECEIPT_PARTIAL')
    WHERE (CASE WHEN NEW.report_plan_fingerprint IS NULL OR NEW.report_plan_fingerprint = '' THEN 0 ELSE 1 END)
       <> (CASE WHEN NEW.report_plan_job_count IS NULL THEN 0 ELSE 1 END);

  SELECT RAISE(ABORT, 'REPORT_PLAN_FINGERPRINT_INVALID')
    WHERE NEW.report_plan_fingerprint IS NOT NULL
      AND (
        length(NEW.report_plan_fingerprint) <> 64 OR
        NEW.report_plan_fingerprint GLOB '*[^0-9a-f]*'
      );

  SELECT RAISE(ABORT, 'REPORT_PLAN_JOB_COUNT_INVALID')
    WHERE NEW.report_plan_job_count IS NOT NULL
      AND (typeof(NEW.report_plan_job_count) <> 'integer' OR NEW.report_plan_job_count < 1);

  SELECT RAISE(ABORT, 'REPORT_PLAN_FINGERPRINT_IMMUTABLE')
    WHERE OLD.report_plan_fingerprint IS NOT NULL
      AND OLD.report_plan_fingerprint IS NOT NEW.report_plan_fingerprint;

  SELECT RAISE(ABORT, 'REPORT_PLAN_JOB_COUNT_IMMUTABLE')
    WHERE OLD.report_plan_job_count IS NOT NULL
      AND OLD.report_plan_job_count IS NOT NEW.report_plan_job_count;

  SELECT RAISE(ABORT, 'REPORT_PLAN_ASSIGNMENT_STATE_INVALID')
    WHERE OLD.report_plan_fingerprint IS NULL
      AND OLD.report_plan_job_count IS NULL
      AND NEW.report_plan_fingerprint IS NOT NULL
      AND NEW.report_plan_job_count IS NOT NULL
      AND NOT (
        OLD.status = 'running'
        AND NEW.status = 'running'
        AND NEW.profile_id IS NOT NULL
      );
END;

CREATE INDEX idx_sync_runs_report_plan_fingerprint
  ON sync_runs(report_plan_fingerprint);

PRAGMA optimize;
