import assert from 'node:assert/strict';
import { createTestHarness } from 'wrangler';
import { handleGlobalRoleGovernanceApiRoute } from '../cloudflare/runtime/global-role-governance-api.js';
import { handleUserLifecycleApiRoute } from '../cloudflare/runtime/user-lifecycle-api.js';

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
  await assertGlobalRoleAtomicity(db);
  await assertLifecycleAtomicity(db);

  console.log(JSON.stringify({
    ok: true,
    module: 'security-integrity-real-d1-harness',
    runtime: 'cloudflare-createTestHarness',
    controlMigrationsApplied: true,
    dbInvariantsVerified: true,
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
  assert.equal(migration?.name, '0005_control_security_integrity.sql');

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

async function createAuditFailureTrigger(db, name, action) {
  await db.prepare(`
    CREATE TRIGGER ${name}
    BEFORE INSERT ON audit_log
    FOR EACH ROW
    WHEN NEW.action=?1
    BEGIN
      SELECT RAISE(ABORT, 'test_audit_failure:${action}');
    END
  `).bind(action).run();
}

async function dropTrigger(db, name) {
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

async function userStatus(db, userId) {
  const row = await db.prepare(`SELECT status FROM users WHERE user_id=?1`).bind(userId).first();
  return row?.status || null;
}
