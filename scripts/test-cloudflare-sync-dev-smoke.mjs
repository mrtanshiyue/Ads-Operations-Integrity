import assert from 'node:assert/strict';
import {
  CloudflareSyncDevSmokeError,
  DEPLOYMENT_EQUIVALENCE_PATHS,
  fetchCloudflareSyncDevHealth,
  isGitDeploymentEquivalent,
  validateCloudflareSyncDevHealth,
  waitForCloudflareSyncDevHealth,
} from './smoke-cloudflare-sync-dev.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const staleSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const validHealth = Object.freeze({
  ok:true,
  service:'ads-operations-sync',
  environment:'development',
  amazonAdsEnabled:false,
  runtimeVersion:Object.freeze({
    id:'version-123',
    tag:sha,
    timestamp:'2026-08-16T00:00:00.000Z',
  }),
  dependencies:Object.freeze({
    controlDb:true,
    dataBucket:true,
    storeDatabases:1,
    workflow:true,
  }),
});

assert.deepEqual(validateCloudflareSyncDevHealth(validHealth, sha.toUpperCase()), {
  ok:true,
  expectedCommit:sha,
  runtimeVersionId:'version-123',
  runtimeVersionTag:sha,
  runtimeVersionTimestamp:'2026-08-16T00:00:00.000Z',
  deploymentExact:true,
  amazonAdsEnabled:false,
  storeDatabases:1,
});

const staleValidated = validateCloudflareSyncDevHealth({
  ...validHealth,
  runtimeVersion:{ ...validHealth.runtimeVersion, tag:staleSha },
}, sha);
assert.equal(staleValidated.deploymentExact, false);
assert.equal(staleValidated.runtimeVersionTag, staleSha);

assert.throws(
  () => validateCloudflareSyncDevHealth({ ...validHealth, amazonAdsEnabled:true }, sha),
  (error) => error instanceof CloudflareSyncDevSmokeError
    && error.code === 'CF_SYNC_DEV_KILL_SWITCH_NOT_DISABLED'
    && error.retryable === false,
);
assert.throws(
  () => validateCloudflareSyncDevHealth({
    ...validHealth,
    dependencies:{ ...validHealth.dependencies, workflow:false },
    runtimeVersion:{ ...validHealth.runtimeVersion, tag:staleSha },
  }, sha),
  /CF_SYNC_DEV_WORKFLOW_MISSING/,
  'binding validation must happen before deployment equivalence',
);
assert.throws(
  () => validateCloudflareSyncDevHealth({
    ...validHealth,
    runtimeVersion:{ ...validHealth.runtimeVersion, tag:'not-a-commit' },
  }, sha),
  /CF_SYNC_DEV_RUNTIME_VERSION_TAG_INVALID/,
);

assert(DEPLOYMENT_EQUIVALENCE_PATHS.includes('cloudflare/runtime'));
assert(DEPLOYMENT_EQUIVALENCE_PATHS.includes('cloudflare/foundation/migrations'));
assert(DEPLOYMENT_EQUIVALENCE_PATHS.includes('scripts/deploy-cloudflare-sync-dev.mjs'));
assert(DEPLOYMENT_EQUIVALENCE_PATHS.includes('package.json'));

{
  const calls = [];
  const equivalent = isGitDeploymentEquivalent({
    deployedCommit:staleSha,
    expectedCommit:sha,
    cwd:'/repo',
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status:0 };
    },
  });
  assert.equal(equivalent, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['merge-base', '--is-ancestor', staleSha, sha]);
  assert.deepEqual(calls[1].args.slice(0, 5), ['diff', '--quiet', staleSha, sha, '--']);
  for (const path of DEPLOYMENT_EQUIVALENCE_PATHS) assert(calls[1].args.includes(path));
  assert(calls.every((call) => call.command === 'git'));
  assert(calls.every((call) => call.options.shell === false));
}

{
  let calls = 0;
  const equivalent = isGitDeploymentEquivalent({
    deployedCommit:staleSha,
    expectedCommit:sha,
    spawn() {
      calls += 1;
      return { status:calls === 1 ? 1 : 0 };
    },
  });
  assert.equal(equivalent, false);
  assert.equal(calls, 1, 'non-ancestor deployment must not reach diff check');
}

{
  let calls = 0;
  const equivalent = isGitDeploymentEquivalent({
    deployedCommit:staleSha,
    expectedCommit:sha,
    spawn() {
      calls += 1;
      return { status:calls === 2 ? 1 : 0 };
    },
  });
  assert.equal(equivalent, false);
  assert.equal(calls, 2);
}

{
  const calls = [];
  const result = await fetchCloudflareSyncDevHealth({
    url:'https://sync.example.workers.dev/health',
    expectedCommit:sha,
    fetchImpl:async (url, init) => {
      calls.push({ url:String(url), init });
      return new Response(JSON.stringify(validHealth), {
        status:200,
        headers:{ 'content-type':'application/json' },
      });
    },
    timeoutMs:1000,
  });
  assert.equal(result.runtimeVersionTag, sha);
  assert.equal(result.deploymentExact, true);
  assert.equal(result.deploymentEquivalent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /expected_sha=/);
  assert.equal(calls[0].init.method, 'GET');
}

{
  let equivalenceCalls = 0;
  const result = await fetchCloudflareSyncDevHealth({
    url:'https://sync.example.workers.dev/health',
    expectedCommit:sha,
    fetchImpl:async () => new Response(JSON.stringify({
      ...validHealth,
      runtimeVersion:{ ...validHealth.runtimeVersion, tag:staleSha },
    }), { status:200 }),
    deploymentEquivalent:async ({ deployedCommit, expectedCommit }) => {
      equivalenceCalls += 1;
      assert.equal(deployedCommit, staleSha);
      assert.equal(expectedCommit, sha);
      return true;
    },
    timeoutMs:1000,
  });
  assert.equal(equivalenceCalls, 1);
  assert.equal(result.deploymentExact, false);
  assert.equal(result.deploymentEquivalent, true);
  assert.equal(result.runtimeVersionTag, staleSha);
}

{
  let fetchCalls = 0;
  let sleeps = 0;
  const result = await waitForCloudflareSyncDevHealth({
    url:'https://sync.example.workers.dev/health',
    expectedCommit:sha,
    attempts:3,
    delayMs:0,
    timeoutMs:1000,
    sleep:async () => { sleeps += 1; },
    fetchImpl:async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        ...validHealth,
        runtimeVersion:{ ...validHealth.runtimeVersion, tag:fetchCalls < 3 ? staleSha : sha },
      }), { status:200 });
    },
    deploymentEquivalent:async () => false,
  });
  assert.equal(result.attempt, 3);
  assert.equal(fetchCalls, 3);
  assert.equal(sleeps, 2);
  assert.equal(result.deploymentExact, true);
}

{
  let fetchCalls = 0;
  await assert.rejects(
    () => waitForCloudflareSyncDevHealth({
      url:'https://sync.example.workers.dev/health',
      expectedCommit:sha,
      attempts:3,
      delayMs:0,
      timeoutMs:1000,
      sleep:async () => {},
      fetchImpl:async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ ...validHealth, amazonAdsEnabled:true }), { status:200 });
      },
    }),
    (error) => error instanceof CloudflareSyncDevSmokeError
      && error.code === 'CF_SYNC_DEV_KILL_SWITCH_NOT_DISABLED'
      && error.retryable === false,
  );
  assert.equal(fetchCalls, 1, 'kill-switch violation must fail immediately without retry');
}

console.log('Cloudflare Sync Dev disabled health smoke tests: PASS');
