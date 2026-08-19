import { parseAmazonSettlementCsv } from './settlement-csv-import.js';
import { createD1SettlementImportRepository } from './settlement-import-repository.js';
import {
  bindSettlementImportSourceReceipt,
  createSettlementImportSourceObjectStore,
} from './settlement-import-source-object.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DATA_CLASSES = new Set(['unclassified', 'business', 'acceptance']);
const CSV_CONTENT_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
]);

export async function handleSettlementImportsApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/imports\/settlements$/);
  if (!match) return null;
  if (!env.CONTROL_DB) return json(request, { error:'control_db_not_bound' }, 503);

  const storeId = safeDecode(match[1]);
  if (!storeId) return json(request, { error:'invalid_store_id' }, 400);
  const route = await authorizedStoreRoute(env, storeId);
  if (route.error) return json(request, { error:route.error }, route.status);

  const method = request.method.toUpperCase();
  if (method === 'POST') {
    if (!await hasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.write')) {
      return json(request, { error:'forbidden', permission:'ads.write' }, 403);
    }
    return uploadSettlement(request, env, route, actor, storeId, url);
  }
  if (method === 'PATCH') {
    if (!await hasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.write')) {
      return json(request, { error:'forbidden', permission:'ads.write' }, 403);
    }
    const importId = optionalImportId(url.searchParams.get('importId'));
    if (importId.error || !importId.value) {
      return json(request, { error:importId.error || 'settlement_import_id_required' }, 400);
    }
    return classifySettlementAuthority(request, env, route, actor, storeId, importId.value);
  }
  if (method === 'GET') {
    if (!await hasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.read')) {
      return json(request, { error:'forbidden', permission:'ads.read' }, 403);
    }
    const importId = optionalImportId(url.searchParams.get('importId'));
    if (importId.error) return json(request, { error:importId.error }, 400);
    return importId.value
      ? settlementDetail(request, route, importId.value)
      : listSettlements(request, route, url);
  }
  return json(request, { error:'method_not_allowed' }, 405);
}

