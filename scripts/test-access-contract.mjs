import assert from 'node:assert/strict';
import { normalizeVerifiedAccessIdentity } from '../src/access.js';
import { enforceStrictAccessActorBinding } from '../src/access-actor.js';
import { handleAccessGovernanceApiRoute } from '../cloudflare/runtime/access-governance-api.js';

const user = normalizeVerifiedAccessIdentity({
  sub: 'user-sub-123',
  email: 'Owner@Example.COM ',
  exp: 1_800_000_000,
});
assert.deepEqual(user, {
  sub: 'user-sub-123',
  email: 'owner@example.com',
  exp: 1_800_000_000,
  principalType: 'user',
});

const service = normalizeVerifiedAccessIdentity({
  sub: '',
  common_name: '0123456789abcdef.access',
  exp: 1_800_000_000,
});
assert.deepEqual(service, {
  sub: '0123456789abcdef.access',
  email: '',
  exp: 1_800_000_000,
  principalType: 'service_token',
});

assert.throws(
  () => normalizeVerifiedAccessIdentity({ sub: '', common_name: '', exp: 1_800_000_000 }),
  /subject missing/,
);
assert.throws(
  () => normalizeVerifiedAccessIdentity({ sub: '', common_name: 'not-a-service-token', exp: 1_800_000_000 }),
  /subject missing/,
);

{
  const db = fakeUsersDb({
    user_id: 'user-dev-owner',
    cf_access_sub: 'user-sub-123',
    email: 'owner@example.com',
    email_norm: 'owner@example.com',
    display_name: 'Owner',
    status: 'active',
  });
  const result = await enforceStrictAccessActorBinding(db, {
    authenticated: true,
    identity: { sub: 'user-sub-123', email: 'owner@example.com' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.newlyBound, false);
}

{
  const db = fakeUsersDb({
    user_id: 'user-dev-owner',
    cf_access_sub: 'original-sub',
    email: 'owner@example.com',
    email_norm: 'owner@example.com',
    display_name: 'Owner',
    status: 'active',
  });
  const result = await enforceStrictAccessActorBinding(db, {
    authenticated: true,
    identity: { sub: 'different-sub', email: 'owner@example.com' },
  });
  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: 'access_subject_mismatch',
  });
}

{
  const db = fakeUsersDb({
    user_id: 'user-dev-owner',
    cf_access_sub: null,
    email: 'owner@example.com',
    email_norm: 'owner@example.com',
    display_name: 'Owner',
    status: 'active',
  });
  const result = await enforceStrictAccessActorBinding(db, {
    authenticated: true,
    identity: { sub: 'first-real-sub', email: 'owner@example.com' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.newlyBound, true);
  assert.equal(db.row.cf_access_sub, 'first-real-sub');
}

{
  const db = fakeUsersDb({
    user_id: 'user-dev-owner',
    cf_access_sub: 'user-sub-123',
    email: 'owner@example.com',
    email_norm: 'owner@example.com',
    display_name: 'Owner',
    status: 'active',
  });
  const result = await enforceStrictAccessActorBinding(db, {
    authenticated: true,
    identity: { sub: 'unknown-sub', email: 'nobody@example.com' },
  });
  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: 'app_user_not_provisioned',
  });
}

const governanceDb = fakeGovernanceDb();
const governanceActor = { user_id: 'user-dev-owner' };

{
  const request = new Request('https://example.test/api/v1/access/roles?scope=store', { headers: { 'cf-ray': 'roles-ray' } });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-request-id'), 'roles-ray');
  const payload = await response.json();
  assert.deepEqual(payload.roles.map((role) => role.roleKey), ['operator', 'analyst', 'viewer']);
  assert(payload.roles.every((role) => role.roleScope === 'store'));
}

{
  const request = new Request('https://example.test/api/v1/access/users?status=active&limit=10');
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.items.length, 2);
  const owner = payload.items.find((item) => item.userId === 'user-dev-owner');
  assert.deepEqual(owner.globalRoles, ['owner']);
  assert.equal(owner.cfAccessBound, true);
}

