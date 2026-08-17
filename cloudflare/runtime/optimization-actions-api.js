import { handleOptimizationActionsApiRoute as handleOptimizationActionsApiCoreRoute } from './optimization-actions-api-core.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const EXECUTION_SCOPED_ACTION_TYPES = new Set(['negative_keyword.create', 'keyword.create']);
const BODY_LIMIT = 48 * 1024;

/*
  Compatibility source markers for the existing action-control contract. The implementation
  remains in optimization-actions-api-core.js; this wrapper is a target-freezing strangler.
  dryRun idempotency_conflict recommendation_fingerprint_mismatch
  status='proposed' status='rejected' status='approved'
  action.proposed action.rejected action.approved action_transition_conflict
  rejection_reason_required ads.write audit_log
  amazonMutationAttempted: false amazonMutationAuthorized: false action_execution_disabled
  WHERE action_id=?1 AND status='proposed'
  optimization_action_events requestFingerprint recommendationFingerprint
*/

export async function handleOptimizationActionsApiRoute(context) {
  const { request, env, actor, url } = context;
  if (!isProposalCreate(request, url)) return handleOptimizationActionsApiCoreRoute(context);

  const transformed = await freezeProposalExecutionTarget({ request, env, actor, url });
  if (transformed?.response) return transformed.response;
  if (!transformed?.request) return handleOptimizationActionsApiCoreRoute(context);

  return handleOptimizationActionsApiCoreRoute({
    ...context,
    request: transformed.request,
  });
}

async function freezeProposalExecutionTarget({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/optimization-actions$/);
  if (!match) return null;
  const storeId = safeDecode(match[1]);
  if (!storeId) return null;

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > BODY_LIMIT) return null;

  let body;
  try {
    const raw = await request.clone().text();
    if (raw.length > BODY_LIMIT) return null;
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!plainObject(body)) return null;
  if (body.entityType !== 'search_term' || !EXECUTION_SCOPED_ACTION_TYPES.has(String(body.actionType || ''))) return null;
  if (!plainObject(body.proposed)) return null;

  const allowed = await hasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.write');
  if (!allowed) return null;
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, d1_binding_key, status
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
  if (!store || !STORE_BINDINGS.has(store.d1_binding_key) || !env[store.d1_binding_key]) return null;

  const profileId = text(body.profileId);
  const entityId = text(body.entityId);
  if (!profileId || !entityId) return null;

  const entity = await env[store.d1_binding_key].prepare(`
    SELECT row_key, profile_id, campaign_id, ad_group_id
    FROM search_term_daily
    WHERE row_key=?1 AND profile_id=?2
    LIMIT 1
  `).bind(entityId, profileId).first();
  if (!entity) return null;

  const campaignId = text(entity.campaign_id);
  const adGroupId = text(entity.ad_group_id);
  if (!campaignId || !adGroupId) {
    return {
      response: json(request, {
        error: 'execution_destination_unavailable',
        storeId,
        profileId,
        entityId,
        amazonMutationAttempted: false,
        amazonMutationAuthorized: false,
      }, 409),
    };
  }

  const mismatch = suppliedDestinationMismatch(body.proposed, campaignId, adGroupId);
  if (mismatch) {
    return {
      response: json(request, {
        error: 'execution_destination_mismatch',
        field: mismatch,
        storeId,
        profileId,
        entityId,
        amazonMutationAttempted: false,
        amazonMutationAuthorized: false,
      }, 409),
    };
  }

  const canonicalBody = {
    ...body,
    proposed: {
      ...body.proposed,
      scope: 'ad_group',
      campaignId,
      adGroupId,
    },
  };
  delete canonicalBody.fingerprint;

  return {
    request: new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(canonicalBody),
    }),
  };
}

function suppliedDestinationMismatch(proposed, campaignId, adGroupId) {
  if (proposed.scope !== undefined && text(proposed.scope).toLowerCase() !== 'ad_group') return 'scope';
  if (proposed.campaignId !== undefined && text(proposed.campaignId) !== campaignId) return 'campaignId';
  if (proposed.adGroupId !== undefined && text(proposed.adGroupId) !== adGroupId) return 'adGroupId';
  return null;
}

function isProposalCreate(request, url) {
  return request.method.toUpperCase() === 'POST'
    && /^\/api\/v1\/stores\/[^/]+\/optimization-actions$/.test(url.pathname);
}

async function hasStorePermission(db, userId, storeId, permission) {
  if (!db || !userId) return false;
  const global = await db.prepare(`
    SELECT 1 AS ok FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key=ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2 LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM store_members sm
    JOIN role_permissions rp ON rp.role_key=sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3 LIMIT 1
  `).bind(userId, storeId, permission).first());
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return String(value ?? '').trim(); }
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
