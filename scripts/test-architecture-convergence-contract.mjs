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
assert.equal(await exists('.github/workflows/pages.yml'), false, 'legacy GitHub Pages workflow must remain inactive');
assert.equal(await exists('.github/workflows/ci-main.yml'), false, 'legacy TiDB-era main CI must remain inactive');

// Historical material must remain recoverable without remaining active.
for (const archivedPath of [
  'docs/archive/legacy-warehouse-v4/wrangler.jsonc',
  'docs/archive/legacy-github-pages/pages.yml',
  'docs/archive/legacy-github-pages/ci-main.yml',
  'docs/archive/legacy-github-pages/build-cloudflare.mjs',
  'docs/archive/legacy-github-pages/README.md',
  'docs/archive/legacy-github-pages/README_PRODUCTION_STATUS.md',
]) {
  assert.equal(await exists(archivedPath), true, `missing legacy archive: ${archivedPath}`);
}

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

const buildShim = await text('scripts/build-cloudflare.mjs');
assert.match(buildShim, /build-cloudflare-native\.mjs/);
assert.doesNotMatch(buildShim, /amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/);

const nativeBuild = await text('scripts/build-cloudflare-native.mjs');
assert.match(nativeBuild, /build-cloudflare-native-copy-all\.mjs/);
assert.match(nativeBuild, /enforce-cloudflare-native-asset-allowlist\.mjs/);

const allowlist = await text('scripts/enforce-cloudflare-native-asset-allowlist.mjs');
assert.match(allowlist, /explicit-file-allowlist-v1/);
assert.match(allowlist, /forbiddenAssets/);
assert.match(allowlist, /private-cloud-query-v1\.js/);
assert.match(allowlist, /private-cloud-warehouse-v3\.js/);

const canonicalCi = await text('.github/workflows/cloudflare-native-canonical-ci.yml');
assert.match(canonicalCi, /Cloudflare Native Canonical CI/);
assert.match(canonicalCi, /consolidation\/\*\*/);
assert.doesNotMatch(canonicalCi, /wrangler deploy/);
assert.doesNotMatch(canonicalCi, /upload-pages-artifact|deploy-pages/);

console.log(JSON.stringify({
  ok: true,
  contract: 'architecture-convergence-phase0-v1',
  canonicalRuntime: 'cloudflare-native',
  rootWranglerAbsent: true,
  legacyPagesInactive: true,
  legacyArchived: true,
  nativeAssetAllowlistEnforced: true,
}, null, 2));
