export class FactPublishError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FactPublishError';
    this.code = code;
  }
}

export async function publishSearchTermPartition({ db, jobId, now }) {
  const job = await loadReportJob(db, jobId);
  if (!job) throw new FactPublishError('REPORT_JOB_NOT_FOUND');

  if (job.status === 'ingested') {
    await verifyCommittedSearchTermLineage(db, job);
    return { reused: true, job };
  }
  if (job.status !== 'downloaded') throw new FactPublishError('REPORT_JOB_NOT_READY_FOR_FACT_PUBLISH');
  if (!isNonNegativeSafeIntegerReceipt(job.raw_row_count)) {
    throw new FactPublishError('RAW_ROW_COUNT_RECEIPT_MISSING');
  }
  if (job.report_type !== 'spSearchTerm' || job.ad_product !== 'SPONSORED_PRODUCTS') {
    throw new FactPublishError('SEARCH_TERM_REPORT_CONTRACT_MISMATCH');
  }

  const expectedCount = job.raw_row_count;
  const stage = await db.prepare(`
    SELECT
      COUNT(*) AS row_count,
      COALESCE(SUM(CASE WHEN dataset_key = 'search_term_daily' THEN 1 ELSE 0 END), 0) AS dataset_count,
      COALESCE(SUM(CASE
        WHEN json_valid(canonical_row_json) = 0 THEN 1
        WHEN logical_row_key <> json_extract(canonical_row_json, '$.rowKey') THEN 1
        ELSE 0
      END), 0) AS identity_mismatch_count
    FROM report_fact_stage
    WHERE job_id = ?1
  `).bind(job.job_id).first();

  const stageCount = Number(stage?.row_count || 0);
  const datasetCount = Number(stage?.dataset_count || 0);
  const mismatchCount = Number(stage?.identity_mismatch_count || 0);
  if (stageCount !== expectedCount || datasetCount !== expectedCount || mismatchCount !== 0) {
    throw new FactPublishError('STAGE_RECEIPT_INCONSISTENT');
  }

  const statements = [
    db.prepare(`
      DELETE FROM search_term_daily
      WHERE profile_id = ?2
        AND ad_product = ?3
        AND report_date BETWEEN ?4 AND ?5
        AND EXISTS (
          SELECT 1 FROM report_jobs rj
          WHERE rj.job_id = ?1
            AND rj.status = 'downloaded'
            AND rj.raw_row_count = ?6
            AND (SELECT COUNT(*) FROM report_fact_stage s WHERE s.job_id = ?1) = ?6
            AND NOT EXISTS (
              SELECT 1 FROM report_fact_stage sx
              WHERE sx.job_id = ?1 AND sx.dataset_key <> 'search_term_daily'
            )
        )
    `).bind(job.job_id, job.profile_id, job.ad_product, job.start_date, job.end_date, expectedCount),

    db.prepare(`
      INSERT INTO search_term_daily(
        row_key, profile_id, report_date, ad_product, campaign_id, ad_group_id,
        keyword_id, target_id, search_term, normalized_search_term, match_type,
        impressions, clicks, cost_micros, purchases, units_sold, sales_micros,
        metrics_json, source_report_job_id, source_keyword_type
      )
      SELECT
        json_extract(s.canonical_row_json, '$.rowKey'),
        rj.profile_id,
        json_extract(s.canonical_row_json, '$.reportDate'),
        rj.ad_product,
        json_extract(s.canonical_row_json, '$.campaignId'),
        json_extract(s.canonical_row_json, '$.adGroupId'),
        json_extract(s.canonical_row_json, '$.keywordId'),
        json_extract(s.canonical_row_json, '$.targetId'),
        json_extract(s.canonical_row_json, '$.searchTerm'),
        json_extract(s.canonical_row_json, '$.normalizedSearchTerm'),
        json_extract(s.canonical_row_json, '$.matchType'),
        CAST(json_extract(s.canonical_row_json, '$.impressions') AS INTEGER),
        CAST(json_extract(s.canonical_row_json, '$.clicks') AS INTEGER),
        CAST(json_extract(s.canonical_row_json, '$.costMicros') AS INTEGER),
        CAST(json_extract(s.canonical_row_json, '$.purchases') AS INTEGER),
        CAST(json_extract(s.canonical_row_json, '$.unitsSold') AS INTEGER),
        CAST(json_extract(s.canonical_row_json, '$.salesMicros') AS INTEGER),
        json_extract(s.canonical_row_json, '$.metricsJson'),
        rj.job_id,
        json_extract(s.canonical_row_json, '$.sourceKeywordType')
      FROM report_fact_stage s
      JOIN report_jobs rj ON rj.job_id = s.job_id
      WHERE s.job_id = ?1
        AND s.dataset_key = 'search_term_daily'
        AND rj.status = 'downloaded'
        AND rj.raw_row_count = ?2
        AND (SELECT COUNT(*) FROM report_fact_stage sc WHERE sc.job_id = ?1) = ?2
        AND NOT EXISTS (
          SELECT 1 FROM report_fact_stage sx
          WHERE sx.job_id = ?1 AND sx.dataset_key <> 'search_term_daily'
        )
      ORDER BY s.source_row_ordinal
    `).bind(job.job_id, expectedCount),

    db.prepare(`
      UPDATE report_jobs
      SET row_count = ?2,
          ingested_at = ?3,
          status = 'ingested',
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?1
        AND status = 'downloaded'
        AND raw_row_count = ?2
        AND (SELECT COUNT(*) FROM report_fact_stage s WHERE s.job_id = ?1) = ?2
        AND NOT EXISTS (
          SELECT 1 FROM report_fact_stage sx
          WHERE sx.job_id = ?1 AND sx.dataset_key <> 'search_term_daily'
        )
    `).bind(job.job_id, expectedCount, requiredText(now, 'INGESTED_AT_REQUIRED')),

    db.prepare(`
      DELETE FROM report_fact_stage
      WHERE job_id = ?1
        AND EXISTS (
          SELECT 1 FROM report_jobs rj
          WHERE rj.job_id = ?1
            AND rj.status = 'ingested'
            AND rj.row_count = ?2
        )
    `).bind(job.job_id, expectedCount),
  ];

  const results = await db.batch(statements);
  if (Number(results?.[2]?.meta?.changes || 0) !== 1) {
    // DELETE/INSERT were guarded by the same downloaded+stage receipt predicate, so a 0-row CAS
    // cannot authorize destructive publication. Treat the result as unverified and fail closed.
    throw new FactPublishError('FACT_PUBLISH_RECEIPT_UNAVAILABLE');
  }

  const committed = await loadReportJob(db, job.job_id);
  if (!committed || committed.status !== 'ingested' || committed.row_count !== expectedCount) {
    throw new FactPublishError('FACT_PUBLISH_JOB_RECEIPT_MISMATCH');
  }
  await verifyCommittedSearchTermLineage(db, committed);
  return { reused: false, job: committed };
}

