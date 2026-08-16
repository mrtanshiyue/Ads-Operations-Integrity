import assert from 'node:assert/strict';
import { createTestHarness } from 'wrangler';
import {
  executeAccessRecovery,
  recoveryConfirmation,
} from './break-glass-access-recovery.mjs';

const server = createTestHarness({
  workers: [{ configPath: './cloudflare/runtime/wrangler.security-test.jsonc' }],
});

await server.listen();
try {
  const worker = server.getWorker('ads-operations-security-test');
  await worker.applyD1Migrations('CONTROL_DB');
  const env = await worker.getEnv();
  const db = env.CONTROL_DB;

  await db.prepare(`
    INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status)
    VALUES('owner-cli','sub-owner-cli','owner-cli@example.invalid','owner-cli@example.invalid','Owner CLI','active')
  `).run();
  await db.prepare(`
    INSERT INTO user_global_roles(user_id,role_key,granted_by)
    VALUES('owner-cli','owner','owner-cli')
  `).run();

  const baseInput = {
    environment: 'dev',
    userId: 'owner-cli',
    expectedEmail: 'owner-cli@example.invalid',
    newCfAccessSub: 'sub-owner-cli-recovered',
    operatorIdentity: 'operator:local-d1-break-glass-test',
    reason: 'Recover the existing owner subject through the tested break-glass CLI path.',
    ticket: 'SEC-D1-CLI-1',
  };

  const dryRun = await executeAccessRecovery({
    db,
    input: { ...baseInput, execute: false },
    recoveryId: 'recovery-cli-dry-run-0001',
    env: {},
  });
  assert.equal(dryRun.executed, false);
  assert.equal(dryRun.plan.expectedPreviousCfAccessSub, 'sub-owner-cli');
  assert.equal(await subjectFor(db, 'owner-cli'), 'sub-owner-cli');
  assert.equal(await recoveryCount(db, 'recovery-cli-dry-run-0001'), 0);

  await createAuditFailureTrigger(db);
  await assert.rejects(
    () => executeAccessRecovery({
      db,
      input: {
        ...baseInput,
        execute: true,
        confirmation: recoveryConfirmation(baseInput.userId, baseInput.ticket),
      },
      recoveryId: 'recovery-cli-audit-fail-0001',
      env: {},
    }),
    /test_break_glass_cli_audit_failure/,
  );
  assert.equal(await subjectFor(db, 'owner-cli'), 'sub-owner-cli');
  assert.equal(await recoveryCount(db, 'recovery-cli-audit-fail-0001'), 0);
  assert.equal(await auditCount(db, 'recovery-cli-audit-fail-0001'), 0);
  await db.prepare('DROP TRIGGER test_break_glass_cli_audit_failure').run();

  const result = await executeAccessRecovery({
    db,
    input: {
      ...baseInput,
      execute: true,
      confirmation: recoveryConfirmation(baseInput.userId, baseInput.ticket),
    },
    recoveryId: 'recovery-cli-success-0001',
    env: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.recoveryId, 'recovery-cli-success-0001');
  assert.equal(result.auditAction, 'security.break_glass.access_subject_rebind');
  assert.equal(await subjectFor(db, 'owner-cli'), baseInput.newCfAccessSub);
  assert.equal(await recoveryCount(db, result.recoveryId), 1);
  assert.equal(await auditCount(db, result.recoveryId), 1);
  assert.equal(await roleCount(db, 'owner-cli', 'owner'), 1);

  const audit = await db.prepare(`
    SELECT actor_user_id,action,entity_id,request_id,details_json
    FROM audit_log WHERE event_id=?1
  `).bind(result.recoveryId).first();
  assert.equal(audit?.actor_user_id, null);
  assert.equal(audit?.action, 'security.break_glass.access_subject_rebind');
  assert.equal(audit?.entity_id, 'owner-cli');
  assert.equal(audit?.request_id, result.recoveryId);
  const details = JSON.parse(audit?.details_json || '{}');
  assert.equal(details.operatorIdentity, baseInput.operatorIdentity);
  assert.equal(details.ticket, baseInput.ticket);
  assert.equal(details.globalRoleChanged, false);
  assert.equal(details.controlPlane, 'break-glass-cli');

  console.log(JSON.stringify({
    ok: true,
    module: 'break-glass-access-recovery-real-d1',
    dryRunNoMutation: true,
    auditFailureRollback: true,
    successfulPostflight: true,
    ownerRolePreserved: true,
    remoteD1Touched: false,
  }));
} finally {
  await server.close();
}

async function createAuditFailureTrigger(db) {
  await db.prepare(`
    CREATE TRIGGER test_break_glass_cli_audit_failure
    BEFORE INSERT ON audit_log
    FOR EACH ROW
    WHEN NEW.action='security.break_glass.access_subject_rebind'
    BEGIN
      SELECT RAISE(ABORT, 'test_break_glass_cli_audit_failure');
    END
  `).run();
}

async function subjectFor(db, userId) {
  const row = await db.prepare('SELECT cf_access_sub FROM users WHERE user_id=?1').bind(userId).first();
  return row?.cf_access_sub ?? null;
}

async function recoveryCount(db, recoveryId) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM access_recovery_events WHERE recovery_id=?1')
    .bind(recoveryId).first();
  return Number(row?.count || 0);
}

async function auditCount(db, eventId) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE event_id=?1')
    .bind(eventId).first();
  return Number(row?.count || 0);
}

async function roleCount(db, userId, roleKey) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM user_global_roles WHERE user_id=?1 AND role_key=?2')
    .bind(userId, roleKey).first();
  return Number(row?.count || 0);
}
