import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/query-native-bid-intelligence-v1.js', import.meta.url), 'utf8');

assert.match(source, /const PREVIEW_VERSION = '1\.0\.0'/);
assert.match(source, /const GOVERNANCE_VERSION = 'ads-query-governance-v2'/);
assert.match(source, /window\.QueryNativeModuleData/);
assert.match(source, /adapter\.ads\(\{ \.\.\.request, source: 'query'/);
assert.match(source, /executionAuthorized: false/);
assert.match(source, /不生成 Suggested Bid/);
assert.match(source, /本模块不生成调价动作/);
assert.doesNotMatch(source, /\bAdsStore(?:\.|\[|\?)/, 'Preview must not access the legacy AdsStore object');
assert.doesNotMatch(source, /suggestedBid/);
assert.doesNotMatch(source, /assertActionAllowed|adoptGovernance|report_slots/);

const emitted = [];
class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}
class TestMutationObserver {
  observe() {}
  disconnect() {}
}
const document = {
  readyState: 'loading',
  documentElement: {},
  addEventListener() {},
  getElementById() { return null; },
  createElement() { return { id: '', style: {}, dataset: {}, textContent: '', appendChild() {} }; },
};
const window = {
  addEventListener() {},
  dispatchEvent(event) { emitted.push(event); },
};
const context = vm.createContext({
  window,
  document,
  CustomEvent: TestCustomEvent,
  MutationObserver: TestMutationObserver,
  console,
  setTimeout,
  clearTimeout,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  Promise,
  Map,
  Set,
  Math,
});
vm.runInContext(source, context, { filename: 'query-native-bid-intelligence-v1.js' });

const preview = window.QueryNativeBidIntelligence;
assert.equal(preview.version, '1.0.0');

const blockedGovernance = {
  schemaVersion: 'ads-query-governance-v2',
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
};
const rows = [
  {
    date: '2026-06-01', targetingId: 'T1', targeting: 'reading glasses women',
    campaign: 'Campaign A', adGroup: 'Ad Group A', impressions: 1000, clicks: 50,
    spend: 10, sales: 50, orders: 2, currentBid: 0.50, bidValueTrusted: true,
  },
  {
    date: '2026-06-02', targetingId: 'T1', targeting: 'reading glasses women',
    campaign: 'Campaign A', adGroup: 'Ad Group A', impressions: 800, clicks: 30,
    spend: 5, sales: 0, orders: 0, currentBid: 0.55, bidValueTrusted: true,
  },
  {
    date: '2026-06-02', targetingId: 'T2', targeting: 'fashion readers',
    campaign: 'Campaign B', adGroup: 'Ad Group B', impressions: 600, clicks: 25,
    spend: 20, sales: 0, orders: 0, currentBid: null, bidValueTrusted: true,
  },
];

const blocked = preview.analyzeRows(rows, blockedGovernance);
assert.equal(blocked.summary.rowCount, 3);
assert.equal(blocked.summary.groupCount, 2);
assert.equal(blocked.summary.spend, 35);
assert.equal(blocked.summary.sales, 50);
assert.equal(blocked.summary.orders, 2);
assert.equal(blocked.summary.bidCoverage, 2 / 3);
assert.equal(blocked.summary.bidGovernanceReady, false);
assert.ok(blocked.summary.blockers.includes('归因窗口源数据不可用'));
const t1 = blocked.groups.find(row => row.targetingId === 'T1');
const t2 = blocked.groups.find(row => row.targetingId === 'T2');
assert.equal(t1.latestBid, 0.55, 'Latest trusted bid must be selected by date');
assert.equal(t1.signal.key, 'analysis-only', 'Missing attribution maturity must prevent action-like interpretation');
assert.equal(t2.latestBid, null);
assert.equal(t2.signal.key, 'bid-missing');

const readyGovernance = {
  schemaVersion: 'ads-query-governance-v2',
  readiness: {
    targetingIdentityReady: true,
    bidSourceColumnReady: true,
    bidValueNullabilityTrusted: true,
    adProductReady: true,
    advertisedProductIdentityReady: true,
    attributionMaturityReady: true,
    bidGovernanceReady: true,
    campaignStudioReady: true,
  },
};
const ready = preview.analyzeRows(rows.slice(0, 2), readyGovernance);
assert.equal(ready.summary.bidGovernanceReady, true);
assert.equal(ready.groups[0].signal.key, 'efficient');
assert.match(ready.groups[0].signal.detail, /不生成调价动作/);
assert.equal(preview.state().executionAuthorized, false);

console.log('Query-native bid intelligence preview contracts passed');
