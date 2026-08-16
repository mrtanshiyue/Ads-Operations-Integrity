import assert from 'node:assert/strict';
import { createTestHarness } from 'wrangler';

await import('./test-security-integrity-request-pipeline-contract.mjs');

const TEAM_DOMAIN = 'https://security-test.cloudflareaccess.com';
const ACCESS_AUD = 'security-test-audience';
const KID = 'security-test-key-1';

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const attackerKeys = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
Object.assign(publicJwk, { kid: KID, alg: 'RS256', use: 'sig' });

const server = createTestHarness({
  workers: [{ configPath: './cloudflare/runtime/wrangler.access-integration-test.jsonc' }],
});

await server.listen();
const originalFetch = globalThis.fetch;
let jwksFetchCount = 0;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (request.url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
    jwksFetchCount += 1;
    return Response.json({ keys: [publicJwk] });
  }
  throw new Error(`unexpected_outbound_request:${request.method}:${request.url}`);
};

try {
  const worker = server.getWorker('ads-operations-web-access-integration-test');
  await worker.applyD1Migrations('CONTROL_DB');
  const env = await worker.getEnv();
  const db = env.CONTROL_DB;
  await seed(db);

  await assertMissingJwt(worker);
  await assertInvalidSignature(worker, attackerKeys.privateKey);
  await assertInvalidAudience(worker, privateKey);
  await assertSubjectMismatch(worker, privateKey);
  await assertFirstBind(worker, db, privateKey);
  await assertDisabledUserDenied(worker, privateKey);
  await assertOwnerGovernanceMutation(worker, db, privateKey);

  assert.ok(jwksFetchCount >= 1, 'full request pipeline must fetch Access JWKS');

  console.log(JSON.stringify({
    ok: true,
    module: 'access-web-worker-real-request-pipeline',
    realWebEntry: true,
    realLocalD1: true,
    realRs256Jwt: true,
    jwksOutboundMockedAtNodeBoundary: true,
    missingJwtDenied: true,
    invalidSignatureDenied: true,
    invalidAudienceDenied: true,
    subjectMismatchDenied: true,
    firstBindVerified: true,
    disabledUserDenied: true,
    ownerGovernanceMutationVerified: true,
    governanceAuditVerified: true,
    remoteD1Touched: false,
  }));
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}

async function seed(db) {
  const users = [
    ['owner-request', 'sub-owner-request', 'owner-request@example.invalid', 'Owner Request', 'active'],
    ['mismatch-user', 'sub-mismatch-old', 'mismatch@example.invalid', 'Mismatch User', 'active'],
    ['unbound-user', null, 'unbound@example.invalid', 'Unbound User', 'active'],
    ['disabled-user', 'sub-disabled-user', 'disabled@example.invalid', 'Disabled User', 'disabled'],
    ['role-target', 'sub-role-target', 'role-target@example.invalid', 'Role Target', 'active'],
  ];
  for (const [userId, sub, email, displayName, status] of users) {
    await db.prepare(`
      INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status)
      VALUES(?1,?2,?3,?3,?4,?5)
    `).bind(userId, sub, email, displayName, status).run();
  }
  await db.prepare(`
    INSERT INTO user_global_roles(user_id,role_key,granted_by)
    VALUES('owner-request','owner','owner-request')
  `).run();
}

async function assertMissingJwt(worker) {
  const response = await worker.fetch('http://worker.test/api/v1/access/roles');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'access_denied', reason: 'missing_token' });
}

async function assertInvalidSignature(worker, signingKey) {
  const token = await signJwt(signingKey, {
    sub: 'sub-owner-request',
    email: 'owner-request@example.invalid',
  });
  const response = await requestWithJwt(worker, 'GET', '/api/v1/access/roles', token);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'access_denied', reason: 'invalid_token' });
}

async function assertInvalidAudience(worker, signingKey) {
  const token = await signJwt(signingKey, {
    sub: 'sub-owner-request',
    email: 'owner-request@example.invalid',
    aud: 'wrong-audience',
  });
  const response = await requestWithJwt(worker, 'GET', '/api/v1/access/roles', token);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'access_denied', reason: 'invalid_token' });
}

async function assertSubjectMismatch(worker, signingKey) {
  const token = await signJwt(signingKey, {
    sub: 'sub-mismatch-new',
    email: 'mismatch@example.invalid',
  });
  const response = await requestWithJwt(worker, 'GET', '/api/v1/access/roles', token);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'access_subject_mismatch' });
}

async function assertFirstBind(worker, db, signingKey) {
  const token = await signJwt(signingKey, {
    sub: 'sub-unbound-first-bind',
    email: 'unbound@example.invalid',
  });
  const response = await requestWithJwt(worker, 'GET', '/api/v1/access/roles', token);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'forbidden', permission: 'users.manage' });
  const row = await db.prepare(`
    SELECT cf_access_sub,status FROM users WHERE user_id='unbound-user'
  `).first();
  assert.equal(row?.cf_access_sub, 'sub-unbound-first-bind');
  assert.equal(row?.status, 'active');
}

async function assertDisabledUserDenied(worker, signingKey) {
  const token = await signJwt(signingKey, {
    sub: 'sub-disabled-user',
    email: 'disabled@example.invalid',
  });
  const response = await requestWithJwt(worker, 'GET', '/api/v1/access/roles', token);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'app_user_not_provisioned' });
}

async function assertOwnerGovernanceMutation(worker, db, signingKey) {
  const token = await signJwt(signingKey, {
    sub: 'sub-owner-request',
    email: 'owner-request@example.invalid',
  });
  const response = await requestWithJwt(
    worker,
    'PUT',
    '/api/v1/access/users/role-target/global-roles/admin',
    token,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.changed, true);
  assert.deepEqual(payload.globalRoles, ['admin']);

  const role = await db.prepare(`
    SELECT role_key,granted_by FROM user_global_roles
    WHERE user_id='role-target' AND role_key='admin'
  `).first();
  assert.equal(role?.role_key, 'admin');
  assert.equal(role?.granted_by, 'owner-request');

  const audit = await db.prepare(`
    SELECT actor_user_id,action,entity_type,entity_id,details_json
    FROM audit_log
    WHERE action='user.global_role.grant'
      AND entity_id='role-target:admin'
    ORDER BY occurred_at DESC
    LIMIT 1
  `).first();
  assert.equal(audit?.actor_user_id, 'owner-request');
  assert.equal(audit?.action, 'user.global_role.grant');
  assert.equal(audit?.entity_type, 'user_global_role');
  assert.equal(audit?.entity_id, 'role-target:admin');
  const details = JSON.parse(audit?.details_json || '{}');
  assert.equal(details.userId, 'role-target');
  assert.equal(details.roleKey, 'admin');
  assert.equal(details.privilegeEscalation, true);
}

async function requestWithJwt(worker, method, pathname, token) {
  return worker.fetch(`http://worker.test${pathname}`, {
    method,
    headers: {
      'cf-access-jwt-assertion': token,
      'cf-ray': `security-integration-${Math.random().toString(16).slice(2)}`,
      ...(method === 'PUT' || method === 'PATCH' || method === 'POST'
        ? { 'content-type': 'application/json' }
        : {}),
    },
  });
}

async function signJwt(signingKey, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const payload = {
    iss: TEAM_DOMAIN,
    aud: ACCESS_AUD,
    sub: 'sub-owner-request',
    email: 'owner-request@example.invalid',
    nbf: now - 5,
    exp: now + 300,
    ...overrides,
  };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
