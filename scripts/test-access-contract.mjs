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
    'store-membership-read',
    'store-membership-upsert',
    'store-membership-store-role-only',
    'store-membership-active-user-only',
    'store-membership-dual-global-permission',
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

function fakeGovernanceDb({ permissions = ['users.manage', 'stores.manage'] } = {}) {
  const roles = new Map([
    ['owner', { role_key: 'owner', role_name: 'Owner', role_scope: 'global', priority: 1, is_system: 1, permissions: ['users.manage', 'stores.manage'] }],
    ['operator', { role_key: 'operator', role_name: 'Operator', role_scope: 'store', priority: 30, is_system: 1, permissions: ['products.manage', 'keywords.manage'] }],
    ['analyst', { role_key: 'analyst', role_name: 'Analyst', role_scope: 'store', priority: 50, is_system: 1, permissions: ['analytics.read', 'ads.read'] }],
    ['viewer', { role_key: 'viewer', role_name: 'Viewer', role_scope: 'store', priority: 90, is_system: 1, permissions: ['analytics.read', 'ads.read'] }],
  ]);
  const users = new Map([
    ['user-dev-owner', { user_id: 'user-dev-owner', cf_access_sub: 'owner-sub', email: 'owner@example.test', display_name: 'Owner', status: 'active', last_seen_at: '2026-08-16 10:00:00', created_at: '2026-08-10 10:00:00', updated_at: '2026-08-16 10:00:00', global_roles_csv: 'owner' }],
    ['user-analyst', { user_id: 'user-analyst', cf_access_sub: null, email: 'analyst@example.test', display_name: 'Analyst User', status: 'active', last_seen_at: null, created_at: '2026-08-11 10:00:00', updated_at: '2026-08-11 10:00:00', global_roles_csv: null }],
    ['user-disabled', { user_id: 'user-disabled', cf_access_sub: null, email: 'disabled@example.test', display_name: 'Disabled User', status: 'disabled', last_seen_at: null, created_at: '2026-08-12 10:00:00', updated_at: '2026-08-12 10:00:00', global_roles_csv: null }],
  ]);
  const store = { store_id: 'store-dev-01', store_code: 'DEV01', display_name: 'Development Store', marketplace_code: 'US', amazon_region: 'NA', status: 'active' };
  const state = { members: new Map(), audits: [] };

  const memberDetail = (storeId, userId, roleKey) => {
    const user = users.get(userId);
    const role = roles.get(roleKey);
    if (!user || !role) return null;
    return {
      store_id: storeId,
      user_id: userId,
      role_key: roleKey,
      created_at: '2026-08-16 10:30:00',
      email: user.email,
      display_name: user.display_name,
      user_status: user.status,
      last_seen_at: user.last_seen_at,
      role_name: role.role_name,
      role_scope: role.role_scope,
    };
  };

  return {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM user_global_roles ugr')) {
                return permissions.includes(params[1]) ? { ok: 1 } : null;
              }
              if (sql.includes('FROM stores')) {
                return params[0] === store.store_id ? { ...store } : null;
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
              if (sql.includes('INSERT INTO store_members')) {
                state.members.set(`${params[0]}:${params[1]}`, params[2]);
                return { success: true };
              }
              if (sql.includes('DELETE FROM store_members')) {
                state.members.delete(`${params[0]}:${params[1]}`);
                return { success: true };
              }
              if (sql.includes('INSERT INTO audit_log')) {
                state.audits.push({
                  actorUserId: params[1],
                  storeId: params[2],
                  action: params[3],
                  entityType: params[4],
                  entityId: params[5],
                  details: JSON.parse(params[8]),
                });
                return { success: true };
              }
              throw new Error(`Unexpected governance WRITE contract: ${sql}`);
            },
          };
        },
      };
    },
  };
}
