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

assert.equal(await exists('wrangler.jsonc'), false, 'root wrangler.jsonc must remain absent');
assert.equal(await exists('src/worker.js'), false, 'legacy Warehouse proxy worker must remain inactive');
assert.equal(await exists('.github/workflows/pages.yml'), false, 'legacy GitHub Pages workflow must remain inactive');
assert.equal(await exists('.github/workflows/ci-main.yml'), false, 'legacy TiDB-era main CI must remain inactive');

const retiredBrowserAssets = [
  'assets/private-cloud-query-v1.js',
  'assets/private-cloud-warehouse-v3.js',
  'assets/private-cloud-warehouse-v4.js',
  'assets/generated/inline-script-09.js',
  'assets/generated/inline-script-11.js',
];
for (const retiredPath of retiredBrowserAssets) {
  assert.equal(await exists(retiredPath), false, `legacy browser loader must not remain active source: ${retiredPath}`);
}

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
  assert.equal(await exists(`.github/workflows/${workflow}`), false, `retired granular workflow must remain inactive: ${workflow}`);
}

for (const archivedPath of [
  'docs/archive/legacy-warehouse-v4/wrangler.jsonc',
  'docs/archive/legacy-warehouse-v4/src-worker.js',
  'docs/archive/legacy-github-pages/pages.yml',
  'docs/archive/legacy-github-pages/ci-main.yml',
  'docs/archive/legacy-github-pages/build-cloudflare.mjs',
  'docs/archive/legacy-github-pages/README.md',
  'docs/archive/legacy-github-pages/README_PRODUCTION_STATUS.md',
  'docs/archive/legacy-browser-loaders/README.md',
  'docs/archive/legacy-browser-loaders/private-cloud-query-v1.js',
  'docs/archive/legacy-browser-loaders/private-cloud-warehouse-v3.js',
  'docs/archive/legacy-browser-loaders/private-cloud-warehouse-v4.js',
  'docs/archive/legacy-browser-loaders/generated-inline-script-09.js',
  'docs/archive/legacy-browser-loaders/generated-inline-script-11.js',
]) {
  assert.equal(await exists(archivedPath), true, `missing legacy archive: ${archivedPath}`);
}
for (const workflow of retiredGranularWorkflows) {
  assert.equal(await exists(`docs/archive/legacy-ci/${workflow}`), true, `missing retired CI archive: ${workflow}`);
}
assert.equal(await exists('docs/archive/legacy-ci/README.md'), true, 'missing retired CI archive manifest');
assert.equal(await exists('docs/archive/legacy-deploy/package-deploy-scripts.json'), true, 'missing direct deploy command archive');
assert.equal(await exists('scripts/block-direct-cloudflare-deploy.mjs'), true, 'missing direct deploy blocker');
assert.equal(await exists('scripts/block-dormant-amazon-execution.mjs'), true, 'missing dormant Amazon execution blocker');
assert.equal(await exists('scripts/break-glass-access-recovery.mjs'), true, 'missing break-glass access recovery CLI');
assert.equal(await exists('scripts/test-break-glass-access-recovery.mjs'), true, 'missing break-glass CLI contract test');
assert.equal(await exists('scripts/test-security-integrity-d1-harness.mjs'), true, 'missing real local D1 security harness');
assert.equal(await exists('cloudflare/runtime/wrangler.security-test.jsonc'), true, 'missing local D1 security test config');
assert.equal(await exists('cloudflare/foundation/migrations/control/0006_control_access_recovery.sql'), true, 'missing access recovery migration');

