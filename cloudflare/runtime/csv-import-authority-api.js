const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const DATA_CLASSES = new Set(['unclassified', 'business', 'acceptance']);
const PROVENANCE_CLASSES = new Set(['legacy_batch_only', 'exact_source_object', 'reconciled_exact_source']);
const GOVERNED_PROVENANCE = new Set(['exact_source_object', 'reconciled_exact_source']);
const MAX_BODY_BYTES = 64 * 1024;

export async function handleCsvImportAuthorityApiRoute({ request, env, actor, url }) {
  if (request.method.toUpperCase() !== 'PATCH') return null;
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/imports\/([^/]+)$/);
  if (!match) return null;

  const storeId = safeDecode(match[1]);
  const importId = safeDecode(match[2]);
  if (!storeId) return json(request, { error:'invalid_store_id' }, 400);
  if (!importId) return json(request, { error:'invalid_import_id' }, 400);
  // Settlement authority has its own API and CAS contract.
  if (importId === 'settlements') return null;

  const route = await authorizedStoreDb(env, actor.user_id, storeId, 'ads.write');
  if (route.error) return json(request, { error:route.error, permission:route.permission }, route.status);

  const body = await readJson(request);
  if (body.error) return json(request, { error:body.error }, 400);
  const keys = Object.keys(body.value);
  if (keys.some((key) => !['dataClass', 'provenanceClass', 'reason', 'evidence'].includes(key))) {
    return json(request, { error:'unsupported_import_authority_field' }, 400);
  }

  const reason = text(body.value.reason);
  if (!reason || reason.length > 1000) return json(request, { error:'import_authority_reason_required' }, 400);
  if (body.value.evidence != null && !plainObject(body.value.evidence)) {
    return json(request, { error:'invalid_import_authority_evidence' }, 400);
  }
  const requestedDataClass = body.value.dataClass == null ? null : text(body.value.dataClass);
  const requestedProvenanceClass = body.value.provenanceClass == null ? null : text(body.value.provenanceClass);
  if (requestedDataClass != null && !DATA_CLASSES.has(requestedDataClass)) {
    return json(request, { error:'invalid_data_class' }, 400);
  }
  if (requestedProvenanceClass != null && !PROVENANCE_CLASSES.has(requestedProvenanceClass)) {
    return json(request, { error:'invalid_provenance_class' }, 400);
  }

  const row = await loadImportAuthorityContext(route.storeDb, importId);
  if (!row) return json(request, { error:'import_not_found' }, 404);

  const exists = row.authority_version != null;
  if (!exists && (!requestedDataClass || !requestedProvenanceClass)) {
    return json(request, { error:'initial_import_authority_requires_both_classes' }, 400);
  }
  const dataClass = requestedDataClass || row.data_class;
  const provenanceClass = requestedProvenanceClass || row.provenance_class;
  if (!dataClass || !provenanceClass) return json(request, { error:'import_authority_class_required' }, 400);
  if (exists && dataClass === row.data_class && provenanceClass === row.provenance_class) {
    return json(request, { error:'import_authority_no_change' }, 409);
  }

  const now = new Date().toISOString();
  const evidenceJson = JSON.stringify(body.value.evidence || {});
  const previousVersion = exists ? Number(row.authority_version) : null;
  const nextVersion = exists ? previousVersion + 1 : 1;
  let mutation;
  try {
    if (exists) {
      mutation = await route.storeDb.prepare(`
        UPDATE csv_import_authority
        SET data_class=?2, provenance_class=?3, authority_version=?4,
            actor_user_id=?5, reason=?6, evidence_json=?7, updated_at=?8
        WHERE import_id=?1
          AND authority_version=?9
          AND data_class=?10
          AND provenance_class=?11
      `).bind(
        importId, dataClass, provenanceClass, nextVersion, actor.user_id, reason, evidenceJson, now,
        previousVersion, row.data_class, row.provenance_class,
      ).run();
    } else {
      mutation = await route.storeDb.prepare(`
        INSERT INTO csv_import_authority(
          import_id,data_class,provenance_class,authority_version,
          actor_user_id,reason,evidence_json,created_at,updated_at
        ) VALUES(?1,?2,?3,1,?4,?5,?6,?7,?7)
      `).bind(importId, dataClass, provenanceClass, actor.user_id, reason, evidenceJson, now).run();
    }
  } catch (error) {
    const message = error?.message || String(error);
    if (message.includes('CSV_IMPORT_AUTHORITY_') || message.includes('CSV_IMPORT_PROVENANCE_')) {
      return json(request, { error:'import_authority_conflict', detail:authorityConflictDetail(message) }, 409);
    }
    if (!exists && isAuthorityInsertRace(message)) {
      return resolveCasConflict(request, route.storeDb, importId, dataClass, provenanceClass);
    }
    throw error;
  }

  if (mutationChanges(mutation) !== 1) {
    return resolveCasConflict(request, route.storeDb, importId, dataClass, provenanceClass);
  }

  const updated = {
    import_id:importId,
    data_class:dataClass,
    provenance_class:provenanceClass,
    authority_version:nextVersion,
    actor_user_id:actor.user_id,
    reason,
    evidence_json:evidenceJson,
    created_at:exists ? row.authority_created_at : now,
    updated_at:now,
  };

  await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'csv_import.authority_changed', importId, {
    previous:exists ? {
      dataClass:row.data_class,
      provenanceClass:row.provenance_class,
      authorityVersion:previousVersion,
    } : null,
    current:{ dataClass, provenanceClass, authorityVersion:nextVersion },
    reason,
  }, 'csv_import');

  return json(request, {
    schemaVersion:'csv-import-authority-v1',
    storeId,
    importId,
    authority:publicImportAuthority(updated),
  }, exists ? 200 : 201);
}

