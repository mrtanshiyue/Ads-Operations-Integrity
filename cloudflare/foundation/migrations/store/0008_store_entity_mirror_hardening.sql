-- Phase E - forward hardening for entity snapshot receipts and deterministic insert guards.

DROP TRIGGER trg_entity_stage_receipt_insert_guard;
DROP TRIGGER trg_entity_snapshot_receipt_profile_match;
DROP TRIGGER trg_entity_snapshot_receipt_new_hash_required;

CREATE TRIGGER trg_entity_stage_receipt_insert_guard
BEFORE INSERT ON amazon_entity_stage_receipts
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_STAGE_HASH_INVALID')
    WHERE length(NEW.snapshot_sha256) <> 64
       OR NEW.snapshot_sha256 GLOB '*[^0-9a-f]*';
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
          json_extract(s.canonical_entity_json, '$.profileId') IS NULL OR
          json_extract(s.canonical_entity_json, '$.profileId') <> NEW.profile_id OR
          json_extract(s.canonical_entity_json, '$.syncedAt') IS NULL OR
          json_extract(s.canonical_entity_json, '$.syncedAt') <> NEW.snapshot_synced_at OR
          json_extract(s.canonical_entity_json, '$.entityType') IS NULL OR
          json_extract(s.canonical_entity_json, '$.entityType') <> s.entity_type OR
          CASE s.entity_type
            WHEN 'campaign' THEN json_extract(s.canonical_entity_json, '$.campaignId')
            WHEN 'ad_group' THEN json_extract(s.canonical_entity_json, '$.adGroupId')
            WHEN 'keyword' THEN json_extract(s.canonical_entity_json, '$.keywordId')
            WHEN 'target' THEN json_extract(s.canonical_entity_json, '$.targetId')
          END IS NULL OR
          CASE s.entity_type
            WHEN 'campaign' THEN json_extract(s.canonical_entity_json, '$.campaignId')
            WHEN 'ad_group' THEN json_extract(s.canonical_entity_json, '$.adGroupId')
            WHEN 'keyword' THEN json_extract(s.canonical_entity_json, '$.keywordId')
            WHEN 'target' THEN json_extract(s.canonical_entity_json, '$.targetId')
          END <> s.entity_id
        )
    );
END;

CREATE TRIGGER trg_entity_snapshot_receipt_insert_guard
BEFORE INSERT ON amazon_entity_snapshot_receipts
BEGIN
  SELECT RAISE(ABORT, 'ENTITY_SNAPSHOT_HASH_REQUIRED')
    WHERE NEW.snapshot_sha256 IS NULL;
  SELECT RAISE(ABORT, 'ENTITY_SNAPSHOT_HASH_INVALID')
    WHERE length(NEW.snapshot_sha256) <> 64
       OR NEW.snapshot_sha256 GLOB '*[^0-9a-f]*';
  SELECT RAISE(ABORT, 'ENTITY_SNAPSHOT_SYNC_RUN_PROFILE_MISMATCH')
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_runs sr
      WHERE sr.run_id = NEW.run_id AND sr.profile_id = NEW.profile_id AND sr.status = 'running'
    );
  SELECT RAISE(ABORT, 'ENTITY_SNAPSHOT_STAGE_RECEIPT_REQUIRED')
    WHERE NOT EXISTS (
      SELECT 1 FROM amazon_entity_stage_receipts er
      WHERE er.run_id = NEW.run_id
        AND er.profile_id = NEW.profile_id
        AND er.snapshot_synced_at = NEW.snapshot_synced_at
        AND er.snapshot_sha256 = NEW.snapshot_sha256
        AND er.campaign_count = NEW.campaign_count
        AND er.ad_group_count = NEW.ad_group_count
        AND er.keyword_count = NEW.keyword_count
        AND er.target_count = NEW.target_count
    );
END;

PRAGMA optimize;