const nativeWrangler = await text('cloudflare/runtime/wrangler.native.jsonc');
assert.match(nativeWrangler, /"main"\s*:\s*"\.\/web-entry\.js"/);
const webEntry = await text('cloudflare/runtime/web-entry.js');
assert.match(webEntry, /from ['"]\.\/web-worker\.js['"]/);
assert.doesNotMatch(webEntry, /src\/worker\.js/);
assert.doesNotMatch(webEntry, /break-glass-access-recovery|access_recovery_events/);
const archivedWarehouseProxy = await text('docs/archive/legacy-warehouse-v4/src-worker.js');
assert.match(archivedWarehouseProxy, /WAREHOUSE_BINDING_UNAVAILABLE/);
assert.match(archivedWarehouseProxy, /amazon-warehouse-cloud-v4\.internal/);

const readme = await text('README.md');
assert.match(readme, /Cloudflare Native/i);
assert.match(readme, /Amazon Ads Operations OS/i);
assert.doesNotMatch(readme, /这是一个部署在 \*\*GitHub Pages\*\*/i);

const status = await text('README_PRODUCTION_STATUS.md');
assert.match(status, /Architecture Convergence Phase 0/i);
assert.match(status, /final Cloudflare Native Production deployment contract is \*\*not established yet\*\*/i);
assert.match(status, /legacy-browser-loaders/);
assert.match(status, /cloudflare-native-data-panel-v1\.js/);
assert.match(status, /cloudflare_native_raw_import_not_migrated/);

const packageJson = JSON.parse(await text('package.json'));
assert.equal(packageJson.scripts?.build, 'node scripts/build-cloudflare.mjs');
assert.equal(packageJson.scripts?.['check:cloudflare'], 'npm run check:cf-native');
assert.equal(
  packageJson.scripts?.['security:break-glass:access-recovery'],
  'node scripts/break-glass-access-recovery.mjs',
  'break-glass CLI npm alias must remain explicit and fail-closed by default',
);
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
  assert.match(String(packageJson.scripts?.[scriptName] || ''), /^node scripts\/block-direct-cloudflare-deploy\.mjs /, `direct deploy alias must be blocked: ${scriptName}`);
}
assert.doesNotMatch(JSON.stringify(packageJson.scripts || {}), /wrangler deploy/);
assert.equal(
  packageJson.scripts?.['provision:cf-sync:dev:amazon-secrets'],
  'node scripts/block-dormant-amazon-execution.mjs provision:cf-sync:dev:amazon-secrets',
  'Amazon credential provisioning npm entrypoint must remain blocked until controlled Store 01 activation',
);

const deployBlocker = await text('scripts/block-direct-cloudflare-deploy.mjs');
assert.match(deployBlocker, /Direct Cloudflare deployment is disabled/);
assert.match(deployBlocker, /CI-gated and exact-commit controlled/);
const amazonBlocker = await text('scripts/block-dormant-amazon-execution.mjs');
assert.match(amazonBlocker, /Amazon live execution remains paused until controlled Store 01 activation is explicitly authorized/);
assert.match(amazonBlocker, /Security Integrity and intermediate platform phases do not authorize Amazon credential provisioning/);
assert.match(amazonBlocker, /deterministic regression coverage only/);

const breakGlass = await text('scripts/break-glass-access-recovery.mjs');
assert.match(breakGlass, /INSERT INTO access_recovery_events/);
assert.match(breakGlass, /break_glass_confirmation_mismatch/);
assert.match(breakGlass, /BREAK_GLASS_PRODUCTION_ENABLED/);
assert.match(breakGlass, /break_glass_production_confirmation_mismatch/);
assert.match(breakGlass, /CLOUDFLARE_API_TOKEN/);
assert.match(breakGlass, /break_glass_api_token_cli_forbidden/);
assert.match(breakGlass, /security\.break_glass\.access_subject_rebind/);
assert.doesNotMatch(breakGlass, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+user_global_roles/i);
assert.doesNotMatch(breakGlass, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+role_permissions/i);
assert.doesNotMatch(breakGlass, /wrangler\s+deploy|AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED/);

const recoveryMigration = await text('cloudflare/foundation/migrations/control/0006_control_access_recovery.sql');
assert.match(recoveryMigration, /CREATE TABLE access_recovery_events/);
assert.match(recoveryMigration, /trg_access_recovery_target_guard/);
assert.match(recoveryMigration, /trg_owner_access_subject_rebind_guard/);
assert.match(recoveryMigration, /trg_access_recovery_apply/);
assert.match(recoveryMigration, /security\.break_glass\.access_subject_rebind/);
assert.match(recoveryMigration, /globalRoleChanged', json\('false'\)/);
assert.doesNotMatch(recoveryMigration, /INSERT INTO\s+user_global_roles|UPDATE\s+user_global_roles/i);

const realD1Harness = await text('scripts/test-security-integrity-d1-harness.mjs');
assert.match(realD1Harness, /createTestHarness/);
assert.match(realD1Harness, /applyD1Migrations\('CONTROL_DB'\)/);
assert.match(realD1Harness, /executeAccessRecovery/);
assert.match(realD1Harness, /test-break-glass-access-recovery\.mjs/);
assert.match(realD1Harness, /breakGlassCliAuditRollbackVerified:\s*true/);
assert.match(realD1Harness, /remoteD1Touched:\s*false/);

const amazonProvisionHelper = await text('scripts/provision-cloudflare-amazon-ads-dev-secrets.mjs');
assert.match(amazonProvisionHelper, /wrangler', 'secret', 'bulk/);
assert.match(amazonProvisionHelper, /runCloudflareAmazonAdsCredentialSmoke/);

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
assert.match(canonicalCi, /name:\s*Static site and security invariants/);
assert.match(canonicalCi, /consolidation\/\*\*/);
assert.match(canonicalCi, /feature\/\*\*/);
assert.match(canonicalCi, /fix\/\*\*/);
assert.match(canonicalCi, /security-integrity-\*/);
assert.match(canonicalCi, /pull_request:[\s\S]*branches:[\s\S]*- main/);
assert.match(canonicalCi, /Validate Native cloud loader strangler boundary/);
assert.match(canonicalCi, /test-native-cloud-loader-strangler-contract\.mjs/);
assert.match(canonicalCi, /Validate Phase E producer and ingestion regressions/);
assert.match(canonicalCi, /Validate R2 provenance Gate 24-27 regressions/);
assert.match(canonicalCi, /Validate real local D1 security transactions/);
assert.match(canonicalCi, /test-security-integrity-d1-harness\.mjs/);
assert.match(canonicalCi, /Validate dormant Amazon transport regressions without deployment/);
assert.doesNotMatch(canonicalCi, /^\s*node scripts\/promote-cloudflare-sync-dev-trigger\.mjs\s*$/m);
assert.doesNotMatch(canonicalCi, /wrangler deploy/);
assert.doesNotMatch(canonicalCi, /upload-pages-artifact|deploy-pages/);

console.log(JSON.stringify({
  ok: true,
  contract: 'security-integrity-canonical-v9',
  canonicalRuntime: 'cloudflare-native',
  canonicalWebEntry: 'cloudflare/runtime/web-entry.js',
  nativeDataPanel: 'assets/cloudflare-native-data-panel-v1.js',
  legacyBrowserLoaderSourceOwner: 'docs/archive/legacy-browser-loaders/',
  rootWranglerAbsent: true,
  legacyWarehouseProxyInactive: true,
  legacyBrowserCloudLoadersInactiveSource: true,
  legacyBrowserCloudLoadersForbiddenFromArtifact: true,
  legacyPagesInactive: true,
  granularCiRetired: true,
  directDeployAliasesBlocked: true,
  amazonLivePackageEntryBlocked: true,
  canonicalShortLivedBranchCoverage: true,
  mainProtectionContextPreserved: true,
  breakGlassCliOnly: true,
  breakGlassNoGlobalRoleWrite: true,
  breakGlassProductionDoubleGate: true,
  breakGlassRealD1Coverage: true,
  legacyArchived: true,
  canonicalCoverageParityLocked: true,
  nativeAssetAllowlistEnforced: true,
}, null, 2));
