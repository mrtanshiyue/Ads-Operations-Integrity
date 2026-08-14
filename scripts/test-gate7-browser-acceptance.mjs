import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-gate7-ui-acceptance-v1.js'), 'utf8');
const builtIndex = await readFile(path.join(repoRoot, 'dist-cloudflare-native/index.html'), 'utf8');

const NAV_TARGETS = [
  'overviewSection',
  'growthCommandSection',
  'multiDimCard',
  'rankGovernanceCard',
  'rootMatrixCard',
  'businessReportCard',
  'transactionReportCard',
];
const CONTROL_IDS = ['fileInput', 'mergeMode', 'dedupeMode', 'dateStart', 'dateEnd', 'filterSearchTerm'];

function createSandbox(environment = 'development', resourceUrls = []) {
  const ids = new Map();
  for (const id of [...NAV_TARGETS, ...CONTROL_IDS]) ids.set(id, { id });
  const appended = [];
  const htmlAttrs = new Map();
  const cspMeta = {
    getAttribute(name) {
      return name === 'content' ? "default-src 'self'; connect-src 'self'; object-src 'none'" : null;
    },
  };
  const navLinks = NAV_TARGETS.map((id) => ({
    getAttribute(name) { return name === 'href' ? `#${id}` : null; },
  }));
  const body = {
    classList: { contains(value) { return value === 'final-workspace-v60'; } },
    appendChild(node) { appended.push(node); if (node?.id) ids.set(node.id, node); },
  };
  const document = {
    body,
    documentElement: { setAttribute(name, value) { htmlAttrs.set(name, value); } },
    querySelector(selector) {
      if (['.app', '.sidebar', '.content'].includes(selector)) return { selector };
      if (selector === 'meta[http-equiv="Content-Security-Policy"]') return cspMeta;
      return null;
    },
    querySelectorAll(selector) {
      return selector === '.sidebarNav a' ? navLinks : [];
    },
    getElementById(id) { return ids.get(id) || null; },
    createElement(tag) {
      return {
        tag,
        id: '',
        textContent: '',
        style: { cssText: '' },
        setAttribute() {},
        remove() {},
      };
    },
  };

  const api = {
    async session() {
      return {
        authenticated: true,
        provisioned: true,
        user: { userId: 'user-dev-owner' },
      };
    },
  };
  const bridge = {
    source: 'query-cloudflare-d1',
    async ads() {
      return {
        source: 'query-cloudflare-d1',
        governance: {
          sourceBackend: 'cloudflare-d1',
          readiness: {
            targetingIdentityReady: false,
            bidSourceColumnReady: false,
            bidValueNullabilityTrusted: false,
            bidGovernanceReady: false,
            campaignStudioReady: false,
          },
        },
        rows: [
          {
            date: '2026-08-11',
            reportGranularity: 'DAY',
            currentBid: null,
            targetBid: null,
            bid: null,
            bidValueTrusted: false,
            governanceReady: false,
          },
          {
            date: '2026-08-12',
            reportGranularity: 'DAY',
            currentBid: null,
            targetBid: null,
            bid: null,
            bidValueTrusted: false,
            governanceReady: false,
          },
        ],
      };
    },
    async allTransactions() {
      const error = new Error('cloudflare_transactions_not_migrated');
      error.status = 501;
      error.code = 'cloudflare_transactions_not_migrated';
      throw error;
    },
  };

  class TestCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }

  const window = {
    location: {
      origin: 'https://ads-operations-web-dev.tanshiyuesir.workers.dev',
      search: '?cf_gate7=1',
    },
    document,
    performance: {
      getEntriesByType(type) {
        return type === 'resource' ? resourceUrls.map((name) => ({ name })) : [];
      },
    },
    CloudflareNativeAPI: api,
    CloudflareNativeQueryBridge: bridge,
    PrivateCloudQuery: bridge,
    dispatchEvent() {},
  };
  const quietConsole = { info() {}, error() {}, log() {}, warn() {} };
  const fetch = async (pathValue) => ({
    ok: true,
    status: 200,
    async json() {
      if (pathValue === '/api/health') return { environment, syncTriggerEnabled: false };
      return {};
    },
  });
  const sandbox = {
    window,
    document,
    performance: window.performance,
    fetch,
    URL,
    URLSearchParams,
    CustomEvent: TestCustomEvent,
    Date,
    Array,
    Object,
    String,
    Boolean,
    Error,
    Set,
    Promise,
    console: quietConsole,
  };
  vm.runInNewContext(source, sandbox, { filename: 'cloudflare-gate7-ui-acceptance-v1.js' });
  return { window, appended, htmlAttrs };
}

