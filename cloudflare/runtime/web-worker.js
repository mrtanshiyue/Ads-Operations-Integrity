import { evaluateAccessIdentity } from '../../src/access.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

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
          bindings: {
            assets: Boolean(env.ASSETS),
            controlDb: Boolean(env.CONTROL_DB),
            dataBucket: Boolean(env.DATA_BUCKET),
            store01: Boolean(env.STORE_01_DB),
            store02: Boolean(env.STORE_02_DB),
            store03: Boolean(env.STORE_03_DB),
            store04: Boolean(env.STORE_04_DB),
          },
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
        }, 200, request);
      }

      const storeHealthMatch = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/health$/);
      if (storeHealthMatch && request.method === 'GET') {
        const storeId = decodeURIComponent(storeHealthMatch[1]);
        const allowed = await actorHasStorePermission(
          env.CONTROL_DB,
          actor.user_id,
          storeId,
          'ads.read',
        );
        if (!allowed) {
          return json({ error: 'forbidden', permission: 'ads.read' }, 403, request);
        }

        const store = await loadStore(env.CONTROL_DB, storeId);
        if (!store) return json({ error: 'store_not_found' }, 404, request);

        const storeDb = resolveStoreDb(env, store.d1_binding_key);
        if (!storeDb) {
          return json({
            error: 'store_db_not_bound',
            binding: store.d1_binding_key,
          }, 503, request);
        }

        const health = await storeDatabaseHealth(storeDb);
        return json({
          store: {
            storeId: store.store_id,
            storeCode: store.store_code,
            displayName: store.display_name,
            binding: store.d1_binding_key,
          },
          health,
        }, 200, request);
      }

      if (url.pathname === '/api/v1/system/bindings' && request.method === 'GET') {
        const permissions = await globalPermissionsForActor(env.CONTROL_DB, actor.user_id);
        if (!permissions.has('system.manage')) {
          return json({ error: 'forbidden', permission: 'system.manage' }, 403, request);
        }
        return json({
          storeBindings: configuredStoreBindings(env),
          r2: Boolean(env.DATA_BUCKET),
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
           s.d1_binding_key, sm.role_key
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
             d1_binding_key, status, sort_order
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
  const allowed = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
  if (!allowed.has(bindingKey)) return null;
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

function configuredStoreBindings(env) {
  return ['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']
    .filter((name) => Boolean(env[name]));
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
