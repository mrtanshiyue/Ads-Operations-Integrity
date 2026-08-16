import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS,
  AMAZON_ADS_CREDENTIAL_SMOKE_PATH,
  buildAmazonAdsCredentialSmokeMessage,
} from '../cloudflare/runtime/amazon-ads-credential-smoke.js';

const DEFAULT_ORIGIN = 'https://ads-operations-sync-dev.tanshiyuesir.workers.dev';
const DEFAULT_TIMEOUT_MS = 15_000;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export class CloudflareAmazonAdsCredentialSmokeError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareAmazonAdsCredentialSmokeError';
    this.code = code;
    this.cause = cause;
  }
}

export function buildAmazonAdsCredentialSmokeProof({ refreshToken, tag, timestamp }) {
  const secret = requiredSecret(refreshToken, 'AMAZON_ADS_CREDENTIAL_SMOKE_REFRESH_TOKEN_REQUIRED');
  const message = buildAmazonAdsCredentialSmokeMessage({ tag, timestamp });
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function resolveCredentialSmokeGitCommit(options = {}) {
  if (options.expectedCommit) {
    return requiredCommitSha(options.expectedCommit, 'AMAZON_ADS_CREDENTIAL_SMOKE_COMMIT_INVALID');
  }
  const spawn = options.spawn ?? spawnSync;
  const cwd = options.cwd ?? process.cwd();
  const result = spawn('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding:'utf8',
    stdio:['ignore', 'pipe', 'inherit'],
    shell:false,
  });
  if (result?.error || result?.status !== 0) {
    throw new CloudflareAmazonAdsCredentialSmokeError(
      'AMAZON_ADS_CREDENTIAL_SMOKE_GIT_HEAD_FAILED',
      result?.error ?? null,
    );
  }
  return requiredCommitSha(result.stdout, 'AMAZON_ADS_CREDENTIAL_SMOKE_COMMIT_INVALID');
}

export async function runCloudflareAmazonAdsCredentialSmoke(options = {}) {
  const env = options.env ?? process.env;
  const refreshToken = requiredSecret(
    options.refreshToken ?? env.AMAZON_ADS_REFRESH_TOKEN,
    'AMAZON_ADS_CREDENTIAL_SMOKE_REFRESH_TOKEN_REQUIRED',
  );
  const expectedCommit = resolveCredentialSmokeGitCommit({
    expectedCommit:options.expectedCommit ?? env.EXPECTED_GIT_SHA,
    spawn:options.spawn,
    cwd:options.cwd,
  });
  const timestamp = Number(options.timestamp ?? Date.now());
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new CloudflareAmazonAdsCredentialSmokeError('AMAZON_ADS_CREDENTIAL_SMOKE_TIMESTAMP_INVALID');
  }
  const origin = String(options.origin ?? env.SYNC_DEV_ORIGIN ?? DEFAULT_ORIGIN).trim().replace(/\/+$/, '');
  const url = String(
    options.url ?? env.SYNC_DEV_CREDENTIAL_SMOKE_URL ?? `${origin}${AMAZON_ADS_CREDENTIAL_SMOKE_PATH}`,
  ).trim();
  const timeoutMs = positiveInteger(
    Number(options.timeoutMs ?? env.SYNC_DEV_CREDENTIAL_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    'AMAZON_ADS_CREDENTIAL_SMOKE_TIMEOUT_INVALID',
  );
  const proof = buildAmazonAdsCredentialSmokeProof({
    refreshToken,
    tag:expectedCommit,
    timestamp,
  });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new CloudflareAmazonAdsCredentialSmokeError('AMAZON_ADS_CREDENTIAL_SMOKE_FETCH_INVALID');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('credential_smoke_timeout'), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method:'POST',
      headers:{
        'accept':'application/json',
        [AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS.timestamp]:String(timestamp),
        [AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS.proof]:proof,
      },
      signal:controller.signal,
    });
  } catch (error) {
    throw new CloudflareAmazonAdsCredentialSmokeError('AMAZON_ADS_CREDENTIAL_SMOKE_REQUEST_FAILED', error);
  } finally {
    clearTimeout(timer);
  }

  const payload = await parseJson(response);
  if (!response.ok || payload?.ok !== true) {
    throw new CloudflareAmazonAdsCredentialSmokeError(
      `AMAZON_ADS_CREDENTIAL_SMOKE_FAILED:${response.status}:${String(payload?.errorCode ?? 'unknown')}`,
    );
  }
  if (payload.amazonAdsEnabled !== false) {
    throw new CloudflareAmazonAdsCredentialSmokeError('AMAZON_ADS_CREDENTIAL_SMOKE_KILL_SWITCH_INVALID');
  }
  if (String(payload?.runtimeVersion?.tag ?? '').toLowerCase() !== expectedCommit) {
    throw new CloudflareAmazonAdsCredentialSmokeError('AMAZON_ADS_CREDENTIAL_SMOKE_VERSION_MISMATCH');
  }
  if (payload?.credentialSmoke?.lwaTokenRefresh !== 'pass') {
    throw new CloudflareAmazonAdsCredentialSmokeError('AMAZON_ADS_CREDENTIAL_SMOKE_LWA_NOT_PASS');
  }
  const sideEffects = payload?.credentialSmoke?.sideEffects;
  if (!sideEffects || Object.values(sideEffects).some((value) => value !== false)) {
    throw new CloudflareAmazonAdsCredentialSmokeError(
      'AMAZON_ADS_CREDENTIAL_SMOKE_SIDE_EFFECT_CONTRACT_INVALID',
    );
  }

  return Object.freeze({
    ok:true,
    expectedCommit,
    runtimeVersionId:payload.runtimeVersion?.id ?? null,
    lwaTokenRefresh:'pass',
    amazonAdsEnabled:false,
    sideEffects:Object.freeze({ ...sideEffects }),
  });
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new CloudflareAmazonAdsCredentialSmokeError('AMAZON_ADS_CREDENTIAL_SMOKE_RESPONSE_INVALID', error);
  }
}

function requiredSecret(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CloudflareAmazonAdsCredentialSmokeError(code);
  return text;
}

function requiredCommitSha(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(text)) throw new CloudflareAmazonAdsCredentialSmokeError(code);
  return text;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CloudflareAmazonAdsCredentialSmokeError(code);
  }
  return value;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await runCloudflareAmazonAdsCredentialSmoke();
  console.log(JSON.stringify(result, null, 2));
}
