import assert from 'node:assert/strict';
import {
  DEV_SYNC_RELEASE_STEPS,
  buildDevSyncReleaseSteps,
  runCloudflareSyncDevRelease,
} from './deploy-cloudflare-sync-dev.mjs';

const config = 'cloudflare/runtime/wrangler.sync.jsonc';
assert.equal(DEV_SYNC_RELEASE_STEPS.length, 3);
assert.deepEqual(DEV_SYNC_RELEASE_STEPS.map((step) => step.name), [
  'control-migrations',
  'store-migrations',
  'sync-worker-deploy',
]);
assert.deepEqual(DEV_SYNC_RELEASE_STEPS[0].args, [
  '--no-install', 'wrangler', 'd1', 'migrations', 'apply', 'ads-ops-control-dev',
  '--remote', '--env', 'dev', '--config', config,
]);
assert.deepEqual(DEV_SYNC_RELEASE_STEPS[1].args, [
  '--no-install', 'wrangler', 'd1', 'migrations', 'apply', 'ads-ops-store-dev',
  '--remote', '--env', 'dev', '--config', config,
]);
assert.deepEqual(DEV_SYNC_RELEASE_STEPS[2].args, [
  '--no-install', 'wrangler', 'deploy', '--strict', '--env', 'dev', '--config', config,
]);
assert(DEV_SYNC_RELEASE_STEPS.every((step) => step.command === 'npx'));
assert(DEV_SYNC_RELEASE_STEPS.every((step) => step.args.includes('dev')));
assert(DEV_SYNC_RELEASE_STEPS.every((step) => !step.args.includes('production')));

const buildSha = 'abcdef0123456789abcdef0123456789abcdef01';
const workerBuildSteps = buildDevSyncReleaseSteps({
  WORKERS_CI:'1',
  WORKERS_CI_COMMIT_SHA:buildSha.toUpperCase(),
});
assert.deepEqual(workerBuildSteps[2].args, [
  '--no-install', 'wrangler', 'deploy', '--strict', '--env', 'dev', '--config', config,
  '--tag', buildSha,
]);
assert.throws(
  () => buildDevSyncReleaseSteps({ WORKERS_CI:'1' }),
  /CF_SYNC_DEV_RELEASE_COMMIT_SHA_INVALID/,
);
assert.throws(
  () => buildDevSyncReleaseSteps({ WORKERS_CI:'1', WORKERS_CI_COMMIT_SHA:'not-a-sha' }),
  /CF_SYNC_DEV_RELEASE_COMMIT_SHA_INVALID/,
);

{
  const calls = [];
  runCloudflareSyncDevRelease({
    cwd:'/repo',
    env:{ CI:'true' },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status:0 };
    },
  });
  assert.equal(calls.length, 3);
  assert(calls[0].args.includes('d1') && calls[0].args.includes('apply'));
  assert(calls[1].args.includes('d1') && calls[1].args.includes('apply'));
  assert(calls[0].args.includes('ads-ops-control-dev'));
  assert(calls[1].args.includes('ads-ops-store-dev'));
  assert(calls[2].args.includes('deploy'));
  assert(calls[2].args.includes('--strict'));
  assert.equal(calls[2].args.includes('--tag'), false);
  assert(calls.every((call) => call.options.shell === false));
  assert(calls.every((call) => call.options.cwd === '/repo'));
}

{
  const calls = [];
  runCloudflareSyncDevRelease({
    cwd:'/repo',
    env:{ WORKERS_CI:'1', WORKERS_CI_COMMIT_SHA:buildSha },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status:0 };
    },
  });
  assert.equal(calls.length, 3);
  const deploy = calls[2].args;
  assert.equal(deploy[deploy.indexOf('--tag') + 1], buildSha);
  assert(deploy.includes('--strict'));
}

{
  let calls = 0;
  assert.throws(
    () => runCloudflareSyncDevRelease({
      spawn() {
        calls += 1;
        return { status:17 };
      },
    }),
    /CF_SYNC_DEV_RELEASE_STEP_FAILED:control-migrations:17/,
  );
  assert.equal(calls, 1, 'deploy must stop immediately when Control D1 migration fails');
}

{
  const calls = [];
  assert.throws(
    () => runCloudflareSyncDevRelease({
      spawn(command, args) {
        calls.push({ command, args });
        return { status:calls.length === 2 ? 23 : 0 };
      },
    }),
    /CF_SYNC_DEV_RELEASE_STEP_FAILED:store-migrations:23/,
  );
  assert.equal(calls.length, 2, 'Worker deploy must not run when Store D1 migration fails');
  assert.equal(calls.some((call) => call.args.includes('deploy')), false);
}

console.log('Cloudflare Sync Dev migration-gated deploy tests: PASS');
