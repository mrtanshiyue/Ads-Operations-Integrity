import assert from 'node:assert/strict';
import { createTestHarness } from 'wrangler';
import { handleGlobalRoleGovernanceApiRoute } from '../cloudflare/runtime/global-role-governance-api.js';
import { handleUserLifecycleApiRoute } from '../cloudflare/runtime/user-lifecycle-api.js';
import {
  executeAccessRecovery,
  recoveryConfirmation,
} from './break-glass-access-recovery.mjs';

// Pure CLI safety contracts run in the same canonical security step before workerd starts.
await import('./test-break-glass-access-recovery.mjs');

const server = createTestHarness({
  workers: [{ configPath: './cloudflare/runtime/wrangler.security-test.jsonc' }],
});

await server.listen();
try {
  const worker = server.getWorker('ads-operations-security-test');
  await worker.applyD1Migrations('CONTROL_DB');
  const env = await worker.getEnv();
  const db = env.CONTROL_DB;

  await seed(db);
  await assertMigrationState(db);
  await assertDatabaseGuards(db);
  await assertAccessRecoveryAtomicity(db);
  await assertBreakGlassCliIntegration(db);
  await assertGlobalRoleAtomicity(db);
  await assertLifecycleAtomicity(db);

  console.log(JSON.stringify({
    ok: true,
    module: 'security-integrity-real-d1-harness',
    runtime: 'cloudflare-createTestHarness',
    controlMigrationsApplied: true,
    dbInvariantsVerified: true,
    accessRecoveryAuditRollbackVerified: true,
    accessRecoverySuccessVerified: true,
    accessRecoveryLedgerImmutableVerified: true,
    breakGlassCliDryRunVerified: true,
    breakGlassCliAuditRollbackVerified: true,
    breakGlassCliPostflightVerified: true,
    globalRoleGrantRollbackVerified: true,
    globalRoleRevokeRollbackVerified: true,
    lifecycleRollbackVerified: true,
    successfulAuditCommitVerified: true,
    remoteD1Touched: false,
  }));
} finally {
  await server.close();
}

async function seed(db) {
  const users = [
    ['owner-a', 'sub-owner-a', 'owner-a@example.invalid', 'Owner A'],
    ['admin-a', 'sub-admin-a', 'admin-a@example.invalid', 'Admin A'],
    ['target-role', 'sub-target-role', 'target-role@example.invalid', 'Target Role'],
    ['target-lifecycle', 'sub-target-lifecycle', 'target-lifecycle@example.invalid', 'Target Lifecycle'],
    ['scope-test', 'sub-scope-test', 'scope-test@example.invalid', 'Scope Test'],
  ];
  for (const [userId, sub, email, displayName] of users) {
    await db.prepare(`
      INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status)
      VALUES(?1,?2,?3,?3,?4,'active')
    `).bind(userId, sub, email, displayName).run();
  }
  await db.prepare(`
    INSERT INTO stores(store_id,store_code,display_name,d1_binding_key,status)
    VALUES('store-security-test','SECURITY','Security Test Store','STORE_TEST_DB','active')
  `).run();
  await db.prepare(`
    INSERT INTO user_global_roles(user_id,role_key,granted_by)
    VALUES('owner-a','owner','owner-a')
  `).run();
  await db.prepare(`
    INSERT INTO user_global_roles(user_id,role_key,granted_by)
    VALUES('admin-a','admin','owner-a')
  `).run();
}

