import {
  buildManualSyncRegistration,
  ContractError,
} from './sync-intent-contract.js';
import {
  registerAndTriggerSync,
  WebSyncOrchestrationError,
} from './web-sync-orchestration.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const START_ROUTE = /^\/api\/v1\/stores\/([^/]+)\/sync$/;
const STATUS_ROUTE = /^\/api\/v1\/stores\/([^/]+)\/sync\/([^/]+)$/;

export async function handleSyncApiRoute({ request, env, actor, url = new URL(request.url) }) {
  const startMatch = url.pathname.match(START_ROUTE);
  if (startMatch && request.method === 'POST') {
    return startStoreSync({ request, env, actor, storeId: decodeURIComponent(startMatch[1]) });
  }

  const statusMatch = url.pathname.match(STATUS_ROUTE);
  if (statusMatch && request.method === 'GET') {
    return storeSyncStatus({
      request,
      env,
      actor,
      storeId: decodeURIComponent(statusMatch[1]),
      instanceId: decodeURIComponent(statusMatch[2]),
    });
  }

  return null;
}

async function startStoreSync({ request, env, actor, storeId }) {
  const allowed = await actorHasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'sync.run');
  if (!allowed) return json(request, { error: 'forbidden', permission: 'sync.run' }, 403);

  // This remains the first producer-side guard. Disabled means no Store D1 registration and no Workflow call.
  if (env.SYNC_TRIGGER_ENABLED !== 'true') return json(request, { error: 'sync_trigger_disabled' }, 503);
  if (!env.AMAZON_SYNC_WORKFLOW) return json(request, { error: 'sync_workflow_not_bound' }, 503);

  const route = await authorizedStoreRoute(env, storeId);
  if (route.error) return json(request, { error: route.error }, route.status);
  if (route.store.status !== 'active') return json(request, { error: 'sync_store_not_active' }, 409);

  const body = await readJsonBody(request);
  if (body.error) return json(request, { error: body.error }, 400);

  const idempotencyKey = String(request.headers.get('idempotency-key') || '').trim();
  if (!idempotencyKey) return json(request, { error: 'idempotency_key_required' }, 400);

  let registration;
  try {
    registration = await buildManualSyncRegistration({
      storeId,
      actorUserId: actor.user_id,
      idempotencyKey,
      requestBody: body.value,
    });
  } catch (error) {
    if (error instanceof ContractError) return contractErrorResponse(request, error);
    throw error;
  }

  const repository = syncRunRepository(route.storeDb);

  try {
    const result = await registerAndTriggerSync({
      registration,
      repository,
      workflow: env.AMAZON_SYNC_WORKFLOW,
    });

    await writeAudit(env.CONTROL_DB, {
      actorUserId: actor.user_id,
      storeId,
      action: result.reused ? 'sync.reuse' : 'sync.start',
      entityType: 'workflow_instance',
      entityId: registration.instanceId,
      request,
      details: {
        datasets: registration.intent.datasets,
        startDate: registration.intent.startDate,
        endDate: registration.intent.endDate,
        triggerDecision: result.triggerDecision,
      },
    });

    return json(request, {
      instanceId: registration.instanceId,
      reused: result.reused,
      run: publicSyncRun(result.durableRun),
      workflow: result.workflow,
    }, result.reused ? 200 : 202);
  } catch (error) {
    if (error instanceof ContractError) return contractErrorResponse(request, error);
    if (error instanceof WebSyncOrchestrationError && error.code === 'WORKFLOW_TRIGGER_RECEIPT_UNAVAILABLE') {
      return json(request, {
        error: error.code,
        instanceId: registration.instanceId,
        retryableWithSameIdempotencyKey: true,
      }, 503);
    }
    throw error;
  }
}

async function storeSyncStatus({ request, env, actor, storeId, instanceId }) {
  const allowed = await actorHasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'sync.read');
  if (!allowed) return json(request, { error: 'forbidden', permission: 'sync.read' }, 403);
  if (!validWorkflowId(instanceId)) return json(request, { error: 'sync_instance_id_invalid' }, 400);

  const route = await authorizedStoreRoute(env, storeId);
  if (route.error) return json(request, { error: route.error }, route.status);

  const run = await route.storeDb.prepare(`
    SELECT run_id, profile_id, trigger_type, scope_key, status, started_at, completed_at,
           error_summary, created_at
    FROM sync_runs
    WHERE run_id = ?1
    LIMIT 1
  `).bind(instanceId).first();
  if (!run) return json(request, { error: 'sync_run_not_found' }, 404);

  const workflow = env.AMAZON_SYNC_WORKFLOW
    ? await getWorkflowStatusSafe(env.AMAZON_SYNC_WORKFLOW, instanceId)
    : { status: 'unknown', hasError: false, rollbackOutcome: null };

  return json(request, { instanceId, run: publicSyncRun(run), workflow }, 200);
}

function syncRunRepository(db) {
  return {
    async insertQueuedRun(input) {
      await db.prepare(`
        INSERT INTO sync_runs(
          run_id, profile_id, trigger_type, scope_key, status, requested_by, intent_fingerprint, created_at
        ) VALUES(?1, NULL, ?2, ?3, 'queued', ?4, ?5, CURRENT_TIMESTAMP)
        ON CONFLICT(run_id) DO NOTHING
      `).bind(
        input.runId,
        input.triggerType,
        input.scopeKey,
        input.requestedBy,
        input.intentFingerprint,
      ).run();
    },

    async loadRun(runId) {
      return db.prepare(`
        SELECT run_id, profile_id, trigger_type, scope_key, status, requested_by,
               intent_fingerprint, started_at, completed_at, error_summary, created_at
        FROM sync_runs
        WHERE run_id = ?1
        LIMIT 1
      `).bind(runId).first();
    },
  };
}

async function authorizedStoreRoute(env, storeId) {
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, store_code, display_name, marketplace_code, amazon_region,
           d1_binding_key, status
    FROM stores
    WHERE store_id = ?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
  if (!store) return { error: 'store_not_found', status: 404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error: 'store_db_unavailable', status: 503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { store, storeDb };
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

function contractErrorResponse(request, error) {
  const conflictCodes = new Set([
    'IDEMPOTENCY_KEY_REUSE_CONFLICT',
    'IDEMPOTENCY_RECEIPT_UNVERIFIABLE',
    'SYNC_RUN_ID_MISMATCH',
    'SYNC_RUN_ACTOR_MISMATCH',
    'SYNC_RUN_TRIGGER_TYPE_MISMATCH',
    'SYNC_QUEUED_PROFILE_RECEIPT_INVALID',
    'SYNC_RUNNING_PROFILE_RECEIPT_MISSING',
  ]);
  const status = conflictCodes.has(error.code) ? 409 : 400;
  return json(request, { error: error.code }, status);
}

function validWorkflowId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(value);
}

async function getWorkflowStatusSafe(binding, instanceId) {
  try {
    const instance = await binding.get(instanceId);
    return publicWorkflowStatus(await instance.status());
  } catch {
    return { status: 'unknown', hasError: false, rollbackOutcome: null };
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
    profileId: run.profile_id || null,
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
