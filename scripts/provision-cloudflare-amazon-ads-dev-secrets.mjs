import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCloudflareSyncDevRelease } from './deploy-cloudflare-sync-dev.mjs';
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
  const release = options.release ?? runCloudflareSyncDevRelease;
  const credentialSmoke = options.credentialSmoke ?? runCloudflareAmazonAdsCredentialSmoke;

  // Fail closed before changing secrets unless the currently served Dev worker is known disabled.
  await smoke({
    url:healthUrl,
    expectedCommit:commitSha,
    cwd,
    attempts:options.smokeAttempts,
    delayMs:options.smokeDelayMs,
    timeoutMs:options.smokeTimeoutMs,
  });

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

  // Secret updates must never be the final deployment authority. Re-run the existing
  // migration-gated release and tag the resulting Worker version with the exact Git commit.
  release({
    spawn,
    cwd,
    env:childEnv,
    commitSha,
  });

  // After the tagged redeploy, require the exact commit rather than merely an equivalent
  // ancestor. This proves secret provisioning did not leave an untagged secret-only version live.
  const postflight = await smoke({
    url:healthUrl,
    expectedCommit:commitSha,
    cwd,
    attempts:options.smokeAttempts,
    delayMs:options.smokeDelayMs,
    timeoutMs:options.smokeTimeoutMs,
    deploymentEquivalent:async () => false,
  });
  if (postflight?.deploymentExact !== true) {
    throw new AmazonAdsDevSecretProvisionError('AMAZON_ADS_DEV_POSTFLIGHT_NOT_EXACT');
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
