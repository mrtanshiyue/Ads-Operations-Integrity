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
const directDeployBlocker = await text('scripts/block-direct-cloudflare-deploy.mjs');
const legacyPromotion = await text('scripts/promote-cloudflare-sync-dev-trigger.mjs');
const phase2Definition = await text('docs/architecture/PHASE2_DEPLOYMENT_INTEGRITY.md');

// Phase 2 must validate itself on push without changing the historical required context name.
assert.match(canonicalCi, /deployment-integrity-\*/);
assert.match(canonicalCi, /name:\s*Static site and security invariants/);
assert.match(canonicalCi, /test-deployment-integrity-contract\.mjs/);

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

// Version metadata is the runtime proof required to compare live traffic with the API-observed version.
assert.match(nativeWrangler, /"version_metadata"\s*:\s*\{\s*"binding"\s*:\s*"CF_VERSION_METADATA"\s*\}/s);

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
  contract: 'deployment-integrity-foundation-v1',
  canonicalCiPushCoverage: true,
  mainProtectionContextPreserved: true,
  directDeployBlocked: true,
  legacyBranchPromotionNonCanonical: true,
  exactCommitBuildContractDefined: true,
  buildUuidRequired: true,
  versionDeploymentCorrelationRequired: true,
  runtimeVersionMetadataRequired: true,
  deploymentReceiptRequired: true,
  amazonDormant: true,
  productionNotReady: true,
  liveCloudflareMutationPerformed: false,
}, null, 2));
