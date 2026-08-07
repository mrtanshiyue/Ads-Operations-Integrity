import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const gateSource = readFileSync(new URL('../assets/query-native-governance-gate-v1.js', import.meta.url), 'utf8');
const queryClient = readFileSync(new URL('../assets/private-cloud-query-v1.js', import.meta.url), 'utf8');

assert.match(gateSource, /const GATE_VERSION = '1\.0\.0'/);
assert.match(gateSource, /const GOVERNANCE_VERSION = 'ads-query-governance-v2'/);
assert.match(gateSource, /btnAIBulk: 'bid'/);
assert.match(gateSource, /btnExportNeg: 'bid'/);
assert.match(gateSource, /btnActionExportSelected: 'bid'/);
assert.match(gateSource, /btnExportActionKeywordExact: 'bid'/);
assert.match(gateSource, /btnCentralExport: 'bid'/);
assert.match(gateSource, /btnLtV5ExportSelected: 'bid'/);
assert.match(gateSource, /btnCopyCampaignStudio: 'campaign'/);
assert.match(gateSource, /btnExportCampaignStudioBulk: 'campaign'/);
assert.match(gateSource, /document\.addEventListener\('click', handleGuardedClick, true\)/);
assert.match(gateSource, /event\.stopImmediatePropagation\(\)/);
assert.match(gateSource, /await client\.ads\(\{/);
assert.match(gateSource, /limit: 1/);
assert.match(gateSource, /readiness\.bidGovernanceReady/);
assert.match(gateSource, /readiness\.campaignStudioReady/);
assert.match(gateSource, /Advertised ASIN\/SKU 源数据不可用/);
assert.match(gateSource, /归因窗口源数据不可用/);
assert.doesNotMatch(gateSource, /sessionStorage|localStorage/);

assert.match(queryClient, /const CLIENT_VERSION = '1\.3\.0'/);
assert.match(queryClient, /const QUERY_NATIVE_GATE_VERSION = '1\.0\.0'/);
assert.match(queryClient, /query-native-governance-gate-v1\.js\?v=\$\{QUERY_NATIVE_GATE_VERSION\}/);
assert.ok(
  queryClient.indexOf('window.QueryNativeModuleData?.version !== QUERY_NATIVE_ADAPTER_VERSION')
    < queryClient.indexOf('window.QueryNativeGovernanceGate?.version !== QUERY_NATIVE_GATE_VERSION')
    && queryClient.indexOf('window.QueryNativeGovernanceGate?.version !== QUERY_NATIVE_GATE_VERSION')
      < queryClient.indexOf('window.QueryNativeAdsTrend?.version !== QUERY_NATIVE_TREND_VERSION'),
  'Governance gate must load after the adapter and before trend/action hosts',
);

const elements = new Map();
const listeners = new Map();
const createElement = id => ({
  id,
  value: '',
  dataset: {},
  style: {},
  title: '',
  hidden: false,
  innerHTML: '',
  setAttribute(name, value) { this[name] = String(value); },
  addEventListener() {},
  closest(selector) { return selector === '[id]' ? this : null; },
  click() { this.clickCount = Number(this.clickCount || 0) + 1; },
});
for (const id of [
  'dateStart', 'dateEnd', 'btnCentralExport', 'btnExportCampaignStudioBulk', 'btnExportActionPlan',
]) elements.set(id, createElement(id));
elements.get('dateStart').value = '2026-06-01';
elements.get('dateEnd').value = '2026-06-30';

const currentGovernance = {
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
const futureGovernance = {
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
let governanceResponse = currentGovernance;
const queryCalls = [];
const emitted = [];

class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}
class TestMutationObserver {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
}

const document = {
  readyState: 'complete',
  documentElement: {},
  body: { appendChild(element) { if (element?.id) elements.set(element.id, element); } },
  getElementById(id) { return elements.get(id) || null; },
  createElement() { return createElement(''); },
  addEventListener(type, callback, capture) { listeners.set(`${type}:${Boolean(capture)}`, callback); },
};
const window = {
  ACTIVE_SHOP: 'YTDBNS',
  ShopScope: { get: () => 'YTDBNS' },
  PrivateCloudQuery: {
    async ads(options) {
      queryCalls.push(options);
      return { rows: [], nextOffset: null, governance: governanceResponse };
    },
  },
  addEventListener(type, callback) { listeners.set(`window:${type}`, callback); },
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
  queueMicrotask,
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
});
vm.runInContext(gateSource, context, { filename: 'query-native-governance-gate-v1.js' });

const gate = window.QueryNativeGovernanceGate;
assert.equal(gate.version, '1.0.0');
assert.equal(gate.governedActions().btnCentralExport, 'bid');
assert.equal(gate.governedActions().btnExportCampaignStudioBulk, 'campaign');
assert.equal(gate.governedActions().btnExportActionPlan, undefined, 'Analysis-only action plan export must remain outside the execution gate');

const blocked = await gate.refresh({ force: true });
assert.equal(queryCalls.length, 1);
assert.equal(queryCalls[0].scope, 'YTDBNS');
assert.equal(queryCalls[0].from, '2026-06-01');
assert.equal(queryCalls[0].to, '2026-06-30');
assert.equal(queryCalls[0].limit, 1);
assert.equal(blocked.bidGovernanceReady, false);
assert.equal(blocked.campaignStudioReady, false);
assert.ok(blocked.bidReasons.some(reason => /广告产品类型/.test(reason)));
assert.ok(blocked.bidReasons.some(reason => /Advertised ASIN\/SKU/.test(reason)));
assert.ok(blocked.bidReasons.some(reason => /归因窗口/.test(reason)));
await assert.rejects(() => gate.assertActionAllowed('btnCentralExport'), /执行已阻断/);
await assert.rejects(() => gate.assertActionAllowed('btnExportCampaignStudioBulk'), /执行已阻断/);
assert.equal(await gate.assertActionAllowed('btnExportActionPlan'), true);
assert.equal(elements.get('btnCentralExport')['aria-disabled'], 'true');

const capture = listeners.get('click:true');
assert.equal(typeof capture, 'function');
let prevented = false;
let stopped = false;
capture({
  target: elements.get('btnCentralExport'),
  preventDefault() { prevented = true; },
  stopImmediatePropagation() { stopped = true; },
});
assert.equal(prevented, true, 'Guarded execution click must be prevented before legacy listeners run');
assert.equal(stopped, true, 'Guarded execution click must stop legacy listeners before governance approval');

await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(emitted.some(event => event.type === 'lr:governance-action-blocked'));

governanceResponse = futureGovernance;
const ready = await gate.refresh({ force: true });
assert.equal(ready.bidGovernanceReady, true);
assert.equal(ready.campaignStudioReady, true);
assert.equal(await gate.assertActionAllowed('btnCentralExport'), true);
assert.equal(await gate.assertActionAllowed('btnExportCampaignStudioBulk'), true);
assert.equal(elements.get('btnCentralExport')['aria-disabled'], 'false');

console.log('Query-native source-proven execution gate contracts passed');
