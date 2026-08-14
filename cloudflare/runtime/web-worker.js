import { evaluateAccessIdentity } from '../../src/access.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const SYNC_DATASETS = new Set([
  'campaign_daily',
  'ad_group_daily',
  'keyword_daily',
  'target_daily',
  'search_term_daily',
  'advertised_product_daily',
  'purchased_product_daily',
  'placement_daily',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: apiHeaders(request) });
    }

    try {
      if (url.pathname === '/api/health') {
        return json({
          ok: true,
          service: 'ads-operations-web',
          environment: env.APP_ENV || 'unknown',
          dependencies: {
            assets: Boolean(env.ASSETS),
            controlDb: Boolean(env.CONTROL_DB),
            dataBucket: Boolean(env.DATA_BUCKET),
            storeDatabases: configuredStoreDatabaseCount(env),
            syncWorkflow: Boolean(env.AMAZON_SYNC_WORKFLOW),
          },
          syncTriggerEnabled: env.SYNC_TRIGGER_ENABLED === 'true',
        }, 200, request);
      }

      if (!env.CONTROL_DB) {
        return json({ error: 'control_db_not_bound' }, 503, request);
      }

      const access = await evaluateAccessIdentity(request, env);
      if (String(env.ACCESS_MODE || '').toLowerCase() === 'enforce' && !access.authenticated) {
        return json({ error: 'access_denied', reason: access.error || 'unauthenticated' }, 401, request);
      }

      if (url.pathname === '/api/v1/session' && request.method === 'GET') {
        return sessionResponse(request, env, access);
      }

      const actor = await resolveActor(env.CONTROL_DB, access);
      if (!actor) {
        return json({ error: 'app_user_not_provisioned' }, 403, request);
      }

      await touchLastSeen(env.CONTROL_DB, actor.user_id);

      if (url.pathname === '/api/v1/stores' && request.method === 'GET') {
        const stores = await storesForActor(env.CONTROL_DB, actor.user_id);
        return json({ stores }, 200, request);
      }

      if (url.pathname === '/api/v1/capabilities' && request.method === 'GET') {
        const [globalPermissions, storePermissions] = await Promise.all([
          globalPermissionsForActor(env.CONTROL_DB, actor.user_id),
          storePermissionsForActor(env.CONTROL_DB, actor.user_id),
        ]);
        return json({
          globalPermissions: [...globalPermissions].sort(),
          storePermissions,
          syncTriggerEnabled: env.SYNC_TRIGGER_ENABLED === 'true',
        }, 200, request);
      }

      const storeHealthMatch = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/health$/);
      if (storeHealthMatch && request.method === 'GET') {
        const storeId = decodeURIComponent(storeHealthMatch[1]);
        const allowed = await actorHasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.read');
        if (!allowed) return json({ error: 'forbidden', permission: 'ads.read' }, 403, request);

        const route = await authorizedStoreRoute(env, storeId);
        if (route.error) return json({ error: route.error }, route.status, request);

        const health = await storeDatabaseHealth(route.storeDb);
        return json({
          store: {
            storeId: route.store.store_id,
            storeCode: route.store.store_code,
            displayName: route.store.display_name,
          },
          health,
        }, 200, request);
      }

      const syncStartMatch = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/sync$/);
      if (syncStartMatch && request.method === 'POST') {
        const storeId = decodeURIComponent(syncStartMatch[1]);
        return startStoreSync(request, env, actor, storeId);
      }

      const syncStatusMatch = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/sync\/([^/]+)$/);
      if (syncStatusMatch && request.method === 'GET') {
        const storeId = decodeURIComponent(syncStatusMatch[1]);
        const instanceId = decodeURIComponent(syncStatusMatch[2]);
        return storeSyncStatus(request, env, actor, storeId, instanceId);
      }

      if (url.pathname === '/api/v1/system/health' && request.method === 'GET') {
        const permissions = await globalPermissionsForActor(env.CONTROL_DB, actor.user_id);
        if (!permissions.has('system.manage')) {
          return json({ error: 'forbidden', permission: 'system.manage' }, 403, request);
        }
        return json({
          controlDatabase: true,
          storeDatabases: configuredStoreDatabaseCount(env),
          dataBucket: Boolean(env.DATA_BUCKET),
          syncWorkflow: Boolean(env.AMAZON_SYNC_WORKFLOW),
          syncTriggerEnabled: env.SYNC_TRIGGER_ENABLED === 'true',
        }, 200, request);
      }

      return json({ error: 'not_found' }, 404, request);
    } catch (error) {
      console.error('api_error', {
        message: error?.message || String(error),
        stack: error?.stack,
        path: url.pathname,
        cfRay: request.headers.get('cf-ray'),
      });
      return json({ error: 'internal_error' }, 500, request);
    }
  },
};

