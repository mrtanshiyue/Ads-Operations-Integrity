import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGlobalRoleGovernanceApiRoute } from '../cloudflare/runtime/global-role-governance-api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/global-role-governance-api.js'), 'utf8');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');

function createDb({ secondOwner = true } = {}) {
  const users = new Map([
    ['owner-a', user('owner-a', 'owner-a@example.test', 'Owner A', 'active', 'sub-owner-a')],
    ['owner-b', user('owner-b', 'owner-b@example.test', 'Owner B', 'active', 'sub-owner-b')],
    ['admin-a', user('admin-a', 'admin-a@example.test', 'Admin A', 'active', 'sub-admin-a')],
    ['ordinary', user('ordinary', 'ordinary@example.test', 'Ordinary', 'active', 'sub-ordinary')],
    ['inactive', user('inactive', 'inactive@example.test', 'Inactive', 'disabled', 'sub-inactive')],
    ['unbound', user('unbound', 'unbound@example.test', 'Unbound', 'active', null)],
    ['store-member', user('store-member', 'store@example.test', 'Store Member', 'active', 'sub-store')],
  ]);
  const globalRoles = new Map();
  setRole(globalRoles, 'owner-a', 'owner', 'bootstrap', '2026-08-16 01:00:00');
  if (secondOwner) setRole(globalRoles, 'owner-b', 'owner', 'owner-a', '2026-08-16 02:00:00');
  setRole(globalRoles, 'admin-a', 'admin', 'owner-a', '2026-08-16 03:00:00');
  const memberships = new Set(['store-dev-01:store-member']);
  const audits = [];
  const state = { users, globalRoles, memberships, audits };

  function actorAuthority(userId) {
    const row = users.get(userId);
    const roles = rolesFor(globalRoles, userId);
    const isOwner = roles.includes('owner');
    return {
      status: row?.status || null,
      is_owner: isOwner ? 1 : 0,
      has_users_manage: isOwner || roles.includes('admin') ? 1 : 0,
      has_system_manage: isOwner ? 1 : 0,
    };
  }

  function targetRow(userId) {
    const row = users.get(userId);
    if (!row) return null;
    return {
      ...row,
      global_roles_csv: rolesFor(globalRoles, userId).join(',') || null,
      store_membership_count: [...memberships].filter((entry) => entry.endsWith(`:${userId}`)).length,
    };
  }

  function activeOwnerCount() {
    let count = 0;
    for (const relation of globalRoles.values()) {
      if (relation.role_key !== 'owner') continue;
      if (users.get(relation.user_id)?.status === 'active') count += 1;
    }
    return count;
  }

  return {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return statement(sql, params);
        },
        ...statement(sql, []),
      };
    },
  };

  function statement(sql, params) {
    return {
      async first() {
        if (sql.includes('AS is_owner') && sql.includes('AS has_system_manage')) {
          return actorAuthority(params[0]);
        }
        if (sql.includes('store_membership_count') && sql.includes('global_roles_csv')) {
          return targetRow(params[0]);
        }
        if (sql.includes('AS active_owner_count')) {
          return { active_owner_count: activeOwnerCount() };
        }
        throw new Error(`unexpected Phase C first query: ${sql}`);
      },
      async run() {
        if (sql.includes('INSERT INTO user_global_roles')) {
          const [userId, roleKey, actorUserId] = params;
          const target = users.get(userId);
          const authority = actorAuthority(actorUserId);
          const allowed = Boolean(target)
            && target.status === 'active'
            && target.cf_access_sub !== null
            && rolesFor(globalRoles, userId).length === 0
            && ![...memberships].some((entry) => entry.endsWith(`:${userId}`))
            && authority.status === 'active'
            && Boolean(authority.is_owner)
            && Boolean(authority.has_users_manage)
            && Boolean(authority.has_system_manage);
          if (!allowed) return { meta: { changes: 0 } };
          setRole(globalRoles, userId, roleKey, actorUserId, '2026-08-16 12:30:00');
          return { meta: { changes: 1 } };
        }
        if (sql.includes('INSERT INTO audit_log')) {
          audits.push({
            eventId: params[0],
            actorUserId: params[1],
            action: params[2],
            entityType: params[3],
            entityId: params[4],
            requestId: params[5],
            cfRay: params[6],
            details: JSON.parse(params[7]),
          });
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected Phase C run query: ${sql}`);
      },
      async all() {
        if (sql.includes('DELETE FROM user_global_roles') && sql.includes('RETURNING')) {
          const [userId, roleKey, actorUserId] = params;
          const relationKey = `${userId}:${roleKey}`;
          const relation = globalRoles.get(relationKey);
          if (!relation) return { results: [] };
          const authority = actorAuthority(actorUserId);
          if (authority.status !== 'active' || !authority.is_owner || !authority.has_users_manage || !authority.has_system_manage) {
            return { results: [] };
          }
          const target = users.get(userId);
          if (roleKey === 'owner' && target?.status === 'active' && activeOwnerCount() <= 1) {
            return { results: [] };
          }
          globalRoles.delete(relationKey);
          return { results: [{ ...relation }] };
        }
        throw new Error(`unexpected Phase C all query: ${sql}`);
      },
    };
  }
}

function user(userId, email, displayName, status, cfAccessSub) {
  return {
    user_id: userId,
    email,
    display_name: displayName,
    status,
    cf_access_sub: cfAccessSub,
  };
}

function setRole(map, userId, roleKey, grantedBy, grantedAt) {
  map.set(`${userId}:${roleKey}`, {
    user_id: userId,
    role_key: roleKey,
    granted_by: grantedBy,
    granted_at: grantedAt,
  });
}

function rolesFor(map, userId) {
  return [...map.values()]
    .filter((row) => row.user_id === userId)
    .map((row) => row.role_key)
    .sort();
}

async function mutate(db, actorUserId, method, userId, roleKey, ray = null) {
  const headers = {};
  if (ray) headers['cf-ray'] = ray;
  const request = new Request(`https://example.test/api/v1/access/users/${encodeURIComponent(userId)}/global-roles/${encodeURIComponent(roleKey)}`, {
    method,
    headers,
  });
  return handleGlobalRoleGovernanceApiRoute({
    request,
    env: { CONTROL_DB: db },
    actor: { user_id: actorUserId },
    url: new URL(request.url),
  });
}

// Authorization: non-owner and admin must never mutate global roles.
for (const actorUserId of ['ordinary', 'admin-a']) {
  const db = createDb();
  const response = await mutate(db, actorUserId, 'PUT', 'ordinary', 'owner');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'forbidden', role: 'owner' });
  assert.equal(db.state.audits.length, 0);
}

