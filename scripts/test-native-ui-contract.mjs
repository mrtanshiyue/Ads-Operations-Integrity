import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { handleAuditApiRoute } from '../cloudflare/runtime/audit-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeApiSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-api-v1.js'), 'utf8');
const bridgeSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-query-bridge-v1.js'), 'utf8');
const negativeGovernanceSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-negative-governance-v1.js'), 'utf8');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const auditApiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/audit-api.js'), 'utf8');
const builtIndex = await readFile(path.join(repoRoot, 'dist-cloudflare-native/index.html'), 'utf8');

function createAuditDb({ globalRead = true, storeRead = false, storeExists = true, rows } = {}) {
  const events = rows || [
    {
      event_id: 'event-02',
      occurred_at: '2026-08-16 10:42:00',
      actor_user_id: 'user-dev-owner',
      actor_email: 'owner@example.test',
      actor_display_name: 'Development Owner',
      store_id: 'store-dev-01',
      store_code: 'DEV01',
      store_display_name: 'Development Store',
      action: 'negative_product_scope.upsert',
      entity_type: 'negative_product_scope',
      entity_id: 'store-dev-01:product-dev:negative-dev',
      request_id: 'audit-ray-02',
      cf_ray: 'audit-ray-02',
      details_json: '{"status":"active"}',
    },
    {
      event_id: 'event-01',
      occurred_at: '2026-08-16 10:41:00',
      actor_user_id: 'user-dev-owner',
      actor_email: 'owner@example.test',
      actor_display_name: 'Development Owner',
      store_id: null,
      store_code: null,
      store_display_name: null,
      action: 'keyword.update',
      entity_type: 'keyword',
      entity_id: 'keyword-dev',
      request_id: 'audit-ray-01',
      cf_ray: 'audit-ray-01',
      details_json: '{broken-json',
    },
  ];

  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM user_global_roles ugr')) return globalRead ? { ok: 1 } : null;
              if (sql.includes('FROM store_members sm')) return storeRead ? { ok: 1 } : null;
              if (sql.includes('FROM stores')) {
                return storeExists && params[0] === 'store-dev-01' ? { store_id: 'store-dev-01' } : null;
              }
              throw new Error(`unexpected audit first query: ${sql}`);
            },
            async all() {
              if (sql.includes('FROM audit_log a')) return { results: events };
              throw new Error(`unexpected audit all query: ${sql}`);
            },
          };
        },
      };
    },
  };
}

const auditActor = { user_id: 'user-dev-owner' };
const auditRequest = new Request('https://example.test/api/v1/audit/events?storeId=store-dev-01&action=negative_product_scope.upsert&from=2026-08-16&to=2026-08-16&limit=1', {
  headers: { 'cf-ray': 'audit-query-ray' },
});
const auditResponse = await handleAuditApiRoute({
  request: auditRequest,
  env: { CONTROL_DB: createAuditDb() },
  actor: auditActor,
  url: new URL(auditRequest.url),
});
assert.equal(auditResponse.status, 200);
assert.equal(auditResponse.headers.get('cache-control'), 'no-store');
assert.equal(auditResponse.headers.get('x-request-id'), 'audit-query-ray');
const auditPayload = await auditResponse.json();
assert.equal(auditPayload.items.length, 1);
assert.equal(auditPayload.items[0].eventId, 'event-02');
assert.equal(auditPayload.items[0].actor.email, 'owner@example.test');
assert.equal(auditPayload.items[0].store.storeId, 'store-dev-01');
assert.deepEqual(auditPayload.items[0].details, { status: 'active' });
assert.equal(typeof auditPayload.nextCursor, 'string');
assert.equal(auditPayload.filters.from, '2026-08-16 00:00:00');
assert.equal(auditPayload.filters.to, '2026-08-16 23:59:59');

const scopedAuditRequest = new Request('https://example.test/api/v1/audit/events?storeId=store-dev-01');
const scopedAuditResponse = await handleAuditApiRoute({
  request: scopedAuditRequest,
  env: { CONTROL_DB: createAuditDb({ globalRead: false, storeRead: true, rows: [] }) },
  actor: { user_id: 'store-auditor' },
  url: new URL(scopedAuditRequest.url),
});
assert.equal(scopedAuditResponse.status, 200);
assert.equal((await scopedAuditResponse.json()).items.length, 0);

const deniedAuditRequest = new Request('https://example.test/api/v1/audit/events');
const deniedAuditResponse = await handleAuditApiRoute({
  request: deniedAuditRequest,
  env: { CONTROL_DB: createAuditDb({ globalRead: false, storeRead: true }) },
  actor: { user_id: 'store-auditor' },
  url: new URL(deniedAuditRequest.url),
});
assert.equal(deniedAuditResponse.status, 403);
assert.deepEqual(await deniedAuditResponse.json(), { error: 'forbidden', permission: 'audit.read' });

const missingStoreRequest = new Request('https://example.test/api/v1/audit/events?storeId=missing-store');
const missingStoreResponse = await handleAuditApiRoute({
  request: missingStoreRequest,
  env: { CONTROL_DB: createAuditDb({ storeExists: false }) },
  actor: auditActor,
  url: new URL(missingStoreRequest.url),
});
assert.equal(missingStoreResponse.status, 404);
assert.deepEqual(await missingStoreResponse.json(), { error: 'store_not_found' });

const invalidAuditRequest = new Request('https://example.test/api/v1/audit/events?from=2026-02-31');
const invalidAuditResponse = await handleAuditApiRoute({
  request: invalidAuditRequest,
  env: { CONTROL_DB: createAuditDb() },
  actor: auditActor,
  url: new URL(invalidAuditRequest.url),
});
assert.equal(invalidAuditResponse.status, 400);
assert.deepEqual(await invalidAuditResponse.json(), { error: 'invalid_audit_from' });

assert.match(webEntrySource, /handleAuditApiRoute/);
assert.match(webEntrySource, /AUDIT_ROUTE_PATTERN/);
assert.match(nativeApiSource, /auditEvents:\s*\(params\)/);
assert.match(auditApiSource, /audit\.read/);
assert.match(auditApiSource, /FROM audit_log a/);
assert.match(auditApiSource, /ORDER BY a\.occurred_at DESC, a\.event_id DESC/);
assert.doesNotMatch(auditApiSource, /INSERT INTO|UPDATE audit_log|DELETE FROM audit_log/);
assert.doesNotMatch(auditApiSource, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/);

const nativeApiCalls = [];
const events = [];
const nativeApi = {
  async stores() {
    nativeApiCalls.push({ method: 'stores' });
    return {
      stores: [{
        store_id: 'store-dev-01',
        store_code: 'DEV01',
        display_name: 'Development Store',
        marketplace_code: 'US',
      }],
    };
  },
  async capabilities() {
    nativeApiCalls.push({ method: 'capabilities' });
    return { globalPermissions: ['negatives.manage', 'negatives.read'], storePermissions: {} };
  },
  async storeProducts(storeId, options) {
    nativeApiCalls.push({ method: 'storeProducts', storeId, options: { ...options } });
    return { items: [{ productId: 'product-dev', modelCode: 'SYNTH-01', sellerSku: 'SKU-01', asin: 'B000DEV001' }] };
  },
  async listNegativeKeywords(options) {
    nativeApiCalls.push({ method: 'listNegativeKeywords', options: { ...options } });
    return { items: [{ negativeKeywordId: 'negative-dev', keywordText: 'free glasses', matchType: 'PHRASE', status: 'active' }] };
  },
  async storeNegativeKeywords(storeId, options) {
    nativeApiCalls.push({ method: 'storeNegativeKeywords', storeId, options: { ...options } });
    return { items: [{ negativeKeywordId: 'negative-dev', keywordText: 'free glasses', matchType: 'PHRASE', keywordStatus: 'active', scopeStatus: 'active' }] };
  },
  async productNegativeKeywords(storeId, productId, options) {
    nativeApiCalls.push({ method: 'productNegativeKeywords', storeId, productId, options: { ...options } });
    return { items: [{ negativeKeywordId: 'negative-dev', keywordText: 'free glasses', matchType: 'PHRASE', keywordStatus: 'active', scopeStatus: 'active' }] };
  },
  async putStoreNegativeKeyword(storeId, negativeKeywordId, body) {
    nativeApiCalls.push({ method: 'putStoreNegativeKeyword', storeId, negativeKeywordId, body: { ...body } });
    return { scope: { negativeKeywordId, scopeStatus: body.status } };
  },
  async deleteStoreNegativeKeyword(storeId, negativeKeywordId) {
    nativeApiCalls.push({ method: 'deleteStoreNegativeKeyword', storeId, negativeKeywordId });
    return { deleted: true };
  },
  async putProductNegativeKeyword(storeId, productId, negativeKeywordId, body) {
    nativeApiCalls.push({ method: 'putProductNegativeKeyword', storeId, productId, negativeKeywordId, body: { ...body } });
    return { scope: { negativeKeywordId, scopeStatus: body.status } };
  },
  async deleteProductNegativeKeyword(storeId, productId, negativeKeywordId) {
    nativeApiCalls.push({ method: 'deleteProductNegativeKeyword', storeId, productId, negativeKeywordId });
    return { deleted: true };
  },
  async searchTermsDaily(storeId, options) {
    nativeApiCalls.push({ method: 'searchTermsDaily', storeId, options: { ...options } });
    return {
      grain: 'day',
      nextCursor: null,
      items: [
        {
          reportDate: '2026-08-11',
          profileId: 'profile-dev',
          campaignId: 'campaign-dev',
          campaignName: 'Development Campaign',
          adGroupId: 'adgroup-dev',
          adGroupName: 'Development Ad Group',
          keywordId: 'keyword-dev',
          keywordText: 'reading glasses',
          searchTerm: 'reading glasses men',
          matchType: 'BROAD',
          impressions: 40,
          clicks: 4,
          costMicros: 400000,
          purchases: 1,
          unitsSold: 1,
          salesMicros: 2000000,
        },
        {
          reportDate: '2026-08-12',
          profileId: 'profile-dev',
          campaignId: 'campaign-dev',
          campaignName: 'Development Campaign',
          adGroupId: 'adgroup-dev',
          adGroupName: 'Development Ad Group',
          targetId: 'target-dev',
          targetExpressionText: 'asin-expanded-from',
          targetType: 'PRODUCT_TARGET',
          searchTerm: 'reading glasses women',
          matchType: 'TARGETING_EXPRESSION',
          impressions: 60,
          clicks: 6,
          costMicros: 600000,
          purchases: 2,
          unitsSold: 2,
          salesMicros: 3000000,
        },
      ],
    };
  },
  async analyticsOverview(options) {
    nativeApiCalls.push({ method: 'analyticsOverview', options: { ...options } });
    return {
      totals: {
        impressions: 100,
        clicks: 10,
        costMicros: 1000000,
        purchases: 3,
        unitsSold: 3,
        salesMicros: 5000000,
      },
      daily: [
        { reportDate: '2026-08-11', impressions: 40, clicks: 4, costMicros: 400000, purchases: 1, unitsSold: 1, salesMicros: 2000000 },
        { reportDate: '2026-08-12', impressions: 60, clicks: 6, costMicros: 600000, purchases: 2, unitsSold: 2, salesMicros: 3000000 },
      ],
      stores: [],
      sync: [],
    };
  },
};

