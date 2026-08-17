import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-operator-workspace-v1.js'), 'utf8');
const builtIndex = await readFile(path.join(repoRoot, 'dist-cloudflare-native/index.html'), 'utf8');
const allowlistSource = await readFile(path.join(repoRoot, 'scripts/enforce-cloudflare-native-asset-allowlist.mjs'), 'utf8');
const tag = '<script src="assets/cloudflare-native-operator-workspace-v1.js"></script>';

new vm.Script(source, { filename: 'cloudflare-native-operator-workspace-v1.js' });
assert.equal((builtIndex.split(tag).length - 1), 1, 'Operator Workspace must be injected exactly once');
assert.match(allowlistSource, /'cloudflare-native-operator-workspace-v1\.js'/);
assert.doesNotMatch(allowlistSource, /allowedAssets\s*=\s*new Set\(\s*\[\s*['"]\*['"]/);

const sandboxWindow = {};
vm.runInNewContext(source, { window: sandboxWindow, console }, { filename: 'cloudflare-native-operator-workspace-v1.js' });
const workspace = sandboxWindow.CloudflareOperatorWorkspace;
assert.ok(workspace, 'Operator Workspace public contract must be installed');
assert.equal(workspace.version, '1.1.0');

const navigation = Array.from(workspace.navigationContract);
const keys = navigation.map((entry) => entry.key);
for (const requiredKey of [
  'overview',
  'productRegistry',
  'storeProductMapping',
  'positiveKeywords',
  'negativeKeywords',
  'productKeywordGovernance',
  'searchTerms',
  'recommendationQueue',
  'targeting',
  'bidIntelligence',
  'governanceHealth',
  'operationsHealth',
  'dataHealth',
  'auditTrail',
  'users',
  'storeMembership',
  'rolesAccess',
]) {
  assert.ok(keys.includes(requiredKey), `Missing Operator Workspace navigation item: ${requiredKey}`);
}

const byKey = Object.fromEntries(navigation.map((entry) => [entry.key, entry]));
assert.equal(byKey.searchTerms.kind, 'surface');
assert.equal(byKey.searchTerms.target, 'decision-intelligence');
assert.equal(byKey.recommendationQueue.target, 'decision-actions');
assert.equal(byKey.governanceHealth.target, 'governance-health');
assert.deepEqual(Array.from(byKey.searchTerms.permissionSets[0]), ['analytics.read']);
assert.deepEqual(Array.from(byKey.recommendationQueue.permissionSets[0]), ['ads.read']);
assert.deepEqual(Array.from(byKey.governanceHealth.permissionSets[0]), ['ads.read']);

const groups = Array.from(workspace.groupContract).map((entry) => entry.key);
assert.deepEqual(groups, ['overview', 'products', 'keywords', 'ads', 'operations', 'administration']);
for (const entry of navigation) {
  assert.equal(typeof entry.label.zh, 'string');
  assert.equal(typeof entry.label.en, 'string');
  assert.ok(entry.label.zh.length > 0 && entry.label.en.length > 0, `${entry.key} must have zh/en labels`);
  assert.ok(Array.isArray(entry.permissionSets), `${entry.key} must declare permission sets`);
}

const ownerCaps = {
  globalPermissions: [
    'analytics.read', 'products.read', 'products.manage', 'ads.read',
    'keywords.read', 'keywords.manage', 'negatives.read', 'negatives.manage',
    'audit.read', 'users.manage', 'stores.manage',
  ],
  storePermissions: {},
};
const ownerAccess = workspace.evaluateAccess(ownerCaps, 'store-dev-01');
for (const key of keys) assert.equal(ownerAccess[key], true, `Owner capability should expose ${key}`);

const analystCaps = {
  globalPermissions: [],
  storePermissions: {
    'store-dev-01': ['analytics.read', 'ads.read', 'keywords.read', 'products.read', 'negatives.read', 'audit.read'],
  },
};
const analystAccess = workspace.evaluateAccess(analystCaps, 'store-dev-01');
assert.equal(analystAccess.overview, true);
assert.equal(analystAccess.productRegistry, true);
assert.equal(analystAccess.storeProductMapping, true);
assert.equal(analystAccess.positiveKeywords, true);
assert.equal(analystAccess.productKeywordGovernance, true);
assert.equal(analystAccess.negativeKeywords, true);
assert.equal(analystAccess.searchTerms, true);
assert.equal(analystAccess.recommendationQueue, true);
assert.equal(analystAccess.governanceHealth, true);
assert.equal(analystAccess.operationsHealth, true);
assert.equal(analystAccess.auditTrail, true);
assert.equal(analystAccess.users, false);
assert.equal(analystAccess.storeMembership, false);
assert.equal(analystAccess.rolesAccess, false);

const analyticsOnlyCaps = {
  globalPermissions: [],
  storePermissions: { 'store-dev-01': ['analytics.read'] },
};
const analyticsOnlyAccess = workspace.evaluateAccess(analyticsOnlyCaps, 'store-dev-01');
assert.equal(analyticsOnlyAccess.searchTerms, true);
assert.equal(analyticsOnlyAccess.recommendationQueue, false);
assert.equal(analyticsOnlyAccess.governanceHealth, false);

const failedClosed = workspace.evaluateAccess(null, 'store-dev-01');
for (const key of keys) assert.equal(failedClosed[key], false, `Missing capability context must fail closed for ${key}`);

assert.match(source, /CloudflareProductGovernance/);
assert.match(source, /CloudflareKeywordGovernance/);
assert.match(source, /CloudflareNegativeGovernance/);
assert.match(source, /CloudflareDecisionIntelligence/);
assert.match(source, /decision-intelligence/);
assert.match(source, /decision-actions/);
assert.match(source, /governance-health/);
assert.match(source, /data-phase9-governance-health/);
assert.match(source, /OPERATOR WORKSPACE · DAILY OPERATIONS/);
assert.doesNotMatch(source, /PHASE 3 · OPERATOR WORKSPACE/);
assert.match(source, /CloudflareOperationsHealth/);
assert.match(source, /CloudflareAuditConsole/);
assert.match(source, /CloudflareAccessConsole/);
assert.match(source, /cloudflare-operator-store-change/);
assert.match(source, /@media \(max-width: 960px\)/);
assert.match(source, /@media \(max-width: 560px\)/);
assert.match(source, /btnLangToggle/);
assert.match(source, /btnNativeKeywordGovernance/);
assert.match(source, /btnNativeProductGovernance/);
assert.match(source, /btnNativeNegativeGovernance/);
assert.match(source, /btnNativeOperationsHealth/);
assert.match(source, /btnNativeAuditConsole/);
assert.match(source, /btnNativeAccessConsole/);
assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|startSync\s*\(|wrangler\s+deploy|AMAZON_ADS|AMAZON_SYNC_WORKFLOW/);

console.log(JSON.stringify({
  ok: true,
  contract: 'operator-workspace-v2',
  navigationItems: navigation.length,
  groups: groups.length,
  permissionAware: true,
  bilingual: true,
  responsive: true,
  searchTermIntelligenceFirstClass: true,
  recommendationQueueFirstClass: true,
  governanceHealthFirstClass: true,
  transport: 'existing-native-console-public-apis-only',
}, null, 2));