-- Phase E - entity mirror write-time hierarchy and durable stage/final snapshot receipt guards.

ALTER TABLE amazon_entity_snapshot_receipts
ADD COLUMN snapshot_sha256 TEXT CHECK (snapshot_sha256 IS NULL OR length(snapshot_sha256) = 64);

CREATE TABLE amazon_entity_stage_receipts (
  run_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  snapshot_synced_at TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  campaign_count INTEGER NOT NULL CHECK (campaign_count >= 0),
  ad_group_count INTEGER NOT NULL CHECK (ad_group_count >= 0),
  keyword_count INTEGER NOT NULL CHECK (keyword_count >= 0),
  target_count INTEGER NOT NULL CHECK (target_count >= 0),
  staged_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES sync_runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT
);

CREATE TRIGGER trg_campaign_identity_guard
BEFORE UPDATE ON campaigns
BEGIN
  SELECT RAISE(ABORT, 'CAMPAIGN_PROFILE_IMMUTABLE')
    WHERE OLD.profile_id IS NOT NEW.profile_id;
END;

CREATE TRIGGER trg_ad_group_insert_hierarchy
BEFORE INSERT ON ad_groups
BEGIN
  SELECT RAISE(ABORT, 'AD_GROUP_CAMPAIGN_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM campaigns c
      WHERE c.campaign_id = NEW.campaign_id AND c.profile_id = NEW.profile_id
    );
END;

CREATE TRIGGER trg_ad_group_update_guard
BEFORE UPDATE ON ad_groups
BEGIN
  SELECT RAISE(ABORT, 'AD_GROUP_IDENTITY_IMMUTABLE')
    WHERE OLD.profile_id IS NOT NEW.profile_id OR OLD.campaign_id IS NOT NEW.campaign_id;
  SELECT RAISE(ABORT, 'AD_GROUP_CAMPAIGN_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM campaigns c
      WHERE c.campaign_id = NEW.campaign_id AND c.profile_id = NEW.profile_id
    );
END;

CREATE TRIGGER trg_keyword_insert_hierarchy
BEFORE INSERT ON keywords
BEGIN
  SELECT RAISE(ABORT, 'KEYWORD_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM ad_groups a
      WHERE a.ad_group_id = NEW.ad_group_id
        AND a.campaign_id = NEW.campaign_id
        AND a.profile_id = NEW.profile_id
    );
END;

CREATE TRIGGER trg_keyword_update_guard
BEFORE UPDATE ON keywords
BEGIN
  SELECT RAISE(ABORT, 'KEYWORD_IDENTITY_IMMUTABLE')
    WHERE OLD.profile_id IS NOT NEW.profile_id
       OR OLD.campaign_id IS NOT NEW.campaign_id
       OR OLD.ad_group_id IS NOT NEW.ad_group_id;
  SELECT RAISE(ABORT, 'KEYWORD_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM ad_groups a
      WHERE a.ad_group_id = NEW.ad_group_id
        AND a.campaign_id = NEW.campaign_id
        AND a.profile_id = NEW.profile_id
    );
END;

CREATE TRIGGER trg_target_insert_hierarchy
BEFORE INSERT ON targets
BEGIN
  SELECT RAISE(ABORT, 'TARGET_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM ad_groups a
      WHERE a.ad_group_id = NEW.ad_group_id
        AND a.campaign_id = NEW.campaign_id
        AND a.profile_id = NEW.profile_id
    );
END;

CREATE TRIGGER trg_target_update_guard
BEFORE UPDATE ON targets
BEGIN
  SELECT RAISE(ABORT, 'TARGET_IDENTITY_IMMUTABLE')
    WHERE OLD.profile_id IS NOT NEW.profile_id
       OR OLD.campaign_id IS NOT NEW.campaign_id
       OR OLD.ad_group_id IS NOT NEW.ad_group_id;
  SELECT RAISE(ABORT, 'TARGET_HIERARCHY_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM ad_groups a
      WHERE a.ad_group_id = NEW.ad_group_id
        AND a.campaign_id = NEW.campaign_id
        AND a.profile_id = NEW.profile_id
    );
END;

DROP TRIGGER trg_amazon_entity_stage_insert_guard;

CREATE TRIGGER trg_amazon_entity_stage_insert_guard
BEFORE INSERT ON amazon_entity_stage
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_STAGE_FROZEN')
    WHERE EXISTS (
      SELECT 1 FROM amazon_entity_stage_receipts r WHERE r.run_id = NEW.run_id
    ) OR EXISTS (
      SELECT 1 FROM amazon_entity_snapshot_receipts r WHERE r.run_id = NEW.run_id
    );
  SELECT RAISE(ABORT, 'ENTITY_STAGE_SYNC_RUN_PROFILE_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_runs sr
      WHERE sr.run_id = NEW.run_id AND sr.profile_id = NEW.profile_id AND sr.status = 'running'
    );
END;

