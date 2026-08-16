import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUserLifecycleApiRoute } from '../cloudflare/runtime/user-lifecycle-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/user-lifecycle-api.js'), 'utf8');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const nativeApiSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-api-v1.js'), 'utf8');
const accessConsoleSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-access-console-v1.js'), 'utf8');

function createDb({ permissions = ['users.manage'] } = {}) {
  const users = new Map([
    ['user-owner', userRow('user-owner', 'owner@example.test', 'Owner', 'active', 'owner')],
    ['user-operator', userRow('user-operator', 'operator@example.test', 'Operator', 'active', null)],
    ['user-disabled', userRow('user-disabled', 'disabled@example.test', 'Disabled User', 'disabled', null)],
  ]);
  const memberships = new Map([
    ['store-dev-01:user-operator', 'operator'],
    ['store-dev-01:user-disabled', 'viewer'],
  ]);
  const state = { users, memberships, audits: [] };

  return {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM users u') && sql.includes('WHERE u.user_id=?1')) {
                const row = users.get(params[0]);
                return row ? { ...row } : null;
              }
              if (sql.includes('FROM user_global_roles ugr')) {
                return permissions.includes(params[1]) ? { ok: 1 } : null;
              }
              throw new Error(`unexpected lifecycle first query: ${sql}`);
            },
            async run() {
              if (sql.includes('UPDATE users') && sql.includes('SET status=?1')) {
                const [status, userId] = params;
                const row = users.get(userId);
                if (row) {
                  row.status = status;
                  row.updated_at = '2026-08-16 11:30:00';
                }
                return { success: true };
              }
              if (sql.includes('INSERT INTO audit_log')) {
                state.audits.push({
                  actorUserId: params[1],
                  action: params[2],
                  entityType: params[3],
                  entityId: params[4],
                  requestId: params[5],
                  cfRay: params[6],
                  details: JSON.parse(params[7]),
                });
                return { success: true };
              }
              throw new Error(`unexpected lifecycle write query: ${sql}`);
            },
          };
        },
      };
    },
  };
}

function userRow(userId, email, displayName, status, globalRolesCsv) {
  return {
    user_id: userId,
    cf_access_sub: userId === 'user-owner' ? 'owner-sub' : `${userId}-sub`,
    email,
    display_name: displayName,
    status,
    last_seen_at: '2026-08-16 10:00:00',
    created_at: '2026-08-10 10:00:00',
    updated_at: '2026-08-16 10:00:00',
    global_roles_csv: globalRolesCsv,
  };
}

