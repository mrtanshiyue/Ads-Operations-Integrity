import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCloudflareSyncDevExactBuild } from './trigger-cloudflare-sync-dev-build.mjs';
import { runCloudflareAmazonAdsCredentialSmoke } from './smoke-cloudflare-amazon-ads-credentials-dev.mjs';
import { waitForCloudflareSyncDevHealth } from './smoke-cloudflare-sync-dev.mjs';

const SYNC_CONFIG = 'cloudflare/runtime/wrangler.sync.jsonc';
const DEFAULT_HEALTH_URL = 'https://ads-operations-sync-dev.tanshiyuesir.workers.dev/health';
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const AMAZON_ADS_DEV_SECRET_NAMES = Object.freeze([
  'AMAZON_ADS_CLIENT_ID',
  'AMAZON_ADS_CLIENT_SECRET',
  'AMAZON_ADS_REFRESH_TOKEN',
]);

export class AmazonAdsDevSecretProvisionError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'AmazonAdsDevSecretProvisionError';
    this.code = code;
    this.cause = cause;
  }
}

export function buildAmazonAdsDevSecretPayload(env = {}) {
  const payload = {};
  for (const name of AMAZON_ADS_DEV_SECRET_NAMES) {
    const value = env?.[name];
    if (typeof value !== 'string' || !value.trim()) {
      throw new AmazonAdsDevSecretProvisionError(`AMAZON_ADS_DEV_SECRET_REQUIRED:${name}`);
    }
    payload[name] = value;
  }
  return Object.freeze(payload);
}

export function sanitizeAmazonAdsDevProvisionEnv(env = {}) {
  const result = { ...env };
  for (const name of AMAZON_ADS_DEV_SECRET_NAMES) delete result[name];
  return result;
}

export function parseAmazonAdsDevSecretList(stdout) {
  let entries;
  try {
    entries = JSON.parse(String(stdout ?? '').trim());
  } catch (error) {
    throw new AmazonAdsDevSecretProvisionError('AMAZON_ADS_DEV_SECRET_LIST_JSON_INVALID', error);
  }
  if (!Array.isArray(entries)) {
    throw new AmazonAdsDevSecretProvisionError('AMAZON_ADS_DEV_SECRET_LIST_INVALID');
  }
  const names = new Set(entries.map((entry) => String(entry?.name ?? '').trim()).filter(Boolean));
  const missing = AMAZON_ADS_DEV_SECRET_NAMES.filter((name) => !names.has(name));
  if (missing.length) {
    throw new AmazonAdsDevSecretProvisionError(
      `AMAZON_ADS_DEV_SECRET_LIST_MISSING:${missing.join(',')}`,
    );
  }
  return Object.freeze([...names].sort());
}

export function resolveCurrentGitCommit(options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const cwd = options.cwd ?? process.cwd();
  const result = spawn('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding:'utf8',
    stdio:['ignore', 'pipe', 'inherit'],
    shell:false,
  });
  if (result?.error) {
    throw new AmazonAdsDevSecretProvisionError('AMAZON_ADS_DEV_GIT_HEAD_FAILED', result.error);
  }
  if (result?.status !== 0) {
    throw new AmazonAdsDevSecretProvisionError(
      `AMAZON_ADS_DEV_GIT_HEAD_FAILED:${String(result?.status)}`,
    );
  }
  return requiredCommitSha(result.stdout, 'AMAZON_ADS_DEV_GIT_HEAD_INVALID');
}