async function startStoreSync(request, env, actor, storeId) {
  const allowed = await actorHasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'sync.run');
  if (!allowed) return json({ error: 'forbidden', permission: 'sync.run' }, 403, request);
  if (env.SYNC_TRIGGER_ENABLED !== 'true') return json({ error: 'sync_trigger_disabled' }, 503, request);
  if (!env.AMAZON_SYNC_WORKFLOW) return json({ error: 'sync_workflow_not_bound' }, 503, request);

  const route = await authorizedStoreRoute(env, storeId);
  if (route.error) return json({ error: route.error }, route.status, request);

  const body = await readJsonBody(request);
  if (body.error) return json({ error: body.error }, 400, request);

  const input = normalizeSyncRequest(body.value);
  if (input.error) return json({ error: input.error }, 400, request);

  const idempotencyKey = normalizeIdempotencyKey(request.headers.get('idempotency-key'));
  if (!idempotencyKey) {
    return json({ error: 'idempotency_key_required' }, 400, request);
  }

  const instanceId = await syncInstanceId(storeId, input.value, idempotencyKey);
  const existingRun = await route.storeDb.prepare(`
    SELECT run_id, profile_id, trigger_type, scope_key, status, started_at, completed_at, created_at
    FROM sync_runs
    WHERE run_id = ?1
    LIMIT 1
  `).bind(instanceId).first();

  if (existingRun) {
    const existing = await getWorkflowStatusSafe(env.AMAZON_SYNC_WORKFLOW, instanceId);
    return json({
      instanceId,
      reused: true,
      run: publicSyncRun(existingRun),
      workflow: existing,
    }, 200, request);
  }

  const profile = await route.storeDb.prepare(`
    SELECT profile_id, status
    FROM amazon_profiles
    WHERE profile_id = ?1
    LIMIT 1
  `).bind(input.value.profileId).first();
  if (!profile || profile.status !== 'active') {
    return json({ error: 'sync_profile_not_active' }, 400, request);
  }

  const scopeKey = `ads:${input.value.datasets.join(',')}:${input.value.startDate}:${input.value.endDate}`;
  await route.storeDb.prepare(`
    INSERT INTO sync_runs(
      run_id, profile_id, trigger_type, scope_key, status, requested_by, created_at
    ) VALUES(?1, ?2, 'manual', ?3, 'queued', ?4, CURRENT_TIMESTAMP)
  `).bind(instanceId, input.value.profileId, scopeKey, actor.user_id).run();

  try {
    const instance = await env.AMAZON_SYNC_WORKFLOW.create({
      id: instanceId,
      params: {
        storeId,
        profileId: input.value.profileId,
        startDate: input.value.startDate,
        endDate: input.value.endDate,
        datasets: input.value.datasets,
        triggerType: 'manual',
        reportConfigVersion: 'v1',
        requestedBy: actor.user_id,
      },
    });
    const status = await instance.status();
    await writeAudit(env.CONTROL_DB, {
      actorUserId: actor.user_id,
      storeId,
      action: 'sync.start',
      entityType: 'workflow_instance',
      entityId: instanceId,
      request,
      details: { datasets: input.value.datasets, startDate: input.value.startDate, endDate: input.value.endDate },
    });
    return json({ instanceId: instance.id, reused: false, workflow: publicWorkflowStatus(status) }, 202, request);
  } catch (error) {
    const existing = await getWorkflowStatusSafe(env.AMAZON_SYNC_WORKFLOW, instanceId);
    if (existing?.status && existing.status !== 'unknown') {
      return json({ instanceId, reused: true, workflow: existing }, 200, request);
    }

    await route.storeDb.prepare(`
      UPDATE sync_runs
      SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_summary = ?2
      WHERE run_id = ?1
    `).bind(instanceId, safeErrorCode(error)).run();
    throw error;
  }
}

