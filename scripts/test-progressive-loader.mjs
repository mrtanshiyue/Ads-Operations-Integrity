import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const loader = readFileSync(new URL('../assets/private-cloud-warehouse-v4.js', import.meta.url), 'utf8');
const query = readFileSync(new URL('../assets/private-cloud-query-v1.js', import.meta.url), 'utf8');
const sourceReadiness = readFileSync(new URL('../assets/query-native-ads-source-readiness-v1.js', import.meta.url), 'utf8');
const bidIntelligence = readFileSync(new URL('../assets/query-native-bid-intelligence-v1.js', import.meta.url), 'utf8');
const legacyCore = readFileSync(new URL('../assets/generated/inline-script-04.js', import.meta.url), 'utf8');
const parityAudit = readFileSync(new URL('../assets/bid-governance-parity-audit-v1.js', import.meta.url), 'utf8');
const shopUi = readFileSync(new URL('../assets/generated/inline-script-11.js', import.meta.url), 'utf8');

const section = (source, startNeedle, endNeedle) => {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Missing section start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing section end: ${endNeedle}`);
  return source.slice(start, end);
};

assert.match(index, /assets\/generated\/inline-script-11\.js\?v=1\.1\.0/);
assert.match(index, /assets\/private-cloud-warehouse-v4\.js/);
assert.doesNotMatch(index, /assets\/private-cloud-warehouse-v4\.js\?v=/);
assert.match(loader, /const LOADER_VERSION = '4\.3\.0'/);
assert.match(query, /const CLIENT_VERSION = '1\.3\.0'/);
assert.match(query, /const QUERY_NATIVE_ADAPTER_VERSION = '1\.2\.0'/);
assert.match(query, /const QUERY_NATIVE_GATE_VERSION = '1\.0\.0'/);
assert.match(query, /const QUERY_NATIVE_SOURCE_READINESS_VERSION = '1\.0\.0'/);
assert.match(query, /const QUERY_NATIVE_BID_INTELLIGENCE_VERSION = '1\.0\.0'/);
assert.match(query, /const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1\.0\.1'/);
assert.match(query, /const QUERY_NATIVE_TREND_VERSION = '1\.1\.0'/);
assert.match(query, /const QUERY_NATIVE_HOST_VERSION = '1\.0\.0'/);
assert.match(query, /query-native-module-data-v1\.js\?v=\$\{QUERY_NATIVE_ADAPTER_VERSION\}/);
assert.match(query, /query-native-governance-gate-v1\.js\?v=\$\{QUERY_NATIVE_GATE_VERSION\}/);
assert.match(query, /query-native-ads-source-readiness-v1\.js\?v=\$\{QUERY_NATIVE_SOURCE_READINESS_VERSION\}/);
assert.match(query, /query-native-bid-intelligence-v1\.js\?v=\$\{QUERY_NATIVE_BID_INTELLIGENCE_VERSION\}/);
assert.match(query, /bid-governance-parity-audit-v1\.js\?v=\$\{BID_GOVERNANCE_PARITY_AUDIT_VERSION\}/);
assert.match(query, /query-native-ads-trend-v1\.js\?v=\$\{QUERY_NATIVE_TREND_VERSION\}/);
assert.match(query, /query-native-ads-trend-host-v1\.js\?v=\$\{QUERY_NATIVE_HOST_VERSION\}/);
assert.match(query, /async function ensureQueryNativeModules\(\)/);
assert.ok(
  query.indexOf('window.QueryNativeModuleData?.version !== QUERY_NATIVE_ADAPTER_VERSION')
    < query.indexOf('window.QueryNativeGovernanceGate?.version !== QUERY_NATIVE_GATE_VERSION')
    && query.indexOf('window.QueryNativeGovernanceGate?.version !== QUERY_NATIVE_GATE_VERSION')
      < query.indexOf('window.AdsSourceReadinessInspector?.version !== QUERY_NATIVE_SOURCE_READINESS_VERSION')
    && query.indexOf('window.AdsSourceReadinessInspector?.version !== QUERY_NATIVE_SOURCE_READINESS_VERSION')
      < query.indexOf('window.QueryNativeBidIntelligence?.version !== QUERY_NATIVE_BID_INTELLIGENCE_VERSION')
    && query.indexOf('window.QueryNativeBidIntelligence?.version !== QUERY_NATIVE_BID_INTELLIGENCE_VERSION')
      < query.indexOf('window.BidGovernanceParityAudit?.version !== BID_GOVERNANCE_PARITY_AUDIT_VERSION')
    && query.indexOf('window.BidGovernanceParityAudit?.version !== BID_GOVERNANCE_PARITY_AUDIT_VERSION')
      < query.indexOf('window.QueryNativeAdsTrend?.version !== QUERY_NATIVE_TREND_VERSION')
    && query.indexOf('window.QueryNativeAdsTrend?.version !== QUERY_NATIVE_TREND_VERSION')
      < query.indexOf('window.QueryNativeAdsTrendHost?.version !== QUERY_NATIVE_HOST_VERSION'),
  'Query-native module assets must load in adapter → governance gate → source readiness → bid intelligence → parity audit → controller → host order',
);
assert.match(sourceReadiness, /const INSPECTOR_VERSION = '1\.0\.0'/);
assert.match(sourceReadiness, /client\.preflightAdsSource\(normalized\)/);
assert.match(sourceReadiness, /候选就绪 ≠ 生产执行解锁/);
assert.match(sourceReadiness, /activation\?\.authorizesExecution !== false/);
assert.doesNotMatch(sourceReadiness, /QueryNativeGovernanceGate\.(?:adopt|refresh|assertActionAllowed)/);
assert.match(bidIntelligence, /const PREVIEW_VERSION = '1\.0\.0'/);
assert.match(bidIntelligence, /window\.QueryNativeModuleData/);
assert.match(bidIntelligence, /source: 'query'/);
assert.match(bidIntelligence, /executionAuthorized: false/);
assert.match(bidIntelligence, /不生成 Suggested Bid/);
assert.doesNotMatch(bidIntelligence, /\bAdsStore(?:\.|\[|\?)/, 'Bid intelligence preview must not access the legacy AdsStore object');
assert.doesNotMatch(bidIntelligence, /suggestedBid|assertActionAllowed|report_slots/);
assert.match(parityAudit, /const AUDIT_VERSION = '1\.0\.1'/);
assert.match(legacyCore, /getBidGovernanceScopedRowsForParity:\(\)=>getBidGovScopedRows\("searchTerm"\)\.map\(row=>\(\{\.\.\.row\}\)\)/);
assert.match(parityAudit, /AdsDashboardApp\?\.debug\?\.getBidGovernanceScopedRowsForParity/);
assert.doesNotMatch(parityAudit, /\bgetBidGovScopedRows\(/);
assert.match(parityAudit, /window\.QueryNativeModuleData\.ads/);
assert.match(parityAudit, /source: 'query'/);
assert.match(parityAudit, /executionAuthorized: false/);
assert.match(parityAudit, /migrationCandidate: pass/);
assert.match(parityAudit, /rawBootstrapFingerprint/);
assert.match(parityAudit, /dataFingerprint/);
assert.doesNotMatch(parityAudit, /PrivateCloudAds\?*\.?(?:loadRaw|loadFullHistory|loadCurrentMonth|loadRecentMonths)|QueryNativeGovernanceGate\.(?:adopt|refresh|assertActionAllowed)|suggestedBid|report_slots/);
assert.match(query, /'ads-source-readiness-inspector'/);
assert.match(query, /'bid-intelligence-preview'/);
assert.match(query, /'bid-governance-parity-audit'/);
assert.match(shopUi, /const SHOP_UI_VERSION = '1\.1\.0'/);
assert.match(loader, /const FETCH_CONCURRENCY = 1/);
assert.match(loader, /loadingStrategy: 'query-first-progressive-v1'/);
assert.match(loader, /btnPrivateCloudCurrentMonth/);
assert.match(loader, /btnPrivateCloudRecentMonths/);
assert.match(loader, /btnPrivateCloudFullHistory/);
assert.match(loader, /loadFullHistory: \(\) => loadRawRange\(\{ mode: 'full' \}\)/);
assert.match(loader, /dataFingerprint/);
assert.match(loader, /const directPanelChild = element =>/);
assert.match(loader, /panel\.insertBefore\(card, statusHost \|\| null\)/);
assert.match(loader, /#privateCloudImportPanel > \.queryFirstOverviewCard/);
assert.match(loader, /\.queryFirstOverviewCard\{[^}]*width:100%;[^}]*min-width:0/);
assert.doesNotMatch(loader, /status\.insertAdjacentElement\('beforebegin', card\)/);
assert.match(query, /\/api\/v1\/query\/bootstrap/);
assert.match(query, /If-None-Match/);
assert.match(query, /governance-execution-gate/);
assert.match(query, /query-native-module-assets/);

assert.match(query, /const ADS_SOURCE_PREFLIGHT_HEADER = 'X-Ads-Source-Headers-B64'/);
assert.match(query, /async function preflightAdsSource\(headers, options = \{\}\)/);
assert.match(query, /\/api\/v1\/query\/ads\/source-preflight\?clientPreflight=\$\{nonce\}/);
assert.match(query, /useCache: false/);
assert.match(query, /payload\.schemaVersion !== 'ads-source-preflight-v1'/);
assert.match(query, /payload\.activation\?\.writesFacts !== false/);
assert.match(query, /payload\.activation\?\.changesCurrentSlot !== false/);
assert.match(query, /payload\.activation\?\.authorizesExecution !== false/);
assert.match(query, /preflightAdsSource,/);
assert.match(query, /'ads-source-preflight'/);
assert.match(query, /new TextEncoder\(\)\.encode\(JSON\.stringify\(headers\)\)/);
assert.match(query, /\.replace\(\/\\\+\/g, '-'\)/);
assert.match(query, /\.replace\(\/\\\/\/g, '_'\)/);
assert.doesNotMatch(query, /source-preflight\?[^'`\n]*headers=/i);

