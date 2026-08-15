-- Phase E prototype - deterministic staging and search-term write-time invariants.

ALTER TABLE search_term_daily ADD COLUMN source_keyword_type TEXT;

CREATE TABLE report_fact_stage (
  job_id TEXT NOT NULL,
  dataset_key TEXT NOT NULL,
  source_row_ordinal INTEGER NOT NULL CHECK (source_row_ordinal >= 0),
  logical_row_key TEXT NOT NULL,
  canonical_row_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, source_row_ordinal),
  UNIQUE (job_id, logical_row_key),
  FOREIGN KEY (job_id) REFERENCES report_jobs(job_id) ON DELETE CASCADE
);

CREATE TABLE amazon_entity_stage (
  run_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('campaign','ad_group','keyword','target')),
  source_row_ordinal INTEGER NOT NULL CHECK (source_row_ordinal >= 0),
  entity_id TEXT NOT NULL,
  canonical_entity_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, entity_type, source_row_ordinal),
  UNIQUE (run_id, entity_type, entity_id),
  FOREIGN KEY (run_id) REFERENCES sync_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT
);

CREATE TABLE amazon_entity_snapshot_receipts (
  run_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  snapshot_synced_at TEXT NOT NULL,
  campaign_count INTEGER NOT NULL CHECK (campaign_count >= 0),
  ad_group_count INTEGER NOT NULL CHECK (ad_group_count >= 0),
  keyword_count INTEGER NOT NULL CHECK (keyword_count >= 0),
  target_count INTEGER NOT NULL CHECK (target_count >= 0),
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES sync_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_amazon_entity_stage_insert_guard
BEFORE INSERT ON amazon_entity_stage
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_STAGE_SYNC_RUN_PROFILE_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_runs sr
      WHERE sr.run_id = NEW.run_id AND sr.profile_id = NEW.profile_id AND sr.status = 'running'
    );
END;

CREATE TRIGGER trg_report_fact_stage_insert_guard
BEFORE INSERT ON report_fact_stage
BEGIN
  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_FROZEN')
    WHERE EXISTS (
      SELECT 1 FROM report_jobs rj
      WHERE rj.job_id = NEW.job_id AND rj.raw_row_count IS NOT NULL
    );
END;

CREATE TRIGGER trg_report_fact_stage_update_guard
BEFORE UPDATE ON report_fact_stage
BEGIN
  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_FROZEN')
    WHERE EXISTS (
      SELECT 1 FROM report_jobs rj
      WHERE rj.job_id = OLD.job_id AND rj.raw_row_count IS NOT NULL
    );
END;

CREATE TRIGGER trg_report_fact_stage_delete_guard
BEFORE DELETE ON report_fact_stage
BEGIN
  SELECT RAISE(ABORT, 'REPORT_FACT_STAGE_FROZEN')
    WHERE EXISTS (
      SELECT 1 FROM report_jobs rj
      WHERE rj.job_id = OLD.job_id
        AND rj.raw_row_count IS NOT NULL
        AND rj.status <> 'ingested'
    );
END;

CREATE TRIGGER trg_entity_snapshot_receipt_profile_match
BEFORE INSERT ON amazon_entity_snapshot_receipts
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_SNAPSHOT_SYNC_RUN_PROFILE_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_runs sr
      WHERE sr.run_id = NEW.run_id AND sr.profile_id = NEW.profile_id AND sr.status = 'running'
    );
END;

