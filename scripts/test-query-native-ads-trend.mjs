import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../assets/query-native-module-data-v1.js', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../assets/query-native-ads-trend-v1.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../assets/generated/inline-script-04.js', import.meta.url), 'utf8');

assert.match(adapter, /const ADAPTER_VERSION = '1\.1\.0'/);
assert.match(adapter, /async function queryAds\(request\)/);
assert.match(adapter, /client\.allAds\(\{/);
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

assert.match(main, /window\.QueryNativeAdsTrend\?\.ownsTrend\?\.\(\)/);
assert.match(main, /getAdsRowsForQueryCompatibility:\(\)=>AdsStore\.all/);
assert.match(index, /assets\/query-native-module-data-v1\.js\?v=1\.1\.0/);
assert.match(index, /assets\/query-native-ads-trend-v1\.js\?v=1\.0\.0/);
assert.ok(
  index.indexOf('assets/query-native-module-data-v1.js?v=1.1.0')
    < index.indexOf('assets/query-native-ads-trend-v1.js?v=1.0.0'),
  'The Query-native adapter must load before the ads trend controller',
);

const queryCalls = [];
const overviewCalls = [];
const emitted = [];
class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

const queryRows = [
  {
    id: 'ad-1', storeId: 'YTDBNS', date: '2026-06-01',
    portfolio: 'Core', campaign: 'Campaign A', adGroup: 'Group 1',
    searchTerm: 'reading glasses women', targeting: 'reading glasses',
    targetingType: 'manual', matchType: 'EXACT', bid: 0.72,
    impressions: 1000, clicks: 50, spend: 20, orders: 5, sales: 100, units: 5,
    metrics: { adProduct: 'SP', advertisedAsin: 'B000000001', attributionWindowDays: 7 },
  },
  {
    id: 'ad-1', storeId: 'YTDBNS', date: '2026-06-01',
    portfolio: 'Core', campaign: 'Campaign A', adGroup: 'Group 1',
    searchTerm: 'reading glasses women', targeting: 'reading glasses',
    targetingType: 'manual', matchType: 'EXACT', bid: 0.72,
    impressions: 1000, clicks: 50, spend: 20, orders: 5, sales: 100, units: 5,
    metrics: { adProduct: 'SP', advertisedAsin: 'B000000001', attributionWindowDays: 7 },
  },
  {
    id: 'ad-2', storeId: 'YTDBNS', date: '2026-06-02',
    portfolio: 'Other', campaign: 'Campaign B', adGroup: 'Group 2',
    searchTerm: 'reading glasses men', targeting: 'reading glasses',
    targetingType: 'manual', matchType: 'BROAD', bid: 0.40,
    impressions: 500, clicks: 20, spend: 12, orders: 1, sales: 25, units: 1,
    metrics: { adProduct: 'SP' },
  },
];

const window = {
  ACTIVE_SHOP: 'YTDBNS',
  ShopScope: { get: () => 'YTDBNS' },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent(event) { emitted.push(event); },
  PrivateCloudQuery: {
    async allAds(options) {
      queryCalls.push(options);
      return { rows: queryRows, nextOffset: null };
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
  adProduct: 'SP',
  search: 'reading -men',
  force: true,
});
assert.equal(queryCalls.length, 1);
assert.equal(queryCalls[0].campaign, 'Campaign A');
assert.equal(adsResult.source, 'query-tidb');
assert.equal(adsResult.rows.length, 1, 'Query ads rows must be deduplicated and client-filtered');
assert.equal(adsResult.rows[0].impr, 1000);
assert.equal(adsResult.rows[0].currentBid, 0.72);
assert.equal(adsResult.rows[0].advertisedAsin, 'B000000001');
assert.equal(adsResult.rows[0].attributionWindowDays, 7);
assert.equal(adsResult.rows[0].adProduct, 'SP');

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

window.PrivateCloudQuery.allAds = async () => {
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
