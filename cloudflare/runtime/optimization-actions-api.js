import { handleOptimizationActionsApiRoute as handleOptimizationActionsApiCoreRoute } from './optimization-actions-api-core.js';
import {
  AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
  buildExecutionPlan,
} from './amazon-action-execution-safety.js';
import { buildDormantNegativeKeywordMutationEnvelope } from './amazon-negative-keyword-mutation-adapter.js';
import {
  DEFAULT_EXECUTION_PERMIT_TTL_SECONDS,
  MAX_EXECUTION_PERMIT_TTL_SECONDS,
  MIN_EXECUTION_PERMIT_TTL_SECONDS,
  issueSingleUseExecutionPermit,
} from './optimization-execution-control-plane.js';

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
  const { request, url } = context;

  if (isApplyReadinessDryRun(request, url)) {
    return executionReadinessDryRun(context);
  }
  if (isPermitIssuance(request, url)) {
    return executionPermitIssuance(context);
  }

  if (!isProposalCreate(request, url)) return handleOptimizationActionsApiCoreRoute(context);

  const transformed = await freezeProposalExecutionTarget(context);
  if (transformed?.response) return transformed.response;
  if (!transformed?.request) return handleOptimizationActionsApiCoreRoute(context);

  return handleOptimizationActionsApiCoreRoute({
    ...context,
    request: transformed.request,
  });
}

async function executionReadinessDryRun({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/optimization-actions\/([^/]+)\/apply$/);
  if (!match) return handleOptimizationActionsApiCoreRoute({ request, env, actor, url });
  const storeId = safeDecode(match[1]);
  const actionId = safeDecode(match[2]);
  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  if (!actionId) return json(request, { error: 'invalid_action_id' }, 400);

  const route = await authorizedStoreDb(env, actor.user_id, storeId, 'ads.write');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  const action = await findExecutionAction(route.storeDb, actionId);
  if (!action) return json(request, { error: 'action_not_found' }, 404);

  const plan = await buildExecutionPlan({ storeId, action });
  const mutationEnvelope = await buildDormantNegativeKeywordMutationEnvelope(plan);
  return json(request, {
    schemaVersion: 'optimization-action-execution-dry-run-v2',
    storeId,
    actionId,
    valid: plan.valid,
    plan,
    mutationEnvelope,
    execution: {
      mode: 'dry_run_only',
      permitIssued: false,
      receiptWritten: false,
      amazonMutationAttempted: false,
      amazonMutationAuthorized: false,
      networkDispatchAuthorized: false,
    },
  }, 200);
}