async function uploadSettlement(request, env, route, actor, storeId, url) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CSV_BYTES) {
    return json(request, { error:'settlement_csv_size_limit_exceeded', maxBytes:MAX_CSV_BYTES }, 413);
  }
  const contentType = String(request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType && !CSV_CONTENT_TYPES.has(contentType)) {
    return json(request, { error:'unsupported_media_type', expected:'text/csv' }, 415);
  }
  if (!env.DATA_BUCKET) return json(request, { error:'data_bucket_not_bound' }, 503);

  let sourceBytes;
  try { sourceBytes = new Uint8Array(await request.arrayBuffer()); }
  catch { return json(request, { error:'settlement_csv_body_unreadable' }, 400); }
  if (sourceBytes.byteLength === 0) return json(request, { error:'settlement_csv_empty' }, 400);
  if (sourceBytes.byteLength > MAX_CSV_BYTES) {
    return json(request, { error:'settlement_csv_size_limit_exceeded', maxBytes:MAX_CSV_BYTES }, 413);
  }

  const sourceFileName = sourceFileNameFromRequest(request, url);
  if (!sourceFileName) return json(request, { error:'source_file_name_required' }, 400);
  const context = parseUploadContext(url);
  if (context.error) return json(request, { error:context.error }, 400);

  const uploadedAt = new Date().toISOString();
  let parsed;
  try {
    parsed = await parseAmazonSettlementCsv({
      csvBytes:sourceBytes,
      sourceFileName,
      uploadedAt,
      marketplace:context.value.marketplace,
      currencyCode:context.value.currencyCode,
      maxBytes:MAX_CSV_BYTES,
    });
  } catch (error) {
    const errorCode = safeSettlementErrorCode(error?.code);
    await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'settlement_import.failed', 'settlement_import', null, {
      sourceFileName,
      failureClass:'validation',
      errorCode,
      sourceEvidencePersisted:false,
    });
    return json(request, { error:errorCode }, 400);
  }

  if (!parsed.ok) {
    await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'settlement_import.rejected', 'settlement_import', null, {
      sourceFileName,
      rowCount:parsed.rowCount,
      acceptedRows:parsed.acceptedRows,
      rejectedRows:parsed.rejectedRows,
      reportStartDate:parsed.reportStartDate,
      reportEndDate:parsed.reportEndDate,
      contentSha256:parsed.contentSha256,
      sourceEvidencePersisted:false,
      errorCodes:parsed.validationSummary?.errorCodes || {},
    });
    return json(request, {
      error:'settlement_validation_failed',
      validation:publicValidation(parsed),
    }, 422);
  }

  const repository = createD1SettlementImportRepository(route.storeDb);
  const duplicate = await repository.findDuplicate({
    contentSha256:parsed.contentSha256,
    reportStartDate:parsed.reportStartDate,
    reportEndDate:parsed.reportEndDate,
  });
  if (duplicate) {
    await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'settlement_import.duplicate', 'settlement_import', duplicate.import_id, {
      sourceFileName,
      contentSha256:parsed.contentSha256,
      reportStartDate:parsed.reportStartDate,
      reportEndDate:parsed.reportEndDate,
    });
    return settlementDetail(request, route, duplicate.import_id, { duplicate:true, validation:parsed });
  }

  const importId = `settlement-${crypto.randomUUID()}`;
  const sourceObjectStore = createSettlementImportSourceObjectStore({ bucket:env.DATA_BUCKET });
  let sourceDescriptor;
  let persistedSource;
  try {
    sourceDescriptor = await sourceObjectStore.describe({
      bytes:sourceBytes,
      storeId,
      sourceFileName,
      contentType:contentType || null,
      importerUserId:actor.user_id,
      uploadedAt,
    });
    if (sourceDescriptor.contentSha256 !== parsed.contentSha256
        || sourceDescriptor.contentBytes !== parsed.contentBytes) {
      throw Object.assign(new Error('settlement_source_parser_identity_mismatch'), {
        code:'SETTLEMENT_SOURCE_PARSER_IDENTITY_MISMATCH',
      });
    }
    persistedSource = await sourceObjectStore.persist(sourceDescriptor);
  } catch (error) {
    const errorCode = safeSettlementErrorCode(error?.code, 'settlement_source_persist_failed');
    await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'settlement_import.failed', 'settlement_import', importId, {
      sourceFileName,
      failureClass:'source_persistence',
      errorCode,
      contentSha256:parsed.contentSha256,
    });
    return json(request, { error:errorCode }, 500);
  }

  const sourceReceipt = bindSettlementImportSourceReceipt(importId, persistedSource);
  let batch;
  try {
    batch = await repository.commitValidatedImport({
      importId,
      parsed,
      sourceObject:sourceReceipt,
      now:uploadedAt,
    });
  } catch (error) {
    const errorCode = safeSettlementErrorCode(error?.code, 'settlement_import_commit_failed');
    await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'settlement_import.failed', 'settlement_import', importId, {
      sourceFileName,
      failureClass:'d1_commit',
      errorCode,
      contentSha256:parsed.contentSha256,
      sourceObjectKey:persistedSource.objectKey,
      sourceObjectReusableOnRetry:true,
    });
    console.error('settlement_import_commit_failed', {
      storeId,
      importId,
      errorCode,
      sourceObjectKey:persistedSource.objectKey,
    });
    return json(request, {
      error:'settlement_import_commit_failed',
      retrySafe:true,
      contentSha256:parsed.contentSha256,
    }, 500);
  }

  await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'settlement_import.published', 'settlement_import', importId, {
    sourceFileName,
    rowCount:parsed.rowCount,
    acceptedRows:parsed.acceptedRows,
    rejectedRows:parsed.rejectedRows,
    reportStartDate:parsed.reportStartDate,
    reportEndDate:parsed.reportEndDate,
    contentSha256:parsed.contentSha256,
    contentBytes:parsed.contentBytes,
    reconciliationStatus:parsed.reconciliation.status,
    reconciliationDifferenceMicros:String(parsed.reconciliation.differenceMicros),
    sourceObjectKey:persistedSource.objectKey,
    sourceObjectReused:Boolean(persistedSource.reusedExisting),
  });

  const [source, authority, reconciliation] = await Promise.all([
    repository.loadSourceObject(importId),
    repository.loadAuthority(importId),
    repository.loadReconciliation(importId),
  ]);
  return json(request, {
    store:publicStore(route.store),
    duplicate:false,
    batch:publicBatch(batch),
    sourceObject:publicSourceObject(source),
    authority:publicAuthority(authority),
    reconciliation:publicReconciliation(reconciliation),
    validation:publicValidation(parsed),
  }, 201);
}

