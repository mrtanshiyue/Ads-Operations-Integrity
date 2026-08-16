import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const distAssets = path.join(distRoot, 'assets');

const dataPanelSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-data-panel-v1.js'), 'utf8');
new vm.Script(dataPanelSource, { filename: 'cloudflare-native-data-panel-v1.js' });
assert.match(dataPanelSource, /CloudflareNativeQueryBridge/);
assert.match(dataPanelSource, /CloudflareNativeDataPanel/);
assert.match(dataPanelSource, /PrivateCloudAds/);
assert.match(dataPanelSource, /ShopScope/);
assert.match(dataPanelSource, /credentialMode:\s*'cloudflare-access-session'/);
assert.match(dataPanelSource, /cloudflare_native_raw_import_not_migrated/);
assert.doesNotMatch(dataPanelSource, /sessionStorage/);
assert.doesNotMatch(dataPanelSource, /X-Dashboard-Password/);
assert.doesNotMatch(dataPanelSource, /amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/);
assert.doesNotMatch(dataPanelSource, /Authorization:\s*Bearer|headers\.set\(['"]Authorization/);
assert.doesNotMatch(dataPanelSource, /\bfetch\s*\(/, 'native data panel must delegate transport instead of fetching directly');

// Keep evidence for why the migration-era browser loaders are forbidden in the Native artifact.
const legacyInline09 = await readFile(path.join(repoRoot, 'assets/generated/inline-script-09.js'), 'utf8');
assert.match(legacyInline09, /sessionStorage/);
assert.match(legacyInline09, /lr_private_cloud_password/);
assert.match(legacyInline09, /X-Dashboard-Password/);
assert.match(legacyInline09, /amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/);
assert.match(legacyInline09, /window\.PrivateCloudAds/);
assert.match(legacyInline09, /lr:shop-change/);

const legacyWarehouseV4 = await readFile(path.join(repoRoot, 'assets/private-cloud-warehouse-v4.js'), 'utf8');
assert.match(legacyWarehouseV4, /amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/);
assert.match(legacyWarehouseV4, /window\.PrivateCloudAds/);
assert.match(legacyWarehouseV4, /lr:shop-change/);
assert.match(legacyWarehouseV4, /lr:cloud-overview-ready/);
assert.match(legacyWarehouseV4, /lr:cloud-loaded/);

const sourceIndex = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
assert.match(sourceIndex, /assets\/generated\/inline-script-09\.js/);
assert.match(sourceIndex, /assets\/generated\/inline-script-11\.js/);
assert.match(sourceIndex, /assets\/private-cloud-warehouse-v4\.js/);

const builtIndex = await readFile(path.join(distRoot, 'index.html'), 'utf8');
assert.match(builtIndex, /connect-src\s+'self';/i);
assert.equal((builtIndex.match(/assets\/cloudflare-native-data-panel-v1\.js/g) || []).length, 1);
assert.doesNotMatch(builtIndex, /assets\/generated\/inline-script-09\.js/);
assert.doesNotMatch(builtIndex, /assets\/generated\/inline-script-11\.js/);
assert.doesNotMatch(builtIndex, /assets\/private-cloud-warehouse-v4\.js/);
assert.doesNotMatch(builtIndex, /assets\/private-cloud-query-v1\.js/);
assert.doesNotMatch(builtIndex, /amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/);
assert.doesNotMatch(builtIndex, /lr_private_cloud_password|X-Dashboard-Password/);

await access(path.join(distAssets, 'cloudflare-native-data-panel-v1.js'), constants.R_OK);
for (const relativePath of [
  'private-cloud-query-v1.js',
  'private-cloud-warehouse-v3.js',
  'private-cloud-warehouse-v4.js',
  'generated/inline-script-09.js',
  'generated/inline-script-11.js',
]) {
  await assert.rejects(
    () => access(path.join(distAssets, relativePath), constants.F_OK),
    error => error?.code === 'ENOENT',
    `retired cloud loader asset must be absent from Native artifact: ${relativePath}`,
  );
}

for (const relativePath of await collectJsFiles(distAssets)) {
  const source = await readFile(path.join(distAssets, relativePath), 'utf8');
  const retiredHostAcceptanceSentinel = relativePath === 'cloudflare-gate7-ui-acceptance-v1.js'
    && /RETIRED_BACKEND_HOST/.test(source)
    && /retired_query_backend_not_requested/.test(source);
  if (!retiredHostAcceptanceSentinel) {
    assert.doesNotMatch(source, /amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/, `legacy Warehouse origin leaked into ${relativePath}`);
  }
  assert.doesNotMatch(source, /X-Dashboard-Password/, `legacy Warehouse password header leaked into ${relativePath}`);
  assert.doesNotMatch(source, /lr_private_cloud_password/, `legacy Warehouse session credential key leaked into ${relativePath}`);
}

console.log(JSON.stringify({
  ok: true,
  contract: 'cloudflare-native-data-panel-strangler-v1',
  nativeController: 'assets/cloudflare-native-data-panel-v1.js',
  transport: 'CloudflareNativeQueryBridge',
  credentialMode: 'cloudflare-access-session',
  rawCloudImportReady: false,
  retiredHostAcceptanceSentinelAllowed: true,
  retiredArtifactLoaders: [
    'assets/generated/inline-script-09.js',
    'assets/generated/inline-script-11.js',
    'assets/private-cloud-warehouse-v4.js',
    'assets/private-cloud-query-v1.js',
  ],
}, null, 2));

async function collectJsFiles(root) {
  const files = [];
  await walk(root, '');
  return files.sort();

  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relativePath);
    }
  }
}