export async function runAmazonAdsDevSecretProvision(options = {}) {
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? spawnSync;
  const cwd = options.cwd ?? process.cwd();
  const payload = buildAmazonAdsDevSecretPayload(env);
  const childEnv = sanitizeAmazonAdsDevProvisionEnv(env);
  const commitSha = options.commitSha
    ? requiredCommitSha(options.commitSha, 'AMAZON_ADS_DEV_COMMIT_SHA_INVALID')
    : resolveCurrentGitCommit({ spawn, cwd });
  const healthUrl = String(options.healthUrl ?? env.SYNC_DEV_HEALTH_URL ?? DEFAULT_HEALTH_URL).trim();
  const smoke = options.smoke ?? waitForCloudflareSyncDevHealth;
  const exactBuild = options.exactBuild ?? runCloudflareSyncDevExactBuild;
  const credentialSmoke = options.credentialSmoke ?? runCloudflareAmazonAdsCredentialSmoke;

  // Phase 5 starts from a canonical-main exact-SHA Sync Worker while Amazon execution is still
  // disabled. This prevents secret provisioning from relying on historical deployment equivalence.
  const prebuild = await exactBuild({
    commitSha,
    env:childEnv,
    fetchImpl:options.fetchImpl,
    sleep:options.sleep,
    attempts:options.buildAttempts,
    delayMs:options.buildDelayMs,
  });
  if (prebuild?.commitSha !== commitSha || prebuild?.buildOutcome !== 'success') {
    throw new AmazonAdsDevSecretProvisionError('AMAZON_ADS_DEV_PREBUILD_NOT_SUCCESS');
  }

  const preflight = await smoke({
    url:healthUrl,
    expectedCommit:commitSha,
    cwd,
    attempts:options.smokeAttempts,
    delayMs:options.smokeDelayMs,
    timeoutMs:options.smokeTimeoutMs,
    requireExact:true,
  });
  if (preflight?.deploymentExact !== true || preflight?.amazonAdsEnabled !== false) {
    throw new AmazonAdsDevSecretProvisionError('AMAZON_ADS_DEV_PREFLIGHT_NOT_EXACT_DISABLED');
  }

  const bulk = spawn('npx', [
    '--no-install', 'wrangler', 'secret', 'bulk',
    '--env', 'dev', '--config', SYNC_CONFIG,
  ], {
    cwd,
    env:childEnv,
    input:`${JSON.stringify(payload)}\n`,
    encoding:'utf8',
    stdio:['pipe', 'inherit', 'inherit'],
    shell:false,
  });
  assertCommandSucceeded(bulk, 'AMAZON_ADS_DEV_SECRET_BULK_FAILED');

  const listed = spawn('npx', [
    '--no-install', 'wrangler', 'secret', 'list', '--format', 'json',
    '--env', 'dev', '--config', SYNC_CONFIG,
  ], {
    cwd,
    env:childEnv,
    encoding:'utf8',
    stdio:['ignore', 'pipe', 'inherit'],
    shell:false,
  });
  assertCommandSucceeded(listed, 'AMAZON_ADS_DEV_SECRET_LIST_FAILED');
  const secretNames = parseAmazonAdsDevSecretList(listed.stdout);

  // Secret mutation can create/deploy a secret-only Worker version. It must never remain the
  // final deployment authority. Re-run the same canonical exact Git SHA through Workers Builds.
  const postbuild = await exactBuild({
    commitSha,
    env:childEnv,
    fetchImpl:options.fetchImpl,
    sleep:options.sleep,
    attempts:options.buildAttempts,
    delayMs:options.buildDelayMs,
  });
  if (postbuild?.commitSha !== commitSha || postbuild?.buildOutcome !== 'success') {
    throw new AmazonAdsDevSecretProvisionError('AMAZON_ADS_DEV_POSTBUILD_NOT_SUCCESS');
  }

  const postflight = await smoke({
    url:healthUrl,
    expectedCommit:commitSha,
    cwd,
    attempts:options.smokeAttempts,
    delayMs:options.smokeDelayMs,
    timeoutMs:options.smokeTimeoutMs,
    requireExact:true,
  });
  if (postflight?.deploymentExact !== true || postflight?.amazonAdsEnabled !== false) {
    throw new AmazonAdsDevSecretProvisionError('AMAZON_ADS_DEV_POSTFLIGHT_NOT_EXACT_DISABLED');
  }

  // Prove the real LWA credential set can refresh an access token while the execution kill
  // switch is still false. The smoke endpoint cannot Create/Poll/Download reports or touch D1/R2,
  // and the access token is discarded inside the Worker rather than returned to this process.
  const credentialPostflight = await credentialSmoke({
    refreshToken:payload.AMAZON_ADS_REFRESH_TOKEN,
    expectedCommit:commitSha,
    url:options.credentialSmokeUrl ?? env.SYNC_DEV_CREDENTIAL_SMOKE_URL,
    cwd,
    timeoutMs:options.credentialSmokeTimeoutMs,
  });
  if (credentialPostflight?.lwaTokenRefresh !== 'pass') {
    throw new AmazonAdsDevSecretProvisionError('AMAZON_ADS_DEV_CREDENTIAL_SMOKE_NOT_PASS');
  }

  return Object.freeze({
    ok:true,
    commitSha,
    secretNames,
    amazonAdsEnabled:false,
    prebuildUuid:prebuild.buildUuid ?? null,
    postbuildUuid:postbuild.buildUuid ?? null,
    runtimeVersionId:postflight.runtimeVersionId ?? null,
    lwaTokenRefresh:'pass',
  });
}

function assertCommandSucceeded(result, code) {
  if (result?.error) throw new AmazonAdsDevSecretProvisionError(code, result.error);
  if (result?.status !== 0) {
    throw new AmazonAdsDevSecretProvisionError(`${code}:${String(result?.status)}`);
  }
}

function requiredCommitSha(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(text)) throw new AmazonAdsDevSecretProvisionError(code);
  return text;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await runAmazonAdsDevSecretProvision();
  console.log(JSON.stringify(result, null, 2));
}
