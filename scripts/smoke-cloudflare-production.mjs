import assert from 'node:assert/strict';

const ORIGIN = 'https://ads-operations-integrity.tanshiyuesir.workers.dev';
const PUBLIC_WAREHOUSE_ORIGIN = 'https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev';
const MAX_ATTEMPTS = 40;
const RETRY_MS = 3000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchNoStore(path) {
  const url = new URL(path, ORIGIN);
  url.searchParams.set('__productionSmoke', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return fetch(url, {
    cache: 'no-store',
    redirect: 'manual',
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'user-agent': 'ads-operations-integrity-production-smoke/1.2',
    },
  });
}

async function waitForPhase2BHealth() {
  let last = 'no response';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchNoStore('/api/_migration/health');
      const text = await response.text();
      last = `HTTP ${response.status}: ${text.slice(0, 500)}`;
      if (response.ok) {
        const payload = JSON.parse(text);
        if (
          payload?.ok === true
          && payload?.service === 'ads-operations-integrity'
          && payload?.hosting === 'cloudflare-workers-static-assets'
          && payload?.dataBackendCutover === false
          && payload?.warehouseTransport === 'service-binding'
          && payload?.accessIdentityLayer === 'phase-2b'
          && payload?.accessMode === 'off'
          && payload?.accessConfigured === false
          && payload?.accessActivationReady === false
          && payload?.accessRuntimeSafe === true
        ) {
          return payload;
        }
      }
    } catch (error) {
      last = error?.stack || String(error);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_MS);
  }
  throw new Error(`Phase 2B production health did not become ready. Last result: ${last}`);
}

const health = await waitForPhase2BHealth();
console.log('Cloudflare Phase 2B health ready:', JSON.stringify(health));

const sessionResponse = await fetchNoStore('/api/_auth/session');
assert.equal(sessionResponse.status, 200, `Default-off Access session endpoint returned HTTP ${sessionResponse.status}`);
const session = await sessionResponse.json();
assert.deepEqual(session.access, {
  mode: 'off',
  configured: false,
  authenticated: false,
});
assert.equal(session.user, null);
console.log('Cloudflare Access identity layer is deployed, activation is not configured, and default-off runtime remains safe');

const unauthorized = await fetchNoStore('/api/v1/health');
const unauthorizedText = await unauthorized.text();
assert.equal(unauthorized.status, 401, `Warehouse BFF must preserve auth boundary; got HTTP ${unauthorized.status}: ${unauthorizedText.slice(0, 500)}`);
const unauthorizedPayload = JSON.parse(unauthorizedText);
assert.equal(unauthorizedPayload?.error, 'Unauthorized', `Unexpected unauthenticated Warehouse response: ${unauthorizedText.slice(0, 500)}`);
console.log('Warehouse Service Binding auth boundary preserved: unauthenticated request rejected with 401');

const loaderResponse = await fetchNoStore('/assets/private-cloud-warehouse-v4.js');
assert.equal(loaderResponse.status, 200, `Production Warehouse loader returned HTTP ${loaderResponse.status}`);
const loader = await loaderResponse.text();
assert.match(loader, /const API_ORIGIN = window\.location\.origin;/, 'Cloudflare production loader is not using the same-origin BFF');
assert.equal(
  loader.includes(`const API_ORIGIN = '${PUBLIC_WAREHOUSE_ORIGIN}';`),
  false,
  'Cloudflare production loader still points directly at the public Warehouse origin',
);
console.log('Cloudflare production loader uses same-origin Warehouse transport');

const home = await fetchNoStore('/');
assert.equal(home.status, 200, `Cloudflare production homepage returned HTTP ${home.status}`);
const homeText = await home.text();
assert.ok(homeText.length > 1000, 'Cloudflare production homepage payload is unexpectedly small');
console.log('Cloudflare production homepage is reachable');

console.log('Cloudflare production runtime smoke gate passed');
