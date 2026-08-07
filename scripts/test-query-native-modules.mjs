import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const queryClient = readFileSync(new URL('../assets/private-cloud-query-v1.js', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../assets/query-native-module-data-v1.js', import.meta.url), 'utf8');
const finance = readFileSync(new URL('../assets/generated/inline-script-08.js', import.meta.url), 'utf8');

const section = (source, startNeedle, endNeedle) => {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Missing section start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing section end: ${endNeedle}`);
  return source.slice(start, end);
};

assert.match(adapter, /const ADAPTER_VERSION = '1\.2\.0'/);
assert.match(adapter, /waitForQueryClient\('allTransactions'\)/);
assert.match(adapter, /client\.allTransactions\(\{/);
assert.match(adapter, /waitForQueryClient\('ads'\)/);
assert.match(adapter, /client\.ads\(\{/);
assert.doesNotMatch(adapter, /waitForQueryClient\('allAds'\)/);
assert.match(adapter, /validateAdsGovernance/);
assert.match(adapter, /ADS_GOVERNANCE_VERSION = 'ads-query-governance-v2'/);
assert.match(adapter, /normalized\.bid = normalized\.currentBid \?\? normalized\.targetBid/);
assert.doesNotMatch(adapter, /metricValue\(source, 'adProduct', 'SP'\)/);
assert.doesNotMatch(adapter, /metricValue\(source, 'attributionWindowDays', 7\)/);
assert.match(adapter, /statusMode: request\.statusMode/);
assert.match(adapter, /source: normalizeSource\(options\.source\)/);
assert.match(adapter, /request\.source === 'raw'/);
assert.match(adapter, /explicit-raw-compatibility/);
assert.match(adapter, /transactionPreTaxNet/);
assert.match(adapter, /MARKETPLACE_ALIASES/);
assert.match(adapter, /marketplaceMatches/);
assert.doesNotMatch(adapter, /\/manifest\?/);
assert.doesNotMatch(adapter, /\/api\/v1\/raw\//);
assert.doesNotMatch(adapter, /__LR_IMPORT_MULTIPLE_FILES__/);

const cachedRowsSection = section(
  adapter,
  '  async function cachedRows(module, request, queryLoader, rawLoader) {',
  '\n\n  async function transactions',
);
assert.match(cachedRowsSection, /request\.source === 'raw'/);
assert.match(cachedRowsSection, /await rawLoader\(request\)/);
assert.match(cachedRowsSection, /await queryLoader\(request\)/);
assert.doesNotMatch(cachedRowsSection, /catch[\s\S]*rawLoader\(request\)/);
assert.match(adapter, /return cachedRows\('transactions', request, queryTransactions, rawTransactions\)/);

assert.match(index, /assets\/query-native-module-data-v1\.js\?v=1\.0\.0/);
assert.match(index, /assets\/generated\/inline-script-08\.js\?v=2\.0\.0/);
assert.ok(
  index.indexOf('assets/query-native-module-data-v1.js?v=1.0.0')
    < index.indexOf('assets/generated/inline-script-08.js?v=2.0.0'),
  'The bootstrap adapter tag must remain before the transaction finance module',
);
assert.match(queryClient, /const CLIENT_VERSION = '1\.3\.0'/);
assert.match(queryClient, /const QUERY_NATIVE_ADAPTER_VERSION = '1\.2\.0'/);
assert.match(queryClient, /query-native-module-data-v1\.js\?v=\$\{QUERY_NATIVE_ADAPTER_VERSION\}/);
assert.match(queryClient, /window\.QueryNativeModuleData\?\.version !== QUERY_NATIVE_ADAPTER_VERSION/);

assert.match(finance, /const MODULE_VERSION='2\.0\.0'/);
assert.match(finance, /sourceMode='query'/);
assert.match(finance, /adapter\.periodTransactions/);
assert.match(finance, /renderGeneration/);
assert.match(finance, /raw-compat/);
assert.match(finance, /使用已导入 Raw 数据/);
assert.match(finance, /正在读取 Raw 兼容数据/);
assert.doesNotMatch(finance, /const rowsFor=/);
assert.doesNotMatch(finance, /const getAllTransactionRows=/);

const queryCalls = [];
const adCalls = [];
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
    attributionWindowDays: { state: 'source-unavailable', value: null },
    targetingId: { state: 'source-present', value: null },
    targetBid: { state: 'source-present', value: null },
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

const window = {
  ACTIVE_SHOP: 'YTDBNS',
  ShopScope: { get: () => 'YTDBNS' },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent(event) { emitted.push(event); },
  PrivateCloudQuery: {
    async allTransactions(options) {
      queryCalls.push(options);
      return {
        nextOffset: null,
        rows: [
          {
            id: 'tx-1', storeId: 'YTDBNS', date: '2026-06-03', category: 'REFUND',
            marketplace: 'amazon.com', status: 'Released', productSales: -20,
            shippingCredits: -3, giftWrapCredits: 0, regulatoryFee: 0,
            promotionalRebates: 1, sellingFees: 2, fbaFees: 1,
            otherTransactionFees: 0, other: 0, total: -19,
            isReleased: true, isDeferred: false,
          },
          {
            id: 'tx-1', storeId: 'YTDBNS', date: '2026-06-03', category: 'REFUND',
            marketplace: 'amazon.com', status: 'Released', productSales: -20,
            shippingCredits: -3, promotionalRebates: 1, sellingFees: 2,
            fbaFees: 1, total: -19, isReleased: true, isDeferred: false,
          },
          {
            id: 'tx-2', storeId: 'YTDBNS', date: '2026-06-04', category: 'ORDER',
            marketplace: 'amazon.ca', status: 'Released', productSales: 50,
            total: 42, isReleased: true, isDeferred: false,
          },
        ],
      };
    },
    async ads(options) {
      adCalls.push(options);
      if (Number(options.offset || 0) === 0) {
        return {
          nextOffset: 2,
          governance,
          rows: [
            {
              id: 'ad-missing', storeId: 'YTDBNS', date: '2026-06-01', campaign: 'C1',
              targetingId: 't1', searchTerm: 'alpha', matchType: 'EXACT', bid: null,
              adProduct: null, attributionWindowDays: null, bidValueTrusted: true,
              governanceReady: false, metrics: { targetBid: null },
              impressions: 10, clicks: 1, spend: 1, orders: 0, sales: 0,
            },
            {
              id: 'ad-zero', storeId: 'YTDBNS', date: '2026-06-02', campaign: 'C1',
              targetingId: 't2', searchTerm: 'beta', matchType: 'EXACT', bid: 0,
              adProduct: null, attributionWindowDays: null, bidValueTrusted: true,
              governanceReady: false, metrics: { targetBid: 0 },
              impressions: 20, clicks: 2, spend: 2, orders: 1, sales: 10,
            },
          ],
        };
      }
      return {
        nextOffset: null,
        governance,
        rows: [
          {
            id: 'ad-positive', storeId: 'YTDBNS', date: '2026-06-03', campaign: 'C1',
            targetingId: 't3', searchTerm: 'gamma', matchType: 'PHRASE', bid: 1.25,
            adProduct: null, attributionWindowDays: null, bidValueTrusted: true,
            governanceReady: false, metrics: { targetBid: 1.25 },
            impressions: 30, clicks: 3, spend: 3, orders: 1, sales: 15,
          },
        ],
      };
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
});
vm.runInContext(adapter, context, { filename: 'query-native-module-data-v1.js' });

const queryResult = await window.QueryNativeModuleData.transactions({
  from: '2026-06-01',
  to: '2026-06-30',
  statusMode: 'accrual',
  marketplace: 'US',
  force: true,
});
assert.equal(queryCalls.length, 1);
assert.deepEqual(
  { scope: queryCalls[0].scope, from: queryCalls[0].from, to: queryCalls[0].to, statusMode: queryCalls[0].statusMode },
  { scope: 'YTDBNS', from: '2026-06-01', to: '2026-06-30', statusMode: 'accrual' },
);
assert.equal(queryResult.source, 'query-tidb');
assert.equal(queryResult.rows.length, 1, 'Query rows must be deduplicated and marketplace-filtered');
assert.equal(queryResult.rows[0].preTaxNet, -19);
assert.ok(emitted.some(event => event.type === 'lr:module-data-ready'));

const adsResult = await window.QueryNativeModuleData.ads({
  from: '2026-06-01',
  to: '2026-06-30',
  campaign: 'C1',
  force: true,
});
assert.equal(adCalls.length, 2, 'Ads adapter must page through client.ads so governance is retained');
assert.equal(adsResult.source, 'query-tidb');
assert.equal(adsResult.rows.length, 3);
assert.equal(adsResult.governance.schemaVersion, 'ads-query-governance-v2');
assert.equal(adsResult.governance.readiness.bidValueNullabilityTrusted, true);
assert.equal(adsResult.governance.readiness.bidGovernanceReady, false);
assert.deepEqual(adsResult.rows.map(row => row.bid), [null, 0, 1.25]);
assert.ok(adsResult.rows.every(row => row.adProduct === null));
assert.ok(adsResult.rows.every(row => row.attributionWindowDays === null));
assert.ok(adsResult.rows.every(row => row.bidValueTrusted === true));
assert.equal(window.QueryNativeModuleData.state().lastGovernance.readiness.bidGovernanceReady, false);

window.AdsDashboardApp = {
  debug: {
    getTransactionRowsForFinance: () => [{
      id: 'raw-1', storeId: 'YTDBNS', date: '2026-06-05', category: 'ORDER',
      marketplace: 'amazon.com', status: 'Released', productSales: 30,
      total: 25, isReleased: true, isDeferred: false,
    }],
  },
};
const rawResult = await window.QueryNativeModuleData.transactions({
  source: 'raw',
  from: '2026-06-01',
  to: '2026-06-30',
  marketplace: 'US',
  force: true,
});
assert.equal(rawResult.source, 'raw-compat');
assert.equal(rawResult.rows.length, 1);

window.PrivateCloudQuery.allTransactions = async () => {
  throw new Error('query unavailable');
};
window.QueryNativeModuleData.clearMemoryCache();
await assert.rejects(
  window.QueryNativeModuleData.transactions({
    source: 'query',
    from: '2026-06-01',
    to: '2026-06-30',
    force: true,
  }),
  /query unavailable/,
  'Query failure must not silently fall back to Raw data',
);

window.PrivateCloudQuery.ads = async () => ({ rows: [], nextOffset: null });
window.QueryNativeModuleData.clearMemoryCache();
await assert.rejects(
  window.QueryNativeModuleData.ads({
    source: 'query',
    from: '2026-06-01',
    to: '2026-06-30',
    force: true,
  }),
  /缺少治理契约/,
  'Ads Query without governance must fail closed',
);

console.log('Query-native module contracts passed');