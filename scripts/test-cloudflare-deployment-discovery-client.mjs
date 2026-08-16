import assert from 'node:assert/strict';
import {
  CloudflareDeploymentDiscoveryError,
  assertLiveRuntimeVersion,
  discoverWorkerDeploymentTopology,
} from './cloudflare-deployment-discovery-client.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const scriptName = 'ads-operations-web-dev';
const workerTag = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const triggerUuid = '11111111-2222-3333-4444-555555555555';
const deploymentId = '22222222-3333-4444-5555-666666666666';
const versionId = '33333333-4444-5555-6666-777777777777';
const buildUuid = '44444444-5555-6666-7777-888888888888';
const commitSha = 'ce59e4cc43413338f35a34cb44622a7aa26f9875';
const token = 'read-only-discovery-test-token';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function topologyResponses(overrides = {}) {
  const trigger = {
    trigger_uuid: triggerUuid,
    trigger_name: 'Historical gated deploy',
    external_script_id: workerTag,
    branch_includes: ['__manual_ci_gated_deploy__'],
    branch_excludes: [],
    build_command: 'npm run build:cf-native',
    deploy_command: 'npx wrangler deploy',
    root_directory: '/',
    ...(overrides.trigger || {}),
  };
  const deployment = {
    id: deploymentId,
    created_on: '2026-08-15T10:00:00.000Z',
    source: 'wrangler',
    strategy: 'percentage',
    versions: [{ percentage: 100, version_id: versionId }],
    ...(overrides.deployment || {}),
  };
  const build = {
    build_uuid: buildUuid,
    status: 'stopped',
    build_outcome: 'success',
    build_trigger_metadata: {
      branch: '__manual_ci_gated_deploy__',
      build_trigger_source: 'push',
      commit_hash: commitSha,
      repo_name: 'Ads-Operations-Integrity',
    },
    trigger: {
      trigger_uuid: triggerUuid,
      external_script_id: workerTag,
    },
    ...(overrides.build || {}),
  };
  return [
    { success: true, result: [{ id: scriptName, tag: workerTag }] },
    { success: true, result: [trigger] },
    { success: true, result: { deployments: [deployment] } },
    {
      success: true,
      result: {
        id: versionId,
        number: 42,
        metadata: {
          source: 'wrangler',
          created_on: '2026-08-15T09:59:00.000Z',
          modified_on: '2026-08-15T09:59:30.000Z',
        },
      },
    },
    { success: true, result: { builds: { [versionId]: build } } },
  ];
}

function discoveryFetch(responses, seen) {
  const queue = [...responses];
  return async (url, init) => {
    seen.push({ url, init });
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.body, undefined);
    const next = queue.shift();
    assert.ok(next, `unexpected request: ${url}`);
    return jsonResponse(next);
  };
}

