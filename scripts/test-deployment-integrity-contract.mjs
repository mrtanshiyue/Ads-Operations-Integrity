import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (relativePath) => readFile(path.join(repoRoot, relativePath), 'utf8');

const canonicalCi = await text('.github/workflows/cloudflare-native-canonical-ci.yml');
const packageJson = JSON.parse(await text('package.json'));
const nativeWrangler = await text('cloudflare/runtime/wrangler.native.jsonc');
const syncWrangler = await text('cloudflare/runtime/wrangler.sync.jsonc');
const webEntry = await text('cloudflare/runtime/web-entry.js');
const deploymentHealth = await text('cloudflare/runtime/deployment-health.js');
const buildsClient = await text('scripts/cloudflare-workers-builds-client.mjs');
const discoveryClient = await text('scripts/cloudflare-deployment-discovery-client.mjs');
const deploymentReceipt = await text('scripts/deployment-integrity-receipt.mjs');
const directDeployBlocker = await text('scripts/block-direct-cloudflare-deploy.mjs');
const legacyPromotion = await text('scripts/promote-cloudflare-sync-dev-trigger.mjs');
const phase2Definition = await text('docs/architecture/PHASE2_DEPLOYMENT_INTEGRITY.md');

// Phase 2 must validate itself on push without changing the historical required context name.
assert.match(canonicalCi, /deployment-integrity-\*/);
assert.match(canonicalCi, /name:\s*Static site and security invariants/);
assert.match(canonicalCi, /test-deployment-integrity-contract\.mjs/);
assert.match(canonicalCi, /test-deployment-health-contract\.mjs/);
assert.match(canonicalCi, /test-cloudflare-workers-builds-client\.mjs/);
assert.match(canonicalCi, /test-cloudflare-deployment-discovery-client\.mjs/);
assert.match(canonicalCi, /test-deployment-integrity-receipt\.mjs/);

// Canonical CI remains validation-only. No repository path may silently restore direct deployment.
assert.doesNotMatch(canonicalCi, /wrangler\s+deploy/);
assert.doesNotMatch(canonicalCi, /^\s*node scripts\/promote-cloudflare-sync-dev-trigger\.mjs\s*$/m);
assert.doesNotMatch(canonicalCi, /^\s*node scripts\/deploy-cloudflare-sync-dev\.mjs\s*$/m);

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
    `direct deploy alias must remain fail-closed: ${scriptName}`,
  );
}
assert.doesNotMatch(JSON.stringify(packageJson.scripts || {}), /wrangler deploy/);
assert.match(directDeployBlocker, /Direct Cloudflare deployment is disabled/);
assert.match(directDeployBlocker, /CI-gated and exact-commit controlled/);

// Historical branch-promotion code stays classified as legacy and must not become canonical truth again.
assert.match(legacyPromotion, /__manual_ci_gated_deploy__/);
assert.match(legacyPromotion, /cloudflare-foundation-v1/);
assert.match(legacyPromotion, /cloudflare-foundation-ci\.yml/);
assert.match(phase2Definition, /implementation history \/ regression material/i);
assert.match(phase2Definition, /Workers Builds API/i);
assert.match(phase2Definition, /commit_hash/);
assert.match(phase2Definition, /build_uuid/);
assert.match(phase2Definition, /version_id/);
assert.match(phase2Definition, /deployment receipt/i);

// Version metadata must be both bound and actually exposed through the canonical health route.
assert.match(nativeWrangler, /"version_metadata"\s*:\s*\{\s*"binding"\s*:\s*"CF_VERSION_METADATA"\s*\}/s);
assert.match(webEntry, /handleDeploymentHealthRoute/);
assert.match(webEntry, /deployment-health\.js/);
assert.match(deploymentHealth, /CF_VERSION_METADATA/);
assert.match(deploymentHealth, /versionId/);
assert.match(deploymentHealth, /versionTag/);
assert.match(deploymentHealth, /versionTimestamp/);
assert.match(deploymentHealth, /\/api\/health/);
assert.doesNotMatch(deploymentHealth, /CLOUDFLARE_API_TOKEN|AMAZON_CLIENT_SECRET|AMAZON_ADS_CLIENT_SECRET/);