export async function verifyCommittedSearchTermLineage(db, job) {
  if (job?.status !== 'ingested' || !isNonNegativeSafeIntegerReceipt(job?.row_count)) {
    throw new FactPublishError('FACT_PUBLISH_JOB_RECEIPT_INVALID');
  }
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS total_rows,
      COALESCE(SUM(CASE WHEN source_report_job_id = ?1 THEN 1 ELSE 0 END), 0) AS lineage_rows
    FROM search_term_daily
    WHERE profile_id = ?2
      AND ad_product = ?3
      AND report_date BETWEEN ?4 AND ?5
  `).bind(job.job_id, job.profile_id, job.ad_product, job.start_date, job.end_date).first();
  const expected = job.row_count;
  if (Number(row?.total_rows || 0) !== expected || Number(row?.lineage_rows || 0) !== expected) {
    throw new FactPublishError('FACT_PUBLISH_COMMITTED_LINEAGE_MISMATCH');
  }
  return true;
}

async function loadReportJob(db, jobId) {
  return db.prepare(`
    SELECT job_id, profile_id, ad_product, report_type, start_date, end_date,
           status, raw_row_count, row_count, ingested_at
    FROM report_jobs
    WHERE job_id = ?1
    LIMIT 1
  `).bind(jobId).first();
}

function isNonNegativeSafeIntegerReceipt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new FactPublishError(code);
  return text;
}
