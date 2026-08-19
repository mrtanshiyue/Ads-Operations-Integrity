import { SETTLEMENT_CSV_SCHEMA_VERSION, SETTLEMENT_REPORT_TYPE } from './settlement-csv-import.js';
import { canonicalJson } from './canonical-json.js';

const JSON_CHUNK_MAX_ROWS = 500;
const JSON_CHUNK_MAX_BYTES = 1_000_000;
const UTF8_ENCODER = new TextEncoder();

export class SettlementImportRepositoryError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'SettlementImportRepositoryError';
    this.code = code;
    this.cause = cause;
  }
}

export function createD1SettlementImportRepository(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new SettlementImportRepositoryError('SETTLEMENT_IMPORT_DB_INVALID');
  }

  return Object.freeze({
    async findDuplicate({ contentSha256, reportStartDate, reportEndDate }) {
      return db.prepare(`
        SELECT import_id, status, uploaded_at, published_at
        FROM settlement_import_batches
        WHERE content_sha256=?1 AND report_type=?2 AND report_start_date=?3 AND report_end_date=?4
        LIMIT 1
      `).bind(contentSha256, SETTLEMENT_REPORT_TYPE, reportStartDate, reportEndDate).first();
    },

    async commitValidatedImport({ importId, parsed, sourceObject, now }) {
      const batch = normalizeBatch(importId, parsed, now);
      const source = normalizeSourceObject(batch.importId, parsed, sourceObject);
      const statements = [sourceObjectInsert(db, source)];

      statements.push(db.prepare(`
        INSERT INTO settlement_import_batches(
          import_id,source_file_name,report_type,marketplace,currency_code,
          report_start_date,report_end_date,content_sha256,content_bytes,schema_version,
          row_count,accepted_rows,rejected_rows,duplicate_status,status,
          validation_summary_json,uploaded_at
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,'unique','validated',?13,?14)
      `).bind(...batch.bindValues));

      for (const chunkJson of buildJsonChunks(parsed.rows, (row) => ({
        sourceRowOrdinal:row.sourceRowOrdinal,
        logicalRowKey:row.logicalRowKey,
        canonicalRowJson:row.canonicalRowJson,
      }))) {
        statements.push(db.prepare(`
          INSERT INTO settlement_transaction_stage(import_id,source_row_ordinal,logical_row_key,canonical_row_json)
          SELECT ?1,
                 CAST(json_extract(value,'$.sourceRowOrdinal') AS INTEGER),
                 json_extract(value,'$.logicalRowKey'),
                 json_extract(value,'$.canonicalRowJson')
          FROM json_each(?2)
        `).bind(batch.importId, chunkJson));
      }

      statements.push(db.prepare(`
        INSERT INTO settlement_transactions(
          row_key,posted_at,posted_date,settlement_id,transaction_type,order_id,sku,description,quantity,
          marketplace,account_type,fulfillment,tax_collection_model,
          product_sales_micros,product_sales_tax_micros,shipping_credits_micros,shipping_credits_tax_micros,
          gift_wrap_credits_micros,gift_wrap_credits_tax_micros,regulatory_fee_micros,tax_on_regulatory_fee_micros,
          promotional_rebates_micros,promotional_rebates_tax_micros,marketplace_withheld_tax_micros,
          selling_fees_micros,fba_fees_micros,other_transaction_fees_micros,other_micros,total_micros,
          transaction_status,transaction_release_at,currency_code,source_import_id,source_row_ordinal,updated_at
        )
        SELECT
          json_extract(canonical_row_json,'$.rowKey'),
          json_extract(canonical_row_json,'$.postedAt'),
          json_extract(canonical_row_json,'$.postedDate'),
          json_extract(canonical_row_json,'$.settlementId'),
          json_extract(canonical_row_json,'$.transactionType'),
          json_extract(canonical_row_json,'$.orderId'),
          json_extract(canonical_row_json,'$.sku'),
          json_extract(canonical_row_json,'$.description'),
          CAST(json_extract(canonical_row_json,'$.quantity') AS INTEGER),
          json_extract(canonical_row_json,'$.marketplace'),
          json_extract(canonical_row_json,'$.accountType'),
          json_extract(canonical_row_json,'$.fulfillment'),
          json_extract(canonical_row_json,'$.taxCollectionModel'),
          CAST(json_extract(canonical_row_json,'$.productSalesMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.productSalesTaxMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.shippingCreditsMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.shippingCreditsTaxMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.giftWrapCreditsMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.giftWrapCreditsTaxMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.regulatoryFeeMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.taxOnRegulatoryFeeMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.promotionalRebatesMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.promotionalRebatesTaxMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.marketplaceWithheldTaxMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.sellingFeesMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.fbaFeesMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.otherTransactionFeesMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.otherMicros') AS INTEGER),
          CAST(json_extract(canonical_row_json,'$.totalMicros') AS INTEGER),
          json_extract(canonical_row_json,'$.transactionStatus'),
          json_extract(canonical_row_json,'$.transactionReleaseAt'),
          json_extract(canonical_row_json,'$.currencyCode'),
          ?1,source_row_ordinal,?2
        FROM settlement_transaction_stage
        WHERE import_id=?1
        ORDER BY source_row_ordinal
      `).bind(batch.importId, batch.publishedAt));

      statements.push(db.prepare(`
        INSERT INTO settlement_import_reconciliation_receipts(
          import_id,row_count,component_sum_micros,reported_total_micros,
          difference_micros,mismatch_rows,status,evidence_json
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
      `).bind(
        batch.importId,
        parsed.reconciliation.rowCount,
        parsed.reconciliation.componentSumMicros,
        parsed.reconciliation.reportedTotalMicros,
        parsed.reconciliation.differenceMicros,
        parsed.reconciliation.mismatchRows,
        parsed.reconciliation.status,
        canonicalJson({ source:'settlement-parser', schemaVersion:SETTLEMENT_CSV_SCHEMA_VERSION }),
      ));

      statements.push(db.prepare(`
        UPDATE settlement_import_batches
        SET status='published',published_at=?2,updated_at=CURRENT_TIMESTAMP
        WHERE import_id=?1 AND status='validated' AND rejected_rows=0
          AND (SELECT COUNT(*) FROM settlement_transaction_stage WHERE import_id=?1)=accepted_rows
          AND (SELECT COUNT(*) FROM settlement_transactions WHERE source_import_id=?1)=accepted_rows
      `).bind(batch.importId, batch.publishedAt));

      statements.push(db.prepare(`
        DELETE FROM settlement_transaction_stage
        WHERE import_id=?1
          AND EXISTS (
            SELECT 1 FROM settlement_import_batches b
            WHERE b.import_id=?1 AND b.status='published'
          )
      `).bind(batch.importId));

      let result;
      try { result = await db.batch(statements); }
      catch (error) { throw new SettlementImportRepositoryError('SETTLEMENT_IMPORT_DB_BATCH_FAILED', error); }
      const publishResult = result?.[result.length - 2];
      if (Number(publishResult?.meta?.changes || 0) !== 1) {
        throw new SettlementImportRepositoryError('SETTLEMENT_IMPORT_PUBLISH_UNVERIFIED');
      }
      return this.loadImport(batch.importId);
    },

    async loadImport(importId) {
      return db.prepare('SELECT * FROM settlement_import_batches WHERE import_id=?1 LIMIT 1')
        .bind(requiredText(importId,'SETTLEMENT_IMPORT_ID_REQUIRED')).first();
    },

    async loadSourceObject(importId) {
      return db.prepare('SELECT * FROM settlement_import_source_objects WHERE import_id=?1 LIMIT 1')
        .bind(requiredText(importId,'SETTLEMENT_IMPORT_ID_REQUIRED')).first();
    },

    async loadAuthority(importId) {
      return db.prepare('SELECT * FROM settlement_import_authority WHERE import_id=?1 LIMIT 1')
        .bind(requiredText(importId,'SETTLEMENT_IMPORT_ID_REQUIRED')).first();
    },

    async loadReconciliation(importId) {
      return db.prepare('SELECT * FROM settlement_import_reconciliation_receipts WHERE import_id=?1 LIMIT 1')
        .bind(requiredText(importId,'SETTLEMENT_IMPORT_ID_REQUIRED')).first();
    },
  });
}