// Owner may grant another active, Access-bound, store-isolated user.
{
  const db = createDb({ secondOwner: false });
  const response = await mutate(db, 'owner-a', 'PUT', 'ordinary', 'owner', 'phase-c-grant-ray');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-request-id'), 'phase-c-grant-ray');
  const payload = await response.json();
  assert.equal(payload.changed, true);
  assert.deepEqual(payload.globalRoles, ['owner']);
  assert.equal(payload.activeOwnerCount, 2);
  assert.deepEqual(rolesFor(db.state.globalRoles, 'ordinary'), ['owner']);
  assert.equal(db.state.audits.length, 1);
  assert.equal(db.state.audits[0].action, 'user.global_role.grant');
  assert.equal(db.state.audits[0].entityType, 'user_global_role');
  assert.deepEqual(db.state.audits[0].details, {
    userId: 'ordinary',
    roleKey: 'owner',
    previousGlobalRoles: [],
    globalRoles: ['owner'],
    grantedBy: 'owner-a',
    privilegeEscalation: true,
    activeOwnerCountBefore: 1,
    activeOwnerCountAfter: 2,
  });
}

// Self mutation is forbidden for both grant and revoke.
for (const method of ['PUT', 'DELETE']) {
  const db = createDb();
  const response = await mutate(db, 'owner-a', method, 'owner-a', 'owner');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'self_global_role_change_forbidden' });
}

// Grant target invariants.
for (const [target, expected] of [
  ['inactive', 'user_not_active'],
  ['unbound', 'cf_access_binding_required'],
  ['store-member', 'store_membership_conflict'],
]) {
  const db = createDb();
  const response = await mutate(db, 'owner-a', 'PUT', target, 'admin');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, expected);
  assert.deepEqual(rolesFor(db.state.globalRoles, target), []);
  assert.equal(db.state.audits.length, 0);
}

// Only owner/admin are valid global role keys.
{
  const response = await mutate(createDb(), 'owner-a', 'PUT', 'ordinary', 'super-admin');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_global_role', allowedRoles: ['owner', 'admin'] });
}

// Single-global-role model: no implicit admin -> owner replacement or dual role.
{
  const db = createDb();
  const response = await mutate(db, 'owner-a', 'PUT', 'admin-a', 'owner');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'global_role_conflict', globalRoles: ['admin'] });
  assert.deepEqual(rolesFor(db.state.globalRoles, 'admin-a'), ['admin']);
  assert.equal(db.state.audits.length, 0);
}