{
  const request = new Request('https://example.test/api/v1/access/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-ray': 'user-provision-ray' },
    body: JSON.stringify({ email: 'new-user@example.test', displayName: 'New User' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.user.email, 'new-user@example.test');
  assert.equal(governanceDb.state.audits.at(-1).action, 'user.provision');
}

{
  const db = fakeGovernanceDb({ failAudit: true });
  const request = new Request('https://example.test/api/v1/access/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'rollback-user@example.test', displayName: 'Rollback User' }),
  });
  await assert.rejects(
    () => handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: db }, actor: governanceActor, url: new URL(request.url) }),
    /injected_audit_failure/,
  );
  assert.equal([...db.state.users.values()].some((row) => row.email === 'rollback-user@example.test'), false);
  assert.equal(db.state.audits.length, 0);
}

{
  const db = fakeGovernanceDb({ revokePermissionsBeforeMutation: true });
  const request = new Request('https://example.test/api/v1/access/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'revoked-user@example.test', displayName: 'Revoked User' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: db }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'forbidden', permission: 'users.manage' });
  assert.equal([...db.state.users.values()].some((row) => row.email === 'revoked-user@example.test'), false);
  assert.equal(db.state.audits.length, 0);
}

{
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members');
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.store.storeId, 'store-dev-01');
  assert.equal(payload.items.length, 0);
}

{
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-analyst', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'cf-ray': 'member-put-ray' },
    body: JSON.stringify({ roleKey: 'analyst' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.member.userId, 'user-analyst');
  assert.equal(payload.member.roleKey, 'analyst');
  assert.equal(governanceDb.state.audits.at(-1).action, 'store_member.upsert');
  assert.equal(governanceDb.state.audits.at(-1).storeId, 'store-dev-01');
}

{
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-analyst', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleKey: 'viewer' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).member.roleKey, 'viewer');
}

{
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-analyst', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleKey: 'owner' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'store_role_required' });
}

{
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-disabled', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleKey: 'viewer' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'user_not_active' });
}

{
  const auditCountBefore = governanceDb.state.audits.length;
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-dev-owner', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleKey: 'viewer' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'global_role_conflict' });
  assert.equal(governanceDb.state.members.has('store-dev-01:user-dev-owner'), false);
  assert.equal(governanceDb.state.audits.length, auditCountBefore);
}

{
  const raceDb = fakeGovernanceDb({ insertConflictUserId: 'user-analyst' });
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-analyst', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleKey: 'viewer' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: raceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'global_role_conflict' });
  assert.equal(raceDb.state.members.has('store-dev-01:user-analyst'), false);
  assert.equal(raceDb.state.audits.length, 0);
}

{
  const db = fakeGovernanceDb({ failAudit: true });
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-analyst', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleKey: 'viewer' }),
  });
  await assert.rejects(
    () => handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: db }, actor: governanceActor, url: new URL(request.url) }),
    /injected_audit_failure/,
  );
  assert.equal(db.state.members.has('store-dev-01:user-analyst'), false);
  assert.equal(db.state.audits.length, 0);
}

{
  const db = fakeGovernanceDb({ revokePermissionsBeforeMutation: true });
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-analyst', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleKey: 'viewer' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: db }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'forbidden', permission: 'users.manage' });
  assert.equal(db.state.members.has('store-dev-01:user-analyst'), false);
  assert.equal(db.state.audits.length, 0);
}

{
  const deniedDb = fakeGovernanceDb({ permissions: ['users.manage'] });
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-analyst', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleKey: 'viewer' }),
  });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: deniedDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'forbidden', permission: 'stores.manage' });
}

{
  const db = fakeGovernanceDb({ failAudit: true });
  db.state.members.set('store-dev-01:user-analyst', 'viewer');
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-analyst', { method: 'DELETE' });
  await assert.rejects(
    () => handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: db }, actor: governanceActor, url: new URL(request.url) }),
    /injected_audit_failure/,
  );
  assert.equal(db.state.members.get('store-dev-01:user-analyst'), 'viewer');
  assert.equal(db.state.audits.length, 0);
}

{
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/members/user-analyst', { method: 'DELETE' });
  const response = await handleAccessGovernanceApiRoute({ request, env: { CONTROL_DB: governanceDb }, actor: governanceActor, url: new URL(request.url) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true, storeId: 'store-dev-01', userId: 'user-analyst' });
  assert.equal(governanceDb.state.audits.at(-1).action, 'store_member.delete');
}

