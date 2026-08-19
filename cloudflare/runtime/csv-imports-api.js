import { createD1CsvSearchTermImportRepository } from './csv-search-term-import-repository.js';
import { ingestSearchTermCsvOnce } from './csv-search-term-ingestion.js';
import { createCsvImportSourceObjectStore } from './csv-import-source-object.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CSV_CONTENT_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
]);

export async function handleCsvImportsApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/imports(?:\/(search-terms|[^/]+))?(?:\/(errors))?$/);
  if (!match) return null;
  if (!env.CONTROL_DB) return json(request, { error:'control_db_not_bound' }, 503);

  const storeId = safeDecode(match[1]);
  const resource = match[2] ? safeDecode(match[2]) : null;
  const child = match[3] || null;
  if (!storeId) return json(request, { error:'invalid_store_id' }, 400);
  if (match[2] && !resource) return json(request, { error:'invalid_import_id' }, 400);

  const route = await authorizedStoreRoute(env, storeId);
  if (route.error) return json(request, { error:route.error }, route.status);
  const method = request.method.toUpperCase();

  if (!resource) {
    if (method !== 'GET') return json(request, { error:'method_not_allowed' }, 405);
    if (!await hasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.read')) {
      return json(request, { error:'forbidden', permission:'ads.read' }, 403);
    }
    return listImports(request, route, url);
  }

  if (resource === 'search-terms' && !child) {
    if (method !== 'POST') return json(request, { error:'method_not_allowed' }, 405);
    if (!await hasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.write')) {
      return json(request, { error:'forbidden', permission:'ads.write' }, 403);
    }
    return uploadSearchTerms(request, env, route, actor, storeId, url);
  }

  if (!validImportId(resource)) return json(request, { error:'invalid_import_id' }, 400);
  if (!await hasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.read')) {
    return json(request, { error:'forbidden', permission:'ads.read' }, 403);
  }
  if (!child) {
    if (method !== 'GET') return json(request, { error:'method_not_allowed' }, 405);
    return importDetail(request, route, resource);
  }
  if (child === 'errors') {
    if (method !== 'GET') return json(request, { error:'method_not_allowed' }, 405);
    return importErrors(request, route, resource, url);
  }
  return json(request, { error:'not_found' }, 404);
}

async function uploadSearchTerms(request, env, route, actor, storeId, url) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CSV_BYTES) {
    return json(request, { error:'csv_size_limit_exceeded', maxBytes:MAX_CSV_BYTES }, 413);
  }
  const contentType = String(request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType && !CSV_CONTENT_TYPES.has(contentType)) {
    return json(request, { error:'unsupported_media_type', expected:'text/csv' }, 415);
  }
  if (!env.DATA_BUCKET) return json(request, { error:'data_bucket_not_bound' }, 503);

  let sourceBytes;
  try { sourceBytes = new Uint8Array(await request.arrayBuffer()); }
  catch { return json(request, { error:'csv_body_unreadable' }, 400); }
  if (sourceBytes.byteLength === 0) return json(request, { error:'csv_empty' }, 400);
  if (sourceBytes.byteLength > MAX_CSV_BYTES) {
    return json(request, { error:'csv_size_limit_exceeded', maxBytes:MAX_CSV_BYTES }, 413);
  }

  let csvText;
  try { csvText = new TextDecoder('utf-8', { fatal:true }).decode(sourceBytes); }
  catch { return json(request, { error:'csv_invalid_utf8' }, 400); }

  const sourceFileName = sourceFileNameFromRequest(request, url);
  if (!sourceFileName) return json(request, { error:'source_file_name_required' }, 400);
  const context = parseUploadContext(url);
  if (context.error) return json(request, { error:context.error }, 400);

  const repository = createD1CsvSearchTermImportRepository(route.storeDb);
  const sourceObjectStore = createCsvImportSourceObjectStore({ bucket:env.DATA_BUCKET });
  const importId = `csv-${crypto.randomUUID()}`;
  const uploadedAt = new Date().toISOString();
  let outcome;
  try {
    outcome = await ingestSearchTermCsvOnce({
      importId,
      repository,
      sourceObjectStore,
      sourceContext:{
        storeId,
        contentType:contentType || null,
        importerUserId:actor.user_id,
      },
      now:uploadedAt,
      input:{
        csvText,
        sourceBytes,
        sourceFileName,
        marketplace:context.value.marketplace,
        profileId:context.value.profileId,
        currencyCode:context.value.currencyCode,
        uploadedAt,
        maxBytes:MAX_CSV_BYTES,
      },
    });
  } catch (error) {
    const rootCode = String(error?.code || '').trim();
    const causeCode = String(error?.cause?.code || '').trim();
    const isParserFailure = rootCode === 'CSV_IMPORT_PARSE_FAILED';
    await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'csv_import.failed', 'csv_import', importId, {
      sourceFileName,
      failureClass:isParserFailure ? 'validation' : 'internal',
      errorCode:isParserFailure ? safeParserErrorCode(causeCode) : 'csv_import_failed',
      sourceEvidenceRequired:true,
    });
    if (isParserFailure) return json(request, { error:safeParserErrorCode(causeCode) }, 400);
    console.error('csv_import_internal_failure', {
      rootCode:rootCode || 'unknown',
      causeName:error?.cause?.name || null,
      storeId,
      importId,
    });
    return json(request, { error: 'csv_import_failed' }, 500);
  }

  const response = publicOutcome(outcome);
  const action = outcome.action === 'csv_import_duplicate'
    ? 'csv_import.duplicate'
    : outcome.published ? 'csv_import.published' : 'csv_import.rejected';
  await audit(env.CONTROL_DB, request, actor.user_id, storeId, action, 'csv_import', outcome.importId, {
    sourceFileName,
    duplicate:Boolean(outcome.reused),
    published:Boolean(outcome.published),
    rowCount:outcome.parsed?.rowCount ?? null,
    acceptedRows:outcome.parsed?.acceptedRows ?? null,
    rejectedRows:outcome.parsed?.rejectedRows ?? null,
    reportStartDate:outcome.parsed?.reportStartDate ?? null,
    reportEndDate:outcome.parsed?.reportEndDate ?? null,
    contentSha256:outcome.parsed?.contentSha256 ?? null,
    sourceObjectKey:outcome.sourceObject?.objectKey ?? null,
  });

  if (outcome.action === 'csv_import_duplicate') return json(request, response, 200);
  if (!outcome.published) return json(request, response, outcome.batch ? 422 : 400);
  return json(request, response, 201);
}

