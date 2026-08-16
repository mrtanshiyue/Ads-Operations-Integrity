-- Phase E - fail closed before an entity stage receipt can authorize canonical publish.
-- Existing Amazon entity IDs may never be rebound across profile/campaign/ad-group identity.

DROP TRIGGER trg_entity_stage_receipt_insert_guard;

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

  SELECT RAISE(ABORT, 'ENTITY_STAGE_AD_GROUP_HIERARCHY_INVALID')
    WHERE EXISTS (
      SELECT 1
      FROM amazon_entity_stage ag
      WHERE ag.run_id = NEW.run_id AND ag.entity_type = 'ad_group'
        AND NOT EXISTS (
          SELECT 1 FROM amazon_entity_stage c
          WHERE c.run_id = ag.run_id
            AND c.entity_type = 'campaign'
            AND c.entity_id = json_extract(ag.canonical_entity_json, '$.campaignId')
        )
    );

  SELECT RAISE(ABORT, 'ENTITY_STAGE_KEYWORD_HIERARCHY_INVALID')
    WHERE EXISTS (
      SELECT 1
      FROM amazon_entity_stage k
      WHERE k.run_id = NEW.run_id AND k.entity_type = 'keyword'
        AND NOT EXISTS (
          SELECT 1
          FROM amazon_entity_stage ag
          JOIN amazon_entity_stage c
            ON c.run_id = ag.run_id
           AND c.entity_type = 'campaign'
           AND c.entity_id = json_extract(k.canonical_entity_json, '$.campaignId')
          WHERE ag.run_id = k.run_id
            AND ag.entity_type = 'ad_group'
            AND ag.entity_id = json_extract(k.canonical_entity_json, '$.adGroupId')
            AND json_extract(ag.canonical_entity_json, '$.campaignId') = json_extract(k.canonical_entity_json, '$.campaignId')
        )
    );

  SELECT RAISE(ABORT, 'ENTITY_STAGE_TARGET_HIERARCHY_INVALID')
    WHERE EXISTS (
      SELECT 1
      FROM amazon_entity_stage t
      WHERE t.run_id = NEW.run_id AND t.entity_type = 'target'
        AND NOT EXISTS (
          SELECT 1
          FROM amazon_entity_stage ag
          JOIN amazon_entity_stage c
            ON c.run_id = ag.run_id
           AND c.entity_type = 'campaign'
           AND c.entity_id = json_extract(t.canonical_entity_json, '$.campaignId')
          WHERE ag.run_id = t.run_id
            AND ag.entity_type = 'ad_group'
            AND ag.entity_id = json_extract(t.canonical_entity_json, '$.adGroupId')
            AND json_extract(ag.canonical_entity_json, '$.campaignId') = json_extract(t.canonical_entity_json, '$.campaignId')
        )
    );

  SELECT RAISE(ABORT, 'ENTITY_STAGE_CAMPAIGN_IDENTITY_CONFLICT')
    WHERE EXISTS (
      SELECT 1
      FROM amazon_entity_stage s
      JOIN campaigns c ON c.campaign_id = s.entity_id
      WHERE s.run_id = NEW.run_id
        AND s.entity_type = 'campaign'
        AND c.profile_id IS NOT NEW.profile_id
    );

  SELECT RAISE(ABORT, 'ENTITY_STAGE_AD_GROUP_IDENTITY_CONFLICT')
    WHERE EXISTS (
      SELECT 1
      FROM amazon_entity_stage s
      JOIN ad_groups ag ON ag.ad_group_id = s.entity_id
      WHERE s.run_id = NEW.run_id
        AND s.entity_type = 'ad_group'
        AND (
          ag.profile_id IS NOT NEW.profile_id OR
          ag.campaign_id IS NOT json_extract(s.canonical_entity_json, '$.campaignId')
        )
    );

  SELECT RAISE(ABORT, 'ENTITY_STAGE_KEYWORD_IDENTITY_CONFLICT')
    WHERE EXISTS (
      SELECT 1
      FROM amazon_entity_stage s
      JOIN keywords k ON k.keyword_id = s.entity_id
      WHERE s.run_id = NEW.run_id
        AND s.entity_type = 'keyword'
        AND (
          k.profile_id IS NOT NEW.profile_id OR
          k.campaign_id IS NOT json_extract(s.canonical_entity_json, '$.campaignId') OR
          k.ad_group_id IS NOT json_extract(s.canonical_entity_json, '$.adGroupId')
        )
    );

  SELECT RAISE(ABORT, 'ENTITY_STAGE_TARGET_IDENTITY_CONFLICT')
    WHERE EXISTS (
      SELECT 1
      FROM amazon_entity_stage s
      JOIN targets t ON t.target_id = s.entity_id
      WHERE s.run_id = NEW.run_id
        AND s.entity_type = 'target'
        AND (
          t.profile_id IS NOT NEW.profile_id OR
          t.campaign_id IS NOT json_extract(s.canonical_entity_json, '$.campaignId') OR
          t.ad_group_id IS NOT json_extract(s.canonical_entity_json, '$.adGroupId')
        )
    );
END;

PRAGMA optimize;
