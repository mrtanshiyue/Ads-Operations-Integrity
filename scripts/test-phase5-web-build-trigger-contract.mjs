import assert from 'node:assert/strict';
import {
  CloudflareWebDevBuildError,
  runCloudflareWebDevExactBuild,
} from './trigger-cloudflare-web-dev-build.mjs';

const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BUILD_UUID = '11111111-1111-4111-8111-111111111111';
const TRIGGER_UUID = '22222222-2222-4222-8222-222222222222';
const SCRIPT_TAG = '33333333333333333333333333333333';
const OTHER_SCRIPT_TAG = '44444444444444444444444444444444';
const ACCOUNT_ID = '19cd528b5c32e8da423da3cf66a9f05d';

function response(status, payload) {
  return {
    ok:status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function successfulBuild(status = 'stopped', { source = 'manual', branch = '', scriptTag = SCRIPT_TAG } = {}) {
  return {
    build_uuid:BUILD_UUID,
    status,
    build_outcome:status === 'stopped' ? 'success' : null,
    trigger:{
      trigger_uuid:TRIGGER_UUID,
      external_script_id:scriptTag,
    },
    build_trigger_metadata:{
      build_trigger_source:source,
      branch,
      commit_hash:COMMIT,
    },
  };
}

function buildFetch({
  mainSha = COMMIT,
  checkConclusion = 'success',
  source = 'manual',
  branch = '',
  scriptTag = SCRIPT_TAG,
} = {}) {
  const calls = [];
  let buildReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const text = String(url);
    calls.push({ url:text, options });
    if (text.includes('/git/ref/heads/main')) {
      return response(200, { object:{ sha:mainSha } });
    }
    if (text.includes(`/commits/${COMMIT}/check-runs`)) {
      return response(200, {
        check_runs:[{
          id:123,
          name:'Static site and security invariants',
          status:'completed',
          conclusion:checkConclusion,
        }],
      });
    }
    if (text.includes(`/builds/triggers/${TRIGGER_UUID}/builds`)) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { commit_hash:COMMIT });
      return response(200, {
        success:true,
        errors:[],
        messages:[],
        result:{ build_uuid:BUILD_UUID },
      });
    }
    if (text.includes(`/builds/builds/${BUILD_UUID}`)) {
      buildReads += 1;
      return response(200, {
        success:true,
        errors:[],
        messages:[],
        result:successfulBuild(buildReads === 1 ? 'running' : 'stopped', { source, branch, scriptTag }),
      });
    }
    throw new Error(`unexpected_url:${text}`);
  };
  return { fetchImpl, calls, getBuildReads:() => buildReads };
}

function options(fetchImpl) {
  return {
    commitSha:COMMIT,
    env:{
      CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN:'test-token',
      CF_WEB_DEV_BUILD_TRIGGER_UUID:TRIGGER_UUID,
      CF_WEB_DEV_SCRIPT_TAG:SCRIPT_TAG,
    },
    fetchImpl,
    attempts:3,
    delayMs:0,
    sleep:async () => {},
  };
}

{
  let fetchCalls = 0;
  await assert.rejects(
    () => runCloudflareWebDevExactBuild({
      commitSha:COMMIT,
      env:{ CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID, CLOUDFLARE_API_TOKEN:'test-token' },
      fetchImpl:async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    }),
    (error) => error instanceof CloudflareWebDevBuildError
      && error.code === 'CF_WEB_DEV_BUILD_TRIGGER_UUID_REQUIRED',
  );
  assert.equal(fetchCalls, 0);
}

{
  let fetchCalls = 0;
  await assert.rejects(
    () => runCloudflareWebDevExactBuild({
      commitSha:COMMIT,
      env:{
        CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN:'test-token',
        CF_WEB_DEV_BUILD_TRIGGER_UUID:TRIGGER_UUID,
      },
      fetchImpl:async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    }),
    (error) => error instanceof CloudflareWebDevBuildError
      && error.code === 'CF_WEB_DEV_SCRIPT_TAG_REQUIRED',
  );
  assert.equal(fetchCalls, 0);
}

{
  const harness = buildFetch();
  const result = await runCloudflareWebDevExactBuild(options(harness.fetchImpl));
  assert.equal(result.ok, true);
  assert.equal(result.commitSha, COMMIT);
  assert.equal(result.buildUuid, BUILD_UUID);
  assert.equal(result.triggerUuid, TRIGGER_UUID);
  assert.equal(result.scriptTag, SCRIPT_TAG);
  assert.equal(result.buildOutcome, 'success');
  assert.equal(result.source, 'manual');
  assert.equal(harness.getBuildReads(), 2);
  assert.ok(harness.calls.some((call) => call.url.includes('/check-runs')));
}

{
  const harness = buildFetch({ mainSha:OTHER_COMMIT });
  await assert.rejects(
    () => runCloudflareWebDevExactBuild(options(harness.fetchImpl)),
    (error) => error instanceof CloudflareWebDevBuildError
      && error.code === `CF_WEB_DEV_MAIN_POLICY_FAILED:CF_SYNC_DEV_BUILD_SHA_NOT_MAIN:${OTHER_COMMIT}:${COMMIT}`,
  );
  assert.equal(harness.calls.some((call) => call.url.includes('/builds/triggers/')), false);
}

{
  const harness = buildFetch({ checkConclusion:'failure' });
  await assert.rejects(
    () => runCloudflareWebDevExactBuild(options(harness.fetchImpl)),
    (error) => error instanceof CloudflareWebDevBuildError
      && error.code === 'CF_WEB_DEV_MAIN_POLICY_FAILED:CF_SYNC_DEV_CANONICAL_CI_NOT_SUCCESS:completed:failure',
  );
  assert.equal(harness.calls.some((call) => call.url.includes('/builds/triggers/')), false);
}

{
  const harness = buildFetch({ source:'push_event' });
  await assert.rejects(
    () => runCloudflareWebDevExactBuild(options(harness.fetchImpl)),
    (error) => error instanceof CloudflareWebDevBuildError
      && error.code === 'CF_WEB_DEV_BUILD_SOURCE_NOT_MANUAL',
  );
}

{
  const harness = buildFetch({ branch:'phase5-web-exact-main-build' });
  await assert.rejects(
    () => runCloudflareWebDevExactBuild(options(harness.fetchImpl)),
    (error) => error instanceof CloudflareWebDevBuildError
      && error.code === 'CF_WEB_DEV_BUILD_BRANCH_NOT_EMPTY',
  );
}

{
  const harness = buildFetch({ scriptTag:OTHER_SCRIPT_TAG });
  await assert.rejects(
    () => runCloudflareWebDevExactBuild(options(harness.fetchImpl)),
    (error) => error instanceof CloudflareWebDevBuildError
      && error.code === `CF_WEB_DEV_BUILD_CLIENT_FAILED:CF_WORKERS_BUILDS_WORKER_MISMATCH:${OTHER_SCRIPT_TAG}:${SCRIPT_TAG}`,
  );
}

console.log(JSON.stringify({
  ok:true,
  contract:'phase5-web-dev-exact-main-build-v1',
  liveIdentityRequired:true,
  historicalIdentityHardcoded:false,
  exactMainRequired:true,
  canonicalCiRequired:true,
  manualBranchlessRequired:true,
  workerIdentityRequired:true,
}, null, 2));
