export class SearchTermFactStageRepositoryError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'SearchTermFactStageRepositoryError';
    this.code = code;
    this.cause = cause;
  }
}

const DATASET_KEY = 'search_term_daily';

export function createD1SearchTermFactStageRepository(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_INVALID');
  }

  return Object.freeze({
    async loadJob(jobId) {
      const canonicalJobId = requiredText(jobId, 'SEARCH_TERM_STAGE_DB_JOB_ID_REQUIRED');
      return db.prepare(`
        SELECT
          rj.job_id, rj.run_id, rj.profile_id, ap.account_type,
          rj.amazon_report_id, rj.amazon_created_at,
          rj.ad_product, rj.report_type, rj.start_date, rj.end_date, rj.status,
          rj.r2_object_key, rj.content_sha256, rj.content_bytes,
          rj.r2_initial_version, rj.r2_initial_etag, rj.downloaded_at,
          rj.raw_row_count, rj.row_count, rj.ingested_at
        FROM report_jobs rj
        JOIN amazon_profiles ap ON ap.profile_id = rj.profile_id
        WHERE rj.job_id = ?1
        LIMIT 1
      `).bind(canonicalJobId).first();
    },

    async inspectStage(jobId) {
      const canonicalJobId = requiredText(jobId, 'SEARCH_TERM_STAGE_DB_JOB_ID_REQUIRED');
      const result = await db.prepare(`
        SELECT dataset_key, source_row_ordinal, logical_row_key, canonical_row_json
        FROM report_fact_stage
        WHERE job_id = ?1
        ORDER BY source_row_ordinal
      `).bind(canonicalJobId).all();
      return result?.results || [];
    },

    async replaceStageAndPersistReceipt({ job, rows, rawRowCount }) {
      const authority = normalizeDownloadedAuthority(job);
      const canonicalRows = normalizeRows(rows, rawRowCount);
      const authorityValues = authorityBindValues(authority);
      const statements = [];

      // Never destroy provisional stage rows unless the fresh report job still matches the
      // exact downloaded immutable authority used to derive the new deterministic stage.
      statements.push(db.prepare(`
        DELETE FROM report_fact_stage
        WHERE job_id = ?1
          AND EXISTS (
            SELECT 1
            FROM report_jobs rj
            WHERE ${exactDownloadedAuthorityPredicate('rj')}
          )
      `).bind(...authorityValues));

      for (const row of canonicalRows) {
        statements.push(db.prepare(`
          INSERT INTO report_fact_stage(
            job_id, dataset_key, source_row_ordinal, logical_row_key, canonical_row_json
          )
          SELECT ?1, ?14, ?15, ?16, ?17
          WHERE EXISTS (
            SELECT 1
            FROM report_jobs rj
            WHERE ${exactDownloadedAuthorityPredicate('rj')}
          )
        `).bind(
          ...authorityValues,
          row.datasetKey,
          row.sourceRowOrdinal,
          row.logicalRowKey,
          row.canonicalRowJson,
        ));
      }

      // 0015_store_report_fact_stage_receipt_guard.sql is the final D1 truth boundary:
      // this UPDATE can succeed only after the exact complete deterministic stage exists.
      statements.push(db.prepare(`
        UPDATE report_jobs AS rj
        SET raw_row_count = ?14,
            updated_at = CURRENT_TIMESTAMP
        WHERE ${exactDownloadedAuthorityPredicate('rj')}
      `).bind(...authorityValues, rawRowCount));

      let results;
      try {
        results = await db.batch(statements);
      } catch (error) {
        throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_BATCH_FAILED', error);
      }

      const receipt = results?.[results.length - 1];
      if (receipt?.success === false || Number(receipt?.meta?.changes || 0) !== 1) {
        throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_COMMIT_UNVERIFIED');
      }
      return true;
    },
  });
}

function exactDownloadedAuthorityPredicate(alias) {
  return `
    ${alias}.job_id = ?1
    AND ${alias}.run_id = ?2
    AND ${alias}.profile_id = ?3
    AND ${alias}.ad_product = ?4
    AND ${alias}.report_type = ?5
    AND ${alias}.start_date = ?6
    AND ${alias}.end_date = ?7
    AND ${alias}.status = 'downloaded'
    AND ${alias}.r2_object_key = ?8
    AND ${alias}.content_sha256 = ?9
    AND ${alias}.content_bytes = ?10
    AND ${alias}.r2_initial_version = ?11
    AND ${alias}.r2_initial_etag = ?12
    AND ${alias}.downloaded_at = ?13
    AND ${alias}.raw_row_count IS NULL
    AND ${alias}.row_count IS NULL
    AND ${alias}.ingested_at IS NULL
  `;
}

