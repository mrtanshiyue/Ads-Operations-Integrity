import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-operator-context-v1.js'), 'utf8');
const builtIndex = await readFile(path.join(repoRoot, 'dist-cloudflare-native', 'index.html'), 'utf8');
const allowlistSource = await readFile(path.join(repoRoot, 'scripts/enforce-cloudflare-native-asset-allowlist.mjs'), 'utf8');

new vm.Script(source, { filename: 'cloudflare-native-operator-context-v1.js' });

assert.doesNotMatch(source, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(|wrangler\s+deploy|workers\.dev/i);
assert.match(source, /CloudflareOperatorContext/);
assert.match(source, /cloudflare-operator-context-change/);
assert.match(source, /cloudflare-operator-store-change/);
assert.match(source, /#cfProductGovStore/);
assert.match(source, /#cfKeywordGovProduct/);
assert.match(source, /#cfNegGovProduct/);
assert.match(source, /#cfOpsHealthStore/);
assert.match(source, /#cfAuditStore/);
assert.match(source, /#cfAccessStore/);
assert.match(source, /CloudflareAuditConsole/);
assert.match(source, /productKeywords/);
assert.match(source, /listProducts/);
assert.match(source, /@media\(max-width:960px\)/);
assert.match(source, /@media\(max-width:560px\)/);

const events = [];
const sandboxWindow = {
  dispatchEvent(event) { events.push(event); return true; },
  CustomEvent: class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail || null; }
  },
};
vm.runInNewContext(source, { window: sandboxWindow, globalThis: sandboxWindow, console }, {
  filename: 'cloudflare-native-operator-context-v1.js',
});
assert.equal(sandboxWindow.CloudflareOperatorContext.version, '1.0.0');

sandboxWindow.CloudflareOperatorContext.setContext({
  storeId: 'store-dev-01',
  productId: 'product-dev-01',
  keywordId: 'keyword-dev-01',
}, { skipApply: true, skipRefresh: true, source: 'contract-test' });
assert.deepEqual(
  { ...sandboxWindow.CloudflareOperatorContext.getContext() },
  { storeId: 'store-dev-01', productId: 'product-dev-01', keywordId: 'keyword-dev-01' },
);
assert.equal(events.at(-1)?.type, 'cloudflare-operator-context-change');
assert.equal(events.at(-1)?.detail?.source, 'contract-test');

sandboxWindow.CloudflareOperatorContext.setContext(
  { productId: 'product-dev-02' },
  { skipApply: true, skipRefresh: true, source: 'product-switch' },
);
assert.deepEqual(
  { ...sandboxWindow.CloudflareOperatorContext.getContext() },
  { storeId: 'store-dev-01', productId: 'product-dev-02', keywordId: '' },
);

const readOnly = sandboxWindow.CloudflareOperatorContext.evaluatePermissionMode({
  globalPermissions: ['analytics.read'],
  storePermissions: {},
}, 'store-dev-01');
assert.equal(readOnly.mode, 'read-only');
assert.equal(readOnly.canRead, true);
assert.equal(readOnly.canWrite, false);

const manage = sandboxWindow.CloudflareOperatorContext.evaluatePermissionMode({
  globalPermissions: [],
  storePermissions: { 'store-dev-01': ['products.manage'] },
}, 'store-dev-01');
assert.equal(manage.mode, 'manage');
assert.equal(manage.canWrite, true);

const locked = sandboxWindow.CloudflareOperatorContext.evaluatePermissionMode(null, 'store-dev-01');
assert.equal(locked.mode, 'locked');

const contextTag = '<script src="assets/cloudflare-native-operator-context-v1.js"></script>';
assert.equal(builtIndex.split(contextTag).length - 1, 1);
assert.ok(
  builtIndex.indexOf('<script src="assets/cloudflare-native-operator-workspace-v1.js"></script>') < builtIndex.indexOf(contextTag),
  'Operator Context must load after Operator Workspace',
);
assert.match(allowlistSource, /cloudflare-native-operator-context-v1\.js/);

console.log(JSON.stringify({
  ok: true,
  gate: '3.4',
  contract: 'operator-context-store-product-keyword-permission-feedback-audit-linkage',
}, null, 2));
