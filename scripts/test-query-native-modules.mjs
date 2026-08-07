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

assert.match(adapter, /const ADAPTER_VERSION = '1\.1\.0'/);
assert.match(adapter, /waitForQueryClient\('allTransactions'\)/);
assert.match(adapter, /client\.allTransactions\(\{/);
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
assert.match(queryClient, /const QUERY_NATIVE_ADAPTER_VERSION = '1\.1\.0'/);
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
const emitted = [];
class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}
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

console.log('Query-native module contracts passed');
