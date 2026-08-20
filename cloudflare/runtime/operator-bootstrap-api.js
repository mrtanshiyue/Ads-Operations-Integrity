const OPERATOR_BOOTSTRAP_ROUTES = new Set([
  '/api/v1/stores',
  '/api/v1/capabilities',
]);

export function isOperatorBootstrapApiRoute(pathname) {
  return OPERATOR_BOOTSTRAP_ROUTES.has(String(pathname || ''));
}

export async function handleOperatorBootstrapApiRoute({ request, env, actor, url }) {
  if (!isOperatorBootstrapApiRoute(url?.pathname)) return null;
  if (request.method !== 'GET') return null;
  if (!env?.CONTROL_DB) return json(request, { error: 'control_db_not_bound' }, 503);
  if (!actor?.user_id) return json(request, { error: 'app_user_not_provisioned' }, 403);

  if (url.pathname === '/api/v1/stores') {
    const stores = await storesForActor(env.CONTROL_DB, actor.user_id);
    return json(request, { stores }, 200);
  }

  const [globalPermissions, storePermissions] = await Promise.all([
    globalPermissionsForActor(env.CONTROL_DB, actor.user_id),
    storePermissionsForActor(env.CONTROL_DB, actor.user_id),
  ]);
  return json(request, {
    globalPermissions: [...globalPermissions].sort(),
    storePermissions,
    syncTriggerEnabled: env.SYNC_TRIGGER_ENABLED === 'true',
  }, 200);
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

  const scoped = await db.prepare(`
    SELECT s.store_id, s.store_code, s.display_name, s.marketplace_code, s.amazon_region,
           sm.role_key
    FROM store_members sm
    JOIN stores s ON s.store_id = sm.store_id
    WHERE sm.user_id = ?1 AND s.status = 'active'
    ORDER BY s.sort_order, s.store_code
  `).bind(userId).all();
  return scoped.results || [];
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

function json(request, payload, status) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const ray = request.headers.get('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status, headers });
}