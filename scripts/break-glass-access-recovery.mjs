import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ENVIRONMENTS = new Set(['dev', 'production']);
const RECOVERY_ACTION = 'security.break_glass.access_subject_rebind';

export function validateAccessRecoveryInput(input = {}) {
  const environment = requiredEnum(input.environment, ENVIRONMENTS, 'break_glass_environment_invalid');
  const userId = requiredBounded(input.userId, 1, 160, 'break_glass_user_id_invalid');
  const expectedEmailNorm = normalizeEmail(input.expectedEmail);
  const newCfAccessSub = requiredBounded(input.newCfAccessSub, 1, 255, 'break_glass_new_access_sub_invalid');
  const operatorIdentity = requiredBounded(input.operatorIdentity, 3, 200, 'break_glass_operator_invalid');
  const reason = requiredBounded(input.reason, 12, 1000, 'break_glass_reason_invalid');
  const ticket = requiredBounded(input.ticket, 3, 160, 'break_glass_ticket_invalid');
  const execute = input.execute === true;
  const confirmation = String(input.confirmation ?? '').trim();
  const productionConfirmation = String(input.productionConfirmation ?? '').trim();

  return Object.freeze({
    environment,
    userId,
    expectedEmailNorm,
    newCfAccessSub,
    operatorIdentity,
    reason,
    ticket,
    execute,
    confirmation,
    productionConfirmation,
  });
}

export async function loadOwnerRecoveryTarget(db, userId, expectedEmailNorm) {
  requireDatabase(db);
  const row = await db.prepare(`
    SELECT
      u.user_id,
      u.email_norm,
      u.cf_access_sub,
      u.status
    FROM users u
    JOIN user_global_roles ugr
      ON ugr.user_id=u.user_id
     AND ugr.role_key='owner'
    JOIN app_roles ar
      ON ar.role_key=ugr.role_key
     AND ar.role_scope='global'
    WHERE u.user_id=?1
      AND u.email_norm=?2
      AND u.status='active'
    LIMIT 1
  `).bind(userId, expectedEmailNorm).first();

  if (!row) throw new Error('break_glass_active_owner_target_not_found');
  const currentSub = String(row.cf_access_sub ?? '').trim();
  if (!currentSub) throw new Error('break_glass_current_subject_required');
  return Object.freeze({
    userId: String(row.user_id),
    emailNorm: String(row.email_norm),
    currentCfAccessSub: currentSub,
    status: String(row.status),
  });
}

export function buildAccessRecoveryPlan(input, target, options = {}) {
  const recoveryId = requiredBounded(
    options.recoveryId ?? crypto.randomUUID(),
    16,
    160,
    'break_glass_recovery_id_invalid',
  );
  if (target.userId !== input.userId || target.emailNorm !== input.expectedEmailNorm || target.status !== 'active') {
    throw new Error('break_glass_target_state_invalid');
  }
  if (target.currentCfAccessSub === input.newCfAccessSub) {
    throw new Error('break_glass_subject_noop_forbidden');
  }
  return Object.freeze({
    recoveryId,
    environment: input.environment,
    targetUserId: input.userId,
    expectedEmailNorm: input.expectedEmailNorm,
    expectedPreviousCfAccessSub: target.currentCfAccessSub,
    newCfAccessSub: input.newCfAccessSub,
    operatorIdentity: input.operatorIdentity,
    reason: input.reason,
    ticket: input.ticket,
    confirmationRequired: recoveryConfirmation(input.userId, input.ticket),
    productionConfirmationRequired: productionRecoveryConfirmation(input.userId, input.ticket),
  });
}

export async function executeAccessRecovery(options = {}) {
  const db = options.db;
  requireDatabase(db);
  const input = validateAccessRecoveryInput(options.input);
  const target = await loadOwnerRecoveryTarget(db, input.userId, input.expectedEmailNorm);
  const plan = buildAccessRecoveryPlan(input, target, { recoveryId: options.recoveryId });

  if (!input.execute) {
    return Object.freeze({ ok: true, executed: false, plan: safePlan(plan) });
  }

  enforceExecutionConfirmations(input, plan, options.env ?? process.env);

  // Deliberately one D1 statement: 0006 DB triggers revalidate exact owner state,
  // update the Access subject, and append the audit event in the same SQLite statement transaction.
  await db.prepare(`
    INSERT INTO access_recovery_events(
      recovery_id,target_user_id,expected_email_norm,expected_previous_cf_access_sub,
      new_cf_access_sub,operator_identity,reason,ticket
    ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
  `).bind(
    plan.recoveryId,
    plan.targetUserId,
    plan.expectedEmailNorm,
    plan.expectedPreviousCfAccessSub,
    plan.newCfAccessSub,
    plan.operatorIdentity,
    plan.reason,
    plan.ticket,
  ).run();

  const [user, recovery, audit] = await Promise.all([
    db.prepare(`
      SELECT user_id,email_norm,cf_access_sub,status
      FROM users WHERE user_id=?1 LIMIT 1
    `).bind(plan.targetUserId).first(),
    db.prepare(`
      SELECT recovery_id,target_user_id,expected_previous_cf_access_sub,new_cf_access_sub,
             operator_identity,reason,ticket
      FROM access_recovery_events WHERE recovery_id=?1 LIMIT 1
    `).bind(plan.recoveryId).first(),
    db.prepare(`
      SELECT event_id,actor_user_id,action,entity_type,entity_id,request_id,details_json
      FROM audit_log WHERE event_id=?1 LIMIT 1
    `).bind(plan.recoveryId).first(),
  ]);

  assertRecoveryPostflight({ user, recovery, audit, plan });
  return Object.freeze({
    ok: true,
    executed: true,
    recoveryId: plan.recoveryId,
    environment: plan.environment,
    targetUserId: plan.targetUserId,
    ticket: plan.ticket,
    auditAction: RECOVERY_ACTION,
  });
}

