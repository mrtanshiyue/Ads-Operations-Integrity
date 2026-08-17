import { validatePermitBinding } from './amazon-action-execution-safety.js';

export const EXECUTION_PERMIT_SCHEMA_VERSION = 'optimization-execution-permit-v1';
export const DEFAULT_EXECUTION_PERMIT_TTL_SECONDS = 300;
export const MIN_EXECUTION_PERMIT_TTL_SECONDS = 60;
export const MAX_EXECUTION_PERMIT_TTL_SECONDS = 900;

export async function issueSingleUseExecutionPermit({
  db,
  actorId,
  action,
  plan,
  ttlSeconds = DEFAULT_EXECUTION_PERMIT_TTL_SECONDS,
  now = new Date(),
} = {}) {
  const errors = permitIssuanceErrors({ db, actorId, action, plan });
  if (errors.length) return freeze({ issued: false, errors, networkDispatchAuthorized: false });

  const ttl = normalizeTtl(ttlSeconds);
  if (!ttl) return freeze({ issued: false, errors: ['invalid_permit_ttl'], networkDispatchAuthorized: false });
  const issuedAt = normalizeNow(now);
  if (!issuedAt) return freeze({ issued: false, errors: ['invalid_permit_clock'], networkDispatchAuthorized: false });
  const expiresAt = new Date(Date.parse(issuedAt) + ttl * 1000).toISOString();

  await expireStaleIssuedPermit(db, plan.action.actionId, issuedAt);
  const existing = await findIssuedPermit(db, plan.action.actionId);
  if (existing) {
    const sameBinding = permitMatchesPlan(existing, plan);
    return freeze({
      issued: sameBinding,
      idempotentReuse: sameBinding,
      errors: sameBinding ? [] : ['issued_permit_binding_conflict'],
      permit: sameBinding ? publicPermit(existing) : null,
      networkDispatchAuthorized: false,
    });
  }

  const permitId = `execp_${crypto.randomUUID()}`;
  try {
    await db.prepare(`
      INSERT INTO optimization_execution_permits(
        permit_id, action_id, transition, profile_id, entity_type, entity_id, action_type,
        request_fingerprint, target_fingerprint, execution_fingerprint, state,
        issued_by, issued_at, expires_at, created_at
      ) VALUES(?1,?2,'apply',?3,?4,?5,?6,?7,?8,?9,'issued',?10,?11,?12,?11)
    `).bind(
      permitId,
      plan.action.actionId,
      plan.action.profileId,
      actionText(action, 'entityType', 'entity_type'),
      plan.action.entityId,
      plan.action.actionType,
      plan.requestFingerprint,
      plan.targetFingerprint,
      plan.executionFingerprint,
      text(actorId),
      issuedAt,
      expiresAt,
    ).run();
  } catch (error) {
    const raced = await findIssuedPermit(db, plan.action.actionId);
    if (raced && permitMatchesPlan(raced, plan)) {
      return freeze({
        issued: true,
        idempotentReuse: true,
        errors: [],
        permit: publicPermit(raced),
        networkDispatchAuthorized: false,
      });
    }
    throw error;
  }

  const row = await findPermit(db, permitId);
  return freeze({
    issued: true,
    idempotentReuse: false,
    errors: [],
    permit: publicPermit(row),
    networkDispatchAuthorized: false,
  });
}

export async function consumeSingleUseExecutionPermit({ db, actorId, permitId, plan, now = new Date() } = {}) {
  if (!db) return freeze({ consumed: false, errors: ['store_db_required'], networkDispatchAuthorized: false });
  if (!text(actorId)) return freeze({ consumed: false, errors: ['actor_id_required'], networkDispatchAuthorized: false });
  if (!text(permitId)) return freeze({ consumed: false, errors: ['permit_id_required'], networkDispatchAuthorized: false });

  const row = await findPermit(db, permitId);
  if (!row) return freeze({ consumed: false, errors: ['permit_not_found'], networkDispatchAuthorized: false });
  const binding = validatePermitBinding({ permit: row, plan, now });
  if (!binding.valid) {
    return freeze({ consumed: false, errors: binding.errors, permit: publicPermit(row), networkDispatchAuthorized: false });
  }

  const consumedAt = normalizeNow(now);
  if (!consumedAt) return freeze({ consumed: false, errors: ['invalid_permit_clock'], networkDispatchAuthorized: false });
  const result = await db.prepare(`
    UPDATE optimization_execution_permits
    SET state='consumed', consumed_at=?2, consumed_by=?3
    WHERE permit_id=?1 AND state='issued' AND expires_at>?2
  `).bind(text(permitId), consumedAt, text(actorId)).run();
  if (changedRows(result) !== 1) {
    const current = await findPermit(db, permitId);
    return freeze({
      consumed: false,
      errors: ['permit_consumption_conflict'],
      permit: publicPermit(current),
      networkDispatchAuthorized: false,
    });
  }

  return freeze({
    consumed: true,
    errors: [],
    permit: publicPermit(await findPermit(db, permitId)),
    networkDispatchAuthorized: false,
  });
}