CREATE TRIGGER trg_amazon_entity_stage_update_guard
BEFORE UPDATE ON amazon_entity_stage
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_STAGE_FROZEN')
    WHERE EXISTS (
      SELECT 1 FROM amazon_entity_stage_receipts r WHERE r.run_id = OLD.run_id
    ) OR EXISTS (
      SELECT 1 FROM amazon_entity_snapshot_receipts r WHERE r.run_id = OLD.run_id
    );
  SELECT RAISE(ABORT, 'ENTITY_STAGE_IDENTITY_IMMUTABLE')
    WHERE OLD.run_id IS NOT NEW.run_id
       OR OLD.profile_id IS NOT NEW.profile_id
       OR OLD.entity_type IS NOT NEW.entity_type
       OR OLD.source_row_ordinal IS NOT NEW.source_row_ordinal
       OR OLD.entity_id IS NOT NEW.entity_id;
END;

CREATE TRIGGER trg_amazon_entity_stage_delete_guard
BEFORE DELETE ON amazon_entity_stage
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_STAGE_FROZEN')
    WHERE EXISTS (
      SELECT 1 FROM amazon_entity_stage_receipts r WHERE r.run_id = OLD.run_id
    ) AND NOT EXISTS (
      SELECT 1 FROM amazon_entity_snapshot_receipts r WHERE r.run_id = OLD.run_id
    );
END;

CREATE TRIGGER trg_entity_stage_receipt_insert_guard
BEFORE INSERT ON amazon_entity_stage_receipts
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_STAGE_RECEIPT_SYNC_RUN_PROFILE_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_runs sr
      WHERE sr.run_id = NEW.run_id AND sr.profile_id = NEW.profile_id AND sr.status = 'running'
    );
  SELECT RAISE(ABORT, 'ENTITY_STAGE_RECEIPT_AFTER_FINAL_FORBIDDEN')
    WHERE EXISTS (
      SELECT 1 FROM amazon_entity_snapshot_receipts r WHERE r.run_id = NEW.run_id
    );
  SELECT RAISE(ABORT, 'ENTITY_STAGE_RECEIPT_COUNTS_MISMATCH')
    WHERE (SELECT COUNT(*) FROM amazon_entity_stage s WHERE s.run_id = NEW.run_id AND s.entity_type = 'campaign') <> NEW.campaign_count
       OR (SELECT COUNT(*) FROM amazon_entity_stage s WHERE s.run_id = NEW.run_id AND s.entity_type = 'ad_group') <> NEW.ad_group_count
       OR (SELECT COUNT(*) FROM amazon_entity_stage s WHERE s.run_id = NEW.run_id AND s.entity_type = 'keyword') <> NEW.keyword_count
       OR (SELECT COUNT(*) FROM amazon_entity_stage s WHERE s.run_id = NEW.run_id AND s.entity_type = 'target') <> NEW.target_count;
  SELECT RAISE(ABORT, 'ENTITY_STAGE_RECEIPT_STAGE_INVALID')
    WHERE EXISTS (
      SELECT 1 FROM amazon_entity_stage s
      WHERE s.run_id = NEW.run_id
        AND (s.profile_id <> NEW.profile_id OR json_valid(s.canonical_entity_json) = 0)
    );
  SELECT RAISE(ABORT, 'ENTITY_STAGE_RECEIPT_STAGE_IDENTITY_MISMATCH')
    WHERE EXISTS (
      SELECT 1 FROM amazon_entity_stage s
      WHERE s.run_id = NEW.run_id
        AND (
          json_extract(s.canonical_entity_json, '$.profileId') <> NEW.profile_id OR
          json_extract(s.canonical_entity_json, '$.syncedAt') <> NEW.snapshot_synced_at OR
          json_extract(s.canonical_entity_json, '$.entityType') <> s.entity_type OR
          CASE s.entity_type
            WHEN 'campaign' THEN json_extract(s.canonical_entity_json, '$.campaignId')
            WHEN 'ad_group' THEN json_extract(s.canonical_entity_json, '$.adGroupId')
            WHEN 'keyword' THEN json_extract(s.canonical_entity_json, '$.keywordId')
            WHEN 'target' THEN json_extract(s.canonical_entity_json, '$.targetId')
          END <> s.entity_id
        )
    );
END;

CREATE TRIGGER trg_entity_stage_receipt_update_guard
BEFORE UPDATE ON amazon_entity_stage_receipts
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_STAGE_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER trg_entity_stage_receipt_delete_guard
BEFORE DELETE ON amazon_entity_stage_receipts
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_STAGE_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER trg_entity_snapshot_receipt_new_hash_required
BEFORE INSERT ON amazon_entity_snapshot_receipts
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_SNAPSHOT_HASH_REQUIRED')
    WHERE NEW.snapshot_sha256 IS NULL OR length(NEW.snapshot_sha256) <> 64;
END;

CREATE TRIGGER trg_entity_snapshot_receipt_delete_guard
BEFORE DELETE ON amazon_entity_snapshot_receipts
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_SNAPSHOT_RECEIPT_IMMUTABLE');
END;

PRAGMA optimize;
