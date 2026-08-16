import assert from 'node:assert/strict';
import {
  CloudflareSyncDevSmokeError,
  fetchCloudflareSyncDevHealth,
  validateCloudflareSyncDevHealth,
  waitForCloudflareSyncDevHealth,
} from './smoke-cloudflare-sync-dev.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
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
  amazonAdsEnabled:false,
  storeDatabases:1,
});

assert.throws(
  () => validateCloudflareSyncDevHealth({ ...validHealth, amazonAdsEnabled:true }, sha),
  (error) => error instanceof CloudflareSyncDevSmokeError
    && error.code === 'CF_SYNC_DEV_KILL_SWITCH_NOT_DISABLED'
    && error.retryable === false,
);
assert.throws(
  () => validateCloudflareSyncDevHealth({
    ...validHealth,
    runtimeVersion:{ ...validHealth.runtimeVersion, tag:'f'.repeat(40) },
  }, sha),
  /CF_SYNC_DEV_RUNTIME_TAG_MISMATCH/,
);
assert.throws(
  () => validateCloudflareSyncDevHealth({
    ...validHealth,
    dependencies:{ ...validHealth.dependencies, workflow:false },
  }, sha),
  /CF_SYNC_DEV_WORKFLOW_MISSING/,
);

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
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /expected_sha=/);
  assert.equal(calls[0].init.method, 'GET');
}

{
  let fetchCalls = 0;
  let sleeps = 0;
  const staleHealth = {
    ...validHealth,
    runtimeVersion:{ ...validHealth.runtimeVersion, tag:'a'.repeat(40) },
  };
  const result = await waitForCloudflareSyncDevHealth({
    url:'https://sync.example.workers.dev/health',
    expectedCommit:sha,
    attempts:3,
    delayMs:0,
    timeoutMs:1000,
    sleep:async () => { sleeps += 1; },
    fetchImpl:async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify(fetchCalls < 3 ? staleHealth : validHealth), { status:200 });
    },
  });
  assert.equal(result.attempt, 3);
  assert.equal(fetchCalls, 3);
  assert.equal(sleeps, 2);
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