console.log(JSON.stringify({
  ok: true,
  contracts: [
    'identity-user',
    'identity-service-token',
    'missing-principal-rejected',
    'bound-sub-accepted',
    'bound-sub-email-fallback-rejected',
    'unbound-email-first-bind-verified',
    'unknown-identity-rejected',
    'access-role-catalog-read',
    'access-user-catalog-read',
    'user-provision-atomic-audit',
    'user-provision-audit-failure-rollback',
    'user-provision-mutation-time-authority',
    'store-membership-read',
    'store-membership-upsert',
    'store-membership-store-role-only',
    'store-membership-active-user-only',
    'store-membership-global-role-conflict-preflight',
    'store-membership-global-role-conflict-race-normalization',
    'store-membership-audit-failure-rollback',
    'store-membership-mutation-time-authority',
    'store-membership-dual-global-permission',
    'store-membership-delete-audit-failure-rollback',
    'store-membership-delete',
    'store-membership-audit',
  ],
}, null, 2));

function fakeUsersDb(initialRow) {
  const db = {
    row: { ...initialRow },
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              const row = db.row;
              if (!row || row.status !== 'active') return null;

              if (sql.includes('user_id = ?1') && sql.includes('cf_access_sub = ?2')) {
                return row.user_id === params[0] && row.cf_access_sub === params[1] ? { ...row } : null;
              }
              if (sql.includes('cf_access_sub = ?1')) {
                return row.cf_access_sub === params[0] ? { ...row } : null;
              }
              if (sql.includes('email_norm = ?1')) {
                return row.email_norm === params[0] ? { ...row } : null;
              }
              throw new Error(`Unexpected SELECT contract: ${sql}`);
            },
            async run() {
              const row = db.row;
              if (!sql.includes('UPDATE users') || !sql.includes('cf_access_sub IS NULL')) {
                throw new Error(`Unexpected UPDATE contract: ${sql}`);
              }
              if (row && row.user_id === params[1] && !row.cf_access_sub) {
                row.cf_access_sub = params[0];
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db;
}

function fakeGovernanceDb({
  permissions = ['users.manage', 'stores.manage'],
  insertConflictUserId = null,
  failAudit = false,
  revokePermissionsBeforeMutation = false,
} = {}) {
  const roles = new Map([
    ['owner', { role_key: 'owner', role_name: 'Owner', role_scope: 'global', priority: 1, is_system: 1, permissions: ['users.manage', 'stores.manage'] }],
    ['operator', { role_key: 'operator', role_name: 'Operator', role_scope: 'store', priority: 30, is_system: 1, permissions: ['products.manage', 'keywords.manage'] }],
    ['analyst', { role_key: 'analyst', role_name: 'Analyst', role_scope: 'store', priority: 50, is_system: 1, permissions: ['analytics.read', 'ads.read'] }],
    ['viewer', { role_key: 'viewer', role_name: 'Viewer', role_scope: 'store', priority: 90, is_system: 1, permissions: ['analytics.read', 'ads.read'] }],
  ]);
  const users = new Map([
    ['user-dev-owner', { user_id: 'user-dev-owner', cf_access_sub: 'owner-sub', email: 'owner@example.test', email_norm: 'owner@example.test', display_name: 'Owner', status: 'active', last_seen_at: '2026-08-16 10:00:00', created_at: '2026-08-10 10:00:00', updated_at: '2026-08-16 10:00:00', global_roles_csv: 'owner' }],
    ['user-analyst', { user_id: 'user-analyst', cf_access_sub: null, email: 'analyst@example.test', email_norm: 'analyst@example.test', display_name: 'Analyst User', status: 'active', last_seen_at: null, created_at: '2026-08-11 10:00:00', updated_at: '2026-08-11 10:00:00', global_roles_csv: null }],
    ['user-disabled', { user_id: 'user-disabled', cf_access_sub: null, email: 'disabled@example.test', email_norm: 'disabled@example.test', display_name: 'Disabled User', status: 'disabled', last_seen_at: null, created_at: '2026-08-12 10:00:00', updated_at: '2026-08-12 10:00:00', global_roles_csv: null }],
  ]);
  const store = { store_id: 'store-dev-01', store_code: 'DEV01', display_name: 'Development Store', marketplace_code: 'US', amazon_region: 'NA', status: 'active' };
  const permissionSet = new Set(permissions);
  let revokePending = revokePermissionsBeforeMutation;
  const state = { members: new Map(), audits: [], users };

  const actorAuthorized = (actorUserId, requiredPermissions) => {
    const actorRow = users.get(actorUserId);
    return actorRow?.status === 'active'
      && Boolean(actorRow.global_roles_csv)
      && requiredPermissions.every((permission) => permissionSet.has(permission));
  };

  const memberDetail = (storeId, userId, roleKey) => {
    const memberUser = users.get(userId);
    const role = roles.get(roleKey);
    if (!memberUser || !role) return null;
    return {
      store_id: storeId,
      user_id: userId,
      role_key: roleKey,
      created_at: '2026-08-16 10:30:00',
      email: memberUser.email,
      display_name: memberUser.display_name,
      user_status: memberUser.status,
      last_seen_at: memberUser.last_seen_at,
      role_name: role.role_name,
      role_scope: role.role_scope,
    };
  };

  const statement = (sql, params) => ({
    __sql: sql,
    __params: params,
    async first() {
      if (sql.includes('FROM user_global_roles ugr')) {
        return permissionSet.has(params[1]) ? { ok: 1 } : null;
      }
      if (sql.includes('FROM stores')) {
        return params[0] === store.store_id && store.status !== 'disabled' ? { ...store } : null;
      }
      if (sql.includes('FROM users') && sql.includes('WHERE u.user_id=?1')) {
        const row = users.get(params[0]);
        if (!row) return null;
        if (sql.includes('AS has_global_role')) {
          return {
            user_id: row.user_id,
            email: row.email,
            display_name: row.display_name,
            status: row.status,
            has_global_role: Boolean(row.global_roles_csv),
          };
        }
        return { ...row };
      }
      if (sql.includes('FROM users') && sql.includes('WHERE user_id=?1')) {
        const row = users.get(params[0]);
        return row ? { user_id: row.user_id, email: row.email, display_name: row.display_name, status: row.status } : null;
      }
      if (sql.includes('FROM app_roles') && sql.includes('WHERE role_key=?1')) {
        const role = roles.get(params[0]);
        return role ? { role_key: role.role_key, role_name: role.role_name, role_scope: role.role_scope, priority: role.priority, is_system: role.is_system } : null;
      }
      if (sql.includes('FROM store_members sm') && sql.includes('JOIN users u')) {
        const roleKey = state.members.get(`${params[0]}:${params[1]}`);
        return roleKey ? memberDetail(params[0], params[1], roleKey) : null;
      }
      if (sql.includes('FROM store_members')) {
        const roleKey = state.members.get(`${params[0]}:${params[1]}`);
        return roleKey ? { store_id: params[0], user_id: params[1], role_key: roleKey, created_at: '2026-08-16 10:30:00' } : null;
      }
      throw new Error(`Unexpected governance SELECT contract: ${sql}`);
    },
    async all() {
      if (sql.includes('FROM app_roles r')) {
        const scope = params[0];
        const rows = [];
        for (const role of [...roles.values()].sort((a, b) => a.priority - b.priority || a.role_key.localeCompare(b.role_key))) {
          if (scope && role.role_scope !== scope) continue;
          const rolePermissions = [...role.permissions].sort();
          if (!rolePermissions.length) rows.push({ ...role, permission_key: null });
          else for (const permission of rolePermissions) rows.push({ ...role, permission_key: permission });
        }
        return { results: rows };
      }
      if (sql.includes('FROM users u')) {
        const status = params[0];
        const rows = [...users.values()].filter((row) => !status || row.status === status);
        return { results: rows };
      }
      if (sql.includes('FROM store_members sm')) {
        const rows = [];
        for (const [key, roleKey] of state.members.entries()) {
          const [memberStoreId, userId] = key.split(':');
          if (memberStoreId !== params[0]) continue;
          rows.push(memberDetail(memberStoreId, userId, roleKey));
        }
        return { results: rows };
      }
      throw new Error(`Unexpected governance LIST contract: ${sql}`);
    },
    async run() {
      if (sql.includes('INSERT INTO users(')) {
        const [userId, email, emailNorm, displayName, actorUserId] = params;
        if (!actorAuthorized(actorUserId, ['users.manage'])) return result(0);
        if ([...users.values()].some((row) => row.email_norm === emailNorm)) {
          throw new Error('UNIQUE constraint failed: users.email_norm');
        }
        users.set(userId, {
          user_id: userId,
          cf_access_sub: null,
          email,
          email_norm: emailNorm,
          display_name: displayName,
          status: 'active',
          last_seen_at: null,
          created_at: '2026-08-16 11:00:00',
          updated_at: '2026-08-16 11:00:00',
          global_roles_csv: null,
        });
        return result(1);
      }
      if (sql.includes('INSERT INTO store_members')) {
        const [storeId, userId, roleKey, actorUserId] = params;
        const targetUser = users.get(userId);
        const targetRole = roles.get(roleKey);
        const allowed = storeId === store.store_id
          && store.status !== 'disabled'
          && targetUser?.status === 'active'
          && !targetUser.global_roles_csv
          && targetRole?.role_scope === 'store'
          && actorAuthorized(actorUserId, ['users.manage', 'stores.manage']);
        if (!allowed) return result(0);
        if (userId === insertConflictUserId) {
          throw new Error('D1_ERROR: store_member_global_role_conflict: SQLITE_CONSTRAINT');
        }
        state.members.set(`${storeId}:${userId}`, roleKey);
        return result(1);
      }
      if (sql.includes('DELETE FROM store_members')) {
        const [storeId, userId, actorUserId] = params;
        const key = `${storeId}:${userId}`;
        if (storeId !== store.store_id || store.status === 'disabled') return result(0);
        if (!actorAuthorized(actorUserId, ['users.manage', 'stores.manage'])) return result(0);
        if (!state.members.has(key)) return result(0);
        state.members.delete(key);
        return result(1);
      }
      if (sql.includes('INSERT INTO audit_log')) {
        if (failAudit) throw new Error('injected_audit_failure');
        state.audits.push({
          actorUserId: params[1],
          storeId: params[2],
          action: params[3],
          entityType: params[4],
          entityId: params[5],
          details: JSON.parse(params[8]),
        });
        return result(1);
      }
      throw new Error(`Unexpected governance WRITE contract: ${sql}`);
    },
  });

  const db = {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return statement(sql, params);
        },
      };
    },
    async batch(statements) {
      const userSnapshot = new Map([...users.entries()].map(([key, value]) => [key, structuredClone(value)]));
      const memberSnapshot = new Map(state.members);
      const auditSnapshot = state.audits.map((entry) => structuredClone(entry));
      const permissionSnapshot = new Set(permissionSet);
      const revokeSnapshot = revokePending;
      let previousChanges = 0;
      const results = [];
      try {
        for (const item of statements) {
          const sql = item.__sql;
          if (!sql.includes('INSERT INTO audit_log') && revokePending) {
            permissionSet.clear();
            revokePending = false;
          }
          if (sql.includes('INSERT INTO audit_log') && previousChanges !== 1) {
            previousChanges = 0;
            results.push(result(0));
            continue;
          }
          const writeResult = await item.run();
          previousChanges = changedRows(writeResult);
          results.push(writeResult);
        }
        return results;
      } catch (error) {
        users.clear();
        for (const [key, value] of userSnapshot) users.set(key, value);
        state.members.clear();
        for (const [key, value] of memberSnapshot) state.members.set(key, value);
        state.audits.splice(0, state.audits.length, ...auditSnapshot);
        permissionSet.clear();
        for (const permission of permissionSnapshot) permissionSet.add(permission);
        revokePending = revokeSnapshot;
        throw error;
      }
    },
  };
  return db;
}

function result(changes) {
  return { success: true, meta: { changes }, results: [] };
}

function changedRows(value) {
  return Number(value?.meta?.changes ?? value?.changes ?? 0);
}