class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

const window = {
  CloudflareNativeAPI: nativeApi,
  dispatchEvent(event) {
    events.push(event);
  },
};
const sandbox = {
  window,
  CustomEvent: TestCustomEvent,
  Map,
  Date,
  JSON,
  Number,
  String,
  Object,
  Array,
  Error,
  Math,
  Promise,
  console,
};
vm.runInNewContext(negativeGovernanceSource, sandbox, { filename: 'cloudflare-native-negative-governance-v1.js' });
vm.runInNewContext(bridgeSource, sandbox, { filename: 'cloudflare-native-query-bridge-v1.js' });

const negativeGovernance = window.CloudflareNegativeGovernance;
assert(negativeGovernance, 'CloudflareNegativeGovernance was not installed');
assert.equal(negativeGovernance.version, '1.0.0');
await negativeGovernance.listLibrary({ q: 'free' });
await negativeGovernance.listStoreScopes('store-dev-01', { scopeStatus: 'active' });
await negativeGovernance.listProductScopes('store-dev-01', 'product-dev', { scopeStatus: 'active' });
await negativeGovernance.putStoreScope('store-dev-01', 'negative-dev', 'disabled');
await negativeGovernance.deleteStoreScope('store-dev-01', 'negative-dev');
await negativeGovernance.putProductScope('store-dev-01', 'product-dev', 'negative-dev', 'active');
await negativeGovernance.deleteProductScope('store-dev-01', 'product-dev', 'negative-dev');
assert(nativeApiCalls.some((call) => call.method === 'listNegativeKeywords' && call.options.limit === 200 && call.options.q === 'free'));
assert(nativeApiCalls.some((call) => call.method === 'storeNegativeKeywords' && call.storeId === 'store-dev-01'));
assert(nativeApiCalls.some((call) => call.method === 'productNegativeKeywords' && call.productId === 'product-dev'));
assert(nativeApiCalls.some((call) => call.method === 'putStoreNegativeKeyword' && call.body.status === 'disabled'));
assert(nativeApiCalls.some((call) => call.method === 'deleteStoreNegativeKeyword'));
assert(nativeApiCalls.some((call) => call.method === 'putProductNegativeKeyword' && call.body.status === 'active'));
assert(nativeApiCalls.some((call) => call.method === 'deleteProductNegativeKeyword'));
assert.doesNotMatch(negativeGovernanceSource, /AMAZON_ADS_ENABLED|AMAZON_ADS_CLIENT|AMAZON_SYNC_WORKFLOW|startSync\s*\(/);

const bridge = window.CloudflareNativeQueryBridge;
assert(bridge, 'CloudflareNativeQueryBridge was not installed');
assert.equal(window.PrivateCloudQuery, bridge, 'legacy PrivateCloudQuery alias must point at the native bridge');
assert.equal(bridge.source, 'query-cloudflare-d1');
assert(events.some((event) => event.type === 'lr:query-client-ready' && event.detail?.source === 'query-cloudflare-d1'));

const ads = await bridge.ads({
  scope: 'ALL',
  from: '2026-08-11',
  to: '2026-08-12',
  limit: 100,
});
assert.equal(ads.source, 'query-cloudflare-d1');
assert.equal(ads.rows.length, 2);
assert.deepEqual([...new Set(ads.rows.map((row) => row.date))].sort(), ['2026-08-11', '2026-08-12']);
for (const row of ads.rows) {
  assert.equal(row.reportGranularity, 'DAY');
  assert.equal(row.currentBid, null);
  assert.equal(row.targetBid, null);
  assert.equal(row.bid, null);
  assert.equal(row.bidValueTrusted, false);
  assert.equal(row.governanceReady, false);
  assert.equal(row.sourceFile, 'cloudflare-d1');
  assert.equal(row.sourceCoverage.backend, 'cloudflare-d1');
  assert.equal(row.sourceCoverage.grain, 'day');
  assert.equal(row.sourceCoverage.aggregatedRange, false);
}
assert.equal(ads.governance.sourceBackend, 'cloudflare-d1');
assert.equal(ads.governance.readiness.searchTermReady, true);
assert.equal(ads.governance.readiness.targetingIdentityReady, false);
assert.equal(ads.governance.readiness.bidSourceColumnReady, false);
assert.equal(ads.governance.readiness.bidValueNullabilityTrusted, false);
assert.equal(ads.governance.readiness.bidGovernanceReady, false);
assert.equal(ads.governance.legacyCompatibility.dailyRows, true);
assert.equal(ads.governance.legacyCompatibility.rangeRows, false);
assert.equal(ads.governance.legacyCompatibility.bidNullability, 'explicit-null-untrusted');

const searchCall = nativeApiCalls.find((call) => call.method === 'searchTermsDaily');
assert.deepEqual(searchCall, {
  method: 'searchTermsDaily',
  storeId: 'store-dev-01',
  options: {
    startDate: '2026-08-11',
    endDate: '2026-08-12',
    sort: 'cost',
    limit: 200,
    cursor: null,
  },
});

const overview = await bridge.overview({ scope: 'DEV01', from: '2026-08-11', to: '2026-08-12' });
assert.equal(overview.source, 'query-cloudflare-d1');
assert.equal(overview.grain, 'day');
assert.deepEqual(JSON.parse(JSON.stringify(overview.totals)), {
  impressions: 100,
  clicks: 10,
  spend: 1,
  orders: 3,
  units: 3,
  sales: 5,
});

await assert.rejects(
  bridge.allTransactions(),
  (error) => error?.status === 501 && error?.code === 'cloudflare_transactions_not_migrated',
);

assert.match(builtIndex, /connect-src\s+'self';/i);
assert.equal((builtIndex.match(/assets\/cloudflare-native-api-v1\.js/g) || []).length, 1);
assert.equal((builtIndex.match(/assets\/cloudflare-native-negative-governance-v1\.js/g) || []).length, 1);
assert.equal((builtIndex.match(/assets\/cloudflare-native-query-bridge-v1\.js/g) || []).length, 1);
assert.doesNotMatch(builtIndex, /assets\/private-cloud-query-v1\.js/i);

const builtModuleDataPath = path.join(repoRoot, 'dist-cloudflare-native/assets/query-native-module-data-v1.js');
try {
  const moduleData = await readFile(builtModuleDataPath, 'utf8');
  assert.doesNotMatch(moduleData, /query-tidb/);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

console.log(JSON.stringify({
  ok: true,
  contracts: [
    'audit-read-global-permission',
    'audit-read-store-permission-isolation',
    'audit-read-cursor-pagination',
    'audit-read-date-normalization',
    'audit-read-only-no-sync',
    'negative-governance-native-client',
    'negative-governance-store-scope',
    'negative-governance-product-scope',
    'negative-governance-no-sync-trigger',
    'private-cloud-query-alias-native',
    'search-term-real-report-date',
    'report-granularity-day',
    'bid-values-explicit-null-untrusted',
    'governance-not-ready',
    'transactions-explicit-501',
    'overview-daily-series',
    'same-origin-csp',
    'native-client-single-injection',
    'negative-governance-single-injection',
    'legacy-query-client-absent',
    'native-provenance-cloudflare-d1',
  ],
}));
