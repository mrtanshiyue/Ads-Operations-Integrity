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
const gate24Receipt = JSON.parse(await text('docs/architecture/PHASE2_GATE24_DEPLOYMENT_RECEIPT.json'));

// Phase 2 validates itself on push without changing the historical required context name.
assert.match(canonicalCi, /deployment-integrity-\*/);
assert.match(canonicalCi, /name:\s*Static site and security invariants/);
assert.match(canonicalCi, /test-deployment-integrity-contract\.mjs/);
assert.match(canonicalCi, /test-deployment-health-contract\.mjs/);
assert.match(canonicalCi, /test-cloudflare-workers-builds-client\.mjs/);
assert.match(canonicalCi, /test-cloudflare-deployment-discovery-client\.mjs/);
assert.match(canonicalCi, /test-deployment-integrity-receipt\.mjs/);

// Canonical CI is validation-only. Live Cloudflare mutation is a separate controlled operation.
assert.doesNotMatch(canonicalCi, /wrangler\s+deploy/);
assert.doesNotMatch(canonicalCi, /^\s*node scripts\/promote-cloudflare-sync-dev-trigger\.mjs\s*$/m);
assert.doesNotMatch(canonicalCi, /^\s*node scripts\/deploy-cloudflare-sync-dev\.mjs\s*$/m);
assert.doesNotMatch(canonicalCi, /api\.cloudflare\.com/);

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

// Historical branch-motion semantics are non-canonical, while the trigger object remains required by the exact-SHA Builds API path.
assert.match(legacyPromotion, /__manual_ci_gated_deploy__/);
assert.match(legacyPromotion, /cloudflare-foundation-v1/);
assert.match(legacyPromotion, /cloudflare-foundation-ci\.yml/);
assert.match(phase2Definition, /implementation history \/ regression material/i);
assert.match(phase2Definition, /Historical Branch-Motion Deployment Retirement/i);
assert.match(phase2Definition, /trigger object.*required/i);
assert.match(phase2Definition, /Workers Builds API/i);
assert.match(phase2Definition, /commit_hash/);
assert.match(phase2Definition, /build_uuid/);
assert.match(phase2Definition, /version_id/);
assert.match(phase2Definition, /deployment receipt/i);

// Preview URLs are explicitly disabled without disabling the canonical workers.dev route.
assert.match(nativeWrangler, /"preview_urls"\s*:\s*false/);
assert.doesNotMatch(nativeWrangler, /"preview_urls"\s*:\s*true/);
assert.doesNotMatch(nativeWrangler, /"workers_dev"\s*:\s*false/);

// Version metadata is both bound and exposed through the canonical health route.
assert.match(nativeWrangler, /"version_metadata"\s*:\s*\{\s*"binding"\s*:\s*"CF_VERSION_METADATA"\s*\}/s);
assert.match(webEntry, /handleDeploymentHealthRoute/);
assert.match(webEntry, /deployment-health\.js/);
assert.match(deploymentHealth, /CF_VERSION_METADATA/);
assert.match(deploymentHealth, /versionId/);
assert.match(deploymentHealth, /versionTag/);
assert.match(deploymentHealth, /versionTimestamp/);
assert.match(deploymentHealth, /\/api\/health/);
assert.doesNotMatch(deploymentHealth, /CLOUDFLARE_API_TOKEN|AMAZON_CLIENT_SECRET|AMAZON_ADS_CLIENT_SECRET/);

// Exact-SHA Builds API support stays library-only inside canonical CI.
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

// Live topology discovery stays read-only.
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

