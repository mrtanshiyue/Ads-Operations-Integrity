import { buildEntityStageRows, validateEntitySnapshotHierarchy } from './amazon-entity-contract.js';

export class EntityMirrorProducerError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'EntityMirrorProducerError';
    this.code = code;
    this.cause = cause;
  }
}

export function inspectEntityMirrorReceipt({ run, finalReceipt, stageReceipt, profileId }) {
  if (!run) throw new EntityMirrorProducerError('SYNC_RUN_RECEIPT_MISSING');
  if (run.status !== 'running') throw new EntityMirrorProducerError('ENTITY_MIRROR_SYNC_RUN_NOT_RUNNING');
  if (run.profile_id !== profileId) throw new EntityMirrorProducerError('ENTITY_MIRROR_PROFILE_RECEIPT_MISMATCH');
  if (finalReceipt) {
    assertReceiptBase(finalReceipt, run.run_id, profileId, 'ENTITY_SNAPSHOT');
    return 'REUSE_ENTITY_MIRROR_RECEIPT';
  }
  if (stageReceipt) {
    assertReceiptBase(stageReceipt, run.run_id, profileId, 'ENTITY_STAGE');
    return 'REUSE_ENTITY_STAGE_RECEIPT';
  }
  return 'STAGE_AND_PUBLISH';
}

export async function stageEntityMirrorSnapshot({ repository, runId, snapshot, stagedAt }) {
  validateEntitySnapshotHierarchy(snapshot);
  const run = await repository.loadRun(runId);
  let finalReceipt = await repository.loadReceipt(runId);
  let stageReceipt = await repository.loadStageReceipt(runId);
  const decision = inspectEntityMirrorReceipt({ run, finalReceipt, stageReceipt, profileId: snapshot.profileId });

  if (decision === 'REUSE_ENTITY_MIRROR_RECEIPT') {
    assertSnapshotReceipt(finalReceipt, runId, snapshot);
    return { reused: true, published: true, receipt: finalReceipt };
  }
  if (decision === 'REUSE_ENTITY_STAGE_RECEIPT') {
    assertStageReceipt(stageReceipt, runId, snapshot);
    const summary = await repository.loadStageSummary(runId);
    assertStageSummary(summary, snapshot);
    return { reused: true, published: false, stageReceipt };
  }

  const rows = buildEntityStageRows({ runId, snapshot });
  try {
    await repository.replaceStageAndPersistReceipt({
      runId,
      rows,
      profileId: snapshot.profileId,
      syncedAt: snapshot.syncedAt,
      snapshotHash: snapshot.snapshotHash,
      counts: snapshot.counts,
      stagedAt: requiredText(stagedAt, 'ENTITY_SNAPSHOT_STAGED_AT_REQUIRED'),
    });
  } catch (error) {
    finalReceipt = await repository.loadReceipt(runId);
    if (finalReceipt) {
      assertSnapshotReceipt(finalReceipt, runId, snapshot);
      return { reused: true, published: true, receipt: finalReceipt };
    }
    stageReceipt = await repository.loadStageReceipt(runId);
    if (stageReceipt) {
      assertStageReceipt(stageReceipt, runId, snapshot);
      return { reused: true, published: false, stageReceipt };
    }
    throw new EntityMirrorProducerError('ENTITY_STAGE_PERSIST_FAILED', error);
  }

  stageReceipt = await repository.loadStageReceipt(runId);
  assertStageReceipt(stageReceipt, runId, snapshot);
  const summary = await repository.loadStageSummary(runId);
  assertStageSummary(summary, snapshot);
  return { reused: false, published: false, stageReceipt };
}