async function listImports(request, route, url) {
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit.error) return json(request, { error:limit.error }, 400);
  const before = parseOptionalText(url.searchParams.get('before'), 64, 'invalid_before');
  if (before.error) return json(request, { error:before.error }, 400);
  const status = optionalEnum(url.searchParams.get('status'), ['validated','published','rejected']);
  if (status.error) return json(request, { error:'invalid_import_status' }, 400);
  const result = await route.storeDb.prepare(`
    SELECT import_id, source_file_name, report_type, marketplace, profile_id, currency_code,
           report_start_date, report_end_date, content_sha256, content_bytes, schema_version,
           row_count, accepted_rows, rejected_rows, duplicate_status, status,
           validation_summary_json, uploaded_at, published_at, created_at, updated_at
    FROM csv_import_batches
    WHERE (?1 IS NULL OR uploaded_at < ?1) AND (?2 IS NULL OR status = ?2)
    ORDER BY uploaded_at DESC, import_id DESC LIMIT ?3
  `).bind(before.value, status.value, limit.value + 1).all();
  const rows = result.results || [];
  const hasMore = rows.length > limit.value;
  const items = (hasMore ? rows.slice(0, limit.value) : rows).map(publicBatch);
  return json(request, { store:publicStore(route.store), items, nextBefore:hasMore ? items.at(-1)?.uploadedAt || null : null }, 200);
}