// Duplicate grant is idempotent and does not audit.
{
  const db = createDb();
  const response = await mutate(db, 'owner-a', 'PUT', 'admin-a', 'admin');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.changed, false);
  assert.deepEqual(payload.globalRoles, ['admin']);
  assert.equal(db.state.audits.length, 0);
}

// Missing revoke is idempotent and does not audit.
{
  const db = createDb();
  const response = await mutate(db, 'owner-a', 'DELETE', 'ordinary', 'admin');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.changed, false);
  assert.deepEqual(payload.globalRoles, []);
  assert.equal(db.state.audits.length, 0);
}

// Revoke captures deleted relation provenance before it is gone.
{
  const db = createDb();
  const original = { ...db.state.globalRoles.get('admin-a:admin') };
  const response = await mutate(db, 'owner-a', 'DELETE', 'admin-a', 'admin', 'phase-c-revoke-ray');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.changed, true);
  assert.deepEqual(payload.globalRoles, []);
  assert.equal(db.state.globalRoles.has('admin-a:admin'), false);
  assert.equal(db.state.audits.length, 1);
  assert.equal(db.state.audits[0].action, 'user.global_role.revoke');
  assert.equal(db.state.audits[0].entityType, 'user_global_role');
  assert.deepEqual(db.state.audits[0].details, {
    userId: 'admin-a',
    roleKey: 'admin',
    previousGlobalRoles: ['admin'],
    globalRoles: [],
    grantedBy: original.granted_by,
    grantedAt: original.granted_at,
    privilegeEscalation: false,
    activeOwnerCountBefore: 2,
    activeOwnerCountAfter: 2,
  });
}

// Concurrent cross-revoke must never reduce active owners to zero.
{
  const db = createDb();
  const [a, b] = await Promise.all([
    mutate(db, 'owner-a', 'DELETE', 'owner-b', 'owner'),
    mutate(db, 'owner-b', 'DELETE', 'owner-a', 'owner'),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 403]);
  const activeOwners = ['owner-a', 'owner-b'].filter((id) => rolesFor(db.state.globalRoles, id).includes('owner'));
  assert.equal(activeOwners.length, 1, 'atomic conditional revoke must preserve one active owner');
  assert.equal(db.state.audits.filter((event) => event.action === 'user.global_role.revoke').length, 1);
}

// Static contract: conditional writes re-check actor authority and last-owner count atomically.
assert.match(apiSource, /INSERT INTO user_global_roles[\s\S]*actor_user\.status='active'[\s\S]*actor_permission\.permission_key='users\.manage'[\s\S]*actor_permission\.permission_key='system\.manage'/);
assert.match(apiSource, /DELETE FROM user_global_roles[\s\S]*actor_user\.status='active'[\s\S]*actor_permission\.permission_key='users\.manage'[\s\S]*actor_permission\.permission_key='system\.manage'/);
assert.match(apiSource, /DELETE FROM user_global_roles[\s\S]*SELECT COUNT\(\*\)[\s\S]*role_key='owner'[\s\S]*> 1[\s\S]*RETURNING user_id, role_key, granted_by, granted_at/);
assert.doesNotMatch(apiSource, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+role_permissions/i);
assert.doesNotMatch(apiSource, /permission(?:s)?\s*\[/i);
assert.doesNotMatch(apiSource, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/);
assert.match(webEntrySource, /handleGlobalRoleGovernanceApiRoute/);
assert.match(webEntrySource, /GLOBAL_ROLE_GOVERNANCE_ROUTE_PATTERN/);
assert.match(webEntrySource, /global-roles/);

console.log(JSON.stringify({
  ok: true,
  module: 'access-global-role-governance',
  contracts: [
    'active-owner-users-manage-system-manage-required',
    'admin-cannot-mutate-global-role',
    'owner-can-mutate-other-user',
    'self-global-role-change-forbidden',
    'inactive-target-rejected',
    'unbound-target-rejected',
    'store-membership-conflict',
    'owner-admin-role-key-whitelist',
    'single-global-role-no-implicit-replace',
    'duplicate-grant-idempotent-no-audit',
    'missing-revoke-idempotent-no-audit',
    'grant-audit',
    'revoke-audit-with-relation-provenance',
    'atomic-last-owner-protection',
    'concurrent-cross-revoke-preserves-owner',
    'atomic-actor-authority-recheck',
    'no-role-permission-writes',
    'amazon-sync-isolation',
  ],
}));