{
  const seen = [];
  const result = await discoverWorkerDeploymentTopology({
    accountId,
    scriptName,
    token,
    fetchImpl: discoveryFetch(topologyResponses(), seen),
  });
  assert.equal(seen.length, 5);
  assert.deepEqual(seen.map(({ url }) => url), [
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/workers/${workerTag}/triggers`,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/versions/${versionId}`,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/builds?version_ids=${versionId}`,
  ]);
  assert.deepEqual(result, {
    schemaVersion: 'cloudflare-deployment-discovery-v1',
    accountId,
    workerName: scriptName,
    workerTag,
    triggers: [{
      triggerUuid,
      triggerName: 'Historical gated deploy',
      externalScriptId: workerTag,
      branchIncludes: ['__manual_ci_gated_deploy__'],
      branchExcludes: [],
      buildCommand: 'npm run build:cf-native',
      deployCommand: 'npx wrangler deploy',
      rootDirectory: '/',
    }],
    activeDeployment: {
      deploymentId,
      versionId,
      percentage: 100,
      source: 'wrangler',
      strategy: 'percentage',
      createdOn: '2026-08-15T10:00:00.000Z',
    },
    activeVersion: {
      versionId,
      number: 42,
      source: 'wrangler',
      createdOn: '2026-08-15T09:59:00.000Z',
      modifiedOn: '2026-08-15T09:59:30.000Z',
    },
    activeBuild: {
      buildUuid,
      status: 'stopped',
      outcome: 'success',
      commitSha,
      branch: '__manual_ci_gated_deploy__',
      triggerSource: 'push',
      triggerUuid,
      workerTag,
      repoName: 'Ads-Operations-Integrity',
    },
  });
}

{
  const accepted = assertLiveRuntimeVersion({
    versionId,
    health: {
      deployment: {
        versionId,
        versionTag: 'phase2-test',
        versionTimestamp: '2026-08-16T09:00:00.000Z',
      },
    },
  });
  assert.deepEqual(accepted, {
    versionId,
    versionTag: 'phase2-test',
    versionTimestamp: '2026-08-16T09:00:00.000Z',
  });
  assert.throws(
    () => assertLiveRuntimeVersion({
      versionId,
      health: { deployment: { versionId: '99999999-8888-7777-6666-555555555555' } },
    }),
    (error) => error instanceof CloudflareDeploymentDiscoveryError
      && error.code.startsWith('CF_DEPLOYMENT_DISCOVERY_LIVE_VERSION_MISMATCH:'),
  );
}

{
  const seen = [];
  await assert.rejects(
    discoverWorkerDeploymentTopology({
      accountId,
      scriptName,
      token,
      fetchImpl: discoveryFetch([
        { success: true, result: [{ id: 'different-worker', tag: workerTag }] },
      ], seen),
    }),
    (error) => error instanceof CloudflareDeploymentDiscoveryError
      && error.code === 'CF_DEPLOYMENT_DISCOVERY_WORKER_MATCH_INVALID:0',
  );
  assert.equal(seen.length, 1);
}

{
  const seen = [];
  const responses = topologyResponses({
    deployment: {
      versions: [
        { percentage: 50, version_id: versionId },
        { percentage: 50, version_id: '55555555-6666-7777-8888-999999999999' },
      ],
    },
  }).slice(0, 3);
  await assert.rejects(
    discoverWorkerDeploymentTopology({
      accountId,
      scriptName,
      token,
      fetchImpl: discoveryFetch(responses, seen),
    }),
    (error) => error instanceof CloudflareDeploymentDiscoveryError
      && error.code === 'CF_DEPLOYMENT_DISCOVERY_NOT_SINGLE_VERSION:2',
  );
  assert.equal(seen.length, 3);
}

{
  const seen = [];
  const responses = topologyResponses({
    build: {
      trigger: {
        trigger_uuid: '99999999-8888-7777-6666-555555555555',
        external_script_id: workerTag,
      },
    },
  });
  await assert.rejects(
    discoverWorkerDeploymentTopology({
      accountId,
      scriptName,
      token,
      fetchImpl: discoveryFetch(responses, seen),
    }),
    (error) => error instanceof CloudflareDeploymentDiscoveryError
      && error.code.startsWith('CF_DEPLOYMENT_DISCOVERY_BUILD_TRIGGER_NOT_LISTED:'),
  );
  assert.equal(seen.length, 5);
}

{
  const seen = [];
  const responses = topologyResponses();
  responses[4] = { success: true, result: { builds: {} } };
  await assert.rejects(
    discoverWorkerDeploymentTopology({
      accountId,
      scriptName,
      token,
      fetchImpl: discoveryFetch(responses, seen),
    }),
    (error) => error instanceof CloudflareDeploymentDiscoveryError
      && error.code === `CF_DEPLOYMENT_DISCOVERY_VERSION_BUILD_MISSING:${versionId}`,
  );
  assert.equal(seen.length, 5);
}

console.log(JSON.stringify({
  ok: true,
  contract: 'cloudflare-deployment-discovery-client-v1',
  workerTagResolvedByName: true,
  triggersReadOnly: true,
  activeDeploymentSingleVersionRequired: true,
  versionDetailVerified: true,
  versionToBuildCorrelationRequired: true,
  activeBuildTriggerListed: true,
  liveRuntimeVersionCorrelationReady: true,
  allRequestsGetOnly: true,
  noLiveCloudflareRequest: true,
}, null, 2));