async function assertMigrationState(db) {
  const migration = await db.prepare(`
    SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1
  `).first();
  assert.equal(migration?.name, '0006_control_access_recovery.sql');

  const index = await db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='index' AND name='ux_user_global_roles_single_role'
  `).first();
  assert.equal(index?.name, 'ux_user_global_roles_single_role');

  const requiredTriggers = [
    'trg_user_global_roles_scope_insert',
    'trg_store_members_scope_insert',
    'trg_users_global_role_status_update',
    'trg_user_global_roles_last_owner_delete',
    'trg_access_recovery_target_guard',
    'trg_access_recovery_new_subject_guard',
    'trg_owner_access_subject_rebind_guard',
    'trg_access_recovery_apply',
    'trg_access_recovery_immutable_update',
    'trg_access_recovery_immutable_delete',
  ];
  for (const triggerName of requiredTriggers) {
    const row = await db.prepare(`
      SELECT name FROM sqlite_master WHERE type='trigger' AND name=?1
    `).bind(triggerName).first();
    assert.equal(row?.name, triggerName);
  }
}

async function assertDatabaseGuards(db) {
  await assert.rejects(
    () => db.prepare(`
      INSERT INTO user_global_roles(user_id,role_key,granted_by)
      VALUES('admin-a','owner','owner-a')
    `).run(),
    /UNIQUE|constraint/i,
  );

  await assert.rejects(
    () => db.prepare(`
      INSERT INTO user_global_roles(user_id,role_key,granted_by)
      VALUES('scope-test','operator','owner-a')
    `).run(),
    /user_global_roles_requires_global_role/,
  );

  await assert.rejects(
    () => db.prepare(`
      DELETE FROM user_global_roles
      WHERE user_id='owner-a' AND role_key='owner'
    `).run(),
    /last_active_owner_protection/,
  );

  assert.equal(await roleCount(db, 'owner-a', 'owner'), 1);
}

async function assertAccessRecoveryAtomicity(db) {
  const action = 'security.break_glass.access_subject_rebind';
  const originalSub = 'sub-owner-a';
  const recoveredSub = 'sub-owner-a-recovered';

  await assert.rejects(
    () => db.prepare(`
      UPDATE users SET cf_access_sub=?1 WHERE user_id='owner-a'
    `).bind('sub-owner-a-direct').run(),
    /owner_access_subject_rebind_requires_recovery_event/,
  );
  assert.equal(await userAccessSub(db, 'owner-a'), originalSub);

  await createAuditFailureTrigger(db, 'test_fail_break_glass_audit', action);
  await assert.rejects(
    () => insertRecoveryEvent(db, {
      recoveryId: 'recovery-real-d1-fail-0001',
      userId: 'owner-a',
      emailNorm: 'owner-a@example.invalid',
      previousSub: originalSub,
      newSub: recoveredSub,
      operatorIdentity: 'operator:real-d1-test',
      reason: 'Verify break-glass audit failure rolls back the owner subject rebind.',
      ticket: 'SEC-D1-FAIL',
    }),
    /test_audit_failure:security\.break_glass\.access_subject_rebind/,
  );
  assert.equal(await userAccessSub(db, 'owner-a'), originalSub, 'failed recovery audit must roll back subject rebind');
  assert.equal(await recoveryCount(db, 'recovery-real-d1-fail-0001'), 0, 'failed recovery audit must roll back recovery ledger insert');
  assert.equal(await auditCount(db, action, 'owner-a'), 0);
  await dropTrigger(db, 'test_fail_break_glass_audit');

  const recoveryId = 'recovery-real-d1-pass-0001';
  await insertRecoveryEvent(db, {
    recoveryId,
    userId: 'owner-a',
    emailNorm: 'owner-a@example.invalid',
    previousSub: originalSub,
    newSub: recoveredSub,
    operatorIdentity: 'operator:real-d1-test',
    reason: 'Recover the existing owner Access subject after verified identity rotation.',
    ticket: 'SEC-D1-PASS',
  });
  assert.equal(await userAccessSub(db, 'owner-a'), recoveredSub);
  assert.equal(await recoveryCount(db, recoveryId), 1);
  assert.equal(await auditCount(db, action, 'owner-a'), 1);

  const audit = await db.prepare(`
    SELECT actor_user_id,request_id,details_json
    FROM audit_log
    WHERE event_id=?1
  `).bind(recoveryId).first();
  assert.equal(audit?.actor_user_id, null);
  assert.equal(audit?.request_id, recoveryId);
  const details = JSON.parse(audit?.details_json || '{}');
  assert.equal(details.targetUserId, 'owner-a');
  assert.equal(details.previousCfAccessSub, originalSub);
  assert.equal(details.newCfAccessSub, recoveredSub);
  assert.equal(details.globalRoleChanged, false);
  assert.equal(details.controlPlane, 'break-glass-cli');

  await assert.rejects(
    () => db.prepare(`
      INSERT INTO access_recovery_events(
        recovery_id,target_user_id,expected_email_norm,expected_previous_cf_access_sub,
        new_cf_access_sub,operator_identity,reason,ticket
      ) VALUES(?1,'admin-a','admin-a@example.invalid','sub-admin-a',?2,?3,?4,?5)
    `).bind(
      'recovery-real-d1-admin-0001',
      'sub-admin-a-recovered',
      'operator:real-d1-test',
      'Verify break-glass recovery rejects a non-owner target.',
      'SEC-D1-ADMIN',
    ).run(),
    /break_glass_target_state_mismatch/,
  );

  await assert.rejects(
    () => insertRecoveryEvent(db, {
      recoveryId: 'recovery-real-d1-stale-0001',
      userId: 'owner-a',
      emailNorm: 'owner-a@example.invalid',
      previousSub: originalSub,
      newSub: 'sub-owner-a-stale-attempt',
      operatorIdentity: 'operator:real-d1-test',
      reason: 'Verify stale previous subject state cannot be used for recovery.',
      ticket: 'SEC-D1-STALE',
    }),
    /break_glass_target_state_mismatch/,
  );

  await assert.rejects(
    () => insertRecoveryEvent(db, {
      recoveryId: 'recovery-real-d1-conflict-0001',
      userId: 'owner-a',
      emailNorm: 'owner-a@example.invalid',
      previousSub: recoveredSub,
      newSub: 'sub-admin-a',
      operatorIdentity: 'operator:real-d1-test',
      reason: 'Verify recovery cannot steal a Cloudflare Access subject from another user.',
      ticket: 'SEC-D1-CONFLICT',
    }),
    /break_glass_new_subject_conflict/,
  );

  await assert.rejects(
    () => db.prepare(`
      UPDATE access_recovery_events SET ticket='SEC-D1-CHANGED' WHERE recovery_id=?1
    `).bind(recoveryId).run(),
    /access_recovery_ledger_immutable/,
  );
  await assert.rejects(
    () => db.prepare(`
      DELETE FROM access_recovery_events WHERE recovery_id=?1
    `).bind(recoveryId).run(),
    /access_recovery_ledger_immutable/,
  );
  assert.equal(await recoveryCount(db, recoveryId), 1);
  assert.equal(await roleCount(db, 'owner-a', 'owner'), 1, 'break-glass recovery must not alter owner role');
}

async function assertBreakGlassCliIntegration(db) {
  const currentSub = 'sub-owner-a-recovered';
  const newSub = 'sub-owner-a-cli-recovered';
  const ticket = 'SEC-D1-CLI';
  const input = {
    environment: 'dev',
    userId: 'owner-a',
    expectedEmail: 'owner-a@example.invalid',
    newCfAccessSub: newSub,
    operatorIdentity: 'operator:canonical-d1-harness',
    reason: 'Exercise the production break-glass CLI helper against real local D1.',
    ticket,
  };

  const dryRun = await executeAccessRecovery({
    db,
    input: { ...input, execute: false },
    recoveryId: 'recovery-cli-harness-dry-0001',
    env: {},
  });
  assert.equal(dryRun.executed, false);
  assert.equal(dryRun.plan.expectedPreviousCfAccessSub, currentSub);
  assert.equal(await userAccessSub(db, 'owner-a'), currentSub);
  assert.equal(await recoveryCount(db, dryRun.plan.recoveryId), 0);

  const confirmation = recoveryConfirmation(input.userId, input.ticket);
  await createAuditFailureTrigger(
    db,
    'test_fail_break_glass_cli_audit',
    'security.break_glass.access_subject_rebind',
  );
  await assert.rejects(
    () => executeAccessRecovery({
      db,
      input: { ...input, execute: true, confirmation },
      recoveryId: 'recovery-cli-harness-fail-0001',
      env: {},
    }),
    /test_audit_failure:security\.break_glass\.access_subject_rebind/,
  );
  assert.equal(await userAccessSub(db, 'owner-a'), currentSub);
  assert.equal(await recoveryCount(db, 'recovery-cli-harness-fail-0001'), 0);
  await dropTrigger(db, 'test_fail_break_glass_cli_audit');

  const result = await executeAccessRecovery({
    db,
    input: { ...input, execute: true, confirmation },
    recoveryId: 'recovery-cli-harness-pass-0001',
    env: {},
  });
  assert.equal(result.executed, true);
  assert.equal(result.recoveryId, 'recovery-cli-harness-pass-0001');
  assert.equal(result.auditAction, 'security.break_glass.access_subject_rebind');
  assert.equal(await userAccessSub(db, 'owner-a'), newSub);
  assert.equal(await recoveryCount(db, result.recoveryId), 1);
  assert.equal(await roleCount(db, 'owner-a', 'owner'), 1);
}

async function assertGlobalRoleAtomicity(db) {
  await createAuditFailureTrigger(db, 'test_fail_global_role_grant_audit', 'user.global_role.grant');
  await assert.rejects(
    () => globalRoleMutation(db, 'PUT', 'target-role', 'admin', 'grant-fail-ray'),
    /test_audit_failure:user\.global_role\.grant/,
  );
  assert.equal(await roleCount(db, 'target-role', 'admin'), 0, 'failed audit must roll back role grant');
  assert.equal(await auditCount(db, 'user.global_role.grant', 'target-role:admin'), 0);
  await dropTrigger(db, 'test_fail_global_role_grant_audit');

  const grantResponse = await globalRoleMutation(db, 'PUT', 'target-role', 'admin', 'grant-pass-ray');
  assert.equal(grantResponse.status, 200);
  const grantPayload = await grantResponse.json();
  assert.equal(grantPayload.changed, true);
  assert.deepEqual(grantPayload.globalRoles, ['admin']);
  assert.equal(await roleCount(db, 'target-role', 'admin'), 1);
  assert.equal(await auditCount(db, 'user.global_role.grant', 'target-role:admin'), 1);

  await createAuditFailureTrigger(db, 'test_fail_global_role_revoke_audit', 'user.global_role.revoke');
  await assert.rejects(
    () => globalRoleMutation(db, 'DELETE', 'target-role', 'admin', 'revoke-fail-ray'),
    /test_audit_failure:user\.global_role\.revoke/,
  );
  assert.equal(await roleCount(db, 'target-role', 'admin'), 1, 'failed audit must roll back role revoke');
  assert.equal(await auditCount(db, 'user.global_role.revoke', 'target-role:admin'), 0);
  await dropTrigger(db, 'test_fail_global_role_revoke_audit');

  const revokeResponse = await globalRoleMutation(db, 'DELETE', 'target-role', 'admin', 'revoke-pass-ray');
  assert.equal(revokeResponse.status, 200);
  const revokePayload = await revokeResponse.json();
  assert.equal(revokePayload.changed, true);
  assert.deepEqual(revokePayload.globalRoles, []);
  assert.equal(await roleCount(db, 'target-role', 'admin'), 0);
  assert.equal(await auditCount(db, 'user.global_role.revoke', 'target-role:admin'), 1);
}

async function assertLifecycleAtomicity(db) {
  await createAuditFailureTrigger(db, 'test_fail_lifecycle_audit', 'user.status.update');
  await assert.rejects(
    () => lifecycleMutation(db, 'target-lifecycle', 'disabled', 'lifecycle-fail-ray'),
    /test_audit_failure:user\.status\.update/,
  );
  assert.equal(await userStatus(db, 'target-lifecycle'), 'active', 'failed audit must roll back user status');
  assert.equal(await auditCount(db, 'user.status.update', 'target-lifecycle'), 0);
  await dropTrigger(db, 'test_fail_lifecycle_audit');

  const response = await lifecycleMutation(db, 'target-lifecycle', 'disabled', 'lifecycle-pass-ray');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.changed, true);
  assert.equal(payload.user.status, 'disabled');
  assert.equal(await userStatus(db, 'target-lifecycle'), 'disabled');
  assert.equal(await auditCount(db, 'user.status.update', 'target-lifecycle'), 1);
}

async function globalRoleMutation(db, method, userId, roleKey, ray) {
  const request = new Request(
    `https://security.test/api/v1/access/users/${encodeURIComponent(userId)}/global-roles/${encodeURIComponent(roleKey)}`,
    { method, headers: { 'cf-ray': ray } },
  );
  return handleGlobalRoleGovernanceApiRoute({
    request,
    env: { CONTROL_DB: db },
    actor: { user_id: 'owner-a' },
    url: new URL(request.url),
  });
}

