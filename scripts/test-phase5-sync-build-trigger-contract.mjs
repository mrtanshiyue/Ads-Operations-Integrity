import assert from 'node:assert/strict';
import {
  CloudflareSyncDevBuildError,
  DEFAULT_SYNC_DEV_BUILD_TRIGGER_UUID,
  DEFAULT_SYNC_DEV_SCRIPT_TAG,
  runCloudflareSyncDevExactBuild,
} from './trigger-cloudflare-sync-dev-build.mjs';

const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BUILD_UUID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '19cd528b5c32e8da423da3cf66a9f05d';

function response(status, payload) {
  return {
    ok:status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function successfulBuild(status = 'stopped', { source = 'manual', branch = '' } = {}) {
  return {
    build_uuid:BUILD_UUID,
    status,
    build_outcome:status === 'stopped' ? 'success' : null,
    trigger:{
      trigger_uuid:DEFAULT_SYNC_DEV_BUILD_TRIGGER_UUID,
      external_script_id:DEFAULT_SYNC_DEV_SCRIPT_TAG,
    },
    build_trigger_metadata:{
      build_trigger_source:source,
      branch,
      commit_hash:COMMIT,
    },
  };
}

function buildFetch({ source = 'manual', branch = '' } = {}) {
  let buildReads = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url:String(url), options });
    if (String(url).includes('/git/ref/heads/main')) {
      return response(200, { object:{ sha:COMMIT } });
    }
    if (String(url).includes(`/commits/${COMMIT}/check-runs`)) {
      return response(200, {
        check_runs:[{
          id:123,
          name:'Static site and security invariants',
          status:'completed',
          conclusion:'success',
        }],
      });
    }
    if (String(url).includes(`/builds/triggers/${DEFAULT_SYNC_DEV_BUILD_TRIGGER_UUID}/builds`)) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { commit_hash:COMMIT });
      return response(200, { success:true, errors:[], messages:[], result:{ build_uuid:BUILD_UUID } });
    }
    if (String(url).includes(`/builds/builds/${BUILD_UUID}`)) {
      buildReads += 1;
      return response(200, {
        success:true,
        errors:[],
        messages:[],
        result:successfulBuild(buildReads === 1 ? 'running' : 'stopped', { source, branch }),
      });
    }
    throw new Error(`unexpected_url:${String(url)}`);
  };
  return { fetchImpl, calls, getBuildReads:() => buildReads };
}

async function testExactBuildSuccess() {
  const harness = buildFetch();
  const result = await runCloudflareSyncDevExactBuild({
    commitSha:COMMIT,
    env:{ CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID, CLOUDFLARE_API_TOKEN:'test-token' },
    fetchImpl:harness.fetchImpl,
    attempts:3,
    delayMs:0,
    sleep:async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.commitSha, COMMIT);
  assert.equal(result.buildUuid, BUILD_UUID);
  assert.equal(result.buildOutcome, 'success');
  assert.equal(result.source, 'manual');
  assert.equal(harness.getBuildReads(), 2);
  assert.ok(harness.calls.some((call) => call.url.includes('/check-runs')));
}

async function testMainMismatchFailsClosed() {
  const fetchImpl = async (url) => {
    if (String(url).includes('/git/ref/heads/main')) {
      return response(200, { object:{ sha:OTHER_COMMIT } });
    }
    throw new Error(`unexpected_url:${String(url)}`);
  };

  await assert.rejects(
    () => runCloudflareSyncDevExactBuild({
      commitSha:COMMIT,
      env:{ CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID, CLOUDFLARE_API_TOKEN:'test-token' },
      fetchImpl,
      attempts:1,
      delayMs:0,
    }),
    (error) => error instanceof CloudflareSyncDevBuildError
      && error.code === `CF_SYNC_DEV_BUILD_SHA_NOT_MAIN:${OTHER_COMMIT}:${COMMIT}`,
  );
}

async function testCanonicalCiRequired() {
  const fetchImpl = async (url) => {
    if (String(url).includes('/git/ref/heads/main')) {
      return response(200, { object:{ sha:COMMIT } });
    }
    if (String(url).includes('/check-runs')) {
      return response(200, {
        check_runs:[{
          id:999,
          name:'Static site and security invariants',
          status:'completed',
          conclusion:'failure',
        }],
      });
    }
    throw new Error(`unexpected_url:${String(url)}`);
  };

  await assert.rejects(
    () => runCloudflareSyncDevExactBuild({
      commitSha:COMMIT,
      env:{ CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID, CLOUDFLARE_API_TOKEN:'test-token' },
      fetchImpl,
      attempts:1,
      delayMs:0,
    }),
    (error) => error instanceof CloudflareSyncDevBuildError
      && error.code === 'CF_SYNC_DEV_CANONICAL_CI_NOT_SUCCESS:completed:failure',
  );
}

async function testBuildRejectsPushSource() {
  const harness = buildFetch({ source:'push_event' });
  await assert.rejects(
    () => runCloudflareSyncDevExactBuild({
      commitSha:COMMIT,
      env:{ CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID, CLOUDFLARE_API_TOKEN:'test-token' },
      fetchImpl:harness.fetchImpl,
      attempts:3,
      delayMs:0,
      sleep:async () => {},
    }),
    (error) => error instanceof CloudflareSyncDevBuildError
      && error.code === 'CF_SYNC_DEV_BUILD_SOURCE_NOT_MANUAL',
  );
}

async function testBuildRejectsBranchAuthority() {
  const harness = buildFetch({ branch:'phase5-store01-live-read' });
  await assert.rejects(
    () => runCloudflareSyncDevExactBuild({
      commitSha:COMMIT,
      env:{ CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID, CLOUDFLARE_API_TOKEN:'test-token' },
      fetchImpl:harness.fetchImpl,
      attempts:3,
      delayMs:0,
      sleep:async () => {},
    }),
    (error) => error instanceof CloudflareSyncDevBuildError
      && error.code === 'CF_SYNC_DEV_BUILD_BRANCH_NOT_EMPTY',
  );
}

await testExactBuildSuccess();
await testMainMismatchFailsClosed();
await testCanonicalCiRequired();
await testBuildRejectsPushSource();
await testBuildRejectsBranchAuthority();
await import('./test-phase5-web-build-trigger-contract.mjs');

console.log('phase5 sync + web build trigger contracts: PASS');