export async function publishEntityMirrorSnapshot({ repository, runId, snapshot, publishedAt }) {
  validateEntitySnapshotHierarchy(snapshot);
  const run = await repository.loadRun(runId);
  let finalReceipt = await repository.loadReceipt(runId);
  const stageReceipt = await repository.loadStageReceipt(runId);
  const decision = inspectEntityMirrorReceipt({ run, finalReceipt, stageReceipt, profileId: snapshot.profileId });

  if (decision === 'REUSE_ENTITY_MIRROR_RECEIPT') {
    assertSnapshotReceipt(finalReceipt, runId, snapshot);
    return { reused: true, receipt: finalReceipt };
  }
  if (decision !== 'REUSE_ENTITY_STAGE_RECEIPT') {
    throw new EntityMirrorProducerError('ENTITY_STAGE_RECEIPT_REQUIRED');
  }
  assertStageReceipt(stageReceipt, runId, snapshot);
  const summary = await repository.loadStageSummary(runId);
  assertStageSummary(summary, snapshot);

  try {
    await repository.publishStage({
      runId,
      profileId: snapshot.profileId,
      syncedAt: snapshot.syncedAt,
      snapshotHash: snapshot.snapshotHash,
      counts: snapshot.counts,
      publishedAt: requiredText(publishedAt, 'ENTITY_SNAPSHOT_PUBLISHED_AT_REQUIRED'),
    });
  } catch (error) {
    finalReceipt = await repository.loadReceipt(runId);
    if (finalReceipt) {
      assertSnapshotReceipt(finalReceipt, runId, snapshot);
      return { reused: true, receipt: finalReceipt };
    }
    throw new EntityMirrorProducerError('ENTITY_MIRROR_PUBLISH_FAILED', error);
  }

  finalReceipt = await repository.loadReceipt(runId);
  assertSnapshotReceipt(finalReceipt, runId, snapshot);
  return { reused: false, receipt: finalReceipt };
}

export function assertStageSummary(summary, snapshot) {
  if (!summary) throw new EntityMirrorProducerError('ENTITY_STAGE_SUMMARY_MISSING');
  if (summary.profile_id !== snapshot.profileId) throw new EntityMirrorProducerError('ENTITY_STAGE_PROFILE_MISMATCH');
  const expectedTotal = Object.values(snapshot.counts).reduce((sum, value) => sum + value, 0);
  if (expectedTotal > 0 && summary.snapshot_synced_at !== snapshot.syncedAt) {
    throw new EntityMirrorProducerError('ENTITY_STAGE_SYNCED_AT_MISMATCH');
  }
  if (!isNonNegativeSafeInteger(summary.invalid_rows)) throw new EntityMirrorProducerError('ENTITY_STAGE_SUMMARY_INVALID_COUNT');
  if (summary.invalid_rows !== 0) throw new EntityMirrorProducerError('ENTITY_STAGE_INVALID');
  for (const [type, field] of [
    ['campaign', 'campaign_count'],
    ['ad_group', 'ad_group_count'],
    ['keyword', 'keyword_count'],
    ['target', 'target_count'],
  ]) {
    if (!isNonNegativeSafeInteger(summary[field]) || summary[field] !== snapshot.counts[type]) {
      throw new EntityMirrorProducerError(`ENTITY_STAGE_COUNT_MISMATCH:${type}`);
    }
  }
  return true;
}

export function assertStageReceipt(receipt, runId, snapshot) {
  assertReceiptBase(receipt, runId, snapshot.profileId, 'ENTITY_STAGE');
  if (!receipt.staged_at) throw new EntityMirrorProducerError('ENTITY_STAGE_RECEIPT_INCOMPLETE');
  assertReceiptSnapshotFields(receipt, snapshot, 'ENTITY_STAGE_RECEIPT_CONFLICT');
  return true;
}

export function assertSnapshotReceipt(receipt, runId, snapshot) {
  assertReceiptBase(receipt, runId, snapshot.profileId, 'ENTITY_SNAPSHOT');
  if (!receipt.published_at) throw new EntityMirrorProducerError('ENTITY_SNAPSHOT_RECEIPT_INCOMPLETE');
  assertReceiptSnapshotFields(receipt, snapshot, 'ENTITY_SNAPSHOT_RECEIPT_CONFLICT');
  return true;
}