async function storeSyncStatus(request, env, actor, storeId, instanceId) {
  const allowed = await actorHasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'sync.read');
  if (!allowed) return json({ error: 'forbidden', permission: 'sync.read' }, 403, request);
  if (!validWorkflowId(instanceId)) return json({ error: 'sync_instance_id_invalid' }, 400, request);

  const route = await authorizedStoreRoute(env, storeId);
  if (route.error) return json({ error: route.error }, route.status, request);

  const run = await route.storeDb.prepare(`
    SELECT run_id, profile_id, trigger_type, scope_key, status, started_at, completed_at,
           error_summary, created_at
    FROM sync_runs
    WHERE run_id = ?1
    LIMIT 1
  `).bind(instanceId).first();
  if (!run) return json({ error: 'sync_run_not_found' }, 404, request);

  const workflow = env.AMAZON_SYNC_WORKFLOW
    ? await getWorkflowStatusSafe(env.AMAZON_SYNC_WORKFLOW, instanceId)
    : { status: 'unknown' };

  return json({
    instanceId,
    run: publicSyncRun(run),
    workflow,
  }, 200, request);
}

async function authorizedStoreRoute(env, storeId) {
  const store = await loadStore(env.CONTROL_DB, storeId);
  if (!store) return { error: 'store_not_found', status: 404 };
  const storeDb = resolveStoreDb(env, store.d1_binding_key);
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { store, storeDb };
}

async function sessionResponse(request, env, access) {
  if (!access.authenticated) {
    return json({
      authenticated: false,
      accessMode: access.mode,
      configured: access.configured,
      reason: access.error,
    }, 200, request);
  }

  const actor = await resolveActor(env.CONTROL_DB, access);
  if (!actor) {
    return json({
      authenticated: true,
      provisioned: false,
      identity: safeIdentity(access.identity),
    }, 403, request);
  }

  await touchLastSeen(env.CONTROL_DB, actor.user_id);
  const [globalRoles, accessibleStores, globalPermissions, storePermissions] = await Promise.all([
    globalRolesForActor(env.CONTROL_DB, actor.user_id),
    storesForActor(env.CONTROL_DB, actor.user_id),
    globalPermissionsForActor(env.CONTROL_DB, actor.user_id),
    storePermissionsForActor(env.CONTROL_DB, actor.user_id),
  ]);

  return json({
    authenticated: true,
    provisioned: true,
    user: {
      userId: actor.user_id,
      email: actor.email,
      displayName: actor.display_name,
    },
    globalRoles,
    stores: accessibleStores,
    permissions: {
      global: [...globalPermissions].sort(),
      stores: storePermissions,
    },
    features: {
      syncTriggerEnabled: env.SYNC_TRIGGER_ENABLED === 'true',
    },
  }, 200, request);
}

async function resolveActor(db, access) {
  if (!access?.authenticated || !access.identity) return null;
  const sub = String(access.identity.sub || '').trim();
  const emailNorm = String(access.identity.email || '').trim().toLowerCase();
  if (!sub && !emailNorm) return null;

  const row = await db.prepare(`
    SELECT user_id, cf_access_sub, email, email_norm, display_name, status
    FROM users
    WHERE status = 'active'
      AND ((?1 <> '' AND cf_access_sub = ?1) OR (?2 <> '' AND email_norm = ?2))
    LIMIT 1
  `).bind(sub, emailNorm).first();

  if (!row) return null;

  if (sub && !row.cf_access_sub) {
    await db.prepare(`
      UPDATE users
      SET cf_access_sub = ?1, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?2 AND cf_access_sub IS NULL
    `).bind(sub, row.user_id).run();
  }

  return row;
}

