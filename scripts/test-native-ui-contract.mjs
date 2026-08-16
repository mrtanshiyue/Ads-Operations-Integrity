import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-query-bridge-v1.js'), 'utf8');
const negativeGovernanceSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-negative-governance-v1.js'), 'utf8');
const builtIndex = await readFile(path.join(repoRoot, 'dist-cloudflare-native/index.html'), 'utf8');

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