export function recoveryConfirmation(userId, ticket) {
  return `REBIND:${userId}:${ticket}`;
}

export function productionRecoveryConfirmation(userId, ticket) {
  return `PRODUCTION-REBIND:${userId}:${ticket}`;
}

export function parseBreakGlassCliArgs(argv = []) {
  const values = new Map();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === '--execute') {
      execute = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`break_glass_cli_argument_invalid:${token}`);
    const key = token.slice(2);
    if (key === 'api-token') throw new Error('break_glass_api_token_cli_forbidden');
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith('--')) {
      throw new Error(`break_glass_cli_value_required:${key}`);
    }
    if (values.has(key)) throw new Error(`break_glass_cli_duplicate_argument:${key}`);
    values.set(key, String(value));
    index += 1;
  }

  const allowed = new Set([
    'environment', 'account-id', 'database-id', 'user-id', 'expected-email',
    'new-access-sub', 'operator', 'reason', 'ticket', 'confirm', 'production-confirm',
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`break_glass_cli_argument_unsupported:${key}`);
  }

  return Object.freeze({
    connection: Object.freeze({
      accountId: values.get('account-id') || null,
      databaseId: values.get('database-id') || null,
    }),
    input: Object.freeze({
      environment: values.get('environment'),
      userId: values.get('user-id'),
      expectedEmail: values.get('expected-email'),
      newCfAccessSub: values.get('new-access-sub'),
      operatorIdentity: values.get('operator'),
      reason: values.get('reason'),
      ticket: values.get('ticket'),
      confirmation: values.get('confirm') || '',
      productionConfirmation: values.get('production-confirm') || '',
      execute,
    }),
  });
}

function enforceExecutionConfirmations(input, plan, env) {
  if (input.confirmation !== plan.confirmationRequired) {
    throw new Error('break_glass_confirmation_mismatch');
  }
  if (input.environment === 'production') {
    if (String(env?.BREAK_GLASS_PRODUCTION_ENABLED ?? '') !== '1') {
      throw new Error('break_glass_production_disabled');
    }
    if (input.productionConfirmation !== plan.productionConfirmationRequired) {
      throw new Error('break_glass_production_confirmation_mismatch');
    }
  }
}

function assertRecoveryPostflight({ user, recovery, audit, plan }) {
  const auditDetails = parseJsonObject(audit?.details_json);
  const ok = Boolean(user)
    && user.user_id === plan.targetUserId
    && user.email_norm === plan.expectedEmailNorm
    && user.status === 'active'
    && user.cf_access_sub === plan.newCfAccessSub
    && recovery?.recovery_id === plan.recoveryId
    && recovery?.target_user_id === plan.targetUserId
    && recovery?.expected_previous_cf_access_sub === plan.expectedPreviousCfAccessSub
    && recovery?.new_cf_access_sub === plan.newCfAccessSub
    && recovery?.operator_identity === plan.operatorIdentity
    && recovery?.reason === plan.reason
    && recovery?.ticket === plan.ticket
    && audit?.event_id === plan.recoveryId
    && audit?.actor_user_id == null
    && audit?.action === RECOVERY_ACTION
    && audit?.entity_type === 'user'
    && audit?.entity_id === plan.targetUserId
    && audit?.request_id === plan.recoveryId
    && auditDetails?.recoveryId === plan.recoveryId
    && auditDetails?.targetUserId === plan.targetUserId
    && auditDetails?.previousCfAccessSub === plan.expectedPreviousCfAccessSub
    && auditDetails?.newCfAccessSub === plan.newCfAccessSub
    && auditDetails?.operatorIdentity === plan.operatorIdentity
    && auditDetails?.ticket === plan.ticket
    && auditDetails?.controlPlane === 'break-glass-cli'
    && auditDetails?.globalRoleChanged === false;
  if (!ok) throw new Error('break_glass_postflight_verification_failed');
}

function safePlan(plan) {
  return Object.freeze({
    recoveryId: plan.recoveryId,
    environment: plan.environment,
    targetUserId: plan.targetUserId,
    expectedEmailNorm: plan.expectedEmailNorm,
    expectedPreviousCfAccessSub: plan.expectedPreviousCfAccessSub,
    newCfAccessSub: plan.newCfAccessSub,
    operatorIdentity: plan.operatorIdentity,
    reason: plan.reason,
    ticket: plan.ticket,
    confirmationRequired: plan.confirmationRequired,
    ...(plan.environment === 'production'
      ? { productionConfirmationRequired: plan.productionConfirmationRequired }
      : {}),
  });
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEmail(value) {
  const email = requiredBounded(value, 3, 320, 'break_glass_expected_email_invalid').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('break_glass_expected_email_invalid');
  return email;
}

function requiredBounded(value, min, max, code) {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(code);
  return text;
}

function requiredEnum(value, allowed, code) {
  const text = String(value ?? '').trim();
  if (!allowed.has(text)) throw new Error(code);
  return text;
}

function requireDatabase(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('break_glass_database_required');
}

async function runCli() {
  const parsed = parseBreakGlassCliArgs(process.argv.slice(2));
  const accountId = parsed.connection.accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = parsed.connection.databaseId || process.env.CONTROL_D1_DATABASE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const db = createD1RestDatabase({ accountId, databaseId, apiToken });
  const result = await executeAccessRecovery({ db, input: parsed.input, env: process.env });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await runCli();
}
