import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const queryClient = readFileSync(new URL('../assets/private-cloud-query-v1.js', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../assets/query-native-module-data-v1.js', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../assets/query-native-ads-trend-v1.js', import.meta.url), 'utf8');
const host = readFileSync(new URL('../assets/query-native-ads-trend-host-v1.js', import.meta.url), 'utf8');

assert.match(adapter, /const ADAPTER_VERSION = '1\.2\.0'/);
assert.match(adapter, /async function queryAds\(request\)/);
assert.match(adapter, /client\.ads\(\{/);
assert.doesNotMatch(adapter, /client\.allAds\(\{/);
assert.match(adapter, /ADS_GOVERNANCE_VERSION = 'ads-query-governance-v2'/);
assert.match(adapter, /async function overview\(options = \{\}\)/);
assert.match(adapter, /client\.overview\(request\)/);
assert.match(adapter, /getAdsRowsForQueryCompatibility/);
assert.match(adapter, /explicit-raw-compatibility/);
assert.doesNotMatch(adapter, /\/manifest\?/);
assert.doesNotMatch(adapter, /\/api\/v1\/raw\//);
assert.doesNotMatch(adapter, /__LR_IMPORT_MULTIPLE_FILES__/);

assert.match(controller, /const CONTROLLER_VERSION = '1\.0\.0'/);
assert.match(controller, /adapter\.overview\(\{/);
assert.match(controller, /adapter\.ads\(\{/);
assert.match(controller, /ownsTrend: \(\) => true/);
assert.match(controller, /使用已导入 Raw 数据/);
assert.match(controller, /不会静默混入 Raw/);
assert.doesNotMatch(controller, /AdsStore/);
assert.doesNotMatch(controller, /\/manifest\?/);
assert.doesNotMatch(controller, /\/api\/v1\/raw\//);

assert.match(host, /const HOST_VERSION = '1\.0\.0'/);
assert.match(host, /getAdsRowsForQueryCompatibility = \(\) =>/);
assert.match(host, /trendChart = hostGuard/);
assert.match(host, /__queryNativeTrendHostGuard/);

assert.match(queryClient, /const CLIENT_VERSION = '1\.3\.0'/);
assert.match(queryClient, /const QUERY_NATIVE_ADAPTER_VERSION = '1\.2\.0'/);
assert.match(queryClient, /query-native-module-data-v1\.js\?v=\$\{QUERY_NATIVE_ADAPTER_VERSION\}/);
assert.match(queryClient, /query-native-ads-trend-v1\.js\?v=\$\{QUERY_NATIVE_TREND_VERSION\}/);
assert.match(queryClient, /query-native-ads-trend-host-v1\.js\?v=\$\{QUERY_NATIVE_HOST_VERSION\}/);
assert.match(queryClient, /async function ensureQueryNativeModules\(\)/);
assert.ok(
  queryClient.indexOf("window.QueryNativeModuleData?.version !== QUERY_NATIVE_ADAPTER_VERSION")
    < queryClient.indexOf("window.QueryNativeAdsTrend?.version !== QUERY_NATIVE_TREND_VERSION")
    && queryClient.indexOf("window.QueryNativeAdsTrend?.version !== QUERY_NATIVE_TREND_VERSION")
      < queryClient.indexOf("window.QueryNativeAdsTrendHost?.version !== QUERY_NATIVE_HOST_VERSION"),
  'Versioned module assets must load in adapter → controller → host order',
);
assert.match(index, /assets\/query-native-module-data-v1\.js\?v=1\.0\.0/);
assert.match(index, /assets\/generated\/inline-script-08\.js\?v=2\.0\.0/);

const queryCalls = [];
const overviewCalls = [];
const emitted = [];
class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

const governance = {
  schemaVersion: 'ads-query-governance-v2',
  scope: 'YTDBNS',
  stores: ['YTDBNS'],
  fromMonth: '2026-06',
  toMonth: '2026-06',
  fileCount: 1,
  dimensions: {
    adProduct: { state: 'source-unavailable', value: null },
    advertisedAsin: { state: 'source-unavailable', value: null },
    advertisedSku: { state: 'source-unavailable', value: null },
    purchasedAsin: { state: 'source-unavailable', value: null },
    purchasedSku: { state: 'source-unavailable', value: null },
    targetingId: { state: 'source-present', value: null },
    targetBid: { state: 'source-present', value: null },
    targetingType: { state: 'source-present', value: null },
    matchType: { state: 'source-present', value: null },
    reportGranularity: { state: 'inferred', value: 'day' },
    attributionWindowDays: { state: 'source-unavailable', value: null },
    sourceFile: { state: 'catalog-derived', value: null },
  },
  readiness: {
    targetingIdentityReady: true,
    bidSourceColumnReady: true,
    bidValueNullabilityTrusted: true,
    adProductReady: false,
    advertisedProductIdentityReady: false,
    attributionMaturityReady: false,
    bidGovernanceReady: false,
    campaignStudioReady: false,
  },
  legacyCompatibility: {
    storedAdProductDefault: 'SP',
    suppressUnprovenAdProduct: true,
    bidNullability: 'source-null-preserved',
  },
};

const queryRows = [
  {
    id: 'ad-1', storeId: 'YTDBNS', date: '2026-06-01',
    portfolio: 'Core', campaign: 'Campaign A', adGroup: 'Group 1',
    searchTerm: 'reading glasses women', targeting: 'reading glasses',
    targetingId: 't1', targetingType: 'manual', matchType: 'EXACT', bid: 0.72,
    bidValueTrusted: true, governanceReady: false,
    adProduct: null, advertisedAsin: null, advertisedSku: null, attributionWindowDays: null,
    impressions: 1000, clicks: 50, spend: 20, orders: 5, sales: 100, units: 5,
    metrics: { targetBid: 0.72 },
  },
  {
    id: 'ad-1', storeId: 'YTDBNS', date: '2026-06-01',
    portfolio: 'Core', campaign: 'Campaign A', adGroup: 'Group 1',
    searchTerm: 'reading glasses women', targeting: 'reading glasses',
    targetingId: 't1', targetingType: 'manual', matchType: 'EXACT', bid: 0.72,
    bidValueTrusted: true, governanceReady: false,
    adProduct: null, advertisedAsin: null, advertisedSku: null, attributionWindowDays: null,
    impressions: 1000, clicks: 50, spend: 20, orders: 5, sales: 100, units: 5,
    metrics: { targetBid: 0.72 },
  },
  {
    id: 'ad-2', storeId: 'YTDBNS', date: '2026-06-02',
    portfolio: 'Other', campaign: 'Campaign B', adGroup: 'Group 2',
    searchTerm: 'reading glasses men', targeting: 'reading glasses',
    targetingId: 't2', targetingType: 'manual', matchType: 'BROAD', bid: null,
    bidValueTrusted: true, governanceReady: false,
    adProduct: null, advertisedAsin: null, advertisedSku: null, attributionWindowDays: null,
    impressions: 500, clicks: 20, spend: 12, orders: 1, sales: 25, units: 1,
    metrics: { targetBid: null },
  },
];

const window = {
  ACTIVE_SHOP: 'YTDBNS',
  ShopScope: { get: () => 'YTDBNS' },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent(event) { emitted.push(event); },
  PrivateCloudQuery: {
    async ads(options) {
      queryCalls.push(options);
      return { rows: queryRows, nextOffset: null, governance };
    },
    async allTransactions() {
      return { rows: [], nextOffset: null };
    },
    async overview(options) {
      overviewCalls.push(options);
      return {
        schemaVersion: '1.0', scope: options.scope, grain: options.grain,
        series: [{ period: '2026-06-01', impressions: 1000, clicks: 50, adSpend: 20, adOrders: 5, adSales: 100, adUnits: 5, netProductSales: 140 }],
        totals: {},
      };
    },
  },
  AdsDashboardApp: {
    debug: {
      getAdsRowsForQueryCompatibility: () => [{
        id: 'raw-ad-1', storeId: 'YTDBNS', date: '2026-06-03',
        portfolio: 'Core', campaign: 'Campaign A', adGroup: 'Group 1',
        searchTerm: 'reading glasses women', targeting: 'reading glasses',
        targetingType: 'manual', matchType: 'EXACT', currentBid: 0.68,
        impr: 200, clicks: 10, spend: 4, orders: 1, sales: 20, units: 1,
        adProduct: 'SP',
      }],
      getTransactionRowsForFinance: () => [],
    },
  },
};

const context = vm.createContext({
  window,
  CustomEvent: TestCustomEvent,
  console,
  setTimeout,
  clearTimeout,
  Date,
  Map,
  Set,
  Promise,
  Number,
  String,
  Boolean,
  JSON,
  Object,
  Array,
  Error,
  RegExp,
  Math,
});
vm.runInContext(adapter, context, { filename: 'query-native-module-data-v1.js' });

const adsResult = await window.QueryNativeModuleData.ads({
  scope: 'YTDBNS',
  from: '2026-06-01',
  to: '2026-06-30',
  portfolio: 'Core',
  campaign: 'Campaign A',
  matchType: 'EXACT',
  adType: 'manual',
  search: 'reading -men',
  force: true,
});
assert.equal(queryCalls.length, 1);
assert.equal(queryCalls[0].campaign, 'Campaign A');
assert.equal(adsResult.source, 'query-tidb');
assert.equal(adsResult.rows.length, 1, 'Query ads rows must be deduplicated and client-filtered');
assert.equal(adsResult.rows[0].impr, 1000);
assert.equal(adsResult.rows[0].currentBid, 0.72);
assert.equal(adsResult.rows[0].advertisedAsin, null);
assert.equal(adsResult.rows[0].attributionWindowDays, null);
assert.equal(adsResult.rows[0].adProduct, null);
assert.equal(adsResult.rows[0].bidValueTrusted, true);
assert.equal(adsResult.governance.readiness.bidValueNullabilityTrusted, true);
assert.equal(adsResult.governance.readiness.bidGovernanceReady, false);

const overviewResult = await window.QueryNativeModuleData.overview({
  scope: 'YTDBNS',
  from: '2026-06-01',
  to: '2026-06-30',
  grain: 'day',
  force: true,
});
assert.equal(overviewCalls.length, 1);
assert.equal(overviewResult.source, 'query-tidb');
assert.equal(overviewResult.series[0].netProductSales, 140);

const rawResult = await window.QueryNativeModuleData.ads({
  source: 'raw',
  scope: 'YTDBNS',
  from: '2026-06-01',
  to: '2026-06-30',
  campaign: 'Campaign A',
  force: true,
});
assert.equal(rawResult.source, 'raw-compat');
assert.equal(rawResult.rows.length, 1);
assert.equal(rawResult.rows[0].impressions, 200);
assert.equal(rawResult.governance.readiness.bidGovernanceReady, false);

window.PrivateCloudQuery.ads = async () => {
  throw new Error('ads query unavailable');
};
window.QueryNativeModuleData.clearMemoryCache();
await assert.rejects(
  window.QueryNativeModuleData.ads({
    source: 'query',
    from: '2026-06-01',
    to: '2026-06-30',
    force: true,
  }),
  /ads query unavailable/,
  'Query ads failure must not silently fall back to Raw data',
);

assert.ok(emitted.some(event => event.type === 'lr:module-data-ready' && event.detail?.module === 'ads'));
assert.ok(emitted.some(event => event.type === 'lr:module-data-ready' && event.detail?.module === 'overview'));

console.log('Query-native ads trend contracts passed');