async function touchLastSeen(db, userId) {
  await db.prepare(`
    UPDATE users SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?1
  `).bind(userId).run();
}

async function globalRolesForActor(db, userId) {
  const result = await db.prepare(`
    SELECT role_key
    FROM user_global_roles
    WHERE user_id = ?1
    ORDER BY role_key
  `).bind(userId).all();
  return (result.results || []).map((row) => row.role_key);
}

async function storeMembershipsForActor(db, userId) {
  const result = await db.prepare(`
    SELECT s.store_id, s.store_code, s.display_name, s.marketplace_code, s.amazon_region,
           sm.role_key
    FROM store_members sm
    JOIN stores s ON s.store_id = sm.store_id
    WHERE sm.user_id = ?1 AND s.status = 'active'
    ORDER BY s.sort_order, s.store_code
  `).bind(userId).all();
  return result.results || [];
}

async function storesForActor(db, userId) {
  const global = await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id = ?1 AND rp.permission_key = 'stores.manage'
    LIMIT 1
  `).bind(userId).first();

  if (global) {
    const all = await db.prepare(`
      SELECT store_id, store_code, display_name, marketplace_code, amazon_region,
             status, sort_order
      FROM stores
      WHERE status <> 'disabled'
      ORDER BY sort_order, store_code
    `).all();
    return all.results || [];
  }

  return storeMembershipsForActor(db, userId);
}

async function globalPermissionsForActor(db, userId) {
  const result = await db.prepare(`
    SELECT DISTINCT rp.permission_key
    FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id = ?1
  `).bind(userId).all();
  return new Set((result.results || []).map((row) => row.permission_key));
}

async function storePermissionsForActor(db, userId) {
  const result = await db.prepare(`
    SELECT sm.store_id, rp.permission_key
    FROM store_members sm
    JOIN role_permissions rp ON rp.role_key = sm.role_key
    WHERE sm.user_id = ?1
    ORDER BY sm.store_id, rp.permission_key
  `).bind(userId).all();

  const byStore = {};
  for (const row of result.results || []) {
    if (!byStore[row.store_id]) byStore[row.store_id] = [];
    byStore[row.store_id].push(row.permission_key);
  }
  return byStore;
}

async function actorHasStorePermission(db, userId, storeId, permissionKey) {
  const global = await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id = ?1 AND rp.permission_key = ?2
    LIMIT 1
  `).bind(userId, permissionKey).first();
  if (global) return true;

  const scoped = await db.prepare(`
    SELECT 1 AS ok
    FROM store_members sm
    JOIN role_permissions rp ON rp.role_key = sm.role_key
    WHERE sm.user_id = ?1 AND sm.store_id = ?2 AND rp.permission_key = ?3
    LIMIT 1
  `).bind(userId, storeId, permissionKey).first();
  return Boolean(scoped);
}

