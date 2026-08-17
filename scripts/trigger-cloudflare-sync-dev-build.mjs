import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;

export const DEFAULT_SYNC_DEV_BUILD_TRIGGER_UUID = '3771a2de-b602-4477-9c84-47884748b97d';
export const DEFAULT_SYNC_DEV_SCRIPT_TAG = '2c5f0f0afc964509a1f7f2c304138a26';
export const DEFAULT_REPOSITORY = 'mrtanshiyue/Ads-Operations-Integrity';
export const DEFAULT_REQUIRED_CONTEXT = 'Static site and security invariants';

const DEFAULT_CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const DEFAULT_GITHUB_API = 'https://api.github.com';
const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 5_000;

export class CloudflareSyncDevBuildError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareSyncDevBuildError';
    this.code = code;
    this.cause = cause;
  }
}

export async function runCloudflareSyncDevExactBuild(options = {}) {
  const env = options.env ?? process.env;
  const commitSha = requiredSha(options.commitSha ?? env.GITHUB_SHA, 'CF_SYNC_DEV_BUILD_SHA_INVALID');
  const repository = requiredRepository(options.repository ?? env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY);
  const requiredContext = requiredText(
    options.requiredContext ?? env.CF_SYNC_DEV_REQUIRED_CONTEXT ?? DEFAULT_REQUIRED_CONTEXT,
    'CF_SYNC_DEV_REQUIRED_CONTEXT_INVALID',
  );
  const accountId = requiredAccountId(
    options.accountId ?? env.CLOUDFLARE_ACCOUNT_ID,
    'CF_SYNC_DEV_BUILD_ACCOUNT_ID_REQUIRED',
  );
  const apiToken = requiredText(options.apiToken ?? env.CLOUDFLARE_API_TOKEN, 'CF_SYNC_DEV_BUILD_API_TOKEN_REQUIRED');
  const triggerUuid = requiredUuid(
    options.triggerUuid ?? env.CF_SYNC_DEV_BUILD_TRIGGER_UUID ?? DEFAULT_SYNC_DEV_BUILD_TRIGGER_UUID,
    'CF_SYNC_DEV_BUILD_TRIGGER_UUID_INVALID',
  );
  const scriptTag = requiredScriptTag(
    options.scriptTag ?? env.CF_SYNC_DEV_SCRIPT_TAG ?? DEFAULT_SYNC_DEV_SCRIPT_TAG,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== 'function') throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_FETCH_INVALID');

  const githubApi = requiredHttpsBase(options.githubApi ?? env.GITHUB_API_URL ?? DEFAULT_GITHUB_API, 'CF_SYNC_DEV_GITHUB_API_INVALID');
  const cloudflareApi = requiredHttpsBase(options.cloudflareApi ?? DEFAULT_CLOUDFLARE_API, 'CF_SYNC_DEV_CLOUDFLARE_API_INVALID');
  const githubToken = optionalText(options.githubToken ?? env.GITHUB_TOKEN);
  const attempts = positiveInteger(options.attempts ?? env.CF_SYNC_DEV_BUILD_ATTEMPTS ?? DEFAULT_ATTEMPTS, 'CF_SYNC_DEV_BUILD_ATTEMPTS_INVALID');
  const delayMs = nonNegativeInteger(options.delayMs ?? env.CF_SYNC_DEV_BUILD_DELAY_MS ?? DEFAULT_DELAY_MS, 'CF_SYNC_DEV_BUILD_DELAY_INVALID');
  const sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));

  await assertCanonicalMainCi({
    fetchImpl,
    githubApi,
    githubToken,
    repository,
    commitSha,
    requiredContext,
  });

  const created = await cloudflareJson({
    fetchImpl,
    apiToken,
    url:`${cloudflareApi}/accounts/${accountId}/builds/triggers/${triggerUuid}/builds`,
    method:'POST',
    body:{ commit_hash:commitSha },
    code:'CF_SYNC_DEV_BUILD_CREATE_FAILED',
  });
  const buildUuid = requiredUuid(created?.result?.build_uuid, 'CF_SYNC_DEV_BUILD_UUID_MISSING');

  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await cloudflareJson({
      fetchImpl,
      apiToken,
      url:`${cloudflareApi}/accounts/${accountId}/builds/builds/${buildUuid}`,
      method:'GET',
      code:'CF_SYNC_DEV_BUILD_READ_FAILED',
    });
    const build = response?.result;
    validateBuildIdentity({ build, buildUuid, triggerUuid, scriptTag, commitSha });
    last = build;

    if (String(build?.status || '') === 'stopped') {
      if (String(build?.build_outcome || '') !== 'success') {
        throw new CloudflareSyncDevBuildError(
          `CF_SYNC_DEV_BUILD_NOT_SUCCESS:${String(build?.build_outcome || 'unknown')}`,
        );
      }
      return Object.freeze({
        ok:true,
        commitSha,
        buildUuid,
        triggerUuid,
        scriptTag,
        buildOutcome:'success',
        source:'manual',
      });
    }

    if (attempt === attempts) break;
    await sleep(delayMs);
  }

  throw new CloudflareSyncDevBuildError(
    `CF_SYNC_DEV_BUILD_TIMEOUT:${String(last?.status || 'unknown')}`,
  );
}

