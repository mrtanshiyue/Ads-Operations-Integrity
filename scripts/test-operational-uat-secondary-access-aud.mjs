import assert from 'node:assert/strict';
import {
  accessRuntimeConfig,
  evaluateAccessIdentity,
  operationalUatAccessScope,
} from '../src/access.js';

const PRIMARY_AUD = '4cb87cb838507ac2e774cff9fdb6f53c6bbd2bc2db1ab0d9a2d1e04a9e5b1da8';
const UAT_AUD = 'b86d09befdfc53ffbf72a9a13f1db537e290aed444077df92635b129d1dd7337';
const TEAM_DOMAIN = 'https://example.cloudflareaccess.com';
const UAT_URL = 'https://worker.example/api/v1/operational-uat/live-probe';
const NORMAL_URL = 'https://worker.example/api/v1/stores/store-01/analytics';
const KID = 'operational-uat-test-key';

const keyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
publicJwk.kid = KID;
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  assert.equal(String(input), `${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

try {
  const env = {
    APP_ENV: 'production',
    ACCESS_MODE: 'enforce',
    TEAM_DOMAIN,
    ACCESS_AUD: PRIMARY_AUD,
    OPERATIONAL_UAT_ACCESS_AUD: UAT_AUD,
  };

  assert.deepEqual(
    operationalUatAccessScope(new Request(UAT_URL), env),
    { isOperationalUat: true, audience: UAT_AUD },
  );
  assert.deepEqual(
    operationalUatAccessScope(new Request(NORMAL_URL), env),
    { isOperationalUat: false, audience: null },
  );
  assert.equal(accessRuntimeConfig(env).audience, PRIMARY_AUD);
  assert.equal(accessRuntimeConfig(env, { audience: UAT_AUD }).audience, UAT_AUD);

  const serviceSecondary = await evaluateAccessIdentity(
    requestWithJwt(UAT_URL, await signJwt({ aud: [UAT_AUD], common_name: 'uat-service-client.access', sub: '' })),
    env,
  );
  assert.equal(serviceSecondary.authenticated, true);
  assert.equal(serviceSecondary.identity?.principalType, 'service_token');
  assert.equal(serviceSecondary.identity?.sub, 'uat-service-client.access');

  const servicePrimary = await evaluateAccessIdentity(
    requestWithJwt(UAT_URL, await signJwt({ aud: [PRIMARY_AUD], common_name: 'uat-service-client.access', sub: '' })),
    env,
  );
  assert.equal(servicePrimary.authenticated, false);
  assert.equal(servicePrimary.error, 'invalid_token');

  const userSecondary = await evaluateAccessIdentity(
    requestWithJwt(UAT_URL, await signJwt({ aud: [UAT_AUD], sub: 'human-user-sub', email: 'human@example.test' })),
    env,
  );
  assert.equal(userSecondary.authenticated, false);
  assert.equal(userSecondary.error, 'invalid_token');

  const userPrimaryNormal = await evaluateAccessIdentity(
    requestWithJwt(NORMAL_URL, await signJwt({ aud: [PRIMARY_AUD], sub: 'human-user-sub', email: 'human@example.test' })),
    env,
  );
  assert.equal(userPrimaryNormal.authenticated, true);
  assert.equal(userPrimaryNormal.identity?.principalType, 'user');

  const missingSecondaryEnv = { ...env };
  delete missingSecondaryEnv.OPERATIONAL_UAT_ACCESS_AUD;
  const failClosed = await evaluateAccessIdentity(
    requestWithJwt(UAT_URL, await signJwt({ aud: [PRIMARY_AUD], common_name: 'uat-service-client.access', sub: '' })),
    missingSecondaryEnv,
  );
  assert.equal(failClosed.configured, false);
  assert.equal(failClosed.authenticated, false);
  assert.equal(failClosed.error, 'not_configured');

  console.log(JSON.stringify({
    ok: true,
    contract: 'operational-uat-secondary-access-aud',
    uatSecondaryServiceTokenAccepted: true,
    uatPrimaryAudienceRejected: true,
    uatHumanPrincipalRejected: true,
    normalPrimaryHumanPrincipalPreserved: true,
    missingSecondaryAudienceFailsClosed: true,
    amazonExecutionAttempted: false,
  }));
} finally {
  globalThis.fetch = originalFetch;
}

function requestWithJwt(url, token) {
  return new Request(url, { headers: { 'cf-access-jwt-assertion': token } });
}

async function signJwt(extraPayload) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlJson({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const payload = base64urlJson({
    iss: TEAM_DOMAIN,
    iat: now - 1,
    nbf: now - 1,
    exp: now + 300,
    type: 'app',
    ...extraPayload,
  });
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, data));
  return `${header}.${bytesToBase64url(signature)}`;
}

function base64urlJson(value) {
  return bytesToBase64url(new TextEncoder().encode(JSON.stringify(value)));
}

function bytesToBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
