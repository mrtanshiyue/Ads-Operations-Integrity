import assert from 'node:assert/strict';
import {
  AMAZON_ADS_CREDENTIAL_BINDINGS,
  AmazonAdsCredentialProviderError,
  createAmazonAdsAccessTokenProvider,
  createAmazonAdsAccessTokenProviderFromEnv,
} from '../cloudflare/runtime/amazon-ads-credential-provider.js';

async function testEnvBindingAndCache() {
  let calls = 0;
  let nowMs = 1_700_000_000_000;
  const requests = [];
  const provider = createAmazonAdsAccessTokenProviderFromEnv({
    [AMAZON_ADS_CREDENTIAL_BINDINGS.clientId]:'client-id',
    [AMAZON_ADS_CREDENTIAL_BINDINGS.clientSecret]:'client-secret',
    [AMAZON_ADS_CREDENTIAL_BINDINGS.refreshToken]:'refresh-token',
  }, {
    now:() => nowMs,
    fetchImpl:async (url, init) => {
      calls += 1;
      requests.push({ url, init });
      return new Response(JSON.stringify({ access_token:`access-${calls}`, expires_in:3600 }), {
        status:200,
        headers:{ 'content-type':'application/json' },
      });
    },
  });

  assert.equal(await provider.getAccessToken(), 'access-1');
  assert.equal(await provider.getAccessToken(), 'access-1');
  assert.equal(calls, 1);
  assert.equal(requests[0].url, 'https://api.amazon.com/auth/o2/token');
  assert.equal(requests[0].init.method, 'POST');
  const body = new URLSearchParams(requests[0].init.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'refresh-token');
  assert.equal(body.get('client_id'), 'client-id');
  assert.equal(body.get('client_secret'), 'client-secret');

  nowMs += 3_550_000;
  assert.equal(await provider.getAccessToken(), 'access-2');
  assert.equal(calls, 2);
}

async function testRefreshCoalescing() {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const provider = createAmazonAdsAccessTokenProvider({
    clientId:'client-id',
    clientSecret:'client-secret',
    refreshToken:'refresh-token',
    fetchImpl:async () => {
      calls += 1;
      await blocked;
      return Response.json({ access_token:'coalesced-token', expires_in:3600 });
    },
  });
  const first = provider.getAccessToken();
  const second = provider.getAccessToken();
  release();
  assert.deepEqual(await Promise.all([first, second]), ['coalesced-token', 'coalesced-token']);
  assert.equal(calls, 1);
}

async function testSafeRetryHonorsRetryAfter() {
  let calls = 0;
  const sleeps = [];
  const provider = createAmazonAdsAccessTokenProvider({
    clientId:'client-id',
    clientSecret:'client-secret',
    refreshToken:'refresh-token',
    maxRetries:2,
    sleep:async (ms) => { sleeps.push(ms); },
    fetchImpl:async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status:429, headers:{ 'retry-after':'1' } });
      return Response.json({ access_token:'retried-token', expires_in:3600 });
    },
  });
  assert.equal(await provider.getAccessToken(), 'retried-token');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
}

async function testKnownHttpFailureDoesNotLeakResponseBody() {
  const provider = createAmazonAdsAccessTokenProvider({
    clientId:'secret-client',
    clientSecret:'secret-value',
    refreshToken:'secret-refresh',
    maxRetries:0,
    fetchImpl:async () => Response.json({ error:'invalid_client', error_description:'secret-refresh' }, { status:400 }),
  });
  await assert.rejects(provider.getAccessToken(), (error) => {
    assert.ok(error instanceof AmazonAdsCredentialProviderError);
    assert.equal(error.code, 'AMAZON_ADS_TOKEN_HTTP_ERROR');
    assert.equal(error.httpStatus, 400);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
}

await testEnvBindingAndCache();
await testRefreshCoalescing();
await testSafeRetryHonorsRetryAfter();
await testKnownHttpFailureDoesNotLeakResponseBody();
console.log('Amazon Ads credential provider tests: PASS');
