import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createExactCommitBuild,
  waitForExactSuccessfulBuild,
} from './cloudflare-workers-builds-client.mjs';

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;

export const DEFAULT_SYNC_DEV_BUILD_TRIGGER_UUID = '3771a2de-b602-4477-9c84-47884748b97d';
export const DEFAULT_SYNC_DEV_SCRIPT_TAG = '2c5f0f0afc964509a1f7f2c304138a26';
export const DEFAULT_REPOSITORY = 'mrtanshiyue/Ads-Operations-Integrity';
export const DEFAULT_REQUIRED_CONTEXT = 'Static site and security invariants';

const DEFAULT_GITHUB_API = 'https://api.github.com';

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
  const token = requiredText(options.apiToken ?? env.CLOUDFLARE_API_TOKEN, 'CF_SYNC_DEV_BUILD_API_TOKEN_REQUIRED');
  const triggerUuid = requiredText(
    options.triggerUuid ?? env.CF_SYNC_DEV_BUILD_TRIGGER_UUID ?? DEFAULT_SYNC_DEV_BUILD_TRIGGER_UUID,
    'CF_SYNC_DEV_BUILD_TRIGGER_UUID_INVALID',
  ).toLowerCase();
  const scriptTag = requiredText(
    options.scriptTag ?? env.CF_SYNC_DEV_SCRIPT_TAG ?? DEFAULT_SYNC_DEV_SCRIPT_TAG,
    'CF_SYNC_DEV_SCRIPT_TAG_INVALID',
  ).toLowerCase();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== 'function') throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_FETCH_INVALID');

  const githubApi = requiredHttpsBase(
    options.githubApi ?? env.GITHUB_API_URL ?? DEFAULT_GITHUB_API,
    'CF_SYNC_DEV_GITHUB_API_INVALID',
  );
  const githubToken = optionalText(options.githubToken ?? env.GITHUB_TOKEN);

  await assertCanonicalMainCi({
    fetchImpl,
    githubApi,
    githubToken,
    repository,
    commitSha,
    requiredContext,
  });

  let created;
  let accepted;
  try {
    created = await createExactCommitBuild({
      accountId,
      triggerUuid,
      commitSha,
      token,
      fetchImpl,
    });
    accepted = await waitForExactSuccessfulBuild({
      accountId,
      triggerUuid,
      workerTag:scriptTag,
      commitSha,
      buildUuid:created.buildUuid,
      token,
      fetchImpl,
      attempts:options.attempts ?? env.CF_SYNC_DEV_BUILD_ATTEMPTS,
      delayMs:options.delayMs ?? env.CF_SYNC_DEV_BUILD_DELAY_MS,
      sleep:options.sleep,
    });
  } catch (error) {
    throw new CloudflareSyncDevBuildError(
      `CF_SYNC_DEV_BUILD_CLIENT_FAILED:${String(error?.code || error?.message || 'unknown')}`,
      error,
    );
  }

  if (accepted.buildTriggerSource !== 'manual') {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_SOURCE_NOT_MANUAL');
  }
  if (accepted.branch !== null) {
    throw new CloudflareSyncDevBuildError('CF_SYNC_DEV_BUILD_BRANCH_NOT_EMPTY');
  }

  return Object.freeze({
    ok:true,
    commitSha,
    buildUuid:accepted.buildUuid,
    triggerUuid:accepted.triggerUuid,
    scriptTag:accepted.workerTag,
    buildOutcome:accepted.buildOutcome,
    source:accepted.buildTriggerSource,
  });
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

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await runCloudflareSyncDevExactBuild({ commitSha:process.env.EXPECTED_GIT_SHA });
  console.log(JSON.stringify(result, null, 2));
}
