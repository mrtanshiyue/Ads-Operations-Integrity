import { CSV_IMPORT_SCHEMA_VERSION, CSV_SEARCH_TERM_REPORT_TYPE } from './csv-search-term-import.js';
import { canonicalJson } from './canonical-json.js';

const JSON_CHUNK_MAX_ROWS = 500;
const JSON_CHUNK_MAX_BYTES = 1_000_000;
const UTF8_ENCODER = new TextEncoder();

export class CsvImportRepositoryError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CsvImportRepositoryError';
    this.code = code;
    this.cause = cause;
  }
}

export function createD1CsvSearchTermImportRepository(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new CsvImportRepositoryError('CSV_IMPORT_DB_INVALID');
  }
  return Object.freeze({
    async findDuplicate({ contentSha256, reportStartDate, reportEndDate }) {
      return db.prepare(`
        SELECT import_id, status, uploaded_at, published_at
        FROM csv_import_batches
        WHERE content_sha256=?1 AND report_type=?2 AND report_start_date=?3 AND report_end_date=?4
        LIMIT 1
      `).bind(contentSha256, CSV_SEARCH_TERM_REPORT_TYPE, reportStartDate, reportEndDate).first();
    },

    async commitValidatedImport({ importId, parsed, now }) {
      const batch = normalizeBatch(importId, parsed, now);
      const statements = [];
      statements.push(db.prepare(`
        INSERT INTO csv_import_batches(
          import_id, source_file_name, report_type, marketplace, profile_id, advertiser_account_id, currency_code,
          report_start_date, report_end_date, content_sha256, content_bytes, schema_version,
          row_count, accepted_rows, rejected_rows, duplicate_status, status,
          validation_summary_json, uploaded_at
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,'unique','validated',?15,?16)
      `).bind(...batch.bindValues));

      for (const chunkJson of buildJsonChunks(parsed.rows, (row) => ({
        sourceRowOrdinal:row.sourceRowOrdinal,
        logicalRowKey:row.logicalRowKey,
        canonicalRowJson:row.canonicalRowJson,
      }))) {
        statements.push(db.prepare(`
          INSERT INTO csv_search_term_stage(import_id,source_row_ordinal,logical_row_key,canonical_row_json)
          SELECT
            ?1,
            CAST(json_extract(value,'$.sourceRowOrdinal') AS INTEGER),
            json_extract(value,'$.logicalRowKey'),
            json_extract(value,'$.canonicalRowJson')
          FROM json_each(?2)
        `).bind(batch.importId, chunkJson));
      }

      statements.push(db.prepare(`
        INSERT INTO csv_search_term_daily(
          row_key, report_date, advertiser_account_id, portfolio_id, portfolio_name,
          campaign_id, campaign_name, ad_group_id, ad_group_name, targeting_id, targeting,
          targeting_identity_state, targeting_type, targeting_state, target_bid_micros,
          match_type, search_term, normalized_search_term, impressions, clicks, cost_micros,
          purchases, units_sold, sales_micros, marketplace, profile_id, currency_code,
          source_import_id, source_row_ordinal, updated_at
        )
        SELECT
          json_extract(canonical_row_json,'$.rowKey'),
          json_extract(canonical_row_json,'$.reportDate'),
          json_extract(canonical_row_json,'$.advertiserAccountId'),
          json_extract(canonical_row_json,'$.portfolioId'),
          json_extract(canonical_row_json,'$.portfolioName'),
          json_extract(canonical_row_json,'$.campaignId'),
          json_extract(canonical_row_json,'$.campaignName'),
          json_extract(canonical_row_json,'$.adGroupId'),
          json_extract(canonical_row_json,'$.adGroupName'),
          json_extract(canonical_row_json,'$.targetingId'),
          COALESCE(json_extract(canonical_row_json,'$.targeting'),''),
          COALESCE(json_extract(canonical_row_json,'$.targetingIdentityState'),'name_only'),
          json_extract(canonical_row_json,'$.targetingType'),
          json_extract(canonical_row_json,'$.targetingState'),
          CAST(json_extract(canonical_row_json,'$.targetBidMicros') AS INTEGER),
          json_extract(canonical_row_json,'$.matchType'),
          json_extract(canonical_row_json,'$.searchTerm'),
          json_extract(canonical_row_json,'$.normalizedSearchTerm'),
          CAST(json_extract(canonical_row_json,'$.impressions') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.clicks') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.costMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.purchases') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.unitsSold') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.salesMicros') AS INTEGER),
          json_extract(canonical_row_json,'$.marketplace'),
          json_extract(canonical_row_json,'$.profileId'),
          json_extract(canonical_row_json,'$.currencyCode'),
          ?1,
          source_row_ordinal,
          ?2
        FROM csv_search_term_stage
        WHERE import_id=?1
        ORDER BY source_row_ordinal
        ON CONFLICT(row_key) DO UPDATE SET
          impressions=excluded.impressions,
          clicks=excluded.clicks,
          cost_micros=excluded.cost_micros,
          purchases=excluded.purchases,
          units_sold=excluded.units_sold,
          sales_micros=excluded.sales_micros,
          target_bid_micros=excluded.target_bid_micros,
          targeting_type=excluded.targeting_type,
          targeting_state=excluded.targeting_state,
          marketplace=excluded.marketplace,
          profile_id=excluded.profile_id,
          currency_code=excluded.currency_code,
          source_import_id=excluded.source_import_id,
          source_row_ordinal=excluded.source_row_ordinal,
          updated_at=excluded.updated_at
      `).bind(batch.importId, batch.publishedAt));

      statements.push(db.prepare(`
        UPDATE csv_import_batches
        SET status='published', published_at=?2, updated_at=CURRENT_TIMESTAMP
        WHERE import_id=?1 AND status='validated' AND rejected_rows=0
          AND (SELECT COUNT(*) FROM csv_search_term_stage WHERE import_id=?1)=accepted_rows
      `).bind(batch.importId, batch.publishedAt));
      statements.push(db.prepare(`
        DELETE FROM csv_search_term_stage
        WHERE import_id=?1
          AND EXISTS (SELECT 1 FROM csv_import_batches b WHERE b.import_id=?1 AND b.status='published')
      `).bind(batch.importId));

      let result;
      try { result = await db.batch(statements); }
      catch (error) { throw new CsvImportRepositoryError('CSV_IMPORT_DB_BATCH_FAILED', error); }
      const update = result?.[result.length - 2];
      if (Number(update?.meta?.changes || 0) !== 1) throw new CsvImportRepositoryError('CSV_IMPORT_PUBLISH_UNVERIFIED');
      return this.loadImport(batch.importId);
    },

    async recordRejectedImport({ importId, parsed }) {
      if (!parsed || parsed.ok !== false || parsed.rejectedRows < 1) throw new CsvImportRepositoryError('CSV_REJECTED_IMPORT_INVALID');
      const uploadedAt = requiredText(parsed.uploadedAt, 'CSV_UPLOADED_AT_REQUIRED');
      const statements = [db.prepare(`
        INSERT INTO csv_import_batches(
          import_id, source_file_name, report_type, marketplace, profile_id, advertiser_account_id, currency_code,
          report_start_date, report_end_date, content_sha256, content_bytes, schema_version,
          row_count, accepted_rows, rejected_rows, duplicate_status, status,
          validation_summary_json, uploaded_at
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'unique','rejected',?16,?17)
      `).bind(
        requiredText(importId,'CSV_IMPORT_ID_REQUIRED'), requiredText(parsed.sourceFileName,'CSV_SOURCE_FILE_NAME_REQUIRED'),
        CSV_SEARCH_TERM_REPORT_TYPE, parsed.marketplace, parsed.profileId, parsed.advertiserAccountId, parsed.currencyCode,
        requiredText(parsed.reportStartDate,'CSV_REPORT_START_DATE_REQUIRED'), requiredText(parsed.reportEndDate,'CSV_REPORT_END_DATE_REQUIRED'),
        requiredText(parsed.contentSha256,'CSV_CONTENT_SHA256_REQUIRED'), parsed.contentBytes, CSV_IMPORT_SCHEMA_VERSION,
        parsed.rowCount, parsed.acceptedRows, parsed.rejectedRows, canonicalJson(parsed.validationSummary), uploadedAt,
      )];
      for (const chunkJson of buildJsonChunks(parsed.errors, (error, index) => ({
        errorOrdinal:index,
        sourceRowOrdinal:error.sourceRowOrdinal,
        errorCode:error.errorCode,
      }))) {
        statements.push(db.prepare(`
          INSERT INTO csv_import_errors(import_id,error_ordinal,source_row_ordinal,error_code)
          SELECT
            ?1,
            CAST(json_extract(value,'$.errorOrdinal') AS INTEGER),
            CAST(json_extract(value,'$.sourceRowOrdinal') AS INTEGER),
            json_extract(value,'$.errorCode')
          FROM json_each(?2)
        `).bind(importId, chunkJson));
      }
      try { await db.batch(statements); }
      catch (error) { throw new CsvImportRepositoryError('CSV_IMPORT_REJECTION_DB_BATCH_FAILED', error); }
      return this.loadImport(importId);
    },

    async loadImport(importId) {
      return db.prepare(`SELECT * FROM csv_import_batches WHERE import_id=?1 LIMIT 1`).bind(requiredText(importId,'CSV_IMPORT_ID_REQUIRED')).first();
    },
  });
}