function sourceObjectInsert(db, source) {
  return db.prepare(`
    INSERT INTO settlement_import_source_objects(
      import_id,source_object_id,source_kind,r2_binding_key,object_key,
      content_sha256,content_bytes,content_type,source_file_name,
      importer_user_id,uploaded_at,r2_etag,r2_version
    ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
  `).bind(
    source.importId,source.sourceObjectId,source.sourceKind,source.r2BindingKey,source.objectKey,
    source.contentSha256,source.contentBytes,source.contentType,source.sourceFileName,
    source.importerUserId,source.uploadedAt,source.r2Etag,source.r2Version,
  );
}

function normalizeSourceObject(importId, parsed, sourceObject) {
  if (!sourceObject || typeof sourceObject !== 'object' || Array.isArray(sourceObject)) {
    throw new SettlementImportRepositoryError('SETTLEMENT_SOURCE_OBJECT_REQUIRED');
  }
  const id = requiredText(importId, 'SETTLEMENT_IMPORT_ID_REQUIRED');
  if (requiredText(sourceObject.importId, 'SETTLEMENT_SOURCE_IMPORT_ID_REQUIRED') !== id) {
    throw new SettlementImportRepositoryError('SETTLEMENT_SOURCE_IMPORT_ID_MISMATCH');
  }
  const contentSha256 = requiredHash(sourceObject.contentSha256, 'SETTLEMENT_SOURCE_SHA256_REQUIRED');
  const parsedSha256 = requiredHash(parsed?.contentSha256, 'SETTLEMENT_CONTENT_SHA256_REQUIRED');
  if (contentSha256 !== parsedSha256) throw new SettlementImportRepositoryError('SETTLEMENT_SOURCE_SHA256_MISMATCH');
  const contentBytes = positiveInteger(sourceObject.contentBytes, 'SETTLEMENT_SOURCE_CONTENT_BYTES_INVALID');
  if (contentBytes !== parsed?.contentBytes) throw new SettlementImportRepositoryError('SETTLEMENT_SOURCE_CONTENT_BYTES_MISMATCH');
  const sourceFileName = requiredText(sourceObject.sourceFileName, 'SETTLEMENT_SOURCE_FILE_NAME_REQUIRED');
  if (sourceFileName !== parsed?.sourceFileName) throw new SettlementImportRepositoryError('SETTLEMENT_SOURCE_FILE_NAME_MISMATCH');
  const uploadedAt = requiredText(sourceObject.uploadedAt, 'SETTLEMENT_SOURCE_UPLOADED_AT_REQUIRED');
  if (uploadedAt !== parsed?.uploadedAt) throw new SettlementImportRepositoryError('SETTLEMENT_SOURCE_UPLOADED_AT_MISMATCH');
  if (sourceObject.sourceKind !== 'manual_csv_upload') throw new SettlementImportRepositoryError('SETTLEMENT_SOURCE_KIND_INVALID');
  if (sourceObject.r2BindingKey !== 'DATA_BUCKET') throw new SettlementImportRepositoryError('SETTLEMENT_SOURCE_BINDING_INVALID');
  return Object.freeze({
    importId:id,
    sourceObjectId:requiredText(sourceObject.sourceObjectId,'SETTLEMENT_SOURCE_OBJECT_ID_REQUIRED'),
    sourceKind:sourceObject.sourceKind,
    r2BindingKey:sourceObject.r2BindingKey,
    objectKey:requiredText(sourceObject.objectKey,'SETTLEMENT_SOURCE_OBJECT_KEY_REQUIRED'),
    contentSha256,contentBytes,
    contentType:optionalText(sourceObject.contentType),
    sourceFileName,
    importerUserId:requiredText(sourceObject.importerUserId,'SETTLEMENT_SOURCE_IMPORTER_REQUIRED'),
    uploadedAt,
    r2Etag:optionalText(sourceObject.r2Etag),
    r2Version:optionalText(sourceObject.r2Version),
  });
}