async function resolveCasConflict(request, db, importId, dataClass, provenanceClass) {
  const current = await db.prepare(`
    SELECT import_id,data_class,provenance_class,authority_version,
           actor_user_id,reason,evidence_json,created_at,updated_at
    FROM csv_import_authority WHERE import_id=?1 LIMIT 1
  `).bind(importId).first();
  if (current && current.data_class === dataClass && current.provenance_class === provenanceClass) {
    return json(request, { error:'import_authority_no_change' }, 409);
  }
  return json(request, { error:'import_authority_conflict', detail:'CSV_IMPORT_AUTHORITY_CONFLICT' }, 409);
}

async function loadImportAuthorityContext(db, importId) {
  return db.prepare(`
    SELECT b.import_id, b.source_file_name, b.content_sha256, b.status,
           a.data_class, a.provenance_class, a.authority_version,
           a.actor_user_id, a.reason, a.evidence_json, a.created_at AS authority_created_at,
           a.updated_at AS authority_updated_at
    FROM csv_import_batches b
    LEFT JOIN csv_import_authority a ON a.import_id=b.import_id
    WHERE b.import_id=?1
    LIMIT 1
  `).bind(importId).first();
}

async function authorizedStoreDb(env, userId, storeId, permission) {
  if (!env.CONTROL_DB) return { error:'control_db_not_bound', status:503 };
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error:'forbidden', permission, status:403 };
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, store_code, display_name, marketplace_code, d1_binding_key, status
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
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
    JOIN role_permissions rp ON rp.role_key=ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2
    LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM store_members sm
    JOIN role_permissions rp ON rp.role_key=sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3
    LIMIT 1
  `).bind(userId, storeId, permission).first());
}

async function audit(db, request, actorUserId, storeId, action, entityId, details, entityType) {
  try {
    await db.prepare(`
      INSERT INTO audit_log(event_id, actor_user_id, store_id, action, entity_type, entity_id, request_id, cf_ray, details_json)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
    `).bind(
      crypto.randomUUID(), actorUserId, storeId, action, entityType, entityId,
      request.headers.get('cf-ray') || crypto.randomUUID(), request.headers.get('cf-ray'), JSON.stringify(details || {}),
    ).run();
  } catch (error) {
    console.error('productization_audit_failed', { action, entityType, message:error?.message || String(error) });
  }
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { error:'request_body_too_large' };
  let raw;
  try { raw = await request.text(); } catch { return { error:'request_body_unreadable' }; }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return { error:'request_body_too_large' };
  let value;
  try { value = JSON.parse(raw); } catch { return { error:'invalid_json' }; }
  if (!plainObject(value)) return { error:'invalid_json_object' };
  return { value };
}

function publicImportAuthority(row) {
  const hasAuthority = Boolean(row?.import_id && row?.authority_version != null);
  const dataClass = hasAuthority ? row.data_class : 'unclassified';
  const provenanceClass = hasAuthority ? row.provenance_class : 'unknown';
  const analyticsAllowed = dataClass === 'business';
  const governed = analyticsAllowed && GOVERNED_PROVENANCE.has(provenanceClass);
  return {
    schemaVersion:'csv-import-authority-v1',
    classified:hasAuthority,
    dataClass,
    provenanceClass,
    authorityVersion:hasAuthority ? Number(row.authority_version) : null,
    analyticsAllowed,
    recommendationAllowed:governed,
    reviewAllowed:governed,
    actorUserId:hasAuthority ? (row.actor_user_id || null) : null,
    reason:hasAuthority ? (row.reason || null) : null,
    evidence:hasAuthority ? parseJson(row.evidence_json) : {},
    createdAt:hasAuthority ? (row.created_at || null) : null,
    updatedAt:hasAuthority ? (row.updated_at || null) : null,
  };
}

function authorityConflictDetail(message) {
  for (const code of [
    'CSV_IMPORT_AUTHORITY_BATCH_REQUIRED',
    'CSV_IMPORT_AUTHORITY_SOURCE_OBJECT_REQUIRED',
    'CSV_IMPORT_AUTHORITY_VERSION_INVALID',
    'CSV_IMPORT_PROVENANCE_TRANSITION_INVALID',
    'CSV_IMPORT_AUTHORITY_IDENTITY_IMMUTABLE',
  ]) {
    if (message.includes(code)) return code;
  }
  return 'CSV_IMPORT_AUTHORITY_CONFLICT';
}

function isAuthorityInsertRace(message) {
  const value = String(message || '');
  return /UNIQUE constraint failed/i.test(value) && /csv_import_authority\.import_id/i.test(value);
}

function mutationChanges(result) {
  const value = result?.meta?.changes ?? result?.changes;
  const changes = Number(value);
  return Number.isFinite(changes) ? changes : 0;
}

function safeDecode(value) { try { return decodeURIComponent(value); } catch { return null; } }
function text(value) { return String(value ?? '').trim(); }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function parseJson(value) { try { return JSON.parse(value); } catch { return {}; } }
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