// Builds API support is library-only during foundation work. CI may test it only through injected fetch.
assert.match(buildsClient, /builds\/triggers\/.*\/builds/);
assert.match(buildsClient, /commit_hash/);
assert.match(buildsClient, /build_uuid/);
assert.match(buildsClient, /build_trigger_metadata/);
assert.match(buildsClient, /trigger_uuid/);
assert.match(buildsClient, /external_script_id/);
assert.match(buildsClient, /fetchImpl/);
assert.doesNotMatch(buildsClient, /process\.argv/);
assert.doesNotMatch(buildsClient, /process\.env/);
assert.doesNotMatch(buildsClient, /CLOUDFLARE_API_TOKEN/);
assert.doesNotMatch(canonicalCi, /api\.cloudflare\.com/);

// Live topology discovery is a read-only library. It may correlate Worker→trigger→deployment→version→build only with GET.
assert.match(discoveryClient, /\/workers\/scripts/);
assert.match(discoveryClient, /\/builds\/workers\/.*\/triggers/);
assert.match(discoveryClient, /\/deployments/);
assert.match(discoveryClient, /\/versions\//);
assert.match(discoveryClient, /version_ids=/);
assert.match(discoveryClient, /assertLiveRuntimeVersion/);
assert.match(discoveryClient, /method:\s*'GET'/);
assert.doesNotMatch(discoveryClient, /method:\s*'(POST|PUT|PATCH|DELETE)'/);
assert.doesNotMatch(discoveryClient, /process\.argv/);
assert.doesNotMatch(discoveryClient, /process\.env/);
assert.doesNotMatch(discoveryClient, /CLOUDFLARE_API_TOKEN/);

// Deployment receipts are evidence-only and fail closed on commit/version mismatch.
assert.match(deploymentReceipt, /cloudflare-deployment-receipt-v1/);
assert.match(deploymentReceipt, /DEPLOYMENT_RECEIPT_COMMIT_MISMATCH/);
assert.match(deploymentReceipt, /DEPLOYMENT_RECEIPT_LIVE_VERSION_MISMATCH/);
assert.match(deploymentReceipt, /DEPLOYMENT_RECEIPT_BUILD_NOT_SUCCESS/);
assert.match(deploymentReceipt, /buildCommitSha\s*!==\s*commitSha/);
assert.match(deploymentReceipt, /liveRuntimeVersionId\s*!==\s*versionId/);
assert.doesNotMatch(deploymentReceipt, /process\.argv/);
assert.doesNotMatch(deploymentReceipt, /process\.env/);
assert.doesNotMatch(deploymentReceipt, /CLOUDFLARE_API_TOKEN|AMAZON_CLIENT_SECRET|AMAZON_ADS_CLIENT_SECRET/);

// Amazon stays phase-independently dormant. Sync Worker deployment is not part of Phase 2 foundation.
assert.match(nativeWrangler, /"SYNC_TRIGGER_ENABLED"\s*:\s*"false"/);
assert.match(syncWrangler, /"AMAZON_ADS_ENABLED"\s*:\s*"false"/);

// Production remains explicitly non-ready; Phase 2 foundation must not erase provisioning placeholders.
assert.match(nativeWrangler, /REPLACE_PROD_CONTROL_D1_ID/);
assert.match(nativeWrangler, /REPLACE_PROD_STORE_01_D1_ID/);
assert.match(nativeWrangler, /https:\/\/REPLACE_ME\.cloudflareaccess\.com/);
assert.match(nativeWrangler, /"ACCESS_AUD"\s*:\s*"REPLACE_ME"/);
assert.match(phase2Definition, /Production remains out of scope/i);

console.log(JSON.stringify({
  ok: true,
  contract: 'deployment-integrity-foundation-v5',
  canonicalCiPushCoverage: true,
  mainProtectionContextPreserved: true,
  directDeployBlocked: true,
  legacyBranchPromotionNonCanonical: true,
  exactCommitBuildContractDefined: true,
  exactCommitBuildClientLibraryOnly: true,
  readOnlyCloudflareDiscoveryLibraryOnly: true,
  failClosedDeploymentReceipt: true,
  buildUuidRequired: true,
  versionDeploymentCorrelationRequired: true,
  runtimeVersionMetadataRequired: true,
  runtimeVersionHealthRouted: true,
  deploymentReceiptRequired: true,
  amazonDormant: true,
  productionNotReady: true,
  liveCloudflareMutationPerformed: false,
}, null, 2));