assert.match(shopUi, /'queryFirstRawActions'/);
assert.match(shopUi, /'queryFirstOverviewCard'/);
assert.match(shopUi, /const progressiveNodes = collectProgressiveNodes\(\)/);
assert.match(shopUi, /restoreProgressiveNodes\(panel, progressiveNodes\)/);
assert.match(shopUi, /for \(const node of nodes\) panel\.insertBefore\(node, statusRow \|\| null\)/);
assert.match(shopUi, /panel\.dataset\.shopUiVersion = SHOP_UI_VERSION/);
assert.match(shopUi, /window\.__SHOP_SCOPE_UI_VERSION__ = SHOP_UI_VERSION/);

const shopMount = section(
  shopUi,
  '  const mount = () => {',
  '\n\n  const init = () => {',
);
assert.match(shopMount, /const progressiveNodes = collectProgressiveNodes\(\)/);
assert.match(shopMount, /panel\.replaceChildren\(\.\.\.shell\.childNodes\)/);
assert.match(shopMount, /restoreProgressiveNodes\(panel, progressiveNodes\)/);
assert.ok(
  shopMount.indexOf('const progressiveNodes = collectProgressiveNodes()')
    < shopMount.indexOf('panel.replaceChildren(...shell.childNodes)'),
  'Progressive nodes must be captured before the shop UI replaces panel children',
);
assert.ok(
  shopMount.indexOf('panel.replaceChildren(...shell.childNodes)')
    < shopMount.indexOf('restoreProgressiveNodes(panel, progressiveNodes)'),
  'Progressive nodes must be restored immediately after the shop UI replaces panel children',
);

