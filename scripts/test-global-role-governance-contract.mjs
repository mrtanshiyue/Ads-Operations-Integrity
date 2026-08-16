import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGlobalRoleGovernanceApiRoute } from '../cloudflare/runtime/global-role-governance-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/global-role-governance-api.js'), 'utf8');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');

function createDb({ secondOwner = true, failAudit = false } = {}) {
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
  let nextRowId = 1;
  setRole(globalRoles, 'owner-a', 'owner', 'bootstrap', '2026-08-16 01:00:00', nextRowId++);
  if (secondOwner) setRole(globalRoles, 'owner-b', 'owner', 'owner-a', '2026-08-16 02:00:00', nextRowId++);
  setRole(globalRoles, 'admin-a', 'admin', 'owner-a', '2026-08-16 03:00:00', nextRowId++);
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
    return [...globalRoles.values()].filter((relation) => (
      relation.role_key === 'owner' && users.get(relation.user_id)?.status === 'active'
    )).length;
  }

  function prepared(sql, params = []) {
    return {
      __sql: sql,
      __params: params,
      bind(...bound) { return prepared(sql, bound); },
      async first() {
        if (sql.includes('AS is_owner') && sql.includes('AS has_system_manage')) {
          return actorAuthority(params[0]);
        }
        if (sql.includes('store_membership_count') && sql.includes('global_roles_csv')) {
          return targetRow(params[0]);
        }
        if (sql.includes('rowid AS relation_rowid')) {
          const relation = globalRoles.get(`${params[0]}:${params[1]}`);
          return relation ? { ...relation } : null;
        }
        if (sql.includes('AS active_owner_count')) {
          return { active_owner_count: activeOwnerCount() };
        }
        throw new Error(`unexpected global-role first query: ${sql}`);
      },
    };
  }

  async function batch(statements) {
    const roleSnapshot = new Map([...globalRoles.entries()].map(([key, value]) => [key, { ...value }]));
    const auditSnapshot = audits.map((event) => structuredClone(event));
    const rowIdSnapshot = nextRowId;
    let previousChanges = 0;
    const results = [];
    try {
      for (const item of statements) {
        const sql = item.__sql;
        const params = item.__params;
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
          previousChanges = allowed ? 1 : 0;
          if (allowed) {
            setRole(globalRoles, userId, roleKey, actorUserId, '2026-08-16 12:30:00', nextRowId++);
          }
          results.push({ meta: { changes: previousChanges }, results: [] });
          continue;
        }
        if (sql.includes('DELETE FROM user_global_roles')) {
          const [userId, roleKey, actorUserId, relationRowId, grantedBy, grantedAt] = params;
          const relationKey = `${userId}:${roleKey}`;
          const relation = globalRoles.get(relationKey);
          const authority = actorAuthority(actorUserId);
          const target = users.get(userId);
          const matches = Boolean(relation)
            && Number(relation.relation_rowid) === Number(relationRowId)
            && (relation.granted_by ?? null) === (grantedBy ?? null)
            && relation.granted_at === grantedAt;
          const allowed = matches
            && authority.status === 'active'
            && Boolean(authority.is_owner)
            && Boolean(authority.has_users_manage)
            && Boolean(authority.has_system_manage)
            && !(roleKey === 'owner' && target?.status === 'active' && activeOwnerCount() <= 1);
          previousChanges = allowed ? 1 : 0;
          if (allowed) globalRoles.delete(relationKey);
          results.push({ meta: { changes: previousChanges }, results: [] });
          continue;
        }
        if (sql.includes('INSERT INTO audit_log')) {
          if (previousChanges !== 1) {
            previousChanges = 0;
            results.push({ meta: { changes: 0 }, results: [] });
            continue;
          }
          if (failAudit) throw new Error('injected_audit_failure');
          const isGrant = sql.includes('user.global_role.grant');
          const userId = params[5];
          const roleKey = params[6];
          const ownerCountAfter = activeOwnerCount();
          const details = isGrant ? {
            userId,
            roleKey,
            previousGlobalRoles: [],
            globalRoles: [roleKey],
            grantedBy: params[1],
            privilegeEscalation: true,
            activeOwnerCountBefore: ownerCountAfter - (roleKey === 'owner' ? 1 : 0),
            activeOwnerCountAfter: ownerCountAfter,
          } : {
            userId,
            roleKey,
            previousGlobalRoles: [roleKey],
            globalRoles: [],
            grantedBy: params[7],
            grantedAt: params[8],
            privilegeEscalation: false,
            activeOwnerCountBefore: ownerCountAfter + (roleKey === 'owner' ? 1 : 0),
            activeOwnerCountAfter: ownerCountAfter,
          };
          audits.push({
            eventId: params[0],
            actorUserId: params[1],
            action: isGrant ? 'user.global_role.grant' : 'user.global_role.revoke',
            entityType: 'user_global_role',
            entityId: params[2],
            requestId: params[3],
            cfRay: params[4],
            details,
          });
          previousChanges = 1;
          results.push({ meta: { changes: 1 }, results: [] });
          continue;
        }
        if (sql.includes('AS active_owner_count')) {
          results.push({ meta: { changes: 0 }, results: [{ active_owner_count: activeOwnerCount() }] });
          continue;
        }
        throw new Error(`unexpected global-role batch query: ${sql}`);
      }
      return results;
    } catch (error) {
      globalRoles.clear();
      for (const [key, value] of roleSnapshot) globalRoles.set(key, value);
      audits.splice(0, audits.length, ...auditSnapshot);
      nextRowId = rowIdSnapshot;
      throw error;
    }
  }

  return { state, prepare: (sql) => prepared(sql), batch };
}