function normalizeDownloadedAuthority(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_JOB_RECEIPT_INVALID');
  }
  if (job.status !== 'downloaded' || job.raw_row_count != null || job.row_count != null || job.ingested_at != null) {
    throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_JOB_RECEIPT_INVALID');
  }

  const authority = Object.freeze({
    jobId:requiredText(job.job_id, 'SEARCH_TERM_STAGE_DB_JOB_ID_REQUIRED'),
    runId:requiredText(job.run_id, 'SEARCH_TERM_STAGE_DB_RUN_ID_REQUIRED'),
    profileId:requiredText(job.profile_id, 'SEARCH_TERM_STAGE_DB_PROFILE_ID_REQUIRED'),
    adProduct:requiredText(job.ad_product, 'SEARCH_TERM_STAGE_DB_AD_PRODUCT_REQUIRED'),
    reportType:requiredText(job.report_type, 'SEARCH_TERM_STAGE_DB_REPORT_TYPE_REQUIRED'),
    startDate:requiredText(job.start_date, 'SEARCH_TERM_STAGE_DB_START_DATE_REQUIRED'),
    endDate:requiredText(job.end_date, 'SEARCH_TERM_STAGE_DB_END_DATE_REQUIRED'),
    r2ObjectKey:requiredText(job.r2_object_key, 'SEARCH_TERM_STAGE_DB_R2_KEY_REQUIRED'),
    contentSha256:String(job.content_sha256 ?? '').trim(),
    contentBytes:job.content_bytes,
    r2InitialVersion:requiredText(job.r2_initial_version, 'SEARCH_TERM_STAGE_DB_R2_VERSION_REQUIRED'),
    r2InitialEtag:requiredText(job.r2_initial_etag, 'SEARCH_TERM_STAGE_DB_R2_ETAG_REQUIRED'),
    downloadedAt:requiredText(job.downloaded_at, 'SEARCH_TERM_STAGE_DB_DOWNLOADED_AT_REQUIRED'),
  });

  if (authority.adProduct !== 'SPONSORED_PRODUCTS' || authority.reportType !== 'spSearchTerm') {
    throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_REPORT_CONTRACT_MISMATCH');
  }
  if (!/^[0-9a-f]{64}$/.test(authority.contentSha256)) {
    throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_CONTENT_SHA256_INVALID');
  }
  if (!Number.isSafeInteger(authority.contentBytes) || authority.contentBytes < 0) {
    throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_CONTENT_BYTES_INVALID');
  }
  return authority;
}

function authorityBindValues(authority) {
  return [
    authority.jobId,
    authority.runId,
    authority.profileId,
    authority.adProduct,
    authority.reportType,
    authority.startDate,
    authority.endDate,
    authority.r2ObjectKey,
    authority.contentSha256,
    authority.contentBytes,
    authority.r2InitialVersion,
    authority.r2InitialEtag,
    authority.downloadedAt,
  ];
}

function normalizeRows(rows, rawRowCount) {
  if (!Array.isArray(rows)) throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_ROWS_INVALID');
  if (!Number.isSafeInteger(rawRowCount) || rawRowCount < 0 || rawRowCount !== rows.length) {
    throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_ROW_COUNT_INVALID');
  }

  return Object.freeze(rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_ROW_INVALID');
    }
    if (row.datasetKey !== DATASET_KEY) {
      throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_DATASET_INVALID');
    }
    if (row.sourceRowOrdinal !== index) {
      throw new SearchTermFactStageRepositoryError('SEARCH_TERM_STAGE_DB_ORDINAL_INVALID');
    }
    return Object.freeze({
      datasetKey:row.datasetKey,
      sourceRowOrdinal:row.sourceRowOrdinal,
      logicalRowKey:requiredText(row.logicalRowKey, 'SEARCH_TERM_STAGE_DB_LOGICAL_ROW_KEY_REQUIRED'),
      canonicalRowJson:requiredText(row.canonicalRowJson, 'SEARCH_TERM_STAGE_DB_CANONICAL_JSON_REQUIRED'),
    });
  }));
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new SearchTermFactStageRepositoryError(code);
  return text;
}
