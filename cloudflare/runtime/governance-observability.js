const EVENT_ACTIONS = Object.freeze({
  duplicate_suppression: 'optimization_action.observability.duplicate_suppression',
  already_governed_suppression: 'optimization_action.observability.already_governed_suppression',
  fingerprint_conflict: 'optimization_action.observability.fingerprint_conflict',
  governance_error: 'optimization_action.observability.governance_error',
});

const FINGERPRINT_CONFLICT_ERRORS = new Set([
  'idempotency_conflict',
  'recommendation_fingerprint_mismatch',
]);

export async function recordGovernanceObservabilityEvent({
  env,
  request,
  actorUserId = null,
  storeId,
  eventType,
  count = 1,
  entityId = null,
  details = {},
}) {
  const action = EVENT_ACTIONS[eventType];
  if (!action) throw new Error(`unsupported_governance_observability_event:${eventType}`);
  if (!env?.CONTROL_DB) throw new Error('control_db_not_bound');
  const normalizedStoreId = text(storeId, 200);
  if (!normalizedStoreId) throw new Error('store_id_required');
  const normalizedCount = positiveInt(count);
  const requestId = request?.headers?.get?.('cf-ray') || crypto.randomUUID();
  const cfRay = request?.headers?.get?.('cf-ray') || null;
  const payload = {
    schemaVersion: 'governance-observability-event-v1',
    eventType,
    count: normalizedCount,
    amazonMutationAttempted: false,
    amazonMutationAuthorized: false,
    ...(plainObject(details) ? details : {}),
  };

  await env.CONTROL_DB.prepare(`
    INSERT INTO audit_log(
      event_id, actor_user_id, store_id, action, entity_type, entity_id,
      request_id, cf_ray, details_json
    ) VALUES(?1,?2,?3,?4,'optimization_action_observability',?5,?6,?7,?8)
  `).bind(
    crypto.randomUUID(),
    actorUserId || null,
    normalizedStoreId,
    action,
    text(entityId, 240),
    requestId,
    cfRay,
    JSON.stringify(payload),
  ).run();

  return { recorded: true, action, count: normalizedCount };
}

export async function bestEffortGovernanceObservability(input) {
  try {
    return await recordGovernanceObservabilityEvent(input);
  } catch (error) {
    console.error('governance_observability_write_error', {
      storeId: input?.storeId || null,
      eventType: input?.eventType || null,
      message: error?.message || String(error),
    });
    return { recorded: false, error: error?.message || String(error) };
  }
}

export async function observeOptimizationActionResponse({ request, response, env, actor, url, ctx }) {
  if (!response || request.method.toUpperCase() !== 'POST' || response.status !== 409) return response;
  const payload = await response.clone().json().catch(() => null);
  if (!payload || !FINGERPRINT_CONFLICT_ERRORS.has(payload.error)) return response;
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/optimization-actions/);
  const storeId = match ? safeDecode(match[1]) : null;
  if (!storeId) return response;

  const write = bestEffortGovernanceObservability({
    env,
    request,
    actorUserId: actor?.user_id || null,
    storeId,
    eventType: 'fingerprint_conflict',
    entityId: payload.existingActionId || payload.computedFingerprint || null,
    details: {
      conflictType: payload.error,
      idempotencyKey: payload.idempotencyKey || null,
      existingActionId: payload.existingActionId || null,
      existingStatus: payload.existingStatus || null,
      suppliedFingerprint: payload.suppliedFingerprint || null,
      computedFingerprint: payload.computedFingerprint || null,
      requestFingerprint: payload.requestFingerprint || null,
      existingRequestFingerprint: payload.existingRequestFingerprint || null,
    },
  });
  schedule(ctx, write);
  if (!ctx?.waitUntil) await write;
  return response;
}

export function scheduleGovernanceObservability(ctx, promise) {
  schedule(ctx, promise);
  return promise;
}

function schedule(ctx, promise) {
  if (ctx?.waitUntil) ctx.waitUntil(promise);
}

function positiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(10000, Math.max(1, Math.floor(parsed)));
}
function text(value, max) {
  const out = String(value ?? '').trim();
  return out ? out.slice(0, max) : null;
}
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function safeDecode(value) { try { return decodeURIComponent(value); } catch { return null; } }