function buildJsonChunks(items, project) {
  if (!Array.isArray(items)) throw new CsvImportRepositoryError('CSV_IMPORT_CHUNK_ITEMS_INVALID');
  if (typeof project !== 'function') throw new CsvImportRepositoryError('CSV_IMPORT_CHUNK_PROJECTOR_INVALID');
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  for (let index = 0; index < items.length; index += 1) {
    const projected = project(items[index], index);
    const encoded = JSON.stringify(projected);
    const encodedBytes = UTF8_ENCODER.encode(encoded).byteLength;
    if (encodedBytes + 2 > JSON_CHUNK_MAX_BYTES) throw new CsvImportRepositoryError('CSV_IMPORT_CHUNK_ROW_TOO_LARGE');
    const separatorBytes = current.length > 0 ? 1 : 0;
    if (current.length > 0 && (current.length >= JSON_CHUNK_MAX_ROWS || currentBytes + separatorBytes + encodedBytes > JSON_CHUNK_MAX_BYTES)) {
      chunks.push(JSON.stringify(current));
      current = [];
      currentBytes = 2;
    }
    current.push(projected);
    currentBytes += (current.length > 1 ? 1 : 0) + encodedBytes;
  }
  if (current.length > 0) chunks.push(JSON.stringify(current));
  return chunks;
}