async function importDetail(request, route, importId) {
  const row = await route.storeDb.prepare(`
    SELECT import_id, source_file_name, report_type, marketplace, profile_id, currency_code,
           report_start_date, report_end_date, content_sha256, content_bytes, schema_version,
           row_count, accepted_rows, rejected_rows, duplicate_status, status,
           validation_summary_json, uploaded_at, published_at, created_at, updated_at
    FROM csv_import_batches WHERE import_id=?1 LIMIT 1
  `).bind(importId).first();
  if (!row) return json(request, { error:'import_not_found' }, 404);
  const [fact, source] = await Promise.all([
    route.storeDb.prepare(`
      SELECT COUNT(*) AS fact_rows, MIN(report_date) AS min_report_date, MAX(report_date) AS max_report_date,
             COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks,
             COALESCE(SUM(cost_micros),0) AS cost_micros, COALESCE(SUM(purchases),0) AS purchases,
             COALESCE(SUM(sales_micros),0) AS sales_micros
      FROM csv_search_term_daily WHERE source_import_id=?1
    `).bind(importId).first(),
    route.storeDb.prepare(`
      SELECT source_object_id, source_kind, r2_binding_key, object_key, content_sha256, content_bytes,
             content_type, source_file_name, importer_user_id, uploaded_at, r2_etag, r2_version, created_at
      FROM csv_import_source_objects WHERE import_id=?1 LIMIT 1
    `).bind(importId).first(),
  ]);
  return json(request, {
    store:publicStore(route.store),
    batch:publicBatch(row),
    sourceObject:source ? publicSourceObject(source) : null,
    publishedFacts:{
      rowCount:Number(fact?.fact_rows || 0),
      reportStartDate:fact?.min_report_date || null,
      reportEndDate:fact?.max_report_date || null,
      impressions:Number(fact?.impressions || 0),
      clicks:Number(fact?.clicks || 0),
      costMicros:String(fact?.cost_micros || 0),
      purchases:Number(fact?.purchases || 0),
      salesMicros:String(fact?.sales_micros || 0),
    },
  }, 200);
}

async function importErrors(request, route, importId, url) {
  const exists = await route.storeDb.prepare('SELECT import_id FROM csv_import_batches WHERE import_id=?1 LIMIT 1').bind(importId).first();
  if (!exists) return json(request, { error:'import_not_found' }, 404);
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit.error) return json(request, { error:limit.error }, 400);
  const result = await route.storeDb.prepare(`
    SELECT error_ordinal, source_row_ordinal, error_code, column_key, safe_value_excerpt, created_at
    FROM csv_import_errors WHERE import_id=?1 ORDER BY error_ordinal ASC LIMIT ?2
  `).bind(importId, limit.value).all();
  return json(request, {
    importId,
    items:(result.results || []).map((row) => ({
      errorOrdinal:Number(row.error_ordinal),
      sourceRowOrdinal:row.source_row_ordinal == null ? null : Number(row.source_row_ordinal),
      errorCode:row.error_code,
      columnKey:row.column_key || null,
      safeValueExcerpt:row.safe_value_excerpt || null,
      createdAt:row.created_at,
    })),
  }, 200);
}

