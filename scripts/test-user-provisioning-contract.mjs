import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAccessGovernanceApiRoute } from '../cloudflare/runtime/access-governance-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/access-governance-api.js'), 'utf8');
const nativeApiSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-api-v1.js'), 'utf8');

function createDb({ permissions = ['users.manage'] } = {}) {
  const users = new Map([
    ['user-owner', {
      user_id: 'user-owner',
      cf_access_sub: 'owner-sub',
      email: 'owner@example.test',
      email_norm: 'owner@example.test',
      display_name: 'Owner',
      status: 'active',
      last_seen_at: '2026-08-16 10:00:00',
      created_at: '2026-08-10 10:00:00',
      updated_at: '2026-08-16 10:00:00',
      global_roles_csv: 'owner',
    }],
  ]);
  const state = { users, audits: [] };

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
              throw new Error(`unexpected provisioning first query: ${sql}`);
            },
            async run() {
              if (sql.includes('INSERT INTO users(')) {
                const [userId, email, emailNorm, displayName] = params;
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
                  created_at: '2026-08-16 11:10:00',
                  updated_at: '2026-08-16 11:10:00',
                  global_roles_csv: null,
                });
                return { success: true };
              }
              if (sql.includes('INSERT INTO audit_log')) {
                state.audits.push({
                  actorUserId: params[1],
                  storeId: params[2],
                  action: params[3],
                  entityType: params[4],
                  entityId: params[5],
                  requestId: params[6],
                  cfRay: params[7],
                  details: JSON.parse(params[8]),
                });
                return { success: true };
              }
              throw new Error(`unexpected provisioning write query: ${sql}`);
            },
          };
        },
      };
    },
  };
}

const actor = { user_id: 'user-owner' };
const db = createDb();

const createRequest = new Request('https://example.test/api/v1/access/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-ray': 'user-provision-ray' },
  body: JSON.stringify({
    email: ' New.User@Example.COM ',
    displayName: ' New User ',
  }),
});
const createResponse = await handleAccessGovernanceApiRoute({
  request: createRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(createRequest.url),
});
assert.equal(createResponse.status, 201);
assert.equal(createResponse.headers.get('cache-control'), 'no-store');
assert.equal(createResponse.headers.get('x-request-id'), 'user-provision-ray');
const created = await createResponse.json();
assert.equal(created.user.email, 'new.user@example.com');
assert.equal(created.user.displayName, 'New User');
assert.equal(created.user.status, 'active');
assert.equal(created.user.cfAccessBound, false);
assert.deepEqual(created.user.globalRoles, []);
assert.equal(db.state.audits.length, 1);
assert.equal(db.state.audits[0].action, 'user.provision');
assert.equal(db.state.audits[0].entityType, 'user');
assert.equal(db.state.audits[0].storeId, null);
assert.equal(db.state.audits[0].details.email, 'new.user@example.com');
assert.equal(db.state.audits[0].details.cfAccessBound, false);
assert.equal('globalRoles' in db.state.audits[0].details, false);

const duplicateRequest = new Request('https://example.test/api/v1/access/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'NEW.USER@example.com' }),
});
const duplicateResponse = await handleAccessGovernanceApiRoute({
  request: duplicateRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(duplicateRequest.url),
});
assert.equal(duplicateResponse.status, 409);
assert.deepEqual(await duplicateResponse.json(), { error: 'user_email_conflict' });

for (const body of [
  { email: 'elevate@example.com', globalRoles: ['owner'] },
  { email: 'disabled@example.com', status: 'disabled' },
  { email: 'role@example.com', roleKey: 'owner' },
]) {
  const request = new Request('https://example.test/api/v1/access/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await handleAccessGovernanceApiRoute({
    request,
    env: { CONTROL_DB: createDb() },
    actor,
    url: new URL(request.url),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'unsupported_user_provision_field' });
}

for (const email of ['bad', 'a@@example.com', 'a@example', 'a..b@example.com', 'a@-example.com']) {
  const request = new Request('https://example.test/api/v1/access/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const response = await handleAccessGovernanceApiRoute({
    request,
    env: { CONTROL_DB: createDb() },
    actor,
    url: new URL(request.url),
  });
  assert.equal(response.status, 400, email);
  assert.deepEqual(await response.json(), { error: 'invalid_user_email' });
}

const deniedRequest = new Request('https://example.test/api/v1/access/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'denied@example.com' }),
});
const deniedResponse = await handleAccessGovernanceApiRoute({
  request: deniedRequest,
  env: { CONTROL_DB: createDb({ permissions: [] }) },
  actor: { user_id: 'user-no-access' },
  url: new URL(deniedRequest.url),
});
assert.equal(deniedResponse.status, 403);
assert.deepEqual(await deniedResponse.json(), { error: 'forbidden', permission: 'users.manage' });

assert.match(apiSource, /user\.provision/);
assert.match(apiSource, /cf_access_sub, email, email_norm/);
assert.match(nativeApiSource, /createAccessUser:\s*\(body\).*method:\s*'POST'/s);
assert.doesNotMatch(apiSource, /INSERT INTO\s+user_global_roles/i);
assert.doesNotMatch(apiSource, /DELETE FROM\s+user_global_roles/i);
assert.doesNotMatch(apiSource, /UPDATE\s+user_global_roles/i);
assert.doesNotMatch(apiSource, /DELETE FROM\s+users/i);
assert.doesNotMatch(apiSource, /UPDATE\s+users\s+SET\s+status/i);
assert.doesNotMatch(apiSource, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED/);

console.log(JSON.stringify({
  ok: true,
  module: 'access-user-provisioning',
  contracts: [
    'users-manage-required',
    'normalized-email-provisioning',
    'cf-access-unbound-until-first-login',
    'active-status-fixed',
    'no-global-role-grant',
    'no-user-lifecycle-mutation',
    'duplicate-email-conflict',
    'audit-user-provision',
    'native-client-create-user',
    'amazon-sync-isolation',
  ],
}));