function normalizeBatch(importId, parsed, now) {
  if (!parsed || parsed.ok !== true || parsed.rejectedRows !== 0
      || parsed.acceptedRows !== parsed.rowCount || parsed.rowCount < 1
      || parsed.reconciliation?.status !== 'pass') {
    throw new SettlementImportRepositoryError('SETTLEMENT_VALIDATED_IMPORT_REQUIRED');
  }
  const id = requiredText(importId, 'SETTLEMENT_IMPORT_ID_REQUIRED');
  const publishedAt = requiredText(typeof now === 'function' ? now() : now, 'SETTLEMENT_PUBLISHED_AT_REQUIRED');
  return Object.freeze({
    importId:id,
    publishedAt,
    bindValues:[
      id,
      requiredText(parsed.sourceFileName,'SETTLEMENT_SOURCE_FILE_NAME_REQUIRED'),
      SETTLEMENT_REPORT_TYPE,
      parsed.marketplace,
      requiredText(parsed.currencyCode,'SETTLEMENT_CURRENCY_REQUIRED'),
      requiredText(parsed.reportStartDate,'SETTLEMENT_REPORT_START_DATE_REQUIRED'),
      requiredText(parsed.reportEndDate,'SETTLEMENT_REPORT_END_DATE_REQUIRED'),
      requiredHash(parsed.contentSha256,'SETTLEMENT_CONTENT_SHA256_REQUIRED'),
      positiveInteger(parsed.contentBytes,'SETTLEMENT_CONTENT_BYTES_INVALID'),
      SETTLEMENT_CSV_SCHEMA_VERSION,
      parsed.rowCount,
      parsed.acceptedRows,
      canonicalJson(parsed.validationSummary),
      requiredText(parsed.uploadedAt,'SETTLEMENT_UPLOADED_AT_REQUIRED'),
    ],
  });
}

function buildJsonChunks(items, project) {
  if (!Array.isArray(items)) throw new SettlementImportRepositoryError('SETTLEMENT_CHUNK_ITEMS_INVALID');
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  for (let index = 0; index < items.length; index += 1) {
    const projected = project(items[index], index);
    const encoded = JSON.stringify(projected);
    const encodedBytes = UTF8_ENCODER.encode(encoded).byteLength;
    if (encodedBytes + 2 > JSON_CHUNK_MAX_BYTES) throw new SettlementImportRepositoryError('SETTLEMENT_CHUNK_ROW_TOO_LARGE');
    const separatorBytes = current.length > 0 ? 1 : 0;
    if (current.length > 0 && (current.length >= JSON_CHUNK_MAX_ROWS
        || currentBytes + separatorBytes + encodedBytes > JSON_CHUNK_MAX_BYTES)) {
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

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new SettlementImportRepositoryError(code);
  return value;
}
function requiredHash(value, code) {
  const text = requiredText(value, code);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new SettlementImportRepositoryError(code);
  return text;
}
function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new SettlementImportRepositoryError(code);
  return text;
}
function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
