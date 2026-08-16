import assert from 'node:assert/strict';
import {
  CloudflareWorkersBuildsError,
  assertExactSuccessfulBuild,
  createExactCommitBuild,
  getBuildByUuid,
  waitForExactSuccessfulBuild,
} from './cloudflare-workers-builds-client.mjs';

const accountId = '0123456789abcdef0123456789abcdef';
const triggerUuid = '11111111-2222-3333-4444-555555555555';
const buildUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const commitSha = '6293d6fe86610d6239a1db18097010d7b11314f7';
const workerTag = 'worker-tag-phase2-test';
const token = 'test-token-never-sent-to-cloudflare';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function successfulBuild(overrides = {}) {
  return {
    build_uuid: buildUuid,
    status: 'stopped',
    build_outcome: 'success',
    build_trigger_metadata: {
      branch: 'deployment-integrity-phase2',
      build_trigger_source: 'api',
      commit_hash: commitSha,
      repo_name: 'Ads-Operations-Integrity',
    },
    trigger: {
      trigger_uuid: triggerUuid,
      external_script_id: workerTag,
    },
    ...overrides,
  };
}

{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      success: true,
      errors: [],
      messages: [],
      result: { build_uuid: buildUuid, created_on: '2026-08-16T08:58:00.000Z' },
    });
  };
  const result = await createExactCommitBuild({
    accountId,
    triggerUuid,
    commitSha,
    branch: 'deployment-integrity-phase2',
    token,
    fetchImpl,
  });
  assert.deepEqual(result, {
    accountId,
    triggerUuid,
    commitSha,
    branch: 'deployment-integrity-phase2',
    buildUuid,
    createdOn: '2026-08-16T08:58:00.000Z',
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/triggers/${triggerUuid}/builds`,
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    commit_hash: commitSha,
    branch: 'deployment-integrity-phase2',
  });
}

{
  let called = false;
  await assert.rejects(
    createExactCommitBuild({
      accountId,
      triggerUuid,
      commitSha: 'not-a-40-char-sha',
      token,
      fetchImpl: async () => {
        called = true;
        throw new Error('network must not be reached');
      },
    }),
    (error) => error instanceof CloudflareWorkersBuildsError
      && error.code === 'CF_WORKERS_BUILDS_COMMIT_SHA_INVALID',
  );
  assert.equal(called, false);
}

{
  let seen;
  const result = await getBuildByUuid({
    accountId,
    buildUuid,
    token,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return jsonResponse({ success: true, errors: [], messages: [], result: successfulBuild() });
    },
  });
  assert.equal(seen.url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/builds/${buildUuid}`);
  assert.equal(seen.init.method, 'GET');
  assert.equal(result.build_uuid, buildUuid);
}

{
  const accepted = assertExactSuccessfulBuild({
    build: successfulBuild(),
    buildUuid,
    commitSha,
    triggerUuid,
    workerTag,
  });
  assert.deepEqual(accepted, {
    buildUuid,
    commitSha,
    triggerUuid,
    workerTag,
    buildOutcome: 'success',
    status: 'stopped',
    buildTriggerSource: 'api',
    repoName: 'Ads-Operations-Integrity',
    branch: 'deployment-integrity-phase2',
  });
}

for (const [name, build, expectedCodePrefix] of [
  ['commit mismatch', successfulBuild({
    build_trigger_metadata: { ...successfulBuild().build_trigger_metadata, commit_hash: '1111111111111111111111111111111111111111' },
  }), 'CF_WORKERS_BUILDS_COMMIT_MISMATCH:'],
  ['failed build', successfulBuild({ build_outcome: 'fail' }), 'CF_WORKERS_BUILDS_NOT_SUCCESS:fail'],
  ['trigger mismatch', successfulBuild({
    trigger: { ...successfulBuild().trigger, trigger_uuid: '99999999-8888-7777-6666-555555555555' },
  }), 'CF_WORKERS_BUILDS_TRIGGER_MISMATCH:'],
  ['worker mismatch', successfulBuild({
    trigger: { ...successfulBuild().trigger, external_script_id: 'other-worker-tag' },
  }), 'CF_WORKERS_BUILDS_WORKER_MISMATCH:'],
]) {
  assert.throws(
    () => assertExactSuccessfulBuild({ build, buildUuid, commitSha, triggerUuid, workerTag }),
    (error) => {
      assert.ok(error instanceof CloudflareWorkersBuildsError, name);
      assert.ok(error.code.startsWith(expectedCodePrefix), `${name}: ${error.code}`);
      return true;
    },
  );
}

{
  let calls = 0;
  let sleeps = 0;
  const accepted = await waitForExactSuccessfulBuild({
    accountId,
    buildUuid,
    commitSha,
    triggerUuid,
    workerTag,
    token,
    attempts: 3,
    delayMs: 0,
    sleep: async () => { sleeps += 1; },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          success: true,
          result: successfulBuild({ status: 'running', build_outcome: null }),
        });
      }
      return jsonResponse({ success: true, result: successfulBuild() });
    },
  });
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
  assert.equal(accepted.attempt, 2);
  assert.equal(accepted.commitSha, commitSha);
}

{
  await assert.rejects(
    waitForExactSuccessfulBuild({
      accountId,
      buildUuid,
      commitSha,
      triggerUuid,
      workerTag,
      token,
      attempts: 1,
      delayMs: 0,
      sleep: async () => {},
      fetchImpl: async () => jsonResponse({
        success: true,
        result: successfulBuild({ status: 'running', build_outcome: null }),
      }),
    }),
    (error) => error instanceof CloudflareWorkersBuildsError
      && error.code === 'CF_WORKERS_BUILDS_TIMEOUT',
  );
}

{
  await assert.rejects(
    createExactCommitBuild({
      accountId,
      triggerUuid,
      commitSha,
      token,
      fetchImpl: async () => jsonResponse({
        success: false,
        errors: [{ code: 12000, message: 'not found' }],
        result: null,
      }),
    }),
    (error) => error instanceof CloudflareWorkersBuildsError
      && error.code === 'CF_WORKERS_BUILDS_CREATE_FAILED:API:12000',
  );
}

console.log(JSON.stringify({
  ok: true,
  contract: 'cloudflare-workers-builds-client-v1',
  exactCommitRequestPinned: true,
  buildUuidCaptured: true,
  commitMismatchFailsClosed: true,
  failedOutcomeFailsClosed: true,
  triggerIdentityVerified: true,
  workerIdentityVerified: true,
  pollingDeterministic: true,
  noLiveCloudflareRequest: true,
}, null, 2));
