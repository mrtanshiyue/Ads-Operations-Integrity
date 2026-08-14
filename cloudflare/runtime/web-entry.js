import legacyWebWorker from './web-worker.js';
import { handleControlApiRoute } from './control-api.js';
import { handleStoreApiRoute } from './store-api.js';
import { handleAnalyticsApiRoute } from './analytics-api.js';
import { evaluateAccessIdentity } from '../../src/access.js';

const CONTROL_ROUTE_PATTERNS = [
  /^\/api\/v1\/products(?:\/[^/]+)?$/,
  /^\/api\/v1\/keywords(?:\/[^/]+)?$/,
  /^\/api\/v1\/negative-keywords(?:\/[^/]+)?$/,
];
const STORE_ROUTE_PATTERN = /^\/api\/v1\/stores\/[^/]+\/(campaigns|ad-groups|keywords|targets|search-terms)$/;
const ANALYTICS_ROUTE_PATTERN = /^\/api\/v1\/analytics\/(overview|products|keywords)$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const modularRoute = isControlRoute(url.pathname)
      || STORE_ROUTE_PATTERN.test(url.pathname)
      || ANALYTICS_ROUTE_PATTERN.test(url.pathname);
    if (!modularRoute || request.method === 'OPTIONS') {
      return legacyWebWorker.fetch(request, env, ctx);
    }

    if (!env.CONTROL_DB) {
      return json(request, { error: 'control_db_not_bound' }, 503);
    }

    const access = await evaluateAccessIdentity(request, env);
    if (String(env.ACCESS_MODE || '').toLowerCase() === 'enforce' && !access.authenticated) {
      return json(request, { error: 'access_denied', reason: access.error || 'unauthenticated' }, 401);
    }

    const actor = await resolveActor(env.CONTROL_DB, access);
    if (!actor) return json(request, { error: 'app_user_not_provisioned' }, 403);

    await touchLastSeen(env.CONTROL_DB, actor.user_id);

    try {
      if (isControlRoute(url.pathname)) {
        const response = await handleControlApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (STORE_ROUTE_PATTERN.test(url.pathname)) {
        const response = await handleStoreApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (ANALYTICS_ROUTE_PATTERN.test(url.pathname)) {
        const response = await handleAnalyticsApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      return legacyWebWorker.fetch(request, env, ctx);
    } catch (error) {
      console.error('modular_api_error', {
        message: error?.message || String(error),
        stack: error?.stack,
        path: url.pathname,
        cfRay: request.headers.get('cf-ray'),
      });
      return json(request, { error: 'internal_error' }, 500);
    }
  },
};

function isControlRoute(pathname) {
  return CONTROL_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
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
    UPDATE users
    SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?1
  `).bind(userId).run();
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
