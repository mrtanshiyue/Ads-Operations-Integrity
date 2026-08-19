import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DeploymentIntegrityReceiptError,
  createDeploymentIntegrityReceipt,
  createDeploymentReleaseTrace,
  releaseTraceFromDeploymentIntegrityReceipt,
  serializeDeploymentIntegrityReceipt,
  serializeDeploymentReleaseTrace,
} from './deployment-integrity-receipt.mjs';

const base = Object.freeze({
  repository: 'mrtanshiyue/Ads-Operations-Integrity',
  commitSha: '3c7f762429ef688e9dfbf3d15689787e5107c05d',
  githubWorkflowRunId: 31937956079,
  githubRequiredContext: 'Static site and security invariants',
  cloudflareAccountId: '0123456789abcdef0123456789abcdef',
  workerName: 'ads-operations-web-dev',
  workerTag: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  triggerUuid: '11111111-2222-3333-4444-555555555555',
  buildUuid: '22222222-3333-4444-5555-666666666666',
  buildOutcome: 'success',
  buildCommitSha: '3c7f762429ef688e9dfbf3d15689787e5107c05d',
  versionId: '33333333-4444-5555-6666-777777777777',
  deploymentId: '44444444-5555-6666-7777-888888888888',
  liveRuntimeVersionId: '33333333-4444-5555-6666-777777777777',
  acceptedAt: '2026-08-16T09:05:00.000Z',
  CLOUDFLARE_API_TOKEN: 'must-not-appear',
  AMAZON_ADS_CLIENT_SECRET: 'must-not-appear-either',
});

const receipt = createDeploymentIntegrityReceipt(base);
assert.deepEqual(receipt, {
  schemaVersion: 'cloudflare-deployment-receipt-v1',
  repository: base.repository,
  commitSha: base.commitSha,
  githubWorkflowRunId: base.githubWorkflowRunId,
  githubRequiredContext: base.githubRequiredContext,
  cloudflareAccountId: base.cloudflareAccountId,
  workerName: base.workerName,
  workerTag: base.workerTag,
  triggerUuid: base.triggerUuid,
  buildUuid: base.buildUuid,
  buildOutcome: 'success',
  buildCommitSha: base.buildCommitSha,
  versionId: base.versionId,
  deploymentId: base.deploymentId,
  liveRuntimeVersionId: base.liveRuntimeVersionId,
  acceptedAt: base.acceptedAt,
});
assert.equal(Object.isFrozen(receipt), true);
const serialized = serializeDeploymentIntegrityReceipt(receipt);
assert.equal(serialized.endsWith('\n'), true);
assert.doesNotMatch(serialized, /must-not-appear/);
assert.doesNotMatch(serialized, /TOKEN|SECRET/);
assert.deepEqual(JSON.parse(serialized), receipt);

const derivedTrace = releaseTraceFromDeploymentIntegrityReceipt(receipt, {
  environment: 'development',
  deployedAt: '2026-08-16T09:04:59.123456Z',
});
assert.deepEqual(derivedTrace, {
  schemaVersion: 'cloudflare-release-trace-v1',
  gitCommitSha: base.commitSha,
  workersBuildUuid: base.buildUuid,
  workersBuildTriggerUuid: base.triggerUuid,
  workerVersionId: base.versionId,
  deploymentId: base.deploymentId,
  deployedAt: '2026-08-16T09:04:59.123456Z',
  environment: 'development',
  workerName: base.workerName,
});
assert.equal(Object.isFrozen(derivedTrace), true);
assert.deepEqual(JSON.parse(serializeDeploymentReleaseTrace(derivedTrace)), derivedTrace);