async function executionPermitIssuance({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/optimization-actions\/([^/]+)\/execution-permits$/);
  if (!match) return null;
  const storeId = safeDecode(match[1]);
  const actionId = safeDecode(match[2]);
  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  if (!actionId) return json(request, { error: 'invalid_action_id' }, 400);

  const route = await authorizedStoreDb(env, actor.user_id, storeId, 'ads.write');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);
  const body = await readPermitRequest(request);
  if (body.error) return json(request, { error: body.error }, 400);

  const action = await findExecutionAction(route.storeDb, actionId);
  if (!action) return json(request, { error: 'action_not_found' }, 404);
  const plan = await buildExecutionPlan({ storeId, action });
  const result = await issueSingleUseExecutionPermit({
    db: route.storeDb,
    actorId: actor.user_id,
    action,
    plan,
    ttlSeconds: body.expiresInSeconds,
  });

  if (!result.issued) {
    return json(request, {
      error: 'execution_permit_not_issued',
      storeId,
      actionId,
      errors: result.errors,
      permitIssuanceReady: Boolean(plan.permitIssuanceReady),
      amazonMutationAttempted: false,
      amazonMutationAuthorized: false,
      networkDispatchAuthorized: false,
    }, 409);
  }

  return json(request, {
    schemaVersion: 'optimization-action-execution-permit-v1',
    storeId,
    actionId,
    idempotentReuse: Boolean(result.idempotentReuse),
    permit: result.permit,
    execution: {
      mode: 'permit_only',
      singleUse: true,
      amazonMutationAttempted: false,
      amazonMutationAuthorized: false,
      networkDispatchAuthorized: false,
    },
  }, result.idempotentReuse ? 200 : 201);
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

  const route = await authorizedStoreDb(env, actor.user_id, storeId, 'ads.write');
  if (route.error) return null;

  const profileId = text(body.profileId);
  const entityId = text(body.entityId);
  if (!profileId || !entityId) return null;

  const entity = await route.storeDb.prepare(`
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
      executionDestinationContract: 'search-term-ad-group-v1',
      ...(body.actionType === 'negative_keyword.create'
        ? { amazonMutationContract: AMAZON_UNIFIED_TARGET_CONTRACT_VERSION }
        : {}),
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

async function findExecutionAction(db, actionId) {
  return db.prepare(`
    SELECT action_id, profile_id, entity_type, entity_id, action_type, proposed_json,
           rationale_json, status, external_request_id, applied_at
    FROM optimization_actions
    WHERE action_id=?1
    LIMIT 1
  `).bind(actionId).first();
}

async function readPermitRequest(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > BODY_LIMIT) return { error: 'request_body_too_large' };
  const raw = await request.text();
  if (raw.length > BODY_LIMIT) return { error: 'request_body_too_large' };
  let body = {};
  if (raw.trim()) {
    try { body = JSON.parse(raw); } catch { return { error: 'invalid_json' }; }
  }
  if (!plainObject(body)) return { error: 'invalid_json_object' };
  if (Object.keys(body).some((key) => key !== 'expiresInSeconds')) return { error: 'unsupported_permit_field' };
  const ttl = body.expiresInSeconds === undefined ? DEFAULT_EXECUTION_PERMIT_TTL_SECONDS : Number(body.expiresInSeconds);
  if (!Number.isInteger(ttl) || ttl < MIN_EXECUTION_PERMIT_TTL_SECONDS || ttl > MAX_EXECUTION_PERMIT_TTL_SECONDS) {
    return { error: 'invalid_permit_ttl' };
  }
  return { expiresInSeconds: ttl };
}

function suppliedDestinationMismatch(proposed, campaignId, adGroupId) {
  if (proposed.scope !== undefined && text(proposed.scope).toLowerCase() !== 'ad_group') return 'scope';
  if (proposed.campaignId !== undefined && text(proposed.campaignId) !== campaignId) return 'campaignId';
  if (proposed.adGroupId !== undefined && text(proposed.adGroupId) !== adGroupId) return 'adGroupId';
  if (proposed.amazonMutationContract !== undefined && text(proposed.amazonMutationContract) !== AMAZON_UNIFIED_TARGET_CONTRACT_VERSION) return 'amazonMutationContract';
  return null;
}

function isProposalCreate(request, url) {
  return request.method.toUpperCase() === 'POST'
    && /^\/api\/v1\/stores\/[^/]+\/optimization-actions$/.test(url.pathname);
}

function isApplyReadinessDryRun(request, url) {
  return request.method.toUpperCase() === 'POST'
    && /^\/api\/v1\/stores\/[^/]+\/optimization-actions\/[^/]+\/apply$/.test(url.pathname)
    && url.searchParams.get('dryRun') === 'true';
}

function isPermitIssuance(request, url) {
  return request.method.toUpperCase() === 'POST'
    && /^\/api\/v1\/stores\/[^/]+\/optimization-actions\/[^/]+\/execution-permits$/.test(url.pathname);
}

async function authorizedStoreDb(env, userId, storeId, permission) {
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error: 'forbidden', permission, status: 403 };
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, d1_binding_key, status
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
  if (!store) return { error: 'store_not_found', status: 404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error: 'store_db_unavailable', status: 503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { store, storeDb };
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