export async function assertCanonicalMainCi(options = {}) {
  const {
    fetchImpl = fetch,
    repository = DEFAULT_REPOSITORY,
    requiredContext = DEFAULT_REQUIRED_CONTEXT,
  } = options;
  const commitSha = requiredSha(options.commitSha, 'CF_SYNC_DEV_BUILD_SHA_INVALID');
  const githubApi = requiredHttpsBase(options.githubApi ?? DEFAULT_GITHUB_API, 'CF_SYNC_DEV_GITHUB_API_INVALID');
  const githubToken = optionalText(options.githubToken);

  const ref = await githubJson({
    fetchImpl,
    githubToken,
    url:`${githubApi}/repos/${repository}/git/ref/heads/main`,
    code:'CF_SYNC_DEV_MAIN_REF_READ_FAILED',
  });
  const mainSha = requiredSha(ref?.object?.sha, 'CF_SYNC_DEV_MAIN_REF_SHA_INVALID');
  if (mainSha !== commitSha) {
    throw new CloudflareSyncDevBuildError(`CF_SYNC_DEV_BUILD_SHA_NOT_MAIN:${mainSha}:${commitSha}`);
  }

  const checks = await githubJson({
    fetchImpl,
    githubToken,
    url:`${githubApi}/repos/${repository}/commits/${commitSha}/check-runs?per_page=100`,
    code:'CF_SYNC_DEV_CHECK_RUNS_READ_FAILED',
  });
  const runs = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
  const matching = runs.filter((run) => String(run?.name || '') === requiredContext);
  const success = matching.find((run) => run?.status === 'completed' && run?.conclusion === 'success');
  if (!success) {
    const state = matching.length
      ? [...new Set(matching.map((run) => `${String(run?.status || 'unknown')}:${String(run?.conclusion || 'none')}`))].sort().join(',')
      : 'missing';
    throw new CloudflareSyncDevBuildError(`CF_SYNC_DEV_CANONICAL_CI_NOT_SUCCESS:${state}`);
  }

  return Object.freeze({ ok:true, commitSha, requiredContext, checkRunId:Number(success.id) || null });
}

export function validateBuildIdentity({ build, buildUuid, triggerUuid, scriptTag, commitSha }) {
  if (!build || typeof build !== 'object' || Array.isArray(build)) {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_BODY_INVALID');
  }
  if (requiredUuid(build.build_uuid, 'CF_SYNC_DEV_BUILD_UUID_INVALID') !== buildUuid) {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_UUID_MISMATCH');
  }
  const trigger = build.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_TRIGGER_MISSING');
  }
  if (requiredUuid(trigger.trigger_uuid, 'CF_SYNC_DEV_BUILD_TRIGGER_UUID_INVALID') !== triggerUuid) {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_TRIGGER_MISMATCH');
  }
  if (requiredScriptTag(trigger.external_script_id) !== scriptTag) {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_SCRIPT_TAG_MISMATCH');
  }

  const metadata = build.build_trigger_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_METADATA_MISSING');
  }
  if (String(metadata.build_trigger_source || '') !== 'manual') {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_SOURCE_NOT_MANUAL');
  }
  if (String(metadata.branch || '') !== '') {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_BRANCH_NOT_EMPTY');
  }
  if (requiredSha(metadata.commit_hash, 'CF_SYNC_DEV_BUILD_METADATA_SHA_INVALID') !== commitSha) {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_COMMIT_MISMATCH');
  }
  return true;
}

async function cloudflareJson({ fetchImpl, apiToken, url, method, body, code }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers:{
        authorization:`Bearer ${apiToken}`,
        accept:'application/json',
        ...(body ? { 'content-type':'application/json' } : {}),
      },
      ...(body ? { body:JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new CloudflareSyncDevBuildError(code, error);
  }
  let payload = null;
  try {
    payload = await response?.json();
  } catch (error) {
    throw new CloudflareSyncDevBuildError(`${code}:JSON_INVALID`, error);
  }
  if (!response?.ok || payload?.success !== true) {
    const status = Number(response?.status || 0) || 'UNKNOWN';
    const message = Array.isArray(payload?.errors) && payload.errors.length
      ? String(payload.errors[0]?.message || '')
      : '';
    throw new CloudflareSyncDevBuildError(`${code}:${status}${message ? `:${message}` : ''}`);
  }
  return payload;
}

async function githubJson({ fetchImpl, githubToken, url, code }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method:'GET',
      headers:{
        accept:'application/vnd.github+json',
        'x-github-api-version':'2022-11-28',
        ...(githubToken ? { authorization:`Bearer ${githubToken}` } : {}),
      },
    });
  } catch (error) {
    throw new CloudflareSyncDevBuildError(code, error);
  }
  if (!response?.ok) {
    throw new CloudflareSyncDevBuildError(`${code}:${Number(response?.status || 0) || 'UNKNOWN'}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new CloudflareSyncDevBuildError(`${code}:JSON_INVALID`, error);
  }
}

function requiredSha(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(text)) throw new CloudflareSyncDevBuildError(code);
  return text;
}

function requiredUuid(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(text)) throw new CloudflareSyncDevBuildError(code);
  return text;
}

function requiredScriptTag(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(text)) throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_SCRIPT_TAG_INVALID');
  return text;
}

function requiredAccountId(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(text)) throw new CloudflareSyncDevBuildError(code);
  return text;
}

function requiredRepository(value) {
  const text = String(value ?? '').trim();
  if (!REPOSITORY_PATTERN.test(text)) throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_REPOSITORY_INVALID');
  return text;
}

function requiredHttpsBase(value, code) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch (error) {
    throw new CloudflareSyncDevBuildError(code, error);
  }
  if (url.protocol !== 'https:') throw new CloudflareSyncDevBuildError(code);
  return url.toString().replace(/\/$/, '');
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CloudflareSyncDevBuildError(code);
  return text;
}

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new CloudflareSyncDevBuildError(code);
  return number;
}

function nonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new CloudflareSyncDevBuildError(code);
  return number;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await runCloudflareSyncDevExactBuild({ commitSha:process.env.EXPECTED_GIT_SHA });
  console.log(JSON.stringify(result, null, 2));
}
