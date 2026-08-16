import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-operations-health-v1.js'), 'utf8');
const buildSource = await readFile(path.join(repoRoot, 'scripts/build-cloudflare-native-copy-all.mjs'), 'utf8');
const allowlistSource = await readFile(path.join(repoRoot, 'scripts/enforce-cloudflare-native-asset-allowlist.mjs'), 'utf8');

new vm.Script(source, { filename: 'cloudflare-native-operations-health-v1.js' });
assert.doesNotMatch(source, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|wrangler\s+deploy/i);
assert.doesNotMatch(source, /\.startSync\s*\(|startSync\s*\(/, 'operations health console must never start sync');
assert.doesNotMatch(source, /fetch\s*\(/, 'operations health console must delegate transport to CloudflareNativeAPI');
assert.doesNotMatch(source, /createProduct|updateProduct|createKeyword|updateKeyword|putStoreProduct|deleteStoreProduct|putProductKeyword|deleteProductKeyword|putStoreNegativeKeyword|putProductNegativeKeyword/,
  'operations health console must remain read-only');
assert.match(source, /analytics\.read/);
assert.match(source, /audit\.read/);
assert.match(source, /unmapped/);
assert.match(source, /ambiguous/);
assert.match(source, /FAIL-CLOSED EVIDENCE/);

const calls = [];
const window = {
  CloudflareNativeAPI: {
    analyticsDataHealth(params) {
      calls.push({ method: 'analyticsDataHealth', params: { ...params } });
      return Promise.resolve({ generatedAt: '2026-08-16T12:00:00.000Z', stores: [], recentRollupFailures: [] });
    },
    auditEvents(params) {
      calls.push({ method: 'auditEvents', params: { ...params } });
      return Promise.resolve({ items: [], nextCursor: null });
    },
    stores() {
      calls.push({ method: 'stores' });
      return Promise.resolve({ stores: [] });
    },
    capabilities() {
      calls.push({ method: 'capabilities' });
      return Promise.resolve({ globalPermissions: [], storePermissions: {} });
    },
  },
};

vm.runInNewContext(source, { window, console, Set, Object, Array, String, Number, Boolean, Error, Promise }, {
  filename: 'cloudflare-native-operations-health-v1.js',
});

const health = window.CloudflareOperationsHealth;
assert(health, 'CloudflareOperationsHealth was not installed');
assert.equal(health.version, '1.0.0');

await health.dataHealth(' store-dev-01 ');
await health.auditEvents(' store-dev-01 ', { action: 'product.update' });
await health.listStores();
await health.capabilities();

const dataCall = calls.find((call) => call.method === 'analyticsDataHealth');
assert.deepEqual(dataCall.params, { storeId: 'store-dev-01' });
const auditCall = calls.find((call) => call.method === 'auditEvents');
assert.equal(auditCall.params.limit, 20);
assert.equal(auditCall.params.storeId, 'store-dev-01');
assert.equal(auditCall.params.action, 'product.update');
assert(calls.some((call) => call.method === 'stores'));
assert(calls.some((call) => call.method === 'capabilities'));

await assert.rejects(() => health.dataHealth(''), /store_id_required/);
await assert.rejects(() => health.auditEvents('   '), /store_id_required/);

assert.match(buildSource, /cloudflare-native-operations-health-v1\.js/,
  'native build must include the Gate 3.2 operations health console');
assert.match(allowlistSource, /cloudflare-native-operations-health-v1\.js/,
  'native asset allowlist must include the Gate 3.2 operations health console');

console.log(JSON.stringify({
  ok: true,
  contract: 'phase3-operations-health-console-v1',
  transport: 'CloudflareNativeAPI-read-only',
  analyticsRead: true,
  auditRead: true,
  syncStartBlocked: true,
  amazonDormant: true,
  productionMutation: false,
  calls: calls.map((call) => call.method),
}, null, 2));
