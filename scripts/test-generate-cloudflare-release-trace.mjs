import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateReleaseTraceFile,
  releaseTraceFromTopology,
  waitForReleaseTrace,
} from './generate-cloudflare-release-trace.mjs';

const SHA = '5ac7ce4b16e5e1ce860c7855acd54632915f1840';
const topology = Object.freeze({
  workerName: 'ads-operations-web-dev',
  activeBuild: Object.freeze({
    buildUuid: 'b09a529a-86e8-45a1-855d-95e127713d73',
    triggerUuid: '33a47d45-4103-43d7-bca4-7d9096c4abfb',
    commitSha: SHA,
    status: 'success',
    outcome: 'success',
  }),
  activeVersion: Object.freeze({ versionId: '87865358-d45b-466e-ad12-172e88683a9b' }),
  activeDeployment: Object.freeze({
    deploymentId: '07f2e2ba-885c-41c3-94fa-6ba519a344bb',
    versionId: '87865358-d45b-466e-ad12-172e88683a9b',
    percentage: 100,
    createdOn: '2026-08-19T07:45:00.000Z',
  }),
});

const trace = releaseTraceFromTopology(topology, {
  expectedCommitSha: SHA,
  environment: 'development',
  workerName: 'ads-operations-web-dev',
});
assert.deepEqual(trace, {
  schemaVersion: 'cloudflare-release-trace-v1',
  gitCommitSha: SHA,
  workersBuildUuid: topology.activeBuild.buildUuid,
  workersBuildTriggerUuid: topology.activeBuild.triggerUuid,
  workerVersionId: topology.activeVersion.versionId,
  deploymentId: topology.activeDeployment.deploymentId,
  deployedAt: topology.activeDeployment.createdOn,
  environment: 'development',
  workerName: 'ads-operations-web-dev',
});

assert.throws(() => releaseTraceFromTopology({
  ...topology,
  activeBuild: { ...topology.activeBuild, commitSha: '0'.repeat(40) },
}, { expectedCommitSha: SHA, environment: 'development', workerName: topology.workerName }), /RELEASE_TRACE_COMMIT_NOT_LIVE/);
assert.throws(() => releaseTraceFromTopology({
  ...topology,
  activeBuild: { ...topology.activeBuild, outcome: 'failed' },
}, { expectedCommitSha: SHA, environment: 'development', workerName: topology.workerName }), /RELEASE_TRACE_BUILD_NOT_SUCCESS/);
assert.throws(() => releaseTraceFromTopology({
  ...topology,
  activeVersion: { versionId: '11111111-1111-4111-8111-111111111111' },
}, { expectedCommitSha: SHA, environment: 'development', workerName: topology.workerName }), /RELEASE_TRACE_VERSION_MISMATCH/);
assert.throws(() => releaseTraceFromTopology({
  ...topology,
  activeDeployment: { ...topology.activeDeployment, percentage: 90 },
}, { expectedCommitSha: SHA, environment: 'development', workerName: topology.workerName }), /RELEASE_TRACE_TRAFFIC_NOT_FULL/);

let calls = 0;
const waited = await waitForReleaseTrace({
  expectedCommitSha: SHA,
  environment: 'development',
  workerName: topology.workerName,
  accountId: '1'.repeat(32),
  token: 'test-token',
  attempts: 3,
  delayMs: 0,
  sleep: async () => {},
  discover: async () => {
    calls += 1;
    return calls === 1
      ? { ...topology, activeBuild: { ...topology.activeBuild, commitSha: '0'.repeat(40) } }
      : topology;
  },
});
assert.equal(waited.attempt, 2, 'automation must tolerate Cloudflare deployment lag after main advances');
assert.equal(calls, 2);

const dir = await mkdtemp(join(tmpdir(), 'release-trace-'));
try {
  const outputPath = join(dir, 'trace.json');
  await generateReleaseTraceFile({
    expectedCommitSha: SHA,
    environment: 'development',
    workerName: topology.workerName,
    accountId: '1'.repeat(32),
    token: 'test-token',
    outputPath,
    attempts: 1,
    delayMs: 0,
    discover: async () => topology,
  });
  const persisted = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 'cloudflare-release-trace-v1');
  assert.equal(persisted.gitCommitSha, SHA);
  assert.equal(persisted.workerVersionId, topology.activeVersion.versionId);
  assert.equal(persisted.deploymentId, topology.activeDeployment.deploymentId);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  contract: 'cloudflare-release-trace-automation-v1',
  exactMainVerified: true,
  buildSuccessVerified: true,
  liveVersionVerified: true,
  fullTrafficVerified: true,
  deploymentLagRetryVerified: true,
  amazonExecutionAuthorized: false,
}, null, 2));
