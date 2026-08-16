import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS,
  AMAZON_ADS_CREDENTIAL_SMOKE_PATH,
  buildAmazonAdsCredentialSmokeMessage,
  handleAmazonAdsCredentialSmoke,
} from '../cloudflare/runtime/amazon-ads-credential-smoke.js';

const tag = '0123456789abcdef0123456789abcdef01234567';
const refreshToken = 'refresh-token-value';
const now = 1786846500000;
const env = Object.freeze({
  APP_ENV:'development',
  AMAZON_ADS_ENABLED:'false',
  AMAZON_ADS_CLIENT_ID:'client-id',
  AMAZON_ADS_CLIENT_SECRET:'client-secret',
  AMAZON_ADS_REFRESH_TOKEN:refreshToken,
  CF_VERSION_METADATA:{ id:'version-1', tag, timestamp:'2026-08-16T02:15:00Z' },
});

function proofFor(timestamp = now, token = refreshToken) {
  const message = buildAmazonAdsCredentialSmokeMessage({ tag, timestamp });
  return createHmac('sha256', token).update(message).digest('hex');
}

function requestFor({ method='POST', timestamp=now, proof=proofFor(timestamp) } = {}) {
  return new Request(`https://sync.example${AMAZON_ADS_CREDENTIAL_SMOKE_PATH}`, {
    method,
    headers:{
      [AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS.timestamp]:String(timestamp),
      [AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS.proof]:proof,
    },
  });
}

let providerCalls = 0;
const credentialProviderFactory = () => ({
  async getAccessToken() {
    providerCalls += 1;
    return 'ACCESS_TOKEN_MUST_NEVER_LEAVE_WORKER';
  },
});

{
  const response = await handleAmazonAdsCredentialSmoke(requestFor(), env, {
    now:() => now,
    credentialProviderFactory,
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes('ACCESS_TOKEN_MUST_NEVER_LEAVE_WORKER'), false);
  assert.equal(text.includes(refreshToken), false);
  const payload = JSON.parse(text);
  assert.equal(payload.ok, true);
  assert.equal(payload.amazonAdsEnabled, false);
  assert.equal(payload.runtimeVersion.tag, tag);
  assert.equal(payload.credentialSmoke.lwaTokenRefresh, 'pass');
  assert.deepEqual(payload.credentialSmoke.sideEffects, {
    createReport:false,
    pollReport:false,
    downloadReport:false,
    d1Write:false,
    r2Write:false,
  });
  assert.equal(providerCalls, 1);
}

for (const testCase of [
  { request:requestFor({ proof:'0'.repeat(64) }), status:403 },
  { request:requestFor({ timestamp:now - 31_000, proof:proofFor(now - 31_000) }), status:401 },
  { request:requestFor({ method:'GET' }), status:405 },
]) {
  const response = await handleAmazonAdsCredentialSmoke(testCase.request, env, {
    now:() => now,
    credentialProviderFactory,
  });
  assert.equal(response.status, testCase.status);
}
assert.equal(providerCalls, 1);

{
  const response = await handleAmazonAdsCredentialSmoke(requestFor(), {
    ...env,
    AMAZON_ADS_ENABLED:'true',
  }, {
    now:() => now,
    credentialProviderFactory,
  });
  assert.equal(response.status, 409);
  assert.equal(providerCalls, 1);
}

{
  const response = await handleAmazonAdsCredentialSmoke(requestFor(), {
    ...env,
    APP_ENV:'production',
  }, {
    now:() => now,
    credentialProviderFactory,
  });
  assert.equal(response.status, 404);
  assert.equal(providerCalls, 1);
}

{
  const response = await handleAmazonAdsCredentialSmoke(requestFor(), {
    ...env,
    AMAZON_ADS_REFRESH_TOKEN:'',
  }, {
    now:() => now,
    credentialProviderFactory,
  });
  assert.equal(response.status, 503);
  assert.equal(providerCalls, 1);
}

{
  const response = await handleAmazonAdsCredentialSmoke(requestFor(), env, {
    now:() => now,
    credentialProviderFactory:() => ({
      async getAccessToken() {
        throw Object.assign(new Error('AMAZON_ADS_TOKEN_HTTP_ERROR'), {
          code:'AMAZON_ADS_TOKEN_HTTP_ERROR',
          httpStatus:400,
          retryable:false,
        });
      },
    }),
  });
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.errorCode, 'credential_smoke_lwa_refresh_failed');
  assert.equal(payload.providerCode, 'AMAZON_ADS_TOKEN_HTTP_ERROR');
  assert.equal(payload.providerHttpStatus, 400);
}

console.log('Amazon Ads credential-only smoke tests: PASS');
