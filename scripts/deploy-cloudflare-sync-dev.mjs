import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SYNC_CONFIG = 'cloudflare/runtime/wrangler.sync.jsonc';
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function buildDevSyncReleaseSteps(env = {}) {
  const workerBuild = String(env?.WORKERS_CI ?? '').trim() === '1';
  const commitSha = String(env?.WORKERS_CI_COMMIT_SHA ?? '').trim().toLowerCase();
  if (workerBuild && !GIT_SHA_PATTERN.test(commitSha)) {
    throw new Error('CF_SYNC_DEV_RELEASE_COMMIT_SHA_INVALID');
  }

  const deployArgs = [
    '--no-install', 'wrangler', 'deploy', '--strict', '--env', 'dev', '--config', SYNC_CONFIG,
  ];
  if (workerBuild) deployArgs.push('--tag', commitSha);

  return Object.freeze([
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
      args:Object.freeze(deployArgs),
    }),
  ]);
}

export const DEV_SYNC_RELEASE_STEPS = buildDevSyncReleaseSteps();

export function runCloudflareSyncDevRelease(options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const steps = buildDevSyncReleaseSteps(env);

  for (const step of steps) {
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