export function createD1EntityMirrorRepository(db) {
  return {
    async loadRun(runId) {
      return db.prepare(`
        SELECT run_id, profile_id, status, intent_fingerprint, started_at, created_at
        FROM sync_runs
        WHERE run_id = ?1
        LIMIT 1
      `).bind(runId).first();
    },

    async loadReceipt(runId) {
      return db.prepare(`
        SELECT run_id, profile_id, snapshot_synced_at, snapshot_sha256,
               campaign_count, ad_group_count, keyword_count, target_count, published_at
        FROM amazon_entity_snapshot_receipts
        WHERE run_id = ?1
        LIMIT 1
      `).bind(runId).first();
    },

    async loadStageReceipt(runId) {
      return db.prepare(`
        SELECT run_id, profile_id, snapshot_synced_at, snapshot_sha256,
               campaign_count, ad_group_count, keyword_count, target_count, staged_at
        FROM amazon_entity_stage_receipts
        WHERE run_id = ?1
        LIMIT 1
      `).bind(runId).first();
    },

    async replaceStageAndPersistReceipt({ runId, rows, profileId, syncedAt, snapshotHash, counts, stagedAt }) {
      const statements = [
        db.prepare(`
          DELETE FROM amazon_entity_stage
          WHERE run_id = ?1
            AND NOT EXISTS (SELECT 1 FROM amazon_entity_stage_receipts r WHERE r.run_id = ?1)
            AND NOT EXISTS (SELECT 1 FROM amazon_entity_snapshot_receipts r WHERE r.run_id = ?1)
        `).bind(runId),
      ];
      for (const row of rows) {
        statements.push(db.prepare(`
          INSERT INTO amazon_entity_stage(
            run_id, profile_id, entity_type, source_row_ordinal, entity_id, canonical_entity_json
          ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
        `).bind(
          row.runId,
          row.profileId,
          row.entityType,
          row.sourceRowOrdinal,
          row.entityId,
          row.canonicalEntityJson,
        ));
      }
      statements.push(db.prepare(`
        INSERT INTO amazon_entity_stage_receipts(
          run_id, profile_id, snapshot_synced_at, snapshot_sha256,
          campaign_count, ad_group_count, keyword_count, target_count, staged_at
        ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `).bind(
        runId,
        profileId,
        syncedAt,
        snapshotHash,
        counts.campaign,
        counts.ad_group,
        counts.keyword,
        counts.target,
        stagedAt,
      ));
      await db.batch(statements);
    },

    async loadStageSummary(runId) {
      return db.prepare(`
        WITH stage AS (
          SELECT
            s.*,
            json_extract(s.canonical_entity_json, '$.profileId') AS json_profile_id,
            json_extract(s.canonical_entity_json, '$.syncedAt') AS json_synced_at,
            json_extract(s.canonical_entity_json, '$.entityType') AS json_entity_type,
            CASE s.entity_type
              WHEN 'campaign' THEN json_extract(s.canonical_entity_json, '$.campaignId')
              WHEN 'ad_group' THEN json_extract(s.canonical_entity_json, '$.adGroupId')
              WHEN 'keyword' THEN json_extract(s.canonical_entity_json, '$.keywordId')
              WHEN 'target' THEN json_extract(s.canonical_entity_json, '$.targetId')
            END AS json_entity_id
          FROM amazon_entity_stage s
          WHERE s.run_id = ?1
        )
        SELECT
          sr.profile_id AS profile_id,
          MIN(stage.json_synced_at) AS snapshot_synced_at,
          COALESCE(SUM(CASE WHEN stage.entity_type = 'campaign' THEN 1 ELSE 0 END), 0) AS campaign_count,
          COALESCE(SUM(CASE WHEN stage.entity_type = 'ad_group' THEN 1 ELSE 0 END), 0) AS ad_group_count,
          COALESCE(SUM(CASE WHEN stage.entity_type = 'keyword' THEN 1 ELSE 0 END), 0) AS keyword_count,
          COALESCE(SUM(CASE WHEN stage.entity_type = 'target' THEN 1 ELSE 0 END), 0) AS target_count,
          COALESCE(SUM(CASE WHEN stage.run_id IS NOT NULL AND (
            stage.json_profile_id IS NULL OR stage.json_profile_id <> stage.profile_id OR
            stage.json_synced_at IS NULL OR
            stage.json_entity_type IS NULL OR stage.json_entity_type <> stage.entity_type OR
            stage.json_entity_id IS NULL OR stage.json_entity_id <> stage.entity_id
          ) THEN 1 ELSE 0 END), 0) AS invalid_rows
        FROM sync_runs sr
        LEFT JOIN stage ON stage.run_id = sr.run_id
        WHERE sr.run_id = ?1
        GROUP BY sr.profile_id
      `).bind(runId).first();
    },

    async publishStage({ runId, profileId, syncedAt, snapshotHash, counts, publishedAt }) {
      const statements = [
        campaignPublishStatement(db, runId),
        adGroupPublishStatement(db, runId),
        keywordPublishStatement(db, runId),
        targetPublishStatement(db, runId),
        db.prepare(`
          INSERT INTO amazon_entity_snapshot_receipts(
            run_id, profile_id, snapshot_synced_at,
            campaign_count, ad_group_count, keyword_count, target_count, published_at, snapshot_sha256
          )
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
          WHERE EXISTS (
            SELECT 1 FROM sync_runs sr
            WHERE sr.run_id = ?1 AND sr.profile_id = ?2 AND sr.status = 'running'
          )
            AND EXISTS (
              SELECT 1 FROM amazon_entity_stage_receipts er
              WHERE er.run_id = ?1
                AND er.profile_id = ?2
                AND er.snapshot_synced_at = ?3
                AND er.snapshot_sha256 = ?9
                AND er.campaign_count = ?4
                AND er.ad_group_count = ?5
                AND er.keyword_count = ?6
                AND er.target_count = ?7
            )
        `).bind(
          runId,
          profileId,
          syncedAt,
          counts.campaign,
          counts.ad_group,
          counts.keyword,
          counts.target,
          publishedAt,
          snapshotHash,
        ),
        db.prepare(`
          DELETE FROM amazon_entity_stage
          WHERE run_id = ?1
            AND EXISTS (
              SELECT 1 FROM amazon_entity_snapshot_receipts r
              WHERE r.run_id = ?1 AND r.snapshot_sha256 = ?2
            )
        `).bind(runId, snapshotHash),
      ];
      await db.batch(statements);
    },
  };
}