async function classifySettlementAuthority(request, env, route, actor, storeId, importId) {
  const body = await readJson(request);
  if (body.error) return json(request, { error:body.error }, body.status || 400);
  const keys = Object.keys(body.value);
  if (keys.some((key) => !['dataClass','reason','evidence'].includes(key))) {
    return json(request, { error:'unsupported_settlement_authority_field' }, 400);
  }
  const dataClass = String(body.value.dataClass || '').trim();
  if (!DATA_CLASSES.has(dataClass)) return json(request, { error:'invalid_data_class' }, 400);
  const reason = String(body.value.reason || '').trim();
  if (!reason || reason.length > 1000) {
    return json(request, { error:'settlement_authority_reason_required' }, 400);
  }
  const evidence = body.value.evidence == null ? {} : body.value.evidence;
  if (!plainObject(evidence)) return json(request, { error:'invalid_settlement_authority_evidence' }, 400);

  const row = await route.storeDb.prepare(`
    SELECT b.import_id,b.status,b.content_sha256,
           r.status AS reconciliation_status,r.difference_micros,r.mismatch_rows,
           a.data_class,a.provenance_class,a.authority_version,
           a.actor_user_id,a.reason,a.evidence_json,a.created_at,a.updated_at
    FROM settlement_import_batches b
    LEFT JOIN settlement_import_reconciliation_receipts r ON r.import_id=b.import_id
    LEFT JOIN settlement_import_authority a ON a.import_id=b.import_id
    WHERE b.import_id=?1 LIMIT 1
  `).bind(importId).first();
  if (!row) return json(request, { error:'settlement_import_not_found' }, 404);
  if (row.status !== 'published' || row.reconciliation_status !== 'pass'
      || Number(row.difference_micros || 0) !== 0 || Number(row.mismatch_rows || 0) !== 0) {
    return json(request, { error:'settlement_authority_reconciliation_required' }, 409);
  }
  if (!row.authority_version || row.provenance_class !== 'exact_source_object') {
    return json(request, { error:'settlement_authority_exact_source_required' }, 409);
  }
  if (dataClass === row.data_class) return json(request, { error:'settlement_authority_no_change' }, 409);

  const nextVersion = Number(row.authority_version) + 1;
  const now = new Date().toISOString();
  try {
    await route.storeDb.prepare(`
      UPDATE settlement_import_authority
      SET data_class=?2,authority_version=?3,actor_user_id=?4,
          reason=?5,evidence_json=?6,updated_at=?7
      WHERE import_id=?1 AND provenance_class='exact_source_object'
    `).bind(importId, dataClass, nextVersion, actor.user_id, reason, JSON.stringify(evidence), now).run();
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('SETTLEMENT_AUTHORITY_') || message.includes('SETTLEMENT_PROVENANCE_')) {
      return json(request, { error:'settlement_authority_conflict' }, 409);
    }
    throw error;
  }
  const updated = await route.storeDb.prepare(`
    SELECT import_id,data_class,provenance_class,authority_version,
           actor_user_id,reason,evidence_json,created_at,updated_at
    FROM settlement_import_authority WHERE import_id=?1 LIMIT 1
  `).bind(importId).first();
  await audit(env.CONTROL_DB, request, actor.user_id, storeId,
    'settlement_import.authority_changed', 'settlement_import', importId, {
      previous:{
        dataClass:row.data_class,
        provenanceClass:row.provenance_class,
        authorityVersion:Number(row.authority_version),
      },
      current:{
        dataClass,
        provenanceClass:'exact_source_object',
        authorityVersion:nextVersion,
      },
      reason,
      contentSha256:row.content_sha256,
      reconciliationStatus:row.reconciliation_status,
    });
  return json(request, {
    store:publicStore(route.store),
    importId,
    authority:publicAuthority(updated),
  }, 200);
}

async function listSettlements(request, route, url) {
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit.error) return json(request, { error:limit.error }, 400);
  const result = await route.storeDb.prepare(`
    SELECT import_id,source_file_name,report_type,marketplace,currency_code,
           report_start_date,report_end_date,content_sha256,content_bytes,schema_version,
           row_count,accepted_rows,rejected_rows,duplicate_status,status,
           validation_summary_json,uploaded_at,published_at,created_at,updated_at
    FROM settlement_import_batches
    ORDER BY uploaded_at DESC,import_id DESC LIMIT ?1
  `).bind(limit.value).all();
  return json(request, {
    store:publicStore(route.store),
    items:(result.results || []).map(publicBatch),
  }, 200);
}

async function settlementDetail(request, route, importId, extra = {}) {
  const repository = createD1SettlementImportRepository(route.storeDb);
  const [batch, source, authority, reconciliation, facts] = await Promise.all([
    repository.loadImport(importId),
    repository.loadSourceObject(importId),
    repository.loadAuthority(importId),
    repository.loadReconciliation(importId),
    route.storeDb.prepare(`
      SELECT COUNT(*) AS fact_rows,
             MIN(posted_date) AS min_posted_date,
             MAX(posted_date) AS max_posted_date,
             COALESCE(SUM(total_micros),0) AS total_micros
      FROM settlement_transactions WHERE source_import_id=?1
    `).bind(importId).first(),
  ]);
  if (!batch) return json(request, { error:'settlement_import_not_found' }, 404);
  return json(request, {
    store:publicStore(route.store),
    duplicate:Boolean(extra.duplicate),
    batch:publicBatch(batch),
    sourceObject:source ? publicSourceObject(source) : null,
    authority:authority ? publicAuthority(authority) : null,
    reconciliation:reconciliation ? publicReconciliation(reconciliation) : null,
    publishedFacts:{
      rowCount:Number(facts?.fact_rows || 0),
      reportStartDate:facts?.min_posted_date || null,
      reportEndDate:facts?.max_posted_date || null,
      totalMicros:String(facts?.total_micros || 0),
    },
    validation:extra.validation ? publicValidation(extra.validation) : null,
  }, 200);
}

