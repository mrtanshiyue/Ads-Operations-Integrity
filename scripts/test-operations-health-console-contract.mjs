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
assert.doesNotMatch(source, /confidenceScore|actionabilityScore|financialImpact/,
  'executive operations overview must not invent confidence, actionability, or financial impact');
assert.match(source, /analytics\.read/);
assert.match(source, /audit\.read/);
assert.match(source, /unmapped/);
assert.match(source, /ambiguous/);
assert.match(source, /FAIL-CLOSED EVIDENCE/);
assert.match(source, /Four-Store Command Board/);
assert.match(source, /ATTENTION ORDER/);
assert.match(source, /Evidence gap/);
assert.match(source, /reported lag/);
assert.match(source, /unresolved mapping/);

const calls = [];
const window = {
  CloudflareNativeAPI: {
    analyticsDataHealth(params) {
      calls.push({ method: 'analyticsDataHealth', params: { ...params } });
      return Promise.resolve({ generatedAt: '2026-08-22T12:00:00.000Z', stores: [], recentRollupFailures: [] });
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

vm.runInNewContext(source, { window, console, Set, Object, Array, String, Number, Boolean, Error, Promise, Date }, {
  filename: 'cloudflare-native-operations-health-v1.js',
});

const health = window.CloudflareOperationsHealth;
assert(health, 'CloudflareOperationsHealth was not installed');
assert.equal(health.version, '1.1.0');

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

const baseStore = {
  storeId: 'store-healthy',
  storeCode: 'STORE04',
  displayName: 'Healthy store',
  sync: {
    status: 'idle',
    lastSuccessAt: '2026-08-22T11:58:00.000Z',
    lastErrorAt: null,
    lastErrorCode: null,
    lagMinutes: 0,
    updatedAt: '2026-08-22T11:59:00.000Z',
  },
  rollups: [],
};

const healthy = health.classifyStoreHealth(baseStore, []);
assert.equal(healthy.priority, 4);
assert.equal(healthy.attentionKey, 'healthy');

const mapping = health.classifyStoreHealth({
  ...baseStore,
  storeId: 'store-mapping',
  rollups: [{ unmappedRows: 3, ambiguousRows: 2, updatedAt: '2026-08-22T11:59:00.000Z' }],
}, []);
assert.equal(mapping.priority, 3);
assert.equal(mapping.attentionKey, 'mapping_anomaly');
assert.equal(mapping.unmappedRows, 3);
assert.equal(mapping.ambiguousRows, 2);

const freshness = health.classifyStoreHealth({
  ...baseStore,
  storeId: 'store-lag',
  sync: { ...baseStore.sync, lagMinutes: 17 },
}, []);
assert.equal(freshness.priority, 2);
assert.equal(freshness.attentionKey, 'freshness_attention');
assert.match(freshness.reason, /17 min/);

const failure = health.classifyStoreHealth(baseStore, [{
  storeId: baseStore.storeId,
  rollupType: 'search_term',
  partitionKey: '2026-08',
  errorCode: 'rollup_failed',
}]);
assert.equal(failure.priority, 1);
assert.equal(failure.attentionKey, 'health_failure');

const errorAfterSuccess = health.classifyStoreHealth({
  ...baseStore,
  sync: {
    ...baseStore.sync,
    lastSuccessAt: '2026-08-22T11:00:00.000Z',
    lastErrorAt: '2026-08-22T11:30:00.000Z',
    lastErrorCode: 'latest_error',
  },
}, []);
assert.equal(errorAfterSuccess.priority, 1);
assert.equal(errorAfterSuccess.attentionKey, 'health_failure');

const evidenceGap = health.classifyStoreHealth({
  storeId: 'store-gap',
  storeCode: 'STORE01',
  displayName: 'Evidence gap',
  sync: { status: 'never', lastSuccessAt: null, lastErrorAt: null, lagMinutes: null, updatedAt: null },
  rollups: [],
}, []);
assert.equal(evidenceGap.priority, 1);
assert.equal(evidenceGap.attentionKey, 'evidence_gap');
assert.match(evidenceGap.reason, /No sync or rollup freshness evidence/);

const readFailure = health.classifyStoreHealth(null, [], Object.assign(new Error('health_unavailable'), { code: 'health_unavailable' }));
assert.equal(readFailure.priority, 1);
assert.equal(readFailure.attentionKey, 'evidence_gap');

const payload = (store, failures = []) => ({
  generatedAt: '2026-08-22T12:00:00.000Z',
  stores: [store],
  recentRollupFailures: failures,
});
const rows = [
  health.buildCommandRow({ storeId: 'healthy', storeCode: 'STORE04' }, payload({ ...baseStore, storeId: 'healthy' }), null, 3),
  health.buildCommandRow({ storeId: 'mapping', storeCode: 'STORE03' }, payload({
    ...baseStore,
    storeId: 'mapping',
    rollups: [{ unmappedRows: 1, ambiguousRows: 0, updatedAt: '2026-08-22T11:59:00.000Z' }],
  }), null, 2),
  health.buildCommandRow({ storeId: 'lag', storeCode: 'STORE02' }, payload({
    ...baseStore,
    storeId: 'lag',
    sync: { ...baseStore.sync, lagMinutes: 5 },
  }), null, 1),
  health.buildCommandRow({ storeId: 'failure', storeCode: 'STORE01' }, payload(
    { ...baseStore, storeId: 'failure' },
    [{ storeId: 'failure', rollupType: 'daily', errorCode: 'failed' }],
  ), null, 0),
  health.buildCommandRow({ storeId: 'gap', storeCode: 'STORE05' }, payload({
    storeId: 'gap',
    sync: { status: 'never', lagMinutes: null },
    rollups: [],
  }), null, 4),
];

const ranked = health.rankStoreHealthRows(rows);
assert.deepEqual(
  ranked.map((row) => [row.attentionKey, row.priority, row.storeOrder]),
  [
    ['health_failure', 1, 0],
    ['evidence_gap', 1, 4],
    ['freshness_attention', 2, 1],
    ['mapping_anomaly', 3, 2],
    ['healthy', 4, 3],
  ],
  'command board must use deterministic health -> freshness -> mapping -> healthy ordering',
);

assert.match(buildSource, /cloudflare-native-operations-health-v1\.js/,
  'native build must include the operations health console');
assert.match(allowlistSource, /cloudflare-native-operations-health-v1\.js/,
  'native asset allowlist must include the operations health console');

console.log(JSON.stringify({
  ok: true,
  contract: 'executive-operations-overview-v1',
  transport: 'CloudflareNativeAPI-read-only',
  analyticsRead: true,
  auditRead: true,
  attentionOrder: ['health_failure_or_evidence_gap', 'reported_lag', 'mapping_anomaly', 'healthy'],
  failClosedEvidenceGap: true,
  inventedThresholds: false,
  syncStartBlocked: true,
  amazonDormant: true,
  productionMutation: false,
  calls: calls.map((call) => call.method),
}, null, 2));
