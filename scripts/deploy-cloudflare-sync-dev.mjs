import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SYNC_CONFIG = 'cloudflare/runtime/wrangler.sync.jsonc';

export const DEV_SYNC_RELEASE_STEPS = Object.freeze([
  Object.freeze({
    name:'control-migrations',
    command:'npx',
    args:Object.freeze([
      '--no-install', 'wrangler', 'd1', 'migrations', 'apply', 'ads-ops-control-dev',
      '--remote', '--env', 'dev', '--config', SYNC_CONFIG,
    ]),
  }),
  Object.freeze({
    name:'store-migrations',
    command:'npx',
    args:Object.freeze([
      '--no-install', 'wrangler', 'd1', 'migrations', 'apply', 'ads-ops-store-dev',
      '--remote', '--env', 'dev', '--config', SYNC_CONFIG,
    ]),
  }),
  Object.freeze({
    name:'sync-worker-deploy',
    command:'npx',
    args:Object.freeze([
      '--no-install', 'wrangler', 'deploy', '--env', 'dev', '--config', SYNC_CONFIG,
    ]),
  }),
]);

export function runCloudflareSyncDevRelease(options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  for (const step of DEV_SYNC_RELEASE_STEPS) {
    console.log(`[sync-dev-release] ${step.name}`);
    const result = spawn(step.command, [...step.args], {
      cwd,
      env,
      stdio:'inherit',
      shell:false,
    });
    if (result?.error) {
      const error = new Error(`CF_SYNC_DEV_RELEASE_STEP_ERROR:${step.name}`);
      error.cause = result.error;
      throw error;
    }
    if (result?.status !== 0) {
      throw new Error(`CF_SYNC_DEV_RELEASE_STEP_FAILED:${step.name}:${String(result?.status)}`);
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runCloudflareSyncDevRelease();
}