function user(userId, email, displayName, status, cfAccessSub) {
  return { user_id: userId, email, display_name: displayName, status, cf_access_sub: cfAccessSub };
}

function setRole(map, userId, roleKey, grantedBy, grantedAt, relationRowId) {
  map.set(`${userId}:${roleKey}`, {
    relation_rowid: relationRowId,
    user_id: userId,
    role_key: roleKey,
    granted_by: grantedBy,
    granted_at: grantedAt,
  });
}

function rolesFor(map, userId) {
  return [...map.values()].filter((row) => row.user_id === userId).map((row) => row.role_key).sort();
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

for (const actorUserId of ['ordinary', 'admin-a']) {
  const db = createDb();
  const response = await mutate(db, actorUserId, 'PUT', 'ordinary', 'owner');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'forbidden', role: 'owner' });
  assert.equal(db.state.audits.length, 0);
}

{
  const db = createDb({ secondOwner: false });
  const response = await mutate(db, 'owner-a', 'PUT', 'ordinary', 'owner', 'phase1-grant-ray');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'phase1-grant-ray');
  const payload = await response.json();
  assert.equal(payload.changed, true);
  assert.deepEqual(payload.globalRoles, ['owner']);
  assert.equal(payload.activeOwnerCount, 2);
  assert.deepEqual(rolesFor(db.state.globalRoles, 'ordinary'), ['owner']);
  assert.equal(db.state.audits.length, 1);
  assert.equal(db.state.audits[0].action, 'user.global_role.grant');
  assert.deepEqual(db.state.audits[0].details, {
    userId: 'ordinary', roleKey: 'owner', previousGlobalRoles: [], globalRoles: ['owner'],
    grantedBy: 'owner-a', privilegeEscalation: true, activeOwnerCountBefore: 1, activeOwnerCountAfter: 2,
  });
}

for (const method of ['PUT', 'DELETE']) {
  const db = createDb();
  const response = await mutate(db, 'owner-a', method, 'owner-a', 'owner');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'self_global_role_change_forbidden' });
}

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

{
  const response = await mutate(createDb(), 'owner-a', 'PUT', 'ordinary', 'super-admin');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_global_role', allowedRoles: ['owner', 'admin'] });
}

{
  const db = createDb();
  const response = await mutate(db, 'owner-a', 'PUT', 'admin-a', 'owner');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'global_role_conflict', globalRoles: ['admin'] });
}

{
  const db = createDb();
  const response = await mutate(db, 'owner-a', 'PUT', 'admin-a', 'admin');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).changed, false);
  assert.equal(db.state.audits.length, 0);
}

{
  const db = createDb();
  const response = await mutate(db, 'owner-a', 'DELETE', 'ordinary', 'admin');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).changed, false);
  assert.equal(db.state.audits.length, 0);
}

