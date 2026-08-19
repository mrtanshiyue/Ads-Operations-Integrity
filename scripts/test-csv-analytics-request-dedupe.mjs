import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/cloudflare-native-api-v1.js', import.meta.url), 'utf8');

function response(payload = { ok: true }) {
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? 'application/json' : null; } },
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function loadApi(fetchImpl) {
  const window = { location: { origin: 'https://example.test' } };
  const context = vm.createContext({ window, URL, fetch: fetchImpl, console, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'cloudflare-native-api-v1.js' });
  return window.CloudflareNativeAPI;
}

{
  let calls = 0;
  const gate = deferred();
  const api = await loadApi(async () => {
    calls += 1;
    await gate.promise;
    return response({ request: calls });
  });
  const params = { startDate: '2026-06-01', endDate: '2026-06-30', page: 1, limit: 50 };
  const first = api.csvAnalytics('store-01', 'search-term', params);
  const second = api.csvAnalytics('store-01', 'search-term', params);
  await Promise.resolve();
  assert.equal(calls, 1, 'identical concurrent CSV analytics reads must share one fetch');
  gate.resolve();
  await Promise.all([first, second]);
  await api.csvAnalytics('store-01', 'search-term', params);
  assert.equal(calls, 2, 'completed requests must be evicted; this is in-flight dedupe, not stale caching');
}

{
  let calls = 0;
  const gate = deferred();
  const api = await loadApi(async () => {
    calls += 1;
    await gate.promise;
    return response();
  });
  const common = { startDate: '2026-06-01', endDate: '2026-06-30' };
  const first = api.csvAnalytics('store-01', 'search-term', { ...common, page: 1 });
  const second = api.csvAnalytics('store-01', 'search-term', { ...common, page: 2 });
  await Promise.resolve();
  assert.equal(calls, 2, 'different query scopes must never be coalesced');
  gate.resolve();
  await Promise.all([first, second]);
}

console.log(JSON.stringify({ ok: true, contract: 'csv-analytics-in-flight-dedupe', identicalConcurrentReads: { before: 2, after: 1 }, ttlCacheEnabled: false }));
