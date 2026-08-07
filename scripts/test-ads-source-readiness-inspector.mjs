import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/query-native-ads-source-readiness-v1.js', import.meta.url), 'utf8');

assert.match(source, /const INSPECTOR_VERSION = '1\.0\.0'/);
assert.match(source, /const PREFLIGHT_VERSION = 'ads-source-preflight-v1'/);
assert.match(source, /CSV_PREFIX_BYTES = 262144/);
assert.match(source, /file\.slice\(0, CSV_PREFIX_BYTES\)\.text\(\)/);
assert.match(source, /client\.preflightAdsSource\(normalized\)/);
assert.match(source, /activation\?\.writesFacts !== false/);
assert.match(source, /activation\?\.changesCurrentSlot !== false/);
assert.match(source, /activation\?\.authorizesExecution !== false/);
assert.match(source, /候选报表字段满足/);
assert.doesNotMatch(source, /report_slots|localStorage|sessionStorage/i);
assert.doesNotMatch(source, /QueryNativeGovernanceGate\.(?:adopt|refresh|assertActionAllowed)/);

const elements = new Map();
const listeners = new Map();
const createElement = tag => ({
  tagName: tag.toUpperCase(),
  id: '',
  dataset: {},
  style: {},
  hidden: false,
  textContent: '',
  innerHTML: '',
  children: [],
  parentElement: null,
  files: [],
  value: '',
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    if (child.id) elements.set(child.id, child);
  },
  insertBefore(child) {
    child.parentElement = this;
    this.children.push(child);
    if (child.id) elements.set(child.id, child);
  },
  addEventListener(type, fn) { this[`on${type}`] = fn; },
  click() { this.clicked = true; },
});

const panel = createElement('div');
panel.id = 'privateCloudImportPanel';
elements.set(panel.id, panel);
const overview = createElement('div');
overview.id = 'queryFirstOverviewCard';
elements.set(overview.id, overview);
panel.appendChild(overview);
const status = createElement('div');
status.id = 'privateCloudImportStatus';
elements.set(status.id, status);
panel.appendChild(status);

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
  readyState: 'complete',
  documentElement: {},
  head: {
    appendChild(node) {
      if (node.id) elements.set(node.id, node);
    },
  },
  getElementById(id) { return elements.get(id) || null; },
  createElement(tag) {
    const element = createElement(tag);
    Object.defineProperty(element, 'innerHTML', {
      get() { return this._innerHTML || ''; },
      set(value) {
        this._innerHTML = String(value);
        const ids = [...String(value).matchAll(/id="([^"]+)"/g)].map(match => match[1]);
        for (const id of ids) {
          if (!elements.has(id)) {
            const child = createElement(id.includes('File') ? 'input' : id.startsWith('btn') ? 'button' : 'div');
            child.id = id;
            elements.set(id, child);
          }
        }
      },
    });
    return element;
  },
  addEventListener(type, fn) { listeners.set(type, fn); },
};

const preflightCalls = [];
const emitted = [];
const preflightResult = {
  schemaVersion: 'ads-source-preflight-v1',
  headerCount: 16,
  recordType: 'search-term',
  readiness: {
    queryAnalysisCandidate: true,
    bidGovernanceCandidate: false,
    campaignStudioCandidate: false,
  },
  missingForBidGovernance: ['adProduct', 'advertisedAsin', 'advertisedSku', 'attributionWindowDays'],
  missingForCampaignStudio: ['adProduct', 'advertisedAsin', 'advertisedSku', 'attributionWindowDays'],
  activation: {
    writesFacts: false,
    changesCurrentSlot: false,
    authorizesExecution: false,
    status: 'preflight-only',
  },
};
const window = {
  PrivateCloudQuery: {
    async preflightAdsSource(headers) {
      preflightCalls.push(headers);
      return preflightResult;
    },
  },
  addEventListener(type, fn) { listeners.set(`window:${type}`, fn); },
  dispatchEvent(event) { emitted.push(event); },
  Papa: {},
  XLSX: {},
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
vm.runInContext(source, context, { filename: 'query-native-ads-source-readiness-v1.js' });

const inspector = window.AdsSourceReadinessInspector;
assert.equal(inspector.version, '1.0.0');
const headers = [
  'Date', 'Customer Search Term', 'Targeting ID', 'Campaign ID', 'Ad Group ID',
  'Match Type', 'Impressions', 'Clicks', 'Spend', 'Orders', 'Sales', 'Bid',
];
const result = await inspector.inspectHeaders(headers, { fileName: 'candidate.csv' });
assert.equal(preflightCalls.length, 1);
assert.deepEqual(Array.from(preflightCalls[0]), headers);
assert.equal(result.activation.authorizesExecution, false);
assert.equal(inspector.state().fileName, 'candidate.csv');
assert.equal(inspector.state().status, 'ready');
assert.equal(elements.get('adsSourceReadinessGrid').hidden, false);
assert.match(elements.get('adsSourceReadinessResult').textContent, /Bid 缺失/);
assert.match(elements.get('adsSourceReadinessResult').textContent, /Ad Product/);
assert.ok(emitted.some(event => event.type === 'lr:ads-source-readiness-inspector-ready'));

window.PrivateCloudQuery.preflightAdsSource = async () => ({
  ...preflightResult,
  activation: { ...preflightResult.activation, authorizesExecution: true },
});
await assert.rejects(
  () => inspector.inspectHeaders(headers),
  /越过只读安全边界/,
  'Inspector must fail closed if preflight claims execution authorization',
);

console.log('Ads source readiness inspector contracts passed');
