-- Phase E - durable report-plan membership ledger.
-- The run-level fingerprint is not enough by itself: every report job must be an explicit
-- immutable member of that frozen plan before report_jobs can be created.

CREATE TABLE sync_report_plan_jobs (
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  report_plan_fingerprint TEXT NOT NULL,
  dataset_key TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  ad_product TEXT NOT NULL,
  report_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, job_id),
  UNIQUE (job_id),
  UNIQUE (idempotency_key),
  FOREIGN KEY (run_id) REFERENCES sync_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT
);

CREATE INDEX idx_sync_report_plan_jobs_run
  ON sync_report_plan_jobs(run_id, job_id);

CREATE TRIGGER trg_sync_report_plan_jobs_insert_guard
BEFORE INSERT ON sync_report_plan_jobs
BEGIN
  SELECT RAISE(ABORT, 'REPORT_PLAN_MEMBERSHIP_FINGERPRINT_INVALID')
    WHERE length(NEW.report_plan_fingerprint) <> 64
       OR NEW.report_plan_fingerprint GLOB '*[^0-9a-f]*';
  SELECT RAISE(ABORT, 'REPORT_PLAN_MEMBERSHIP_RUN_NOT_STAGING')
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_runs sr
      WHERE sr.run_id = NEW.run_id
        AND sr.profile_id = NEW.profile_id
        AND sr.status = 'running'
        AND sr.report_plan_fingerprint IS NULL
        AND sr.report_plan_job_count IS NULL
    );
END;

CREATE TRIGGER trg_sync_report_plan_jobs_update_guard
BEFORE UPDATE ON sync_report_plan_jobs
BEGIN
  SELECT RAISE(ABORT, 'REPORT_PLAN_MEMBERSHIP_IMMUTABLE');
END;

CREATE TRIGGER trg_sync_report_plan_jobs_delete_guard
BEFORE DELETE ON sync_report_plan_jobs
BEGIN
  SELECT RAISE(ABORT, 'REPORT_PLAN_MEMBERSHIP_IMMUTABLE');
END;

CREATE TRIGGER trg_sync_runs_report_plan_membership_guard
BEFORE UPDATE ON sync_runs
WHEN OLD.report_plan_fingerprint IS NULL
  AND OLD.report_plan_job_count IS NULL
  AND NEW.report_plan_fingerprint IS NOT NULL
  AND NEW.report_plan_job_count IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'REPORT_PLAN_MEMBERSHIP_COUNT_MISMATCH')
    WHERE (SELECT COUNT(*) FROM sync_report_plan_jobs p WHERE p.run_id = NEW.run_id)
       <> NEW.report_plan_job_count;
  SELECT RAISE(ABORT, 'REPORT_PLAN_MEMBERSHIP_RECEIPT_MISMATCH')
    WHERE EXISTS (
      SELECT 1 FROM sync_report_plan_jobs p
      WHERE p.run_id = NEW.run_id
        AND (
          p.profile_id IS NOT NEW.profile_id OR
          p.report_plan_fingerprint IS NOT NEW.report_plan_fingerprint
        )
    );
  SELECT RAISE(ABORT, 'REPORT_PLAN_EXISTING_JOB_CONFLICT')
    WHERE EXISTS (
      SELECT 1
      FROM report_jobs j
      WHERE j.run_id = NEW.run_id
        AND NOT EXISTS (
          SELECT 1 FROM sync_report_plan_jobs p
          WHERE p.run_id = NEW.run_id
            AND p.job_id = j.job_id
            AND p.profile_id = j.profile_id
            AND p.ad_product = j.ad_product
            AND p.report_type = j.report_type
            AND p.start_date = j.start_date
            AND p.end_date = j.end_date
            AND p.idempotency_key = j.idempotency_key
            AND p.request_fingerprint = j.request_fingerprint
            AND p.request_json IS j.request_json
        )
    );
END;

CREATE TRIGGER trg_report_jobs_plan_membership_insert_guard
BEFORE INSERT ON report_jobs
WHEN NEW.run_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM sync_runs sr
    WHERE sr.run_id = NEW.run_id AND sr.report_plan_fingerprint IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_JOB_NOT_IN_FROZEN_PLAN')
    WHERE NOT EXISTS (
      SELECT 1
      FROM sync_runs sr
      JOIN sync_report_plan_jobs p
        ON p.run_id = sr.run_id
       AND p.report_plan_fingerprint = sr.report_plan_fingerprint
      WHERE sr.run_id = NEW.run_id
        AND p.job_id = NEW.job_id
        AND p.profile_id = NEW.profile_id
        AND p.ad_product = NEW.ad_product
        AND p.report_type = NEW.report_type
        AND p.start_date = NEW.start_date
        AND p.end_date = NEW.end_date
        AND p.idempotency_key = NEW.idempotency_key
        AND p.request_fingerprint = NEW.request_fingerprint
        AND p.request_json IS NEW.request_json
    );
END;

CREATE TRIGGER trg_report_jobs_plan_membership_delete_guard
BEFORE DELETE ON report_jobs
WHEN OLD.run_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM sync_runs sr
    WHERE sr.run_id = OLD.run_id AND sr.report_plan_fingerprint IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'REPORT_JOB_FROZEN_PLAN_DELETE_FORBIDDEN');
END;

CREATE TRIGGER trg_sync_runs_frozen_plan_delete_guard
BEFORE DELETE ON sync_runs
WHEN OLD.report_plan_fingerprint IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'SYNC_RUN_FROZEN_PLAN_DELETE_FORBIDDEN');
END;

PRAGMA optimize;
