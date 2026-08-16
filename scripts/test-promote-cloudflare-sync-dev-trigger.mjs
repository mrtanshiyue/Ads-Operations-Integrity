import assert from 'node:assert/strict';
import {
  CLOUDFLARE_FOUNDATION_WORKFLOW,
  CLOUDFLARE_SYNC_DEV_SOURCE_BRANCH,
  CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH,
  CloudflareSyncDevPromotionError,
  promoteVerifiedCloudflareSyncDevTrigger,
  waitForFoundationSuccess,
} from './promote-cloudflare-sync-dev-trigger.mjs';

const repository = 'mrtanshiyue/Ads-Operations-Integrity';
const sha = '0123456789abcdef0123456789abcdef01234567';
const oldSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const apiUrl = 'https://api.github.test';
const token = 'github-test-token';

assert.equal(CLOUDFLARE_SYNC_DEV_SOURCE_BRANCH, 'cloudflare-foundation-v1');
assert.equal(CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH, '__manual_ci_gated_deploy__');
assert.equal(CLOUDFLARE_FOUNDATION_WORKFLOW, 'cloudflare-foundation-ci.yml');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers:{ 'content-type':'application/json' },
  });
}

{
  let polls = 0;
  let sleeps = 0;
  const result = await waitForFoundationSuccess({
    repository,
    sha,
    token,
    apiUrl,
    attempts:3,
    delayMs:0,
    sleep:async () => { sleeps += 1; },
    fetchImpl:async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.authorization, `Bearer ${token}`);
      assert.match(String(url), /cloudflare-foundation-ci\.yml\/runs/);
      polls += 1;
      return json({
        workflow_runs:[{
          id:77,
          head_sha:sha,
          status:polls === 1 ? 'in_progress' : 'completed',
          conclusion:polls === 1 ? null : 'success',
        }],
      });
    },
  });
  assert.deepEqual(result, { runId:77, attempt:2, attempts:3 });
  assert.equal(sleeps, 1);
}

{
  await assert.rejects(
    () => waitForFoundationSuccess({
      repository,
      sha,
      token,
      apiUrl,
      attempts:1,
      delayMs:0,
      sleep:async () => {},
      fetchImpl:async () => json({
        workflow_runs:[{
          id:88,
          head_sha:sha,
          status:'completed',
          conclusion:'failure',
        }],
      }),
    }),
    /CF_SYNC_DEV_PROMOTION_FOUNDATION_NOT_SUCCESS:failure/,
  );
}

{
  const calls = [];
  const result = await promoteVerifiedCloudflareSyncDevTrigger({
    repository,
    sha,
    token,
    apiUrl,
    attempts:1,
    delayMs:0,
    sleep:async () => {},
    fetchImpl:async (url, init) => {
      const target = String(url);
      calls.push({ target, init });
      if (target.includes(`/actions/workflows/${CLOUDFLARE_FOUNDATION_WORKFLOW}/runs`)) {
        return json({ workflow_runs:[{ id:99, head_sha:sha, status:'completed', conclusion:'success' }] });
      }
      if (target.endsWith(`/git/ref/heads/${CLOUDFLARE_SYNC_DEV_SOURCE_BRANCH}`)) {
        return json({ object:{ sha } });
      }
      if (target.endsWith(`/git/ref/heads/${CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH}`)) {
        return json({ object:{ sha:oldSha } });
      }
      if (target.endsWith(`/git/refs/heads/${CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH}`)) {
        assert.equal(init.method, 'PATCH');
        assert.deepEqual(JSON.parse(init.body), { sha, force:false });
        return json({ ref:`refs/heads/${CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH}`, object:{ sha } });
      }
      throw new Error(`unexpected request: ${target}`);
    },
  });
  assert.deepEqual(result, {
    ok:true,
    repository,
    sha,
    foundationRunId:99,
    triggerBranch:CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH,
    reused:false,
  });
  assert.equal(calls.length, 4);
}

{
  const result = await promoteVerifiedCloudflareSyncDevTrigger({
    repository,
    sha,
    token,
    apiUrl,
    attempts:1,
    delayMs:0,
    sleep:async () => {},
    fetchImpl:async (url) => {
      const target = String(url);
      if (target.includes('/actions/workflows/')) {
        return json({ workflow_runs:[{ id:100, head_sha:sha, status:'completed', conclusion:'success' }] });
      }
      if (target.endsWith(`/git/ref/heads/${CLOUDFLARE_SYNC_DEV_SOURCE_BRANCH}`)) {
        return json({ object:{ sha } });
      }
      if (target.endsWith(`/git/ref/heads/${CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH}`)) {
        return json({ message:'Not Found' }, 404);
      }
      if (target.endsWith('/git/refs')) {
        return json({ ref:`refs/heads/${CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH}`, object:{ sha } }, 201);
      }
      throw new Error(`unexpected request: ${target}`);
    },
  });
  assert.equal(result.reused, false);
}

{
  await assert.rejects(
    () => promoteVerifiedCloudflareSyncDevTrigger({
      repository,
      sha,
      token,
      apiUrl,
      attempts:1,
      delayMs:0,
      sleep:async () => {},
      fetchImpl:async (url) => {
        const target = String(url);
        if (target.includes('/actions/workflows/')) {
          return json({ workflow_runs:[{ id:101, head_sha:sha, status:'completed', conclusion:'success' }] });
        }
        if (target.endsWith(`/git/ref/heads/${CLOUDFLARE_SYNC_DEV_SOURCE_BRANCH}`)) {
          return json({ object:{ sha:oldSha } });
        }
        throw new Error(`unexpected request: ${target}`);
      },
    }),
    (error) => error instanceof CloudflareSyncDevPromotionError
      && error.code === `CF_SYNC_DEV_PROMOTION_SOURCE_MOVED:${oldSha}:${sha}`,
  );
}

console.log('Cloudflare Sync Dev CI promotion tests: PASS');
