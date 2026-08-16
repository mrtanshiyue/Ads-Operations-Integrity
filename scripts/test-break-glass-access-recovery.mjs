import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAccessRecoveryPlan,
  executeAccessRecovery,
  parseBreakGlassCliArgs,
  productionRecoveryConfirmation,
  recoveryConfirmation,
  validateAccessRecoveryInput,
} from './break-glass-access-recovery.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'scripts/break-glass-access-recovery.mjs'), 'utf8');

const validInput = Object.freeze({
  environment: 'dev',
  userId: 'user-owner',
  expectedEmail: ' OWNER@EXAMPLE.INVALID ',
  newCfAccessSub: 'sub-owner-recovered',
  operatorIdentity: 'operator:security-admin',
  reason: 'Recover the owner subject after verified identity rotation.',
  ticket: 'SEC-2001',
  execute: false,
});

{
  const validated = validateAccessRecoveryInput(validInput);
  assert.equal(validated.expectedEmailNorm, 'owner@example.invalid');
  assert.equal(validated.environment, 'dev');
  assert.equal(validated.execute, false);
}

for (const input of [
  { ...validInput, environment: 'staging' },
  { ...validInput, userId: '' },
  { ...validInput, expectedEmail: 'not-an-email' },
  { ...validInput, newCfAccessSub: '' },
  { ...validInput, operatorIdentity: 'x' },
  { ...validInput, reason: 'too short' },
  { ...validInput, ticket: 'x' },
]) {
  assert.throws(() => validateAccessRecoveryInput(input), /break_glass_/);
}

{
  const parsed = parseBreakGlassCliArgs([
    '--environment', 'dev',
    '--account-id', 'account-1',
    '--database-id', 'database-1',
    '--user-id', 'user-owner',
    '--expected-email', 'owner@example.invalid',
    '--new-access-sub', 'sub-owner-recovered',
    '--operator', 'operator:security-admin',
    '--reason', 'Recover the owner subject after verified identity rotation.',
    '--ticket', 'SEC-2001',
  ]);
  assert.equal(parsed.input.execute, false);
  assert.equal(parsed.connection.accountId, 'account-1');
  assert.equal(parsed.connection.databaseId, 'database-1');
}

assert.throws(
  () => parseBreakGlassCliArgs(['--api-token', 'secret-value']),
  /break_glass_api_token_cli_forbidden/,
);
assert.throws(
  () => parseBreakGlassCliArgs(['--unknown', 'value']),
  /break_glass_cli_argument_unsupported/,
);
assert.throws(
  () => parseBreakGlassCliArgs(['--ticket']),
  /break_glass_cli_value_required:ticket/,
);