async function loadStore(db, storeId) {
  return db.prepare(`
    SELECT store_id, store_code, display_name, d1_binding_key, status
    FROM stores
    WHERE store_id = ?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
}

function resolveStoreDb(env, bindingKey) {
  if (!STORE_BINDINGS.has(bindingKey)) return null;
  return env[bindingKey] || null;
}

async function storeDatabaseHealth(db) {
  const [profiles, campaigns, keywords, lastSync] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM amazon_profiles').first(),
    db.prepare('SELECT COUNT(*) AS count FROM campaigns').first(),
    db.prepare('SELECT COUNT(*) AS count FROM keywords').first(),
    db.prepare(`
      SELECT run_id, status, started_at, completed_at, created_at
      FROM sync_runs
      ORDER BY created_at DESC
      LIMIT 1
    `).first(),
  ]);

  return {
    ok: true,
    counts: {
      profiles: Number(profiles?.count || 0),
      campaigns: Number(campaigns?.count || 0),
      keywords: Number(keywords?.count || 0),
    },
    lastSync: lastSync || null,
  };
}

async function readJsonBody(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 64 * 1024) return { error: 'request_body_too_large' };
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'json_object_required' };
    return { value };
  } catch {
    return { error: 'invalid_json' };
  }
}

function normalizeSyncRequest(body) {
  const profileId = String(body.profileId || '').trim();
  if (!profileId || profileId.length > 200) return { error: 'sync_profile_id_invalid' };
  const startDate = validIsoDate(body.startDate);
  const endDate = validIsoDate(body.endDate);
  if (!startDate || !endDate || endDate < startDate) return { error: 'sync_date_range_invalid' };

  const datasets = [...new Set((Array.isArray(body.datasets) ? body.datasets : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (!datasets.length) return { error: 'sync_datasets_required' };
  for (const dataset of datasets) {
    if (!SYNC_DATASETS.has(dataset)) return { error: 'sync_dataset_not_allowed' };
  }
  return { value: { profileId, startDate, endDate, datasets } };
}

function validIsoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  return text;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) return null;
  return key;
}

async function syncInstanceId(storeId, input, idempotencyKey) {
  const digest = await sha256Hex(JSON.stringify({
    storeId,
    profileId: input.profileId,
    startDate: input.startDate,
    endDate: input.endDate,
    datasets: [...input.datasets].sort(),
    idempotencyKey,
  }));
  return `sync-${digest.slice(0, 64)}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validWorkflowId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(value);
}

async function getWorkflowStatusSafe(binding, instanceId) {
  try {
    const instance = await binding.get(instanceId);
    return publicWorkflowStatus(await instance.status());
  } catch {
    return { status: 'unknown' };
  }
}

function publicWorkflowStatus(status) {
  return {
    status: String(status?.status || 'unknown'),
    hasError: Boolean(status?.error),
    rollbackOutcome: status?.rollback?.outcome || null,
  };
}

function publicSyncRun(run) {
  return {
    runId: run.run_id,
    profileId: run.profile_id,
    triggerType: run.trigger_type,
    scopeKey: run.scope_key,
    status: run.status,
    startedAt: run.started_at || null,
    completedAt: run.completed_at || null,
    hasError: Boolean(run.error_summary),
    createdAt: run.created_at,
  };
}

async function writeAudit(db, event) {
  try {
    await db.prepare(`
      INSERT INTO audit_log(
        event_id, actor_user_id, store_id, action, entity_type, entity_id,
        request_id, cf_ray, details_json
      ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).bind(
      crypto.randomUUID(),
      event.actorUserId || null,
      event.storeId || null,
      event.action,
      event.entityType || null,
      event.entityId || null,
      event.request.headers.get('cf-ray') || null,
      event.request.headers.get('cf-ray') || null,
      event.details ? JSON.stringify(event.details) : null,
    ).run();
  } catch (error) {
    console.error('audit_write_failed', { message: error?.message || String(error), action: event.action });
  }
}

function safeErrorCode(error) {
  const value = String(error?.name || 'workflow_create_failed').replace(/[^A-Za-z0-9_.:-]/g, '_');
  return value.slice(0, 120);
}

function configuredStoreDatabaseCount(env) {
  return [...STORE_BINDINGS].filter((name) => Boolean(env[name])).length;
}

function safeIdentity(identity) {
  if (!identity) return null;
  return {
    sub: identity.sub || null,
    email: identity.email || null,
    exp: identity.exp || null,
  };
}

function apiHeaders(request) {
  const headers = new Headers(JSON_HEADERS);
  const requestId = request.headers.get('cf-ray');
  if (requestId) headers.set('x-request-id', requestId);
  return headers;
}

function json(payload, status, request) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: apiHeaders(request),
  });
}