async function authorizedStoreRoute(env, storeId) {
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, store_code, display_name, marketplace_code, amazon_region, d1_binding_key, status
    FROM stores WHERE store_id=?1 AND status <> 'disabled' LIMIT 1
  `).bind(storeId).first();
  if (!store) return { error:'store_not_found', status:404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error:'store_db_unavailable', status:503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error:'store_db_unavailable', status:503 };
  return { store, storeDb };
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`
    SELECT 1 AS ok FROM user_global_roles ugr
    JOIN app_roles ar ON ar.role_key=ugr.role_key AND ar.role_scope='global'
    JOIN role_permissions rp ON rp.role_key=ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2 LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM store_members sm
    JOIN app_roles ar ON ar.role_key=sm.role_key AND ar.role_scope='store'
    JOIN role_permissions rp ON rp.role_key=sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3 LIMIT 1
  `).bind(userId, storeId, permission).first());
}

async function audit(db, request, actorUserId, storeId, action, entityType, entityId, details) {
  try {
    await db.prepare(`
      INSERT INTO audit_log(event_id, actor_user_id, store_id, action, entity_type, entity_id, request_id, cf_ray, details_json)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
    `).bind(
      crypto.randomUUID(), actorUserId, storeId, action, entityType, entityId,
      request.headers.get('cf-ray') || crypto.randomUUID(), request.headers.get('cf-ray'), JSON.stringify(details || {}),
    ).run();
  } catch (error) {
    console.error('csv_import_audit_failed', { action, message:error?.message || String(error) });
  }
}

function publicOutcome(outcome) {
  return {
    action:outcome.action,
    importId:outcome.importId,
    duplicate:Boolean(outcome.reused),
    published:Boolean(outcome.published),
    batch:outcome.batch ? publicBatch(outcome.batch) : null,
    sourceObject:outcome.sourceObject ? publicSourceObject(outcome.sourceObject) : null,
    validation:outcome.parsed ? {
      ok:Boolean(outcome.parsed.ok),
      schemaVersion:outcome.parsed.schemaVersion,
      reportType:outcome.parsed.reportType,
      reportStartDate:outcome.parsed.reportStartDate,
      reportEndDate:outcome.parsed.reportEndDate,
      rowCount:outcome.parsed.rowCount,
      acceptedRows:outcome.parsed.acceptedRows,
      rejectedRows:outcome.parsed.rejectedRows,
      contentSha256:outcome.parsed.contentSha256,
      contentBytes:outcome.parsed.contentBytes,
      summary:outcome.parsed.validationSummary,
      errors:(outcome.parsed.errors || []).slice(0, 100),
    } : null,
  };
}

function publicSourceObject(row) {
  return {
    sourceObjectId:row.source_object_id || row.sourceObjectId,
    sourceKind:row.source_kind || row.sourceKind,
    r2BindingKey:row.r2_binding_key || row.r2BindingKey,
    objectKey:row.object_key || row.objectKey,
    contentSha256:row.content_sha256 || row.contentSha256,
    contentBytes:Number(row.content_bytes ?? row.contentBytes ?? 0),
    contentType:row.content_type || row.contentType || null,
    sourceFileName:row.source_file_name || row.sourceFileName,
    importerUserId:row.importer_user_id || row.importerUserId,
    uploadedAt:row.uploaded_at || row.uploadedAt,
    r2Etag:row.r2_etag || row.r2Etag || null,
    r2Version:row.r2_version || row.r2Version || null,
    createdAt:row.created_at || null,
  };
}

function publicBatch(row) {
  return {
    importId:row.import_id,
    sourceFileName:row.source_file_name,
    reportType:row.report_type,
    marketplace:row.marketplace || null,
    profileId:row.profile_id || null,
    currencyCode:row.currency_code || null,
    reportStartDate:row.report_start_date,
    reportEndDate:row.report_end_date,
    contentSha256:row.content_sha256,
    contentBytes:Number(row.content_bytes || 0),
    schemaVersion:row.schema_version,
    rowCount:Number(row.row_count || 0),
    acceptedRows:Number(row.accepted_rows || 0),
    rejectedRows:Number(row.rejected_rows || 0),
    duplicateStatus:row.duplicate_status,
    status:row.status,
    validationSummary:parseJsonObject(row.validation_summary_json),
    uploadedAt:row.uploaded_at,
    publishedAt:row.published_at || null,
    createdAt:row.created_at || null,
    updatedAt:row.updated_at || null,
  };
}

function publicStore(store) {
  return {
    storeId:store.store_id,
    storeCode:store.store_code,
    displayName:store.display_name,
    marketplaceCode:store.marketplace_code || null,
    amazonRegion:store.amazon_region || null,
  };
}

function sourceFileNameFromRequest(request, url) {
  const raw = request.headers.get('x-import-file-name') || url.searchParams.get('fileName') || '';
  if (!raw) return null;
  let text = raw;
  try { text = decodeURIComponent(raw); } catch { return null; }
  text = String(text).trim();
  if (!text || text.length > 240 || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

function parseUploadContext(url) {
  const marketplace = parseOptionalText(url.searchParams.get('marketplace'), 32, 'invalid_marketplace');
  if (marketplace.error) return marketplace;
  const profileId = parseOptionalText(url.searchParams.get('profileId'), 200, 'invalid_profile_id');
  if (profileId.error) return profileId;
  const currencyCode = parseOptionalText(url.searchParams.get('currencyCode'), 8, 'invalid_currency_code');
  if (currencyCode.error) return currencyCode;
  return { value:{ marketplace:marketplace.value, profileId:profileId.value, currencyCode:currencyCode.value?.toUpperCase() || null } };
}

function parseOptionalText(value, maxLength, errorCode) {
  if (value == null || value === '') return { value:null };
  const text = String(value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) return { error:errorCode };
  return { value:text };
}

function parseLimit(value) {
  if (value == null || value === '') return { value:DEFAULT_LIMIT };
  if (!/^\d+$/.test(String(value))) return { error:'invalid_limit' };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) return { error:'invalid_limit' };
  return { value:parsed };
}

function optionalEnum(value, allowed) {
  if (value == null || value === '') return { value:null };
  const text = String(value).trim();
  return allowed.includes(text) ? { value:text } : { error:true };
}

function validImportId(value) {
  return typeof value === 'string' && value.length >= 5 && value.length <= 100 && /^csv-[A-Za-z0-9-]+$/.test(value);
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function safeParserErrorCode(value) {
  const code = String(value || '').trim();
  if (!/^CSV_[A-Z0-9_]{1,100}$/.test(code)) return 'csv_validation_failed';
  return code.toLowerCase();
}

function json(request, payload, status) {
  const headers = new Headers({
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
  });
  const ray = request.headers.get('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status, headers });
}