{
  const db = createPreflightOnlyDb();
  const result = await executeAccessRecovery({
    db,
    input: validInput,
    recoveryId: 'recovery-contract-dry-0001',
    env: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.executed, false);
  assert.equal(result.plan.expectedPreviousCfAccessSub, 'sub-owner-current');
  assert.equal(result.plan.confirmationRequired, 'REBIND:user-owner:SEC-2001');
  assert.equal(db.state.writeCalls, 0, 'dry-run must not perform mutation');
}

{
  const validated = validateAccessRecoveryInput(validInput);
  const target = Object.freeze({
    userId: 'user-owner',
    emailNorm: 'owner@example.invalid',
    currentCfAccessSub: 'sub-owner-current',
    status: 'active',
  });
  assert.throws(
    () => buildAccessRecoveryPlan(validated, target, { recoveryId: 'recovery-noop-test-0001' }),
    /break_glass_subject_noop_forbidden/,
    'fixture new sub must be distinct; this assertion should be replaced below',
  );
}

// Explicitly verify no-op rejection with a matching current/new subject.
{
  const validated = validateAccessRecoveryInput({ ...validInput, newCfAccessSub: 'sub-owner-current' });
  const target = Object.freeze({
    userId: 'user-owner',
    emailNorm: 'owner@example.invalid',
    currentCfAccessSub: 'sub-owner-current',
    status: 'active',
  });
  assert.throws(
    () => buildAccessRecoveryPlan(validated, target, { recoveryId: 'recovery-noop-test-0002' }),
    /break_glass_subject_noop_forbidden/,
  );
}

{
  const db = createPreflightOnlyDb();
  await assert.rejects(
    () => executeAccessRecovery({
      db,
      input: { ...validInput, execute: true, confirmation: 'WRONG' },
      recoveryId: 'recovery-confirm-test-0001',
      env: {},
    }),
    /break_glass_confirmation_mismatch/,
  );
  assert.equal(db.state.writeCalls, 0);
}

{
  const db = createPreflightOnlyDb();
  const productionInput = {
    ...validInput,
    environment: 'production',
    execute: true,
    confirmation: recoveryConfirmation('user-owner', 'SEC-2001'),
    productionConfirmation: productionRecoveryConfirmation('user-owner', 'SEC-2001'),
  };
  await assert.rejects(
    () => executeAccessRecovery({
      db,
      input: productionInput,
      recoveryId: 'recovery-prod-disabled-0001',
      env: {},
    }),
    /break_glass_production_disabled/,
  );
  assert.equal(db.state.writeCalls, 0);
}

{
  const db = createPreflightOnlyDb();
  await assert.rejects(
    () => executeAccessRecovery({
      db,
      input: {
        ...validInput,
        environment: 'production',
        execute: true,
        confirmation: recoveryConfirmation('user-owner', 'SEC-2001'),
        productionConfirmation: 'WRONG',
      },
      recoveryId: 'recovery-prod-confirm-0001',
      env: { BREAK_GLASS_PRODUCTION_ENABLED: '1' },
    }),
    /break_glass_production_confirmation_mismatch/,
  );
  assert.equal(db.state.writeCalls, 0);
}

assert.equal(recoveryConfirmation('u', 'T-1'), 'REBIND:u:T-1');
assert.equal(productionRecoveryConfirmation('u', 'T-1'), 'PRODUCTION-REBIND:u:T-1');

assert.match(source, /INSERT INTO access_recovery_events/);
assert.match(source, /CLOUDFLARE_API_TOKEN/);
assert.match(source, /break_glass_api_token_cli_forbidden/);
assert.match(source, /BREAK_GLASS_PRODUCTION_ENABLED/);
assert.match(source, /break_glass_production_confirmation_mismatch/);
assert.match(source, /security\.break_glass\.access_subject_rebind/);
assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+user_global_roles/i);
assert.doesNotMatch(source, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+role_permissions/i);
assert.doesNotMatch(source, /wrangler\s+deploy|AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED/);
assert.doesNotMatch(source, /--api-token["'`]/);

console.log(JSON.stringify({
  ok: true,
  module: 'break-glass-access-recovery-cli',
  contracts: [
    'dry-run-default-no-mutation',
    'api-token-env-only',
    'active-owner-preflight-required',
    'exact-current-subject-captured',
    'no-op-subject-forbidden',
    'execution-confirmation-required',
    'production-enable-gate-required',
    'production-second-confirmation-required',
    'single-recovery-ledger-insert',
    'no-global-role-write',
    'no-amazon-or-deploy-coupling',
  ],
}));

function createPreflightOnlyDb() {
  const state = { writeCalls: 0 };
  return {
    state,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('JOIN user_global_roles') && sql.includes("ugr.role_key='owner'")) {
                if (args[0] !== 'user-owner' || args[1] !== 'owner@example.invalid') return null;
                return {
                  user_id: 'user-owner',
                  email_norm: 'owner@example.invalid',
                  cf_access_sub: 'sub-owner-current',
                  status: 'active',
                };
              }
              throw new Error('unexpected_fake_read');
            },
            async run() {
              state.writeCalls += 1;
              throw new Error('unexpected_fake_write');
            },
          };
        },
      };
    },
  };
}