function normalizeBatch(importId, parsed, now) {
  if (!parsed || parsed.ok !== true || parsed.rejectedRows !== 0 || parsed.acceptedRows !== parsed.rowCount || parsed.rowCount < 1) {
    throw new CsvImportRepositoryError('CSV_VALIDATED_IMPORT_REQUIRED');
  }
  const id = requiredText(importId, 'CSV_IMPORT_ID_REQUIRED');
  const publishedAt = requiredText(typeof now === 'function' ? now() : now, 'CSV_PUBLISHED_AT_REQUIRED');
  return Object.freeze({
    importId:id,
    publishedAt,
    bindValues:[
      id,
      requiredText(parsed.sourceFileName,'CSV_SOURCE_FILE_NAME_REQUIRED'),
      CSV_SEARCH_TERM_REPORT_TYPE,
      parsed.marketplace,
      parsed.profileId,
      parsed.advertiserAccountId,
      parsed.currencyCode,
      requiredText(parsed.reportStartDate,'CSV_REPORT_START_DATE_REQUIRED'),
      requiredText(parsed.reportEndDate,'CSV_REPORT_END_DATE_REQUIRED'),
      requiredText(parsed.contentSha256,'CSV_CONTENT_SHA256_REQUIRED'),
      parsed.contentBytes,
      CSV_IMPORT_SCHEMA_VERSION,
      parsed.rowCount,
      parsed.acceptedRows,
      canonicalJson(parsed.validationSummary),
      requiredText(parsed.uploadedAt,'CSV_UPLOADED_AT_REQUIRED'),
    ],
  });
}
function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CsvImportRepositoryError(code);
  return text;
}