function campaignPublishStatement(db, runId) {
  return db.prepare(`
    INSERT INTO campaigns(
      campaign_id, profile_id, portfolio_id, ad_product, name, state,
      targeting_type, bidding_strategy, daily_budget_micros, start_date, end_date,
      source_updated_at, synced_at, payload_hash
    )
    SELECT
      json_extract(canonical_entity_json, '$.campaignId'),
      json_extract(canonical_entity_json, '$.profileId'),
      NULL,
      json_extract(canonical_entity_json, '$.adProduct'),
      json_extract(canonical_entity_json, '$.name'),
      json_extract(canonical_entity_json, '$.state'),
      json_extract(canonical_entity_json, '$.targetingType'),
      json_extract(canonical_entity_json, '$.biddingStrategy'),
      CAST(json_extract(canonical_entity_json, '$.dailyBudgetMicros') AS INTEGER),
      json_extract(canonical_entity_json, '$.startDate'),
      json_extract(canonical_entity_json, '$.endDate'),
      NULL,
      json_extract(canonical_entity_json, '$.syncedAt'),
      json_extract(canonical_entity_json, '$.payloadHash')
    FROM amazon_entity_stage
    WHERE run_id = ?1 AND entity_type = 'campaign'
    ON CONFLICT(campaign_id) DO UPDATE SET
      ad_product = excluded.ad_product,
      name = excluded.name,
      state = excluded.state,
      targeting_type = excluded.targeting_type,
      bidding_strategy = excluded.bidding_strategy,
      daily_budget_micros = excluded.daily_budget_micros,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      source_updated_at = NULL,
      synced_at = excluded.synced_at,
      payload_hash = excluded.payload_hash
  `).bind(runId);
}

function adGroupPublishStatement(db, runId) {
  return db.prepare(`
    INSERT INTO ad_groups(
      ad_group_id, profile_id, campaign_id, name, state, default_bid_micros,
      source_updated_at, synced_at, payload_hash
    )
    SELECT
      json_extract(canonical_entity_json, '$.adGroupId'),
      json_extract(canonical_entity_json, '$.profileId'),
      json_extract(canonical_entity_json, '$.campaignId'),
      json_extract(canonical_entity_json, '$.name'),
      json_extract(canonical_entity_json, '$.state'),
      CAST(json_extract(canonical_entity_json, '$.defaultBidMicros') AS INTEGER),
      json_extract(canonical_entity_json, '$.sourceUpdatedAt'),
      json_extract(canonical_entity_json, '$.syncedAt'),
      json_extract(canonical_entity_json, '$.payloadHash')
    FROM amazon_entity_stage
    WHERE run_id = ?1 AND entity_type = 'ad_group'
    ON CONFLICT(ad_group_id) DO UPDATE SET
      name = excluded.name,
      state = excluded.state,
      default_bid_micros = excluded.default_bid_micros,
      source_updated_at = excluded.source_updated_at,
      synced_at = excluded.synced_at,
      payload_hash = excluded.payload_hash
  `).bind(runId);
}

