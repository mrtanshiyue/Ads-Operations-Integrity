-- Phase E - reject identity-changing duplicate report-plan membership inserts before
-- INSERT OR IGNORE can mask a UNIQUE collision.

CREATE TRIGGER trg_sync_report_plan_jobs_duplicate_guard
BEFORE INSERT ON sync_report_plan_jobs
WHEN EXISTS (
  SELECT 1
  FROM sync_report_plan_jobs p
  WHERE p.job_id = NEW.job_id
     OR p.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'REPORT_PLAN_MEMBERSHIP_DUPLICATE_CONFLICT')
    WHERE EXISTS (
      SELECT 1
      FROM sync_report_plan_jobs p
      WHERE (p.job_id = NEW.job_id OR p.idempotency_key = NEW.idempotency_key)
        AND (
          p.run_id IS NOT NEW.run_id OR
          p.job_id IS NOT NEW.job_id OR
          p.profile_id IS NOT NEW.profile_id OR
          p.report_plan_fingerprint IS NOT NEW.report_plan_fingerprint OR
          p.dataset_key IS NOT NEW.dataset_key OR
          p.contract_id IS NOT NEW.contract_id OR
          p.ad_product IS NOT NEW.ad_product OR
          p.report_type IS NOT NEW.report_type OR
          p.start_date IS NOT NEW.start_date OR
          p.end_date IS NOT NEW.end_date OR
          p.idempotency_key IS NOT NEW.idempotency_key OR
          p.request_fingerprint IS NOT NEW.request_fingerprint OR
          p.request_json IS NOT NEW.request_json
        )
    );
END;

PRAGMA optimize;