export async function findPermit(db, permitId) {
  if (!db || !text(permitId)) return null;
  return db.prepare(`
    SELECT permit_id, action_id, transition, profile_id, entity_type, entity_id, action_type,
           request_fingerprint, target_fingerprint, execution_fingerprint, state,
           issued_by, issued_at, expires_at, consumed_at, consumed_by,
           revoked_at, revoked_by, revoke_reason, created_at
    FROM optimization_execution_permits
    WHERE permit_id=?1
    LIMIT 1
  `).bind(text(permitId)).first();
}

function permitIssuanceErrors({ db, actorId, action, plan }) {
  const errors = [];
  if (!db) errors.push('store_db_required');
  if (!text(actorId)) errors.push('actor_id_required');
  if (!action || typeof action !== 'object') errors.push('action_required');
  if (!plan?.valid) errors.push('valid_execution_plan_required');
  if (plan?.action?.status !== 'approved') errors.push('approved_action_required');
  if (plan?.action?.actionType !== 'negative_keyword.create') errors.push('permit_action_type_not_enabled');
  if (!plan?.permitIssuanceReady) errors.push(plan?.mutation?.blockingReason || 'permit_issuance_not_ready');
  if (!text(plan?.action?.profileId)) errors.push('profile_id_required');
  if (!text(plan?.action?.entityId)) errors.push('entity_id_required');
  if (!text(actionText(action, 'entityType', 'entity_type'))) errors.push('entity_type_required');
  if (!hex64(plan?.requestFingerprint)) errors.push('request_fingerprint_required');
  if (!hex64(plan?.targetFingerprint)) errors.push('target_fingerprint_required');
  if (!hex64(plan?.executionFingerprint)) errors.push('execution_fingerprint_required');
  if (plan?.networkDispatchAuthorized !== false) errors.push('invalid_execution_authority_contract');
  return unique(errors);
}

async function expireStaleIssuedPermit(db, actionId, nowIso) {
  await db.prepare(`
    UPDATE optimization_execution_permits
    SET state='expired'
    WHERE action_id=?1 AND transition='apply' AND state='issued' AND expires_at<=?2
  `).bind(text(actionId), nowIso).run();
}

async function findIssuedPermit(db, actionId) {
  return db.prepare(`
    SELECT permit_id, action_id, transition, profile_id, entity_type, entity_id, action_type,
           request_fingerprint, target_fingerprint, execution_fingerprint, state,
           issued_by, issued_at, expires_at, consumed_at, consumed_by,
           revoked_at, revoked_by, revoke_reason, created_at
    FROM optimization_execution_permits
    WHERE action_id=?1 AND transition='apply' AND state='issued'
    LIMIT 1
  `).bind(text(actionId)).first();
}

function permitMatchesPlan(permit, plan) {
  return text(permit?.action_id) === text(plan?.action?.actionId)
    && text(permit?.transition) === 'apply'
    && text(permit?.profile_id) === text(plan?.action?.profileId)
    && text(permit?.entity_id) === text(plan?.action?.entityId)
    && text(permit?.action_type) === text(plan?.action?.actionType)
    && text(permit?.request_fingerprint) === text(plan?.requestFingerprint)
    && text(permit?.target_fingerprint) === text(plan?.targetFingerprint)
    && text(permit?.execution_fingerprint) === text(plan?.executionFingerprint);
}

function publicPermit(row) {
  if (!row) return null;
  return freeze({
    schemaVersion: EXECUTION_PERMIT_SCHEMA_VERSION,
    permitId: row.permit_id,
    actionId: row.action_id,
    transition: row.transition,
    profileId: row.profile_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actionType: row.action_type,
    requestFingerprint: row.request_fingerprint,
    targetFingerprint: row.target_fingerprint,
    executionFingerprint: row.execution_fingerprint,
    state: row.state,
    issuedBy: row.issued_by,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at || null,
    consumedBy: row.consumed_by || null,
    singleUse: true,
    networkDispatchAuthorized: false,
  });
}

function normalizeTtl(value) {
  const ttl = Number(value);
  return Number.isInteger(ttl) && ttl >= MIN_EXECUTION_PERMIT_TTL_SECONDS && ttl <= MAX_EXECUTION_PERMIT_TTL_SECONDS ? ttl : null;
}
function normalizeNow(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function actionText(action, camel, snake) { return text(action?.[camel] ?? action?.[snake]); }
function changedRows(result) { return Number(result?.meta?.changes ?? result?.changes ?? 0); }
function hex64(value) { return /^[a-f0-9]{64}$/i.test(text(value)); }
function text(value) { return String(value ?? '').trim(); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function freeze(value) { return Object.freeze(value); }
