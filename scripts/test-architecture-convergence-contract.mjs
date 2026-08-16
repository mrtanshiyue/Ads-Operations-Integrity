import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function exists(relativePath) {
  try {
    await access(path.join(repoRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function text(relativePath) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

// Active repository paths must expose only the Cloudflare Native deployment model.
assert.equal(await exists('wrangler.jsonc'), false, 'root wrangler.jsonc must remain absent');
assert.equal(await exists('src/worker.js'), false, 'legacy Warehouse proxy worker must remain inactive');
assert.equal(await exists('.github/workflows/pages.yml'), false, 'legacy GitHub Pages workflow must remain inactive');
assert.equal(await exists('.github/workflows/ci-main.yml'), false, 'legacy TiDB-era main CI must remain inactive');

const retiredGranularWorkflows = [
  'cloudflare-access-governance-ci.yml',
  'cloudflare-amazon-report-transport-ci.yml',
  'cloudflare-foundation-ci.yml',
  'cloudflare-gate24-ci.yml',
  'cloudflare-gate25-ci.yml',
  'cloudflare-gate26-ci.yml',
  'cloudflare-gate27-ci.yml',
];
for (const workflow of retiredGranularWorkflows) {
  assert.equal(
    await exists(`.github/workflows/${workflow}`),
    false,
    `retired granular workflow must remain inactive: ${workflow}`,
  );
}

// Historical material must remain recoverable without remaining active.
for (const archivedPath of [
  'docs/archive/legacy-warehouse-v4/wrangler.jsonc',
  'docs/archive/legacy-warehouse-v4/src-worker.js',
  'docs/archive/legacy-github-pages/pages.yml',
  'docs/archive/legacy-github-pages/ci-main.yml',
  'docs/archive/legacy-github-pages/build-cloudflare.mjs',
  'docs/archive/legacy-github-pages/README.md',
  'docs/archive/legacy-github-pages/README_PRODUCTION_STATUS.md',
]) {
  assert.equal(await exists(archivedPath), true, `missing legacy archive: ${archivedPath}`);
}
for (const workflow of retiredGranularWorkflows) {
  assert.equal(
    await exists(`docs/archive/legacy-ci/${workflow}`),
    true,
    `missing retired CI archive: ${workflow}`,
  );
}
assert.equal(await exists('docs/archive/legacy-ci/README.md'), true, 'missing retired CI archive manifest');
assert.equal(await exists('docs/archive/legacy-deploy/package-deploy-scripts.json'), true, 'missing direct deploy command archive');
assert.equal(await exists('scripts/block-direct-cloudflare-deploy.mjs'), true, 'missing direct deploy blocker');

const nativeWrangler = await text('cloudflare/runtime/wrangler.native.jsonc');
assert.match(nativeWrangler, /"main"\s*:\s*"\.\/web-entry\.js"/);
const webEntry = await text('cloudflare/runtime/web-entry.js');
assert.match(webEntry, /from ['"]\.\/web-worker\.js['"]/);
assert.doesNotMatch(webEntry, /src\/worker\.js/);
const archivedWarehouseProxy = await text('docs/archive/legacy-warehouse-v4/src-worker.js');
assert.match(archivedWarehouseProxy, /WAREHOUSE_BINDING_UNAVAILABLE/);
assert.match(archivedWarehouseProxy, /amazon-warehouse-cloud-v4\.internal/);

const readme = await text('README.md');
assert.match(readme, /Cloudflare Native/i);
assert.match(readme, /Amazon Ads Operations OS/i);
assert.doesNotMatch(readme, /这是一个部署在 \*\*GitHub Pages\*\*/i);
assert.doesNotMatch(readme, /GitHub Pages \/ Browser\s*\n\s*-> Cloudflare Worker V4/i);

const status = await text('README_PRODUCTION_STATUS.md');
assert.match(status, /Architecture Convergence Phase 0/i);
assert.match(status, /final Cloudflare Native Production deployment contract is \*\*not established yet\*\*/i);

const packageJson = JSON.parse(await text('package.json'));
assert.equal(packageJson.scripts?.build, 'node scripts/build-cloudflare.mjs');
assert.equal(packageJson.scripts?.['check:cloudflare'], 'npm run check:cf-native');
const directDeployScripts = [
  'deploy:cloudflare',
  'deploy:cf-native:dev',
  'deploy:cf-sync:dev',
  'deploy:cf-stack:dev',
  'deploy:cf-native:prod',
  'deploy:cf-sync:prod',
  'deploy:cf-stack:prod',
];
for (const scriptName of directDeployScripts) {
  assert.match(
    String(packageJson.scripts?.[scriptName] || ''),
    /^node scripts\/block-direct-cloudflare-deploy\.mjs /,
    `direct deploy alias must be blocked: ${scriptName}`,
  );
}
assert.doesNotMatch(JSON.stringify(packageJson.scripts || {}), /wrangler deploy/);

const deployBlocker = await text('scripts/block-direct-cloudflare-deploy.mjs');
assert.match(deployBlocker, /Direct Cloudflare deployment is disabled/);
assert.match(deployBlocker, /CI-gated and exact-commit controlled/);

const buildShim = await text('scripts/build-cloudflare.mjs');
assert.match(buildShim, /build-cloudflare-native\.mjs/);
assert.doesNotMatch(buildShim, /amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/);

const nativeBuild = await text('scripts/build-cloudflare-native.mjs');
assert.match(nativeBuild, /build-cloudflare-native-copy-all\.mjs/);
assert.match(nativeBuild, /enforce-cloudflare-native-asset-allowlist\.mjs/);

const nativeCopyBuild = await text('scripts/build-cloudflare-native-copy-all.mjs');
assert.match(nativeCopyBuild, /cloudflare-native-data-panel-v1\.js/);
assert.match(nativeCopyBuild, /generated-inline-script-09/);
assert.match(nativeCopyBuild, /generated-inline-script-11/);
assert.match(nativeCopyBuild, /private-cloud-warehouse-v4/);

assert.equal(await exists('assets/cloudflare-native-data-panel-v1.js'), true, 'missing canonical Native data panel');
const nativeDataPanel = await text('assets/cloudflare-native-data-panel-v1.js');
assert.match(nativeDataPanel, /CloudflareNativeQueryBridge/);
assert.match(nativeDataPanel, /credentialMode:\s*'cloudflare-access-session'/);
assert.match(nativeDataPanel, /cloudflare_native_raw_import_not_migrated/);
assert.doesNotMatch(nativeDataPanel, /sessionStorage|X-Dashboard-Password|amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/);

const allowlist = await text('scripts/enforce-cloudflare-native-asset-allowlist.mjs');
assert.match(allowlist, /explicit-file-allowlist-v2/);
assert.match(allowlist, /forbiddenAssets/);
assert.match(allowlist, /private-cloud-query-v1\.js/);
assert.match(allowlist, /private-cloud-warehouse-v3\.js/);
assert.match(allowlist, /private-cloud-warehouse-v4\.js/);
assert.match(allowlist, /generated\/inline-script-09\.js/);
assert.match(allowlist, /generated\/inline-script-11\.js/);
assert.match(allowlist, /cloudflare-native-data-panel-v1\.js/);

const canonicalCi = await text('.github/workflows/cloudflare-native-canonical-ci.yml');
assert.match(canonicalCi, /Cloudflare Native Canonical CI/);
assert.match(canonicalCi, /consolidation\/\*\*/);
assert.match(canonicalCi, /Validate Native cloud loader strangler boundary/);
assert.match(canonicalCi, /test-native-cloud-loader-strangler-contract\.mjs/);
assert.match(canonicalCi, /Validate Phase E producer and ingestion regressions/);
assert.match(canonicalCi, /Validate R2 provenance Gate 24-27 regressions/);
assert.match(canonicalCi, /Validate dormant Amazon transport regressions without deployment/);
assert.match(canonicalCi, /test-promote-cloudflare-sync-dev-trigger\.mjs/);
assert.doesNotMatch(canonicalCi, /^\s*node scripts\/promote-cloudflare-sync-dev-trigger\.mjs\s*$/m);
assert.doesNotMatch(canonicalCi, /wrangler deploy/);
assert.doesNotMatch(canonicalCi, /upload-pages-artifact|deploy-pages/);

console.log(JSON.stringify({
  ok: true,
  contract: 'architecture-convergence-phase0-v5',
  canonicalRuntime: 'cloudflare-native',
  canonicalWebEntry: 'cloudflare/runtime/web-entry.js',
  nativeDataPanel: 'assets/cloudflare-native-data-panel-v1.js',
  rootWranglerAbsent: true,
  legacyWarehouseProxyInactive: true,
  legacyBrowserCloudLoadersForbiddenFromArtifact: true,
  legacyPagesInactive: true,
  granularCiRetired: true,
  directDeployAliasesBlocked: true,
  legacyArchived: true,
  canonicalCoverageParityLocked: true,
  nativeAssetAllowlistEnforced: true,
}, null, 2));