const fixture = JSON.parse(await readFile(new URL('../fixtures/deployment-release-trace-production.json', import.meta.url), 'utf8'));
const productionTrace = createDeploymentReleaseTrace(fixture);
assert.deepEqual(productionTrace, fixture);
assert.equal(productionTrace.gitCommitSha, '02aae3792726af2ddc3fc21679c4c0a6f6bcd3e5');
assert.equal(productionTrace.workersBuildUuid, '7da40dbc-9b73-48ef-bab6-d53d42fcd016');
assert.equal(productionTrace.workersBuildTriggerUuid, 'fa90d482-de7b-466b-9ada-04404569ede9');
assert.equal(productionTrace.workerVersionId, '6b056104-ffba-4399-a575-9a070e64ed1e');
assert.equal(productionTrace.deploymentId, '806aa666-dbe4-4a18-a54c-7089ebc2c323');
assert.equal(productionTrace.deployedAt, '2026-08-19T06:48:32.87072Z');
assert.equal(productionTrace.environment, 'production');
assert.equal(productionTrace.workerName, 'ads-operations-web-prod');

for (const [name, patch, expectedPrefix] of [
  ['commit mismatch', { buildCommitSha: '1111111111111111111111111111111111111111' }, 'DEPLOYMENT_RECEIPT_COMMIT_MISMATCH:'],
  ['live version mismatch', { liveRuntimeVersionId: '99999999-8888-7777-6666-555555555555' }, 'DEPLOYMENT_RECEIPT_LIVE_VERSION_MISMATCH:'],
  ['failed build', { buildOutcome: 'fail' }, 'DEPLOYMENT_RECEIPT_BUILD_NOT_SUCCESS:fail'],
  ['invalid build uuid', { buildUuid: 'not-a-uuid' }, 'DEPLOYMENT_RECEIPT_BUILD_UUID_INVALID'],
  ['invalid account', { cloudflareAccountId: 'not-an-account-id' }, 'DEPLOYMENT_RECEIPT_ACCOUNT_ID_INVALID'],
  ['invalid run id', { githubWorkflowRunId: 0 }, 'DEPLOYMENT_RECEIPT_GITHUB_RUN_ID_INVALID'],
  ['invalid accepted at', { acceptedAt: '2026-08-16 09:05:00' }, 'DEPLOYMENT_RECEIPT_ACCEPTED_AT_INVALID'],
]) {
  assert.throws(
    () => createDeploymentIntegrityReceipt({ ...base, ...patch }),
    (error) => {
      assert.ok(error instanceof DeploymentIntegrityReceiptError, name);
      assert.ok(error.code.startsWith(expectedPrefix), `${name}: ${error.code}`);
      return true;
    },
  );
}

for (const [name, patch, expectedCode] of [
  ['invalid release environment', { environment: 'staging' }, 'RELEASE_TRACE_ENVIRONMENT_INVALID'],
  ['invalid release build uuid', { workersBuildUuid: 'not-a-uuid' }, 'RELEASE_TRACE_BUILD_UUID_INVALID'],
  ['invalid release deployedAt', { deployedAt: '2026-08-19 06:48:32' }, 'RELEASE_TRACE_DEPLOYED_AT_INVALID'],
]) {
  assert.throws(
    () => createDeploymentReleaseTrace({ ...fixture, ...patch }),
    (error) => error instanceof DeploymentIntegrityReceiptError && error.code === expectedCode,
    name,
  );
}

assert.throws(
  () => createDeploymentIntegrityReceipt({ ...base, repository: 'invalid repository' }),
  (error) => error instanceof DeploymentIntegrityReceiptError
    && error.code === 'DEPLOYMENT_RECEIPT_REPOSITORY_INVALID',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'cloudflare-deployment-receipt-v1',
  releaseTraceContract: 'cloudflare-release-trace-v1',
  exactCommitEqualityRequired: true,
  successfulBuildRequired: true,
  liveVersionEqualityRequired: true,
  immutableReceipt: true,
  immutableReleaseTrace: true,
  productionFixtureVerified: true,
  secretsExcludedByAllowlist: true,
  canonicalFieldOrderStable: true,
  noLiveCloudflareRequest: true,
}, null, 2));
