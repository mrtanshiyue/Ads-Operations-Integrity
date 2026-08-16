import legacyWebWorker from './web-worker.js';
import { handleControlApiRoute } from './control-api.js';
import { handleStoreApiRoute } from './store-api.js';
import { handleStoreDailySourceObjectMetadataApiRoute } from './store-daily-source-object-metadata-api.js';
import { handleStoreDailySourceObjectChecksumApiRoute } from './store-daily-source-object-checksum-api.js';
import { createStoreDailySourceObjectOperationalMetadataLayer } from './store-daily-source-object-operational-metadata-api.js';
import { createStoreDailySourceObjectByteSizeLayer } from './store-daily-source-object-byte-size-api.js';
import { createStoreDailySourceObjectUploadTimestampLayer } from './store-daily-source-object-upload-timestamp-api.js';
import { createStoreDailySourceObjectVersionLayer } from './store-daily-source-object-version-api.js';
import { createStoreDailySourceObjectEtagLayer } from './store-daily-source-object-etag-api.js';
import { handleStoreProductsApiRoute } from './store-products-api.js';
import { handleProductKeywordsApiRoute } from './product-keywords-api.js';
import { handleNegativeKeywordScopesApiRoute } from './negative-keyword-scopes-api.js';
import { handleAuditApiRoute } from './audit-api.js';
import { handleAccessGovernanceApiRoute } from './access-governance-api.js';
import { handleUserLifecycleApiRoute } from './user-lifecycle-api.js';
import { handleAnalyticsApiRoute } from './analytics-api.js';
import { handleDataHealthApiRoute } from './data-health-api.js';
import { handleSyncApiRoute } from './sync-api.js';
import { evaluateAccessIdentity } from '../../src/access.js';
import { enforceStrictAccessActorBinding } from '../../src/access-actor.js';

const CONTROL_ROUTE_PATTERNS = [
  /^\/api\/v1\/products(?:\/[^/]+)?$/,
  /^\/api\/v1\/keywords(?:\/[^/]+)?$/,
  /^\/api\/v1\/negative-keywords(?:\/[^/]+)?$/,
];
const STORE_PRODUCTS_ROUTE_PATTERN = /^\/api\/v1\/stores\/[^/]+\/products(?:\/[^/]+\/[^/]+)?$/;
const PRODUCT_KEYWORDS_ROUTE_PATTERN = /^\/api\/v1\/products\/[^/]+\/keywords(?:\/[^/]+)?$/;
const NEGATIVE_KEYWORD_SCOPE_ROUTE_PATTERNS = [
  /^\/api\/v1\/stores\/[^/]+\/negative-keywords(?:\/[^/]+)?$/,
  /^\/api\/v1\/stores\/[^/]+\/products\/[^/]+\/negative-keywords(?:\/[^/]+)?$/,
];
const AUDIT_ROUTE_PATTERN = /^\/api\/v1\/audit\/events$/;
const ACCESS_GOVERNANCE_ROUTE_PATTERNS = [
  /^\/api\/v1\/access\/(roles|users)$/,
  /^\/api\/v1\/stores\/[^/]+\/members(?:\/[^/]+)?$/,
];
const STORE_ROUTE_PATTERN = /^\/api\/v1\/stores\/[^/]+\/(campaigns|ad-groups|keywords|targets|search-terms|search-terms-daily)$/;
const SYNC_ROUTE_PATTERN = /^\/api\/v1\/stores\/[^/]+\/sync(?:\/[^/]+)?$/;
const ANALYTICS_ROUTE_PATTERN = /^\/api\/v1\/analytics\/(overview|products|keywords|data-health)$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (shouldApplyStrictAccessGuard(url.pathname, request.method, env)) {
      const guard = await strictAccessGuard(request, env);
      if (guard) return guard;
    }

    const modularRoute = isControlRoute(url.pathname)
      || STORE_PRODUCTS_ROUTE_PATTERN.test(url.pathname)
      || PRODUCT_KEYWORDS_ROUTE_PATTERN.test(url.pathname)
      || isNegativeKeywordScopeRoute(url.pathname)
      || AUDIT_ROUTE_PATTERN.test(url.pathname)
      || isAccessGovernanceRoute(url.pathname)
      || STORE_ROUTE_PATTERN.test(url.pathname)
      || SYNC_ROUTE_PATTERN.test(url.pathname)
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
      if (SYNC_ROUTE_PATTERN.test(url.pathname)) {
        const response = await handleSyncApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (isControlRoute(url.pathname)) {
        const response = await handleControlApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (STORE_PRODUCTS_ROUTE_PATTERN.test(url.pathname)) {
        const response = await handleStoreProductsApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (PRODUCT_KEYWORDS_ROUTE_PATTERN.test(url.pathname)) {
        const response = await handleProductKeywordsApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (isNegativeKeywordScopeRoute(url.pathname)) {
        const response = await handleNegativeKeywordScopesApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (AUDIT_ROUTE_PATTERN.test(url.pathname)) {
        const response = await handleAuditApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (isAccessGovernanceRoute(url.pathname)) {
        if (url.pathname === '/api/v1/access/users' && request.method.toUpperCase() === 'PATCH') {
          const lifecycleResponse = await handleUserLifecycleApiRoute({ request, env, actor, url });
          if (lifecycleResponse) return lifecycleResponse;
        }
        const response = await handleAccessGovernanceApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (STORE_ROUTE_PATTERN.test(url.pathname)) {
        if (url.pathname.endsWith('/search-terms-daily')) {
          const gate24Layer = createStoreDailySourceObjectByteSizeLayer({ env, url });
          const gate23Layer = createStoreDailySourceObjectOperationalMetadataLayer({ env: gate24Layer.env, url });
          const gate25Layer = createStoreDailySourceObjectUploadTimestampLayer({ env: gate23Layer.env });
          const gate26Layer = createStoreDailySourceObjectVersionLayer({ env: gate25Layer.env });
          const gate27Layer = createStoreDailySourceObjectEtagLayer({ env: gate26Layer.env });
          const response = await handleStoreDailySourceObjectChecksumApiRoute({ request, env: gate27Layer.env, actor, url });
          if (response) {
            const gate23Response = await (async () => {
              return gate23Layer.enrich(response);
            })();
            const gate24Response = await (async () => {
              return gate24Layer.enrich(gate23Response);
            })();
            const gate25Response = await (async () => {
              return gate25Layer.enrich(gate24Response);
            })();
            const gate26Response = await (async () => {
              return gate26Layer.enrich(gate25Response);
            })();
            return gate27Layer.enrich(gate26Response);
          }
        }
        const response = await handleStoreApiRoute({ request, env, actor, url });
        if (response) return response;
      }
      if (ANALYTICS_ROUTE_PATTERN.test(url.pathname)) {
        if (url.pathname === '/api/v1/analytics/data-health') {
          const response = await handleDataHealthApiRoute({ request, env, actor, url });
          if (response) return response;
        }
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

void handleStoreDailySourceObjectMetadataApiRoute;

function isControlRoute(pathname) {
  return CONTROL_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function isNegativeKeywordScopeRoute(pathname) {
  return NEGATIVE_KEYWORD_SCOPE_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function isAccessGovernanceRoute(pathname) {
  return ACCESS_GOVERNANCE_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function shouldApplyStrictAccessGuard(pathname, method, env) {
  return String(env.ACCESS_MODE || '').toLowerCase() === 'enforce'
    && pathname.startsWith('/api/')
    && pathname !== '/api/health'
    && method !== 'OPTIONS';
}

async function strictAccessGuard(request, env) {
  if (!env.CONTROL_DB) {
    return json(request, { error: 'control_db_not_bound' }, 503);
  }

  const access = await evaluateAccessIdentity(request, env);
  const result = await enforceStrictAccessActorBinding(env.CONTROL_DB, access);
  if (result.ok) return null;

  const payload = { error: result.error };
  if (result.reason) payload.reason = result.reason;
  return json(request, payload, result.status);
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
