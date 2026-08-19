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
const previewHardeningReceipt = JSON.parse(await text('docs/architecture/PHASE2_PREVIEW_HARDENING_DEPLOYMENT_RECEIPT.json'));

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

// Exact-SHA deployment remains a library contract, not a CI side effect.
assert.match(buildsClient, /commit_hash/);
assert.match(buildsClient, /build_uuid/);
assert.match(buildsClient, /build\.status/);
assert.match(buildsClient, /build\.build_outcome/);
assert.match(buildsClient, /build\.commit_hash/);
assert.match(buildsClient, /throw new Error/);
assert.match(discoveryClient, /GET/);
assert.doesNotMatch(discoveryClient, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
assert.match(deploymentReceipt, /candidateSha/);
assert.match(deploymentReceipt, /versionId/);
assert.match(deploymentReceipt, /deploymentId/);
assert.match(deploymentReceipt, /runtimeVersionId/);
assert.match(directDeployBlocker, /blocked/i);
assert.match(legacyPromotion, /historical/i);

// Runtime still exposes immutable deployment version metadata before all protected API handling.
assert.match(webEntry, /handleDeploymentHealthRoute/);
assert.match(webEntry, /CF_VERSION_METADATA/);
assert.match(deploymentHealth, /CF_VERSION_METADATA/);
assert.match(deploymentHealth, /versionId/);

// Canonical runtime config stays preview-hardened.
assert.match(nativeWrangler, /"preview_urls"\s*:\s*false/);

// Gate 2.4 immutable receipt must remain tied to the exact accepted Dev commit.
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

// Preview hardening receipt is a second immutable deployment record and must stay tied to its deployed candidate SHA.
assert.equal(previewHardeningReceipt.schemaVersion, 'cloudflare-deployment-receipt-v1');
assert.equal(previewHardeningReceipt.commitSha, '0d1115da98282e6874ce2b8128a14fb05a1ac968');
assert.equal(previewHardeningReceipt.buildCommitSha, previewHardeningReceipt.commitSha);
assert.equal(previewHardeningReceipt.githubWorkflowRunId, 31940028696);
assert.equal(previewHardeningReceipt.githubRequiredContext, 'Static site and security invariants');
assert.equal(previewHardeningReceipt.workerName, 'ads-operations-web-dev');
assert.equal(previewHardeningReceipt.workerTag, 'ab2b4da6c8be41a5a72223384c32b71c');
assert.equal(previewHardeningReceipt.triggerUuid, '33a47d45-4103-43d7-bca4-7d9096c4abfb');
assert.equal(previewHardeningReceipt.buildUuid, '006a7123-4204-499d-bae7-4138284bf30d');
assert.equal(previewHardeningReceipt.versionId, '1264fc03-c111-4037-9029-e21ba57a84b2');
assert.equal(previewHardeningReceipt.deploymentId, '46993acd-cc8f-46fb-bd6c-c1a3b7f41bcb');
assert.equal(previewHardeningReceipt.liveRuntimeVersionId, previewHardeningReceipt.versionId);
assert.equal(previewHardeningReceipt.buildOutcome, 'success');

// Amazon remains dormant in every environment.
assert.match(nativeWrangler, /"SYNC_TRIGGER_ENABLED"\s*:\s*"false"/);
assert.match(syncWrangler, /"AMAZON_ADS_ENABLED"\s*:\s*"false"/);

// Production platform provisioning is now authorized. Canonical config must therefore be fully
// resolved and auditable instead of retaining the old Phase-2 placeholder state.
for (const forbiddenPlaceholder of [
  'REPLACE_PROD_CONTROL_D1_ID',
  'REPLACE_PROD_STORE_01_D1_ID',
  'REPLACE_PROD_STORE_02_D1_ID',
  'REPLACE_PROD_STORE_03_D1_ID',
  'REPLACE_PROD_STORE_04_D1_ID',
  'https://REPLACE_ME.cloudflareaccess.com',
  '"ACCESS_AUD": "REPLACE_ME"',
]) {
  assert.doesNotMatch(nativeWrangler, new RegExp(forbiddenPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(nativeWrangler, /"name"\s*:\s*"ads-operations-web-prod"/);
assert.match(nativeWrangler, /"database_name"\s*:\s*"ads-ops-control-prod"/);
for (const storeName of [
  'ads-ops-store-prod-01',
  'ads-ops-store-prod-02',
  'ads-ops-store-prod-03',
  'ads-ops-store-prod-04',
]) {
  assert.match(nativeWrangler, new RegExp(storeName));
  assert.match(syncWrangler, new RegExp(storeName));
}
assert.match(nativeWrangler, /"bucket_name"\s*:\s*"ads-ops-data-prod"/);
assert.match(syncWrangler, /"bucket_name"\s*:\s*"ads-ops-data-prod"/);
assert.match(nativeWrangler, /"ACCESS_MODE"\s*:\s*"enforce"/);
assert.match(nativeWrangler, /https:\/\/tanshiyuesir\.cloudflareaccess\.com/);
assert.match(nativeWrangler, /"ACCESS_AUD"\s*:\s*"[a-f0-9]{64}"/);
assert.match(phase2Definition, /Production platform provisioning superseded the historical Phase 2 production freeze/i);

console.log(JSON.stringify({
  ok: true,
  contract: 'deployment-integrity-production-ready-v8',
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
  previewHardeningImmutableReceiptPreserved: true,
  buildUuidRequired: true,
  versionDeploymentCorrelationRequired: true,
  runtimeVersionMetadataRequired: true,
  runtimeVersionHealthRouted: true,
  previewUrlsDisabled: true,
  amazonDormant: true,
  productionConfigResolved: true
}, null, 2));