const sameOriginResources = [
  'https://ads-operations-web-dev.tanshiyuesir.workers.dev/assets/cloudflare-native-api-v1.js',
  'https://ads-operations-web-dev.tanshiyuesir.workers.dev/assets/cloudflare-native-query-bridge-v1.js',
  'https://ads-operations-web-dev.tanshiyuesir.workers.dev/assets/cloudflare-gate7-ui-acceptance-v1.js',
];
const dev = createSandbox('development', sameOriginResources);
const result = await dev.window.CloudflareGate7Acceptance.pending;
assert.equal(result.ok, true);
assert.equal(dev.window.__CF_GATE7_RESULT__.ok, true);
assert.equal(dev.htmlAttrs.get('data-cf-gate7'), 'pass');
const checks = new Map(result.checks.map((check) => [check.name, check]));
for (const name of [
  'environment_is_development',
  'sync_kill_switch_health',
  'session_authenticated',
  'session_provisioned',
  'owner_identity_mapping',
  'workspace_shell_present',
  'workspace_layout_version',
  'sidebar_navigation_contract',
  'sidebar_navigation_targets_resolve',
  'local_raw_workflow_controls_present',
  'same_origin_connect_policy',
  'native_query_bridge',
  'private_cloud_alias_native',
  'ads_query_cloudflare_d1',
  'query_dates_remain_daily',
  'bid_values_remain_untrusted',
  'governance_remains_closed',
  'retired_query_backend_not_requested',
  'runtime_resources_same_origin',
  'transactions_explicit_not_migrated',
]) {
  assert.equal(checks.get(name)?.ok, true, `${name} should pass`);
}
assert.equal(dev.appended.some((node) => node.id === 'cf-gate7-acceptance'), true);

const prod = createSandbox('production', sameOriginResources);
const prodResult = await prod.window.CloudflareGate7Acceptance.pending;
assert.equal(prodResult.ok, false);
assert.equal(prodResult.error, 'gate7_acceptance_dev_only');
assert.equal(prod.htmlAttrs.get('data-cf-gate7'), 'fail');

const retired = createSandbox('development', [
  ...sameOriginResources,
  'https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev/query',
]);
const retiredResult = await retired.window.CloudflareGate7Acceptance.pending;
assert.equal(retiredResult.ok, false);
assert.equal(retiredResult.checks.find((check) => check.name === 'retired_query_backend_not_requested')?.ok, false);
assert.equal(retiredResult.checks.find((check) => check.name === 'runtime_resources_same_origin')?.ok, false);

assert.equal((builtIndex.match(/assets\/cloudflare-gate7-ui-acceptance-v1\.js/g) || []).length, 1);
assert.match(builtIndex, /connect-src\s+'self';/i);
assert.doesNotMatch(builtIndex, /assets\/private-cloud-query-v1\.js/i);

console.log(JSON.stringify({
  ok: true,
  contracts: [
    'gate7-dev-only',
    'authenticated-ui-shell',
    'sidebar-navigation-targets',
    'local-raw-workflow-controls',
    'same-origin-csp',
    'native-query-cloudflare-d1',
    'daily-report-dates',
    'bid-values-untrusted',
    'governance-closed',
    'retired-backend-not-requested',
    'transactions-explicit-501',
    'gate7-client-single-injection',
  ],
}));