async function lifecycleMutation(db, userId, status, ray) {
  const request = new Request('https://security.test/api/v1/access/users', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'cf-ray': ray },
    body: JSON.stringify({ userId, status }),
  });
  return handleUserLifecycleApiRoute({
    request,
    env: { CONTROL_DB: db },
    actor: { user_id: 'owner-a' },
    url: new URL(request.url),
  });
}

async function insertRecoveryEvent(db, input) {
  return db.prepare(`
    INSERT INTO access_recovery_events(
      recovery_id,target_user_id,expected_email_norm,expected_previous_cf_access_sub,
      new_cf_access_sub,operator_identity,reason,ticket
    ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
  `).bind(
    input.recoveryId,
    input.userId,
    input.emailNorm,
    input.previousSub,
    input.newSub,
    input.operatorIdentity,
    input.reason,
    input.ticket,
  ).run();
}

async function createAuditFailureTrigger(db, name, action) {
  if (!/^test_[a-z0-9_]+$/.test(name)) throw new Error('invalid_test_trigger_name');
  if (!/^[a-z0-9_.]+$/.test(action)) throw new Error('invalid_test_audit_action');
  await db.prepare(`
    CREATE TRIGGER ${name}
    BEFORE INSERT ON audit_log
    FOR EACH ROW
    WHEN NEW.action='${action}'
    BEGIN
      SELECT RAISE(ABORT, 'test_audit_failure:${action}');
    END
  `).run();
}

async function dropTrigger(db, name) {
  if (!/^test_[a-z0-9_]+$/.test(name)) throw new Error('invalid_test_trigger_name');
  await db.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
}

async function roleCount(db, userId, roleKey) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM user_global_roles WHERE user_id=?1 AND role_key=?2
  `).bind(userId, roleKey).first();
  return Number(row?.count || 0);
}

async function auditCount(db, action, entityId) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM audit_log WHERE action=?1 AND entity_id=?2
  `).bind(action, entityId).first();
  return Number(row?.count || 0);
}

async function recoveryCount(db, recoveryId) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM access_recovery_events WHERE recovery_id=?1
  `).bind(recoveryId).first();
  return Number(row?.count || 0);
}

async function userStatus(db, userId) {
  const row = await db.prepare(`SELECT status FROM users WHERE user_id=?1`).bind(userId).first();
  return row?.status || null;
}

async function userAccessSub(db, userId) {
  const row = await db.prepare(`SELECT cf_access_sub FROM users WHERE user_id=?1`).bind(userId).first();
  return row?.cf_access_sub ?? null;
}