{
  const db = createDb();
  const original = { ...db.state.globalRoles.get('admin-a:admin') };
  const response = await mutate(db, 'owner-a', 'DELETE', 'admin-a', 'admin', 'phase1-revoke-ray');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.changed, true);
  assert.deepEqual(payload.globalRoles, []);
  assert.equal(db.state.globalRoles.has('admin-a:admin'), false);
  assert.equal(db.state.audits.length, 1);
  assert.equal(db.state.audits[0].action, 'user.global_role.revoke');
  assert.deepEqual(db.state.audits[0].details, {
    userId: 'admin-a', roleKey: 'admin', previousGlobalRoles: ['admin'], globalRoles: [],
    grantedBy: original.granted_by, grantedAt: original.granted_at, privilegeEscalation: false,
    activeOwnerCountBefore: 2, activeOwnerCountAfter: 2,
  });
}

// Audit failure must roll back the privilege mutation in the same D1 batch transaction.
{
  const db = createDb({ secondOwner: false, failAudit: true });
  await assert.rejects(() => mutate(db, 'owner-a', 'PUT', 'ordinary', 'owner'), /injected_audit_failure/);
  assert.deepEqual(rolesFor(db.state.globalRoles, 'ordinary'), []);
  assert.equal(db.state.audits.length, 0);
}

{
  const db = createDb({ failAudit: true });
  const before = { ...db.state.globalRoles.get('admin-a:admin') };
  await assert.rejects(() => mutate(db, 'owner-a', 'DELETE', 'admin-a', 'admin'), /injected_audit_failure/);
  assert.deepEqual(db.state.globalRoles.get('admin-a:admin'), before);
  assert.equal(db.state.audits.length, 0);
}

// Concurrent cross-revoke must never reduce active owners to zero; the losing actor is re-evaluated.
{
  const db = createDb();
  const [a, b] = await Promise.all([
    mutate(db, 'owner-a', 'DELETE', 'owner-b', 'owner'),
    mutate(db, 'owner-b', 'DELETE', 'owner-a', 'owner'),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 403]);
  assert.equal(['owner-a', 'owner-b'].filter((id) => rolesFor(db.state.globalRoles, id).includes('owner')).length, 1);
  assert.equal(db.state.audits.filter((event) => event.action === 'user.global_role.revoke').length, 1);
}

// Production must fail closed rather than silently fall back to sequential mutation + audit writes.
{
  const db = createDb();
  delete db.batch;
  await assert.rejects(() => mutate(db, 'owner-a', 'PUT', 'ordinary', 'admin'), /control_d1_atomic_batch_required/);
}

assert.match(apiSource, /requireAtomicBatch\(db\)/);
assert.match(apiSource, /await db\.batch\(\[/);
assert.match(apiSource, /INSERT INTO audit_log[\s\S]*WHERE changes\(\)=1/);
assert.match(apiSource, /rowid AS relation_rowid/);
assert.match(apiSource, /DELETE FROM user_global_roles[\s\S]*rowid=\?4[\s\S]*granted_by IS \?5[\s\S]*granted_at=\?6/);
assert.match(apiSource, /DELETE FROM user_global_roles[\s\S]*actor_user\.status='active'[\s\S]*permission_key='users\.manage'[\s\S]*permission_key='system\.manage'/);
assert.match(apiSource, /DELETE FROM user_global_roles[\s\S]*SELECT COUNT\(\*\)[\s\S]*role_key='owner'[\s\S]*> 1/);
assert.doesNotMatch(apiSource, /async function audit\(/);
assert.doesNotMatch(apiSource, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+role_permissions/i);
assert.doesNotMatch(apiSource, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/);
assert.match(webEntrySource, /handleGlobalRoleGovernanceApiRoute/);
assert.match(webEntrySource, /GLOBAL_ROLE_GOVERNANCE_ROUTE_PATTERN/);

console.log(JSON.stringify({
  ok: true,
  module: 'access-global-role-governance',
  contracts: [
    'active-owner-users-manage-system-manage-required',
    'admin-cannot-mutate-global-role',
    'owner-can-mutate-other-user',
    'self-global-role-change-forbidden',
    'inactive-unbound-store-conflict-targets-rejected',
    'owner-admin-role-key-whitelist',
    'single-global-role-no-implicit-replace',
    'idempotent-no-op-no-audit',
    'grant-audit-atomic-batch',
    'revoke-audit-atomic-batch',
    'audit-failure-rolls-back-grant',
    'audit-failure-rolls-back-revoke',
    'revoke-provenance-row-guard',
    'concurrent-last-owner-protection',
    'atomic-batch-required-no-sequential-fallback',
    'amazon-sync-isolation',
  ],
}));
