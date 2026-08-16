import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DEFAULT_ATTEMPTS = 24;
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;

export class CloudflareSyncDevSmokeError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'CloudflareSyncDevSmokeError';
    this.code = code;
    this.retryable = options.retryable !== false;
    this.cause = options.cause ?? null;
  }
}

export function validateCloudflareSyncDevHealth(payload, expectedCommit) {
  const expected = requiredCommitSha(expectedCommit);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_HEALTH_BODY_INVALID');
  }
  if (payload.amazonAdsEnabled !== false) {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_KILL_SWITCH_NOT_DISABLED', { retryable:false });
  }
  if (payload.ok !== true) throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_HEALTH_NOT_OK');
  if (payload.service !== 'ads-operations-sync') {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_SERVICE_MISMATCH');
  }
  if (payload.environment !== 'development') {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_ENVIRONMENT_MISMATCH');
  }

  const version = payload.runtimeVersion;
  if (!version || typeof version !== 'object' || Array.isArray(version)) {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_RUNTIME_VERSION_MISSING');
  }
  const versionId = requiredText(version.id, 'CF_SYNC_DEV_RUNTIME_VERSION_ID_MISSING');
  const versionTag = requiredText(version.tag, 'CF_SYNC_DEV_RUNTIME_VERSION_TAG_MISSING').toLowerCase();
  if (versionTag !== expected) {
    throw new CloudflareSyncDevSmokeError(`CF_SYNC_DEV_RUNTIME_TAG_MISMATCH:${versionTag}:${expected}`);
  }

  const dependencies = payload.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_DEPENDENCIES_MISSING');
  }
  if (dependencies.controlDb !== true) throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_CONTROL_DB_MISSING');
  if (dependencies.dataBucket !== true) throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_DATA_BUCKET_MISSING');
  if (dependencies.workflow !== true) throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_WORKFLOW_MISSING');
  if (!Number.isSafeInteger(dependencies.storeDatabases) || dependencies.storeDatabases < 1) {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_STORE_DB_MISSING');
  }

  return Object.freeze({
    ok:true,
    expectedCommit:expected,
    runtimeVersionId:versionId,
    runtimeVersionTag:versionTag,
    runtimeVersionTimestamp:version.timestamp == null ? null : String(version.timestamp),
    amazonAdsEnabled:false,
    storeDatabases:dependencies.storeDatabases,
  });
}

export async function fetchCloudflareSyncDevHealth(options = {}) {
  const url = requiredHealthUrl(options.url);
  const expectedCommit = requiredCommitSha(options.expectedCommit);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== 'function') {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_FETCH_INVALID', { retryable:false });
  }
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'CF_SYNC_DEV_TIMEOUT_INVALID');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('expected_sha', expectedCommit);
    requestUrl.searchParams.set('smoke_nonce', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    response = await fetchImpl(requestUrl, {
      method:'GET',
      headers:{ accept:'application/json' },
      cache:'no-store',
      signal:controller.signal,
    });
  } catch (error) {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_HEALTH_FETCH_FAILED', { cause:error });
  } finally {
    clearTimeout(timeout);
  }

  if (!response || typeof response.text !== 'function') {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_HEALTH_RESPONSE_INVALID');
  }
  if (!response.ok) {
    const status = Number(response.status || 0);
    const retryable = status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
    throw new CloudflareSyncDevSmokeError(`CF_SYNC_DEV_HEALTH_HTTP_${status || 'UNKNOWN'}`, { retryable });
  }

  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch (error) {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_HEALTH_JSON_INVALID', { cause:error });
  }
  return validateCloudflareSyncDevHealth(payload, expectedCommit);
}

export async function waitForCloudflareSyncDevHealth(options = {}) {
  const attempts = positiveInteger(options.attempts ?? DEFAULT_ATTEMPTS, 'CF_SYNC_DEV_ATTEMPTS_INVALID');
  const delayMs = nonNegativeInteger(options.delayMs ?? DEFAULT_DELAY_MS, 'CF_SYNC_DEV_DELAY_INVALID');
  const sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fetchCloudflareSyncDevHealth(options);
      return Object.freeze({ ...result, attempt, attempts });
    } catch (error) {
      lastError = error;
      if (!(error instanceof CloudflareSyncDevSmokeError) || error.retryable === false || attempt === attempts) {
        throw error;
      }
      console.log(`[sync-dev-smoke] attempt ${attempt}/${attempts} waiting for exact deployment: ${error.code}`);
      await sleep(delayMs);
    }
  }
  throw lastError || new CloudflareSyncDevSmokeError('CF_SYNC_DEV_SMOKE_EXHAUSTED');
}

function requiredHealthUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch (error) {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_HEALTH_URL_INVALID', { retryable:false, cause:error });
  }
  if (url.protocol !== 'https:' || url.pathname !== '/health') {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_HEALTH_URL_INVALID', { retryable:false });
  }
  return url.toString();
}

function requiredCommitSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(sha)) {
    throw new CloudflareSyncDevSmokeError('CF_SYNC_DEV_EXPECTED_SHA_INVALID', { retryable:false });
  }
  return sha;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CloudflareSyncDevSmokeError(code);
  return text;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new CloudflareSyncDevSmokeError(code, { retryable:false });
  }
  return number;
}

function nonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CloudflareSyncDevSmokeError(code, { retryable:false });
  }
  return number;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await waitForCloudflareSyncDevHealth({
    url:process.env.SYNC_DEV_HEALTH_URL,
    expectedCommit:process.env.EXPECTED_GIT_SHA,
    attempts:process.env.SYNC_DEV_SMOKE_ATTEMPTS || DEFAULT_ATTEMPTS,
    delayMs:process.env.SYNC_DEV_SMOKE_DELAY_MS || DEFAULT_DELAY_MS,
    timeoutMs:process.env.SYNC_DEV_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  });
  console.log(JSON.stringify(result, null, 2));
}
