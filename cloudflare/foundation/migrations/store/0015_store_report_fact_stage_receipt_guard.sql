-- Phase E - raw_row_count is the immutable completion receipt for deterministic fact staging.
-- Do not allow that receipt to freeze report_fact_stage unless the staged search-term set is
-- already complete and bound to the exact downloaded report job identity.

CREATE TRIGGER trg_report_jobs_fact_stage_completion_receipt_guard
BEFORE UPDATE ON report_jobs
WHEN OLD.raw_row_count IS NULL AND NEW.raw_row_count IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_STATUS_INVALID')
    WHERE NEW.status <> 'downloaded';

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_CONTRACT_UNSUPPORTED')
    WHERE NEW.ad_product <> 'SPONSORED_PRODUCTS'
       OR NEW.report_type <> 'spSearchTerm';

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_COUNT_MISMATCH')
    WHERE (
      SELECT COUNT(*)
      FROM report_fact_stage s
      WHERE s.job_id = NEW.job_id
    ) <> NEW.raw_row_count;

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_DATASET_MISMATCH')
    WHERE EXISTS (
      SELECT 1
      FROM report_fact_stage s
      WHERE s.job_id = NEW.job_id
        AND s.dataset_key <> 'search_term_daily'
    );

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_ORDINAL_GAP')
    WHERE NEW.raw_row_count > 0
      AND (
        (SELECT MIN(s.source_row_ordinal) FROM report_fact_stage s WHERE s.job_id = NEW.job_id) <> 0
        OR
        (SELECT MAX(s.source_row_ordinal) FROM report_fact_stage s WHERE s.job_id = NEW.job_id)
          <> NEW.raw_row_count - 1
      );

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_CANONICAL_JSON_INVALID')
    WHERE EXISTS (
      SELECT 1
      FROM report_fact_stage s
      WHERE s.job_id = NEW.job_id
        AND json_valid(s.canonical_row_json) = 0
    );

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_ROW_KEY_MISMATCH')
    WHERE EXISTS (
      SELECT 1
      FROM report_fact_stage s
      WHERE s.job_id = NEW.job_id
        AND (
          json_type(s.canonical_row_json, '$.rowKey') <> 'text'
          OR s.logical_row_key IS NOT json_extract(s.canonical_row_json, '$.rowKey')
        )
    );

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_SOURCE_JOB_MISMATCH')
    WHERE EXISTS (
      SELECT 1
      FROM report_fact_stage s
      WHERE s.job_id = NEW.job_id
        AND (
          json_type(s.canonical_row_json, '$.sourceReportJobId') <> 'text'
          OR json_extract(s.canonical_row_json, '$.sourceReportJobId') IS NOT NEW.job_id
        )
    );

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_PROFILE_MISMATCH')
    WHERE EXISTS (
      SELECT 1
      FROM report_fact_stage s
      WHERE s.job_id = NEW.job_id
        AND (
          json_type(s.canonical_row_json, '$.profileId') <> 'text'
          OR json_extract(s.canonical_row_json, '$.profileId') IS NOT NEW.profile_id
        )
    );

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_AD_PRODUCT_MISMATCH')
    WHERE EXISTS (
      SELECT 1
      FROM report_fact_stage s
      WHERE s.job_id = NEW.job_id
        AND (
          json_type(s.canonical_row_json, '$.adProduct') <> 'text'
          OR json_extract(s.canonical_row_json, '$.adProduct') IS NOT NEW.ad_product
        )
    );

  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_RECEIPT_DATE_MISMATCH')
    WHERE EXISTS (
      SELECT 1
      FROM report_fact_stage s
      WHERE s.job_id = NEW.job_id
        AND (
          json_type(s.canonical_row_json, '$.reportDate') <> 'text'
          OR length(json_extract(s.canonical_row_json, '$.reportDate')) <> 10
          OR json_extract(s.canonical_row_json, '$.reportDate') NOT GLOB
             '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          OR json_extract(s.canonical_row_json, '$.reportDate') < NEW.start_date
          OR json_extract(s.canonical_row_json, '$.reportDate') > NEW.end_date
        )
    );
END;

PRAGMA optimize;