async function lifecycle(db, actorUserId, body, ray = null) {
  const headers = { 'content-type': 'application/json' };
  if (ray) headers['cf-ray'] = ray;
  const request = new Request('https://example.test/api/v1/access/users', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  return handleUserLifecycleApiRoute({
    request,
    env: { CONTROL_DB: db },
    actor: { user_id: actorUserId },
    url: new URL(request.url),
  });
}

const db = createDb();
const membershipBefore = db.state.memberships.get('store-dev-01:user-operator');
const disableResponse = await lifecycle(db, 'user-owner', { userId: 'user-operator', status: 'disabled' }, 'lifecycle-disable-ray');
assert.equal(disableResponse.status, 200);
assert.equal(disableResponse.headers.get('cache-control'), 'no-store');
assert.equal(disableResponse.headers.get('x-request-id'), 'lifecycle-disable-ray');
const disabled = await disableResponse.json();
assert.equal(disabled.changed, true);
assert.equal(disabled.user.userId, 'user-operator');
assert.equal(disabled.user.status, 'disabled');
assert.deepEqual(disabled.user.globalRoles, []);
assert.equal(db.state.memberships.get('store-dev-01:user-operator'), membershipBefore);
assert.equal(db.state.audits.length, 1);
assert.equal(db.state.audits[0].action, 'user.status.update');
assert.deepEqual(db.state.audits[0].details, {
  userId: 'user-operator',
  previousStatus: 'active',
  status: 'disabled',
  membershipsPreserved: true,
});

const idempotentResponse = await lifecycle(db, 'user-owner', { userId: 'user-operator', status: 'disabled' });
assert.equal(idempotentResponse.status, 200);
const idempotent = await idempotentResponse.json();
assert.equal(idempotent.changed, false);
assert.equal(idempotent.user.status, 'disabled');
assert.equal(db.state.audits.length, 1, 'idempotent lifecycle update must not audit a no-op');
assert.equal(db.state.memberships.get('store-dev-01:user-operator'), membershipBefore);

const restoreResponse = await lifecycle(db, 'user-owner', { userId: 'user-operator', status: 'active' });
assert.equal(restoreResponse.status, 200);
const restored = await restoreResponse.json();
assert.equal(restored.changed, true);
assert.equal(restored.user.status, 'active');
assert.equal(db.state.memberships.get('store-dev-01:user-operator'), membershipBefore);
assert.equal(db.state.audits.length, 2);
assert.equal(db.state.audits[1].details.previousStatus, 'disabled');
assert.equal(db.state.audits[1].details.status, 'active');

const selfResponse = await lifecycle(createDb(), 'user-owner', { userId: 'user-owner', status: 'disabled' });
assert.equal(selfResponse.status, 409);
assert.deepEqual(await selfResponse.json(), { error: 'self_user_lifecycle_change_forbidden' });

const globalRoleResponse = await lifecycle(createDb(), 'user-operator', { userId: 'user-owner', status: 'disabled' });
assert.equal(globalRoleResponse.status, 409);
assert.deepEqual(await globalRoleResponse.json(), {
  error: 'global_role_user_lifecycle_change_forbidden',
  globalRoles: ['owner'],
});

const missingResponse = await lifecycle(createDb(), 'user-owner', { userId: 'missing-user', status: 'disabled' });
assert.equal(missingResponse.status, 404);
assert.deepEqual(await missingResponse.json(), { error: 'user_not_found' });

const deniedResponse = await lifecycle(createDb({ permissions: [] }), 'user-owner', { userId: 'user-operator', status: 'disabled' });
assert.equal(deniedResponse.status, 403);
assert.deepEqual(await deniedResponse.json(), { error: 'forbidden', permission: 'users.manage' });

for (const body of [
  { userId: 'user-operator', status: 'paused' },
  { userId: 'user-operator', status: 'disabled', globalRoles: [] },
  { userId: 'user-operator', status: 'disabled', roleKey: 'owner' },
  { userId: '', status: 'disabled' },
]) {
  const response = await lifecycle(createDb(), 'user-owner', body);
  assert.equal(response.status, 400);
}

assert.match(webEntrySource, /handleUserLifecycleApiRoute/);
assert.match(webEntrySource, /request\.method\.toUpperCase\(\) === 'PATCH'/);
assert.match(nativeApiSource, /updateAccessUserStatus:\s*\(userId, status\).*method:\s*'PATCH'/s);
assert.match(apiSource, /membershipsPreserved:\s*true/);
assert.doesNotMatch(apiSource, /DELETE FROM\s+store_members/i);
assert.doesNotMatch(apiSource, /INSERT INTO\s+user_global_roles/i);
assert.doesNotMatch(apiSource, /UPDATE\s+user_global_roles/i);
assert.doesNotMatch(apiSource, /DELETE FROM\s+user_global_roles/i);
assert.doesNotMatch(apiSource, /DELETE FROM\s+users/i);
assert.doesNotMatch(apiSource, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/);

assert.match(accessConsoleSource, /api\(\)\.session\(\)/);
assert.match(accessConsoleSource, /state\.currentUserId\s*=\s*String\(session\?\.user\?\.userId/);
assert.match(accessConsoleSource, /api\(\)\.updateAccessUserStatus\(userId, status\)/);
assert.match(accessConsoleSource, /const users = activeUsers\(state\.users\)/);
assert.match(accessConsoleSource, /user\.status === 'active'[\s\S]*?'disabled'[\s\S]*?user\.status === 'disabled' \? 'active'/);
assert.match(accessConsoleSource, /受保护账号/);
assert.match(accessConsoleSource, /当前账号/);
assert.match(accessConsoleSource, /Cloudflare Access/);
assert.match(accessConsoleSource, /Global Roles/);
assert.match(accessConsoleSource, /Last Seen/);
assert.match(accessConsoleSource, /失去应用访问权限/);
assert.match(accessConsoleSource, /店铺成员关系和角色会继续保留/);
assert.match(accessConsoleSource, /之后可以恢复/);
assert.doesNotMatch(accessConsoleSource, /accessUsers\(\{\s*status:\s*'active'/);
assert.doesNotMatch(accessConsoleSource, /deleteAccessUser|grantGlobalRole|revokeGlobalRole|setGlobalRole/);
assert.doesNotMatch(accessConsoleSource, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/);

console.log(JSON.stringify({
  ok: true,
  module: 'access-user-lifecycle',
  contracts: [
    'users-manage-required',
    'ordinary-user-disable',
    'ordinary-user-restore',
    'idempotent-status-no-op',
    'self-lifecycle-forbidden',
    'global-role-user-protected',
    'store-memberships-preserved',
    'audit-status-change',
    'no-user-delete',
    'no-global-role-write',
    'native-client-patch',
    'ui-all-status-user-directory',
    'ui-current-user-protected',
    'ui-global-role-user-protected',
    'ui-disable-confirmation',
    'ui-membership-preservation-message',
    'amazon-sync-isolation',
  ],
}));
