import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-gate6-acceptance-v1.js'), 'utf8');
const builtIndex = await readFile(path.join(repoRoot, 'dist-cloudflare-native/index.html'), 'utf8');
assert.equal((builtIndex.match(/assets\/cloudflare-gate6-acceptance-v1\.js/g) || []).length, 1);

const apiCalls = [];
const appended = [];
const documentElement = {
  attributes: new Map(),
  setAttribute(name, value) { this.attributes.set(name, value); },
};
const document = {
  documentElement,
  body: { appendChild(node) { appended.push(node); } },
  getElementById() { return null; },
  createElement() {
    return {
      id: '',
      style: { cssText: '' },
      textContent: '',
      setAttribute() {},
      remove() {},
    };
  },
};
const nativeApi = {
  async session() {
    apiCalls.push('session');
    return {
      authenticated: true,
      provisioned: true,
      user: { userId: 'user-dev-owner' },
      globalRoles: ['owner'],
    };
  },
  async stores() {
    apiCalls.push('stores');
    return { stores: [{ store_id: 'store-dev-01', store_code: 'DEV01' }] };
  },
  async capabilities() {
    apiCalls.push('capabilities');
    return { syncTriggerEnabled: false };
  },
  async analyticsDataHealth() {
    apiCalls.push('analyticsDataHealth');
    return { stores: [], recentRollupFailures: [] };
  },
  async startSync() {
    apiCalls.push('startSync');
    const error = new Error('sync_trigger_disabled');
    error.status = 503;
    error.code = 'sync_trigger_disabled';
    throw error;
  },
};
const bridge = {
  source: 'query-cloudflare-d1',
  async allTransactions() {
    const error = new Error('cloudflare_transactions_not_migrated');
    error.status = 501;
    error.code = 'cloudflare_transactions_not_migrated';
    throw error;
  },
};
const events = [];
const window = {
  location: { search: '?cf_gate6=1' },
  document,
  CloudflareNativeAPI: nativeApi,
  CloudflareNativeQueryBridge: bridge,
  PrivateCloudQuery: bridge,
  dispatchEvent(event) { events.push(event); },
};
const responses = new Map([
  ['/api/health', { ok: true, status: 200, payload: { environment: 'development', syncTriggerEnabled: false } }],
  ['/api/v1/stores/store-dev-01/health', { ok: true, status: 200, payload: { store: { storeCode: 'DEV01' }, health: { ok: true } } }],
]);
const sandbox = {
  window,
  fetch: async (path) => {
    const item = responses.get(String(path));
    if (!item) throw new Error(`unexpected_fetch:${path}`);
    return { ok: item.ok, status: item.status, async json() { return item.payload; } };
  },
  URLSearchParams,
  CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  Date,
  Map,
  Error,
  Object,
  Array,
  Boolean,
  String,
  Promise,
  console,
};
vm.runInNewContext(source, sandbox, { filename: 'cloudflare-gate6-acceptance-v1.js' });
const result = await window.CloudflareGate6Acceptance.pending;
assert.equal(result.ok, true);
assert.equal(result.userId, 'user-dev-owner');
assert.equal(result.storeCode, 'DEV01');
assert.equal(documentElement.attributes.get('data-cf-gate6'), 'pass');
assert.equal(appended.length, 1);
assert.match(appended[0].textContent, /Cloudflare Gate 6: PASS/);
assert(events.some((event) => event.type === 'cf:gate6-acceptance' && event.detail?.ok === true));
assert.deepEqual(apiCalls, ['session', 'stores', 'capabilities', 'analyticsDataHealth', 'startSync']);
for (const contract of [
  'environment_is_development',
  'session_authenticated',
  'session_provisioned',
  'owner_identity_mapping',
  'owner_role',
  'store_scope_dev01',
  'store_health',
  'sync_post_rejected_by_kill_switch',
  'native_query_bridge',
  'private_cloud_alias_native',
  'transactions_explicit_not_migrated',
]) {
  assert.equal(result.checks.find((item) => item.name === contract)?.ok, true, contract);
}

const productionCalls = [];
const productionWindow = {
  location: { search: '?cf_gate6=1' },
  document: {
    documentElement: { setAttribute() {} },
    body: { appendChild() {} },
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, remove() {}, textContent: '' }; },
  },
  CloudflareNativeAPI: { async session() { productionCalls.push('session'); return {}; } },
  dispatchEvent() {},
};
vm.runInNewContext(source, {
  window: productionWindow,
  fetch: async () => ({ ok: true, status: 200, async json() { return { environment: 'production', syncTriggerEnabled: false }; } }),
  URLSearchParams,
  CustomEvent: class CustomEvent {},
  Date,
  Error,
  Object,
  Array,
  Boolean,
  String,
  Promise,
  console,
}, { filename: 'cloudflare-gate6-acceptance-prod-guard.js' });
const productionResult = await productionWindow.CloudflareGate6Acceptance.pending;
assert.equal(productionResult.ok, false);
assert.equal(productionResult.error, 'gate6_acceptance_dev_only');
assert.deepEqual(productionCalls, []);

console.log(JSON.stringify({
  ok: true,
  contracts: [
    'gate6-dev-only',
    'same-origin-browser-session',
    'owner-mapping',
    'dev01-store-scope',
    'store-health',
    'capabilities',
    'data-health',
    'sync-kill-switch',
    'native-query-bridge',
    'transactions-explicit-501',
  ],
}));
