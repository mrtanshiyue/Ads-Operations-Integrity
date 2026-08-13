import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  accessRuntimeConfig,
  evaluateAccessIdentity,
  normalizeAccessMode,
} from '../src/access.js';

const TEAM_DOMAIN = 'https://phase2b-unit.cloudflareaccess.com';
const ACCESS_AUD = 'phase2b-audience';

assert.equal(normalizeAccessMode({}), 'off');
assert.equal(normalizeAccessMode({ ACCESS_MODE: 'OBSERVE' }), 'observe');
assert.equal(normalizeAccessMode({ ACCESS_MODE: 'enforce' }), 'enforce');
assert.equal(normalizeAccessMode({ ACCESS_MODE: 'unexpected' }), 'off');
assert.deepEqual(
  accessRuntimeConfig({ ACCESS_MODE: 'observe' }),
  { mode: 'observe', configured: false, teamDomain: '', audience: '' },
);
assert.equal(
  accessRuntimeConfig({ ACCESS_MODE: 'observe', TEAM_DOMAIN, ACCESS_AUD }).configured,
  true,
);
assert.equal(
  accessRuntimeConfig({ ACCESS_MODE: 'observe', TEAM_DOMAIN: 'https://example.com', ACCESS_AUD }).configured,
  false,
);

const keyPair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
Object.assign(jwk, { kid: 'phase2b-test-key', alg: 'RS256', use: 'sig' });

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function signJwt(payload) {
  const header = encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' });
  const body = encode(payload);
  const signingInput = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

const now = Math.floor(Date.now() / 1000);
const validToken = await signJwt({
  iss: TEAM_DOMAIN,
  aud: [ACCESS_AUD],
  sub: 'access-user-123',
  email: 'Operator@Example.com',
  iat: now,
  exp: now + 600,
});
const wrongAudienceToken = await signJwt({
  iss: TEAM_DOMAIN,
  aud: ['wrong-audience'],
  sub: 'access-user-123',
  email: 'Operator@Example.com',
  iat: now,
  exp: now + 600,
});

const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = String(input);
  if (url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`Unexpected network request in Access unit test: ${url}`);
};

try {
  const offContext = await evaluateAccessIdentity(
    new Request('https://example.test/api/v1/health'),
    { ACCESS_MODE: 'off' },
  );
  assert.equal(offContext.mode, 'off');
  assert.equal(offContext.authenticated, false);
  assert.equal(offContext.error, null);

  const observeMissing = await evaluateAccessIdentity(
    new Request('https://example.test/api/v1/health'),
    { ACCESS_MODE: 'observe', TEAM_DOMAIN, ACCESS_AUD },
  );
  assert.equal(observeMissing.authenticated, false);
  assert.equal(observeMissing.error, 'missing_token');

  const observeValid = await evaluateAccessIdentity(
    new Request('https://example.test/api/v1/health', {
      headers: { 'cf-access-jwt-assertion': validToken },
    }),
    { ACCESS_MODE: 'observe', TEAM_DOMAIN, ACCESS_AUD },
  );
  assert.equal(observeValid.authenticated, true);
  assert.equal(observeValid.identity.sub, 'access-user-123');
  assert.equal(observeValid.identity.email, 'operator@example.com');

  const observeInvalid = await evaluateAccessIdentity(
    new Request('https://example.test/api/v1/health', {
      headers: { 'cf-access-jwt-assertion': wrongAudienceToken },
    }),
    { ACCESS_MODE: 'observe', TEAM_DOMAIN, ACCESS_AUD },
  );
  assert.equal(observeInvalid.authenticated, false);
  assert.equal(observeInvalid.error, 'invalid_token');

  let warehouseCalls = 0;
  let capturedRequest = null;
  const warehouse = {
    async fetch(request) {
      warehouseCalls += 1;
      capturedRequest = request;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };

  const offResponse = await worker.fetch(
    new Request('https://example.test/api/v1/health', {
      headers: {
        authorization: 'Bearer shared-password-still-required',
        'x-ops-user-sub': 'spoofed-sub',
        'x-ops-user-email': 'spoofed@example.com',
        'x-ops-request-id': 'spoofed-request-id',
        'x-ops-auth-source': 'spoofed-source',
        origin: 'https://browser.example',
      },
    }),
    { ACCESS_MODE: 'off', WAREHOUSE: warehouse },
  );
  assert.equal(offResponse.status, 200);
  assert.equal(warehouseCalls, 1);
  assert.equal(capturedRequest.headers.get('authorization'), 'Bearer shared-password-still-required');
  assert.equal(capturedRequest.headers.get('origin'), null);
  assert.equal(capturedRequest.headers.get('x-ops-user-sub'), null);
  assert.equal(capturedRequest.headers.get('x-ops-user-email'), null);
  assert.equal(capturedRequest.headers.get('x-ops-auth-source'), null);
  assert.notEqual(capturedRequest.headers.get('x-ops-request-id'), 'spoofed-request-id');

  const observeResponse = await worker.fetch(
    new Request('https://example.test/api/v1/health', {
      headers: {
        authorization: 'Bearer shared-password-still-required',
        'cf-access-jwt-assertion': validToken,
        'x-ops-user-sub': 'spoofed-sub',
      },
    }),
    { ACCESS_MODE: 'observe', TEAM_DOMAIN, ACCESS_AUD, WAREHOUSE: warehouse },
  );
  assert.equal(observeResponse.status, 200);
  assert.equal(warehouseCalls, 2);
  assert.equal(capturedRequest.headers.get('authorization'), 'Bearer shared-password-still-required');
  assert.equal(capturedRequest.headers.get('cf-access-jwt-assertion'), null);
  assert.equal(capturedRequest.headers.get('x-ops-user-sub'), 'access-user-123');
  assert.equal(capturedRequest.headers.get('x-ops-user-email'), 'operator@example.com');
  assert.equal(capturedRequest.headers.get('x-ops-auth-source'), 'cloudflare-access');

  const enforceResponse = await worker.fetch(
    new Request('https://example.test/api/v1/health', {
      headers: { authorization: 'Bearer shared-password-still-required' },
    }),
    { ACCESS_MODE: 'enforce', TEAM_DOMAIN, ACCESS_AUD, WAREHOUSE: warehouse },
  );
  assert.equal(enforceResponse.status, 401);
  assert.equal(warehouseCalls, 2, 'Enforce mode must reject missing Access identity before Warehouse');
  assert.equal((await enforceResponse.json()).error, 'ACCESS_REQUIRED');

  const sessionResponse = await worker.fetch(
    new Request('https://example.test/api/_auth/session', {
      headers: { 'cf-access-jwt-assertion': validToken },
    }),
    { ACCESS_MODE: 'observe', TEAM_DOMAIN, ACCESS_AUD, WAREHOUSE: warehouse },
  );
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.access.authenticated, true);
  assert.deepEqual(session.user, {
    sub: 'access-user-123',
    email: 'operator@example.com',
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Cloudflare Access Phase 2B identity contracts passed');