// Deployment receipt code remains evidence-only and fail-closed.
assert.match(deploymentReceipt, /cloudflare-deployment-receipt-v1/);
assert.match(deploymentReceipt, /DEPLOYMENT_RECEIPT_COMMIT_MISMATCH/);
assert.match(deploymentReceipt, /DEPLOYMENT_RECEIPT_LIVE_VERSION_MISMATCH/);
assert.match(deploymentReceipt, /DEPLOYMENT_RECEIPT_BUILD_NOT_SUCCESS/);
assert.match(deploymentReceipt, /buildCommitSha\s*!==\s*commitSha/);
assert.match(deploymentReceipt, /liveRuntimeVersionId\s*!==\s*versionId/);
assert.doesNotMatch(deploymentReceipt, /process\.argv/);
assert.doesNotMatch(deploymentReceipt, /process\.env/);
assert.doesNotMatch(deploymentReceipt, /CLOUDFLARE_API_TOKEN|AMAZON_CLIENT_SECRET|AMAZON_ADS_CLIENT_SECRET/);

// Gate 2.4 immutable receipt stays tied to the accepted deployment SHA, not later governance commits.
assert.equal(gate24Receipt.schemaVersion, 'cloudflare-deployment-receipt-v1');
assert.equal(gate24Receipt.commitSha, '27da62ee2b064c685df35bf76dc395f349f68aba');
assert.equal(gate24Receipt.buildCommitSha, gate24Receipt.commitSha);
assert.equal(gate24Receipt.githubWorkflowRunId, 31938209069);
assert.equal(gate24Receipt.githubRequiredContext, 'Static site and security invariants');
assert.equal(gate24Receipt.workerName, 'ads-operations-web-dev');
assert.equal(gate24Receipt.workerTag, 'ab2b4da6c8be41a5a72223384c32b71c');
assert.equal(gate24Receipt.triggerUuid, '33a47d45-4103-43d7-bca4-7d9096c4abfb');
assert.equal(gate24Receipt.buildUuid, 'f064ee48-6e28-43d2-a575-883c9a45bca1');
assert.equal(gate24Receipt.versionId, '96710600-9968-4e1f-88d4-cd84cc546ca0');
assert.equal(gate24Receipt.deploymentId, 'e6ab548a-b070-4a03-ab7a-b17c255face5');
assert.equal(gate24Receipt.liveRuntimeVersionId, gate24Receipt.versionId);
assert.equal(gate24Receipt.buildOutcome, 'success');

// Amazon remains dormant.
assert.match(nativeWrangler, /"SYNC_TRIGGER_ENABLED"\s*:\s*"false"/);
assert.match(syncWrangler, /"AMAZON_ADS_ENABLED"\s*:\s*"false"/);

// Production remains explicitly non-ready; placeholders cannot be erased by Phase 2 governance work.
for (const placeholder of [
  'REPLACE_PROD_CONTROL_D1_ID',
  'REPLACE_PROD_STORE_01_D1_ID',
  'REPLACE_PROD_STORE_02_D1_ID',
  'REPLACE_PROD_STORE_03_D1_ID',
  'REPLACE_PROD_STORE_04_D1_ID',
]) {
  assert.match(nativeWrangler, new RegExp(placeholder));
}
assert.match(nativeWrangler, /https:\/\/REPLACE_ME\.cloudflareaccess\.com/);
assert.match(nativeWrangler, /"ACCESS_AUD"\s*:\s*"REPLACE_ME"/);
assert.match(phase2Definition, /Production remains out of scope/i);

console.log(JSON.stringify({
  ok: true,
  contract: 'deployment-integrity-post-acceptance-v6',
  canonicalCiPushCoverage: true,
  mainProtectionContextPreserved: true,
  canonicalCiPerformsLiveCloudflareMutation: false,
  directDeployBlocked: true,
  historicalBranchPromotionNonCanonical: true,
  historicalWorkersBuildTriggerPreservedForExactShaExecution: true,
  exactCommitBuildContractDefined: true,
  exactCommitBuildClientLibraryOnly: true,
  readOnlyCloudflareDiscoveryLibraryOnly: true,
  failClosedDeploymentReceipt: true,
  gate24ImmutableReceiptPreserved: true,
  buildUuidRequired: true,
  versionDeploymentCorrelationRequired: true,
  runtimeVersionMetadataRequired: true,
  runtimeVersionHealthRouted: true,
  previewUrlsDisabled: true,
  amazonDormant: true,
  productionNotReady: true
}, null, 2));