const connect = section(
  loader,
  '  async function connectPrivateCloudOverview',
  '\n\n  function renderBootstrap',
);
assert.match(connect, /fetchBootstrap/);
assert.doesNotMatch(connect, /\/manifest\?/);
assert.doesNotMatch(connect, /fetchManifestEntry/);
assert.doesNotMatch(connect, /__LR_IMPORT_MULTIPLE_FILES__/);
assert.doesNotMatch(connect, /responseType: 'blob'/);

const raw = section(
  loader,
  '  async function loadRawRange',
  '\n\n  const extractRows',
);
assert.match(raw, /\/manifest\?/);
assert.match(raw, /fetchManifestEntry/);
assert.match(raw, /__LR_IMPORT_MULTIPLE_FILES__/);
assert.match(raw, /fromMonth/);
assert.match(raw, /toMonth/);

const bridge = section(
  loader,
  '  const queryRequest = async',
  '\n\n  const scheduleScopeReload',
);
assert.match(bridge, /path\.startsWith\('\/api\/v1\/query\/'\)/);
assert.match(bridge, /memoryCredential\.get\(\)/);

for (const forbidden of [
  'sessionStorage',
  'lr_private_cloud_password',
  "headers.set('Cache-Control'",
  'FETCH_CONCURRENCY = 2',
]) {
  assert.equal(loader.includes(forbidden), false, `Forbidden loader pattern: ${forbidden}`);
  assert.equal(query.includes(forbidden), false, `Forbidden query pattern: ${forbidden}`);
}

console.log('Progressive Query-first loader and shop UI invariants passed');
await import('./test-query-native-governance-gate.mjs');
await import('./test-ads-source-readiness-inspector.mjs');
await import('./test-query-native-bid-intelligence.mjs');
await import('./test-bid-governance-parity-audit.mjs');
