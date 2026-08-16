-- Phase E - a frozen report-plan run may only become succeeded/partial/failed when
-- its actual report_jobs are terminal and the durable stats receipt matches storage truth.

CREATE TRIGGER trg_sync_runs_report_plan_terminal_receipt_guard
BEFORE UPDATE ON sync_runs
WHEN OLD.status = 'running'
  AND NEW.report_plan_fingerprint IS NOT NULL
  AND NEW.status IN ('succeeded','partial','failed')
BEGIN
  SELECT RAISE(ABORT, 'SYNC_COMPLETION_COMPLETED_AT_REQUIRED')
    WHERE NEW.completed_at IS NULL OR NEW.completed_at = '';

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_STATS_REQUIRED')
    WHERE NEW.stats_json IS NULL OR NEW.stats_json = '' OR json_valid(NEW.stats_json) = 0;

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_STATS_SCHEMA_INVALID')
    WHERE json_extract(NEW.stats_json, '$.schemaVersion') IS NOT 'sync-report-plan-completion-v1';

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_PLAN_FINGERPRINT_MISMATCH')
    WHERE json_extract(NEW.stats_json, '$.reportPlanFingerprint') IS NOT NEW.report_plan_fingerprint;

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_JOB_COUNT_MISMATCH')
    WHERE typeof(json_extract(NEW.stats_json, '$.jobCount')) <> 'integer'
       OR json_extract(NEW.stats_json, '$.jobCount') <> NEW.report_plan_job_count
       OR (SELECT COUNT(*) FROM report_jobs j WHERE j.run_id = NEW.run_id) <> NEW.report_plan_job_count;

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_STATS_COUNTS_INVALID')
    WHERE typeof(json_extract(NEW.stats_json, '$.ingestedCount')) <> 'integer'
       OR typeof(json_extract(NEW.stats_json, '$.failedCount')) <> 'integer'
       OR typeof(json_extract(NEW.stats_json, '$.cancelledCount')) <> 'integer'
       OR json_extract(NEW.stats_json, '$.ingestedCount') < 0
       OR json_extract(NEW.stats_json, '$.failedCount') < 0
       OR json_extract(NEW.stats_json, '$.cancelledCount') < 0
       OR (
         json_extract(NEW.stats_json, '$.ingestedCount') +
         json_extract(NEW.stats_json, '$.failedCount') +
         json_extract(NEW.stats_json, '$.cancelledCount')
       ) <> NEW.report_plan_job_count;

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_NONTERMINAL_JOBS')
    WHERE EXISTS (
      SELECT 1 FROM report_jobs j
      WHERE j.run_id = NEW.run_id
        AND j.status NOT IN ('ingested','failed','cancelled')
    );

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_STORAGE_STATS_MISMATCH')
    WHERE (SELECT COUNT(*) FROM report_jobs j WHERE j.run_id = NEW.run_id AND j.status = 'ingested')
          <> json_extract(NEW.stats_json, '$.ingestedCount')
       OR (SELECT COUNT(*) FROM report_jobs j WHERE j.run_id = NEW.run_id AND j.status = 'failed')
          <> json_extract(NEW.stats_json, '$.failedCount')
       OR (SELECT COUNT(*) FROM report_jobs j WHERE j.run_id = NEW.run_id AND j.status = 'cancelled')
          <> json_extract(NEW.stats_json, '$.cancelledCount');

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_SUCCEEDED_INVALID')
    WHERE NEW.status = 'succeeded'
      AND (
        json_extract(NEW.stats_json, '$.ingestedCount') <> NEW.report_plan_job_count OR
        json_extract(NEW.stats_json, '$.failedCount') <> 0 OR
        json_extract(NEW.stats_json, '$.cancelledCount') <> 0 OR
        NEW.error_summary IS NOT NULL
      );

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_PARTIAL_INVALID')
    WHERE NEW.status = 'partial'
      AND (
        json_extract(NEW.stats_json, '$.ingestedCount') < 1 OR
        (json_extract(NEW.stats_json, '$.failedCount') + json_extract(NEW.stats_json, '$.cancelledCount')) < 1 OR
        NEW.error_summary IS NOT 'REPORT_PLAN_PARTIAL_FAILURE'
      );

  SELECT RAISE(ABORT, 'SYNC_COMPLETION_FAILED_INVALID')
    WHERE NEW.status = 'failed'
      AND (
        json_extract(NEW.stats_json, '$.ingestedCount') <> 0 OR
        (json_extract(NEW.stats_json, '$.failedCount') + json_extract(NEW.stats_json, '$.cancelledCount')) <> NEW.report_plan_job_count OR
        NEW.error_summary IS NOT 'REPORT_PLAN_FAILED'
      );
END;

CREATE TRIGGER trg_sync_runs_report_plan_terminal_receipt_immutable
BEFORE UPDATE ON sync_runs
WHEN OLD.report_plan_fingerprint IS NOT NULL
  AND OLD.status IN ('succeeded','partial','failed')
BEGIN
  SELECT RAISE(ABORT, 'SYNC_COMPLETION_RECEIPT_IMMUTABLE')
    WHERE OLD.status IS NOT NEW.status
       OR OLD.completed_at IS NOT NEW.completed_at
       OR OLD.stats_json IS NOT NEW.stats_json
       OR OLD.error_summary IS NOT NEW.error_summary;
END;

PRAGMA optimize;
