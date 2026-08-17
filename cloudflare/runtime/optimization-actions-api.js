const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const ACTION_STATUSES = new Set(['proposed', 'approved', 'rejected', 'applying', 'applied', 'failed', 'reverted']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function handleOptimizationActionsApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/optimization-actions(?:\/([^/]+))?(?:\/(apply|revert))?$/);
  if (!match) return null;

  const storeId = decodeURIComponent(match[1]);
  const actionId = match[2] ? decodeURIComponent(match[2]) : null;
  const transition = match[3] || null;
  const method = request.method.toUpperCase();
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, 'ads.read');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  if (method === 'GET' && !actionId) return listActions(request, route.storeDb, url, storeId);
  if (method === 'GET' && actionId && !transition) return actionDetail(request, route.storeDb, actionId, storeId);
  if (method === 'POST' && actionId && transition) return executionDisabled(request, route.storeDb, actionId, transition, storeId);
  return json(request, { error: 'method_not_allowed' }, 405, { allow: actionId ? 'GET, POST' : 'GET' });
}

async function listActions(request, db, url, storeId) {
  const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return json(request, { error: 'invalid_limit' }, 400);
  const status = optionalText(url.searchParams.get('status'), 40);
  if (status && !ACTION_STATUSES.has(status)) return json(request, { error: 'invalid_status' }, 400);
  const actionType = optionalText(url.searchParams.get('actionType'), 120);
  const entityType = optionalText(url.searchParams.get('entityType'), 80);
  const profileId = optionalText(url.searchParams.get('profileId'), 200);

  const result = await db.prepare(`
    SELECT action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
           source_type, rule_key, before_json, proposed_json, rationale_json, status,
           created_by, approved_by, external_request_id, applied_at, created_at, updated_at
    FROM optimization_actions
    WHERE (?1 IS NULL OR status=?1)
      AND (?2 IS NULL OR action_type=?2)
      AND (?3 IS NULL OR entity_type=?3)
      AND (?4 IS NULL OR profile_id=?4)
    ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
             created_at DESC, action_id DESC
    LIMIT ?5
  `).bind(status, actionType, entityType, profileId, limit).all();

  return json(request, {
    schemaVersion: 'optimization-action-read-v1',
    storeId,
    execution: { enabled: false, phase: 11, amazonMutationAuthorized: false },
    filters: { status, actionType, entityType, profileId, limit },
    items: (result.results || []).map(publicAction),
  }, 200);
}

async function actionDetail(request, db, actionId, storeId) {
  const action = await findAction(db, actionId);
  if (!action) return json(request, { error: 'action_not_found' }, 404);
  const events = await db.prepare(`
    SELECT event_id, action_id, event_type, actor_id, details_json, occurred_at
    FROM optimization_action_events
    WHERE action_id=?1
    ORDER BY occurred_at, event_id
  `).bind(actionId).all();

  return json(request, {
    schemaVersion: 'optimization-action-detail-v1',
    storeId,
    action: publicAction(action),
    events: (events.results || []).map((event) => ({
      eventId: event.event_id,
      actionId: event.action_id,
      eventType: event.event_type,
      actorId: event.actor_id || null,
      details: parseJson(event.details_json),
      occurredAt: event.occurred_at,
    })),
    transitionEligibility: {
      approve: false,
      reject: false,
      apply: false,
      revert: false,
      reason: 'phase8_read_only_preview',
    },
    execution: { enabled: false, phase: 11, amazonMutationAuthorized: false },
  }, 200);
}

async function executionDisabled(request, db, actionId, transition, storeId) {
  const action = await findAction(db, actionId);
  if (!action) return json(request, { error: 'action_not_found' }, 404);
  return json(request, {
    error: 'action_execution_disabled',
    storeId,
    actionId,
    requestedTransition: transition,
    currentStatus: action.status,
    requiredPhase: 11,
    amazonMutationAttempted: false,
    amazonMutationAuthorized: false,
  }, 409);
}

async function findAction(db, actionId) {
  if (!actionId || actionId.length > 240) return null;
  return db.prepare(`
    SELECT action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
           source_type, rule_key, before_json, proposed_json, rationale_json, status,
           created_by, approved_by, external_request_id, applied_at, created_at, updated_at
    FROM optimization_actions WHERE action_id=?1 LIMIT 1
  `).bind(actionId).first();
}

function publicAction(row) {
  return {
    actionId: row.action_id,
    idempotencyKey: row.idempotency_key,
    profileId: row.profile_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actionType: row.action_type,
    sourceType: row.source_type,
    ruleKey: row.rule_key || null,
    before: parseJson(row.before_json),
    proposed: parseJson(row.proposed_json),
    rationale: parseJson(row.rationale_json),
    status: row.status,
    createdBy: row.created_by || null,
    approvedBy: row.approved_by || null,
    externalRequestId: row.external_request_id || null,
    appliedAt: row.applied_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    executionAuthorized: false,
  };
}

async function authorizedStoreRoute(env, userId, storeId, permission) {
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error: 'forbidden', permission, status: 403 };
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, d1_binding_key, status
    FROM stores WHERE store_id=?1 AND status <> 'disabled' LIMIT 1
  `).bind(storeId).first();
  if (!store) return { error: 'store_not_found', status: 404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error: 'store_db_unavailable', status: 503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { store, storeDb };
}

async function hasStorePermission(db, userId, storeId, permission) {
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

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return { parseError: true }; }
}
function optionalText(value, max) { const out = String(value || '').trim(); return out ? out.slice(0, max) : null; }
function json(request, payload, status, extraHeaders = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  const ray = request.headers.get('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status, headers });
}