CREATE TRIGGER trg_entity_snapshot_receipt_update_guard
BEFORE UPDATE ON amazon_entity_snapshot_receipts
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_SNAPSHOT_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER trg_search_term_daily_insert_integrity
BEFORE INSERT ON search_term_daily
BEGIN
  SELECT RAISE(ABORT, 'SEARCH_TERM_SOURCE_KEYWORD_TYPE_REQUIRED')
    WHERE NEW.source_keyword_type IS NULL OR NEW.source_keyword_type NOT IN (
      'BROAD','PHRASE','EXACT','TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED'
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_TARGETING_XOR_INVALID')
    WHERE NOT (
      (NEW.keyword_id IS NOT NULL AND NEW.target_id IS NULL) OR
      (NEW.keyword_id IS NULL AND NEW.target_id IS NOT NULL)
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_KEYWORD_TYPE_PATH_MISMATCH')
    WHERE (
      NEW.source_keyword_type IN ('BROAD','PHRASE','EXACT') AND (NEW.keyword_id IS NULL OR NEW.target_id IS NOT NULL)
    ) OR (
      NEW.source_keyword_type IN ('TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED') AND (NEW.keyword_id IS NOT NULL OR NEW.target_id IS NULL)
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_CAMPAIGN_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM campaigns c
      WHERE c.campaign_id = NEW.campaign_id AND c.profile_id = NEW.profile_id
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_AD_GROUP_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM ad_groups a
      WHERE a.ad_group_id = NEW.ad_group_id
        AND a.profile_id = NEW.profile_id
        AND a.campaign_id = NEW.campaign_id
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_KEYWORD_HIERARCHY_MISMATCH')
    WHERE NEW.keyword_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM keywords k
      WHERE k.keyword_id = NEW.keyword_id
        AND k.profile_id = NEW.profile_id
        AND k.campaign_id = NEW.campaign_id
        AND k.ad_group_id = NEW.ad_group_id
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_TARGET_HIERARCHY_MISMATCH')
    WHERE NEW.target_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM targets t
      WHERE t.target_id = NEW.target_id
        AND t.profile_id = NEW.profile_id
        AND t.campaign_id = NEW.campaign_id
        AND t.ad_group_id = NEW.ad_group_id
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_SOURCE_REPORT_JOB_REQUIRED')
    WHERE NEW.source_report_job_id IS NULL;
  SELECT RAISE(ABORT, 'SEARCH_TERM_SOURCE_REPORT_JOB_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM report_jobs rj
      WHERE rj.job_id = NEW.source_report_job_id
        AND rj.profile_id = NEW.profile_id
        AND rj.ad_product = NEW.ad_product
        AND rj.start_date <= NEW.report_date
        AND rj.end_date >= NEW.report_date
        AND rj.status IN ('downloaded','ingested')
    );
END;

CREATE TRIGGER trg_search_term_daily_update_integrity
BEFORE UPDATE ON search_term_daily
WHEN OLD.source_keyword_type IS NOT NULL OR OLD.source_report_job_id IS NOT NULL
  OR NEW.source_keyword_type IS NOT NULL OR NEW.source_report_job_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'SEARCH_TERM_SOURCE_KEYWORD_TYPE_IMMUTABLE')
    WHERE OLD.source_keyword_type IS NOT NULL AND OLD.source_keyword_type IS NOT NEW.source_keyword_type;
  SELECT RAISE(ABORT, 'SEARCH_TERM_SOURCE_REPORT_JOB_IMMUTABLE')
    WHERE OLD.source_report_job_id IS NOT NULL AND OLD.source_report_job_id IS NOT NEW.source_report_job_id;
  SELECT RAISE(ABORT, 'SEARCH_TERM_SOURCE_KEYWORD_TYPE_REQUIRED')
    WHERE NEW.source_keyword_type IS NULL OR NEW.source_keyword_type NOT IN (
      'BROAD','PHRASE','EXACT','TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED'
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_TARGETING_XOR_INVALID')
    WHERE NOT (
      (NEW.keyword_id IS NOT NULL AND NEW.target_id IS NULL) OR
      (NEW.keyword_id IS NULL AND NEW.target_id IS NOT NULL)
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_KEYWORD_TYPE_PATH_MISMATCH')
    WHERE (
      NEW.source_keyword_type IN ('BROAD','PHRASE','EXACT') AND (NEW.keyword_id IS NULL OR NEW.target_id IS NOT NULL)
    ) OR (
      NEW.source_keyword_type IN ('TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED') AND (NEW.keyword_id IS NOT NULL OR NEW.target_id IS NULL)
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_CAMPAIGN_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM campaigns c
      WHERE c.campaign_id = NEW.campaign_id AND c.profile_id = NEW.profile_id
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_AD_GROUP_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM ad_groups a
      WHERE a.ad_group_id = NEW.ad_group_id
        AND a.profile_id = NEW.profile_id
        AND a.campaign_id = NEW.campaign_id
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_KEYWORD_HIERARCHY_MISMATCH')
    WHERE NEW.keyword_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM keywords k
      WHERE k.keyword_id = NEW.keyword_id
        AND k.profile_id = NEW.profile_id
        AND k.campaign_id = NEW.campaign_id
        AND k.ad_group_id = NEW.ad_group_id
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_TARGET_HIERARCHY_MISMATCH')
    WHERE NEW.target_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM targets t
      WHERE t.target_id = NEW.target_id
        AND t.profile_id = NEW.profile_id
        AND t.campaign_id = NEW.campaign_id
        AND t.ad_group_id = NEW.ad_group_id
    );
  SELECT RAISE(ABORT, 'SEARCH_TERM_SOURCE_REPORT_JOB_REQUIRED')
    WHERE NEW.source_report_job_id IS NULL;
  SELECT RAISE(ABORT, 'SEARCH_TERM_SOURCE_REPORT_JOB_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM report_jobs rj
      WHERE rj.job_id = NEW.source_report_job_id
        AND rj.profile_id = NEW.profile_id
        AND rj.ad_product = NEW.ad_product
        AND rj.start_date <= NEW.report_date
        AND rj.end_date >= NEW.report_date
        AND rj.status IN ('downloaded','ingested')
    );
END;

CREATE INDEX idx_report_fact_stage_job_dataset ON report_fact_stage(job_id, dataset_key, source_row_ordinal);
CREATE INDEX idx_amazon_entity_stage_run_type ON amazon_entity_stage(run_id, entity_type, source_row_ordinal);

PRAGMA optimize;