async function authorizedStoreRoute(env, storeId) {
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id,store_code,display_name,marketplace_code,amazon_region,d1_binding_key,status
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
      INSERT INTO audit_log(event_id,actor_user_id,store_id,action,entity_type,entity_id,request_id,cf_ray,details_json)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
    `).bind(
      crypto.randomUUID(),actorUserId,storeId,action,entityType,entityId,
      request.headers.get('cf-ray') || crypto.randomUUID(),request.headers.get('cf-ray'),JSON.stringify(details || {}),
    ).run();
  } catch (error) {
    console.error('settlement_import_audit_failed', { action, message:error?.message || String(error) });
  }
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    return { error:'request_body_too_large', status:413 };
  }
  let text;
  try { text = await request.text(); }
  catch { return { error:'invalid_json' }; }
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    return { error:'request_body_too_large', status:413 };
  }
  try {
    const value = JSON.parse(text);
    if (!plainObject(value)) return { error:'invalid_json' };
    return { value };
  } catch {
    return { error:'invalid_json' };
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function publicValidation(parsed) {
  return {
    ok:Boolean(parsed.ok),
    schemaVersion:parsed.schemaVersion,
    reportType:parsed.reportType,
    reportStartDate:parsed.reportStartDate,
    reportEndDate:parsed.reportEndDate,
    marketplace:parsed.marketplace,
    currencyCode:parsed.currencyCode,
    rowCount:parsed.rowCount,
    acceptedRows:parsed.acceptedRows,
    rejectedRows:parsed.rejectedRows,
    contentSha256:parsed.contentSha256,
    contentBytes:parsed.contentBytes,
    summary:parsed.validationSummary,
    reconciliation:parsed.reconciliation,
    errors:(parsed.errors || []).slice(0, 100),
  };
}
function publicBatch(row) {
  return row ? {
    importId:row.import_id,
    sourceFileName:row.source_file_name,
    reportType:row.report_type,
    marketplace:row.marketplace || null,
    currencyCode:row.currency_code,
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
  } : null;
}
function publicSourceObject(row) {
  return row ? {
    sourceObjectId:row.source_object_id,
    sourceKind:row.source_kind,
    r2BindingKey:row.r2_binding_key,
    objectKey:row.object_key,
    contentSha256:row.content_sha256,
    contentBytes:Number(row.content_bytes || 0),
    contentType:row.content_type || null,
    sourceFileName:row.source_file_name,
    importerUserId:row.importer_user_id,
    uploadedAt:row.uploaded_at,
    r2Etag:row.r2_etag || null,
    r2Version:row.r2_version || null,
    createdAt:row.created_at || null,
  } : null;
}
function publicAuthority(row) {
  return row ? {
    importId:row.import_id,
    dataClass:row.data_class,
    provenanceClass:row.provenance_class,
    authorityVersion:Number(row.authority_version || 0),
    actorUserId:row.actor_user_id,
    reason:row.reason,
    evidence:parseJsonObject(row.evidence_json),
    createdAt:row.created_at,
    updatedAt:row.updated_at,
  } : null;
}
function publicReconciliation(row) {
  return row ? {
    importId:row.import_id,
    rowCount:Number(row.row_count || 0),
    componentSumMicros:String(row.component_sum_micros || 0),
    reportedTotalMicros:String(row.reported_total_micros || 0),
    differenceMicros:String(row.difference_micros || 0),
    mismatchRows:Number(row.mismatch_rows || 0),
    status:row.status,
    evidence:parseJsonObject(row.evidence_json),
    createdAt:row.created_at,
  } : null;
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
  const currencyCode = parseOptionalText(url.searchParams.get('currencyCode'), 8, 'invalid_currency_code');
  if (currencyCode.error) return currencyCode;
  return { value:{ marketplace:marketplace.value, currencyCode:currencyCode.value?.toUpperCase() || null } };
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
function optionalImportId(value) {
  if (value == null || value === '') return { value:null };
  const text = String(value).trim();
  if (text.length < 10 || text.length > 100 || !/^settlement-[A-Za-z0-9-]+$/.test(text)) {
    return { error:'invalid_settlement_import_id' };
  }
  return { value:text };
}
function safeSettlementErrorCode(value, fallback = 'settlement_validation_failed') {
  const code = String(value || '').trim();
  if (!/^SETTLEMENT_[A-Z0-9_]{1,100}$/.test(code)) return fallback;
  return code.toLowerCase();
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