function keywordPublishStatement(db, runId) {
  return db.prepare(`
    INSERT INTO keywords(
      keyword_id, profile_id, campaign_id, ad_group_id, keyword_text,
      normalized_keyword, match_type, state, bid_micros,
      source_updated_at, synced_at, payload_hash
    )
    SELECT
      json_extract(canonical_entity_json, '$.keywordId'),
      json_extract(canonical_entity_json, '$.profileId'),
      json_extract(canonical_entity_json, '$.campaignId'),
      json_extract(canonical_entity_json, '$.adGroupId'),
      json_extract(canonical_entity_json, '$.keywordText'),
      json_extract(canonical_entity_json, '$.normalizedKeyword'),
      json_extract(canonical_entity_json, '$.matchType'),
      json_extract(canonical_entity_json, '$.state'),
      CAST(json_extract(canonical_entity_json, '$.bidMicros') AS INTEGER),
      json_extract(canonical_entity_json, '$.sourceUpdatedAt'),
      json_extract(canonical_entity_json, '$.syncedAt'),
      json_extract(canonical_entity_json, '$.payloadHash')
    FROM amazon_entity_stage
    WHERE run_id = ?1 AND entity_type = 'keyword'
    ON CONFLICT(keyword_id) DO UPDATE SET
      keyword_text = excluded.keyword_text,
      normalized_keyword = excluded.normalized_keyword,
      match_type = excluded.match_type,
      state = excluded.state,
      bid_micros = excluded.bid_micros,
      source_updated_at = excluded.source_updated_at,
      synced_at = excluded.synced_at,
      payload_hash = excluded.payload_hash
  `).bind(runId);
}

function targetPublishStatement(db, runId) {
  return db.prepare(`
    INSERT INTO targets(
      target_id, profile_id, campaign_id, ad_group_id, target_type,
      expression_json, expression_text, state, bid_micros,
      source_updated_at, synced_at, payload_hash
    )
    SELECT
      json_extract(canonical_entity_json, '$.targetId'),
      json_extract(canonical_entity_json, '$.profileId'),
      json_extract(canonical_entity_json, '$.campaignId'),
      json_extract(canonical_entity_json, '$.adGroupId'),
      json_extract(canonical_entity_json, '$.targetType'),
      json_extract(canonical_entity_json, '$.expressionJson'),
      json_extract(canonical_entity_json, '$.expressionText'),
      json_extract(canonical_entity_json, '$.state'),
      CAST(json_extract(canonical_entity_json, '$.bidMicros') AS INTEGER),
      NULL,
      json_extract(canonical_entity_json, '$.syncedAt'),
      json_extract(canonical_entity_json, '$.payloadHash')
    FROM amazon_entity_stage
    WHERE run_id = ?1 AND entity_type = 'target'
    ON CONFLICT(target_id) DO UPDATE SET
      target_type = excluded.target_type,
      expression_json = excluded.expression_json,
      expression_text = excluded.expression_text,
      state = excluded.state,
      bid_micros = excluded.bid_micros,
      source_updated_at = NULL,
      synced_at = excluded.synced_at,
      payload_hash = excluded.payload_hash
  `).bind(runId);
}

function assertReceiptBase(receipt, runId, profileId, prefix) {
  if (!receipt) throw new EntityMirrorProducerError(`${prefix}_RECEIPT_MISSING`);
  if (receipt.run_id !== runId) throw new EntityMirrorProducerError(`${prefix}_RECEIPT_CONFLICT:run_id`);
  if (receipt.profile_id !== profileId) throw new EntityMirrorProducerError(`${prefix}_RECEIPT_CONFLICT:profile_id`);
  for (const field of ['campaign_count', 'ad_group_count', 'keyword_count', 'target_count']) {
    if (!isNonNegativeSafeInteger(receipt[field])) {
      throw new EntityMirrorProducerError(`${prefix}_RECEIPT_INVALID:${field}`);
    }
  }
  if (!receipt.snapshot_synced_at || !receipt.snapshot_sha256) {
    throw new EntityMirrorProducerError(`${prefix}_RECEIPT_INCOMPLETE`);
  }
}

function assertReceiptSnapshotFields(receipt, snapshot, prefix) {
  if (receipt.snapshot_synced_at !== snapshot.syncedAt) {
    throw new EntityMirrorProducerError(`${prefix}:snapshot_synced_at`);
  }
  if (receipt.snapshot_sha256 !== snapshot.snapshotHash) {
    throw new EntityMirrorProducerError(`${prefix}:snapshot_sha256`);
  }
  for (const [type, field] of [
    ['campaign', 'campaign_count'],
    ['ad_group', 'ad_group_count'],
    ['keyword', 'keyword_count'],
    ['target', 'target_count'],
  ]) {
    if (receipt[field] !== snapshot.counts[type]) {
      throw new EntityMirrorProducerError(`${prefix}:${field}`);
    }
  }
}

function isNonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new EntityMirrorProducerError(code);
  return text;
}
