import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-query-bridge-v1.js'), 'utf8');
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
vm.runInNewContext(bridgeSource, sandbox, { filename: 'cloudflare-native-query-bridge-v1.js' });

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
assert.deepEqual(overview.series.map((row) => row.date), ['2026-08-11', '2026-08-12']);
assert.deepEqual(overview.totals, {
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
    'private-cloud-query-alias-native',
    'search-term-real-report-date',
    'report-granularity-day',
    'bid-values-explicit-null-untrusted',
    'governance-not-ready',
    'transactions-explicit-501',
    'overview-daily-series',
    'same-origin-csp',
    'native-client-single-injection',
    'legacy-query-client-absent',
    'native-provenance-cloudflare-d1',
  ],
}));
