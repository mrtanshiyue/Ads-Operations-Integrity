import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 5_000;

export const CLOUDFLARE_SYNC_DEV_SOURCE_BRANCH = 'cloudflare-foundation-v1';
export const CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH = '__manual_ci_gated_deploy__';
export const CLOUDFLARE_FOUNDATION_WORKFLOW = 'cloudflare-foundation-ci.yml';

export class CloudflareSyncDevPromotionError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareSyncDevPromotionError';
    this.code = code;
    this.cause = cause;
  }
}

export async function promoteVerifiedCloudflareSyncDevTrigger(options = {}) {
  const repository = requiredRepository(options.repository ?? process.env.GITHUB_REPOSITORY);
  const sha = requiredSha(options.sha ?? process.env.GITHUB_SHA, 'CF_SYNC_DEV_PROMOTION_SHA_INVALID');
  const token = requiredText(options.token ?? process.env.GITHUB_TOKEN, 'CF_SYNC_DEV_PROMOTION_TOKEN_REQUIRED');
  const apiUrl = requiredApiUrl(options.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const attempts = positiveInteger(
    options.attempts ?? process.env.CF_SYNC_DEV_PROMOTION_ATTEMPTS ?? DEFAULT_ATTEMPTS,
    'CF_SYNC_DEV_PROMOTION_ATTEMPTS_INVALID',
  );
  const delayMs = nonNegativeInteger(
    options.delayMs ?? process.env.CF_SYNC_DEV_PROMOTION_DELAY_MS ?? DEFAULT_DELAY_MS,
    'CF_SYNC_DEV_PROMOTION_DELAY_INVALID',
  );

  if (typeof fetchImpl !== 'function') {
    throw new CloudflareSyncDevPromotionError('CF_SYNC_DEV_PROMOTION_FETCH_INVALID');
  }

  const foundation = await waitForFoundationSuccess({
    repository,
    sha,
    token,
    apiUrl,
    fetchImpl,
    sleep,
    attempts,
    delayMs,
  });

  // Re-check source authority after Foundation completes. A superseded commit must never
  // advance the physical Cloudflare trigger branch even if its own CI happened to finish.
  const source = await readGitRef({
    repository,
    branch:CLOUDFLARE_SYNC_DEV_SOURCE_BRANCH,
    token,
    apiUrl,
    fetchImpl,
    allowMissing:false,
  });
  if (source.sha !== sha) {
    throw new CloudflareSyncDevPromotionError(
      `CF_SYNC_DEV_PROMOTION_SOURCE_MOVED:${source.sha}:${sha}`,
    );
  }

  const trigger = await readGitRef({
    repository,
    branch:CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH,
    token,
    apiUrl,
    fetchImpl,
    allowMissing:true,
  });
  if (trigger?.sha === sha) {
    return Object.freeze({
      ok:true,
      repository,
      sha,
      foundationRunId:foundation.runId,
      triggerBranch:CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH,
      reused:true,
    });
  }

  if (trigger) {
    await githubJson({
      fetchImpl,
      token,
      url:`${apiUrl}/repos/${repository}/git/refs/heads/${encodeURIComponent(CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH)}`,
      method:'PATCH',
      body:{ sha, force:false },
      expectedStatuses:[200],
      code:'CF_SYNC_DEV_PROMOTION_TRIGGER_UPDATE_FAILED',
    });
  } else {
    await githubJson({
      fetchImpl,
      token,
      url:`${apiUrl}/repos/${repository}/git/refs`,
      method:'POST',
      body:{ ref:`refs/heads/${CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH}`, sha },
      expectedStatuses:[201],
      code:'CF_SYNC_DEV_PROMOTION_TRIGGER_CREATE_FAILED',
    });
  }

  return Object.freeze({
    ok:true,
    repository,
    sha,
    foundationRunId:foundation.runId,
    triggerBranch:CLOUDFLARE_SYNC_DEV_TRIGGER_BRANCH,
    reused:false,
  });
}

export async function waitForFoundationSuccess(options = {}) {
  const {
    repository,
    sha,
    token,
    apiUrl,
    fetchImpl,
    sleep,
  } = options;
  const attempts = positiveInteger(options.attempts ?? DEFAULT_ATTEMPTS, 'CF_SYNC_DEV_PROMOTION_ATTEMPTS_INVALID');
  const delayMs = nonNegativeInteger(options.delayMs ?? DEFAULT_DELAY_MS, 'CF_SYNC_DEV_PROMOTION_DELAY_INVALID');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const params = new URLSearchParams({
      head_sha:sha,
      event:'push',
      per_page:'10',
    });
    const response = await githubJson({
      fetchImpl,
      token,
      url:`${apiUrl}/repos/${repository}/actions/workflows/${CLOUDFLARE_FOUNDATION_WORKFLOW}/runs?${params}`,
      method:'GET',
      expectedStatuses:[200],
      code:'CF_SYNC_DEV_PROMOTION_FOUNDATION_QUERY_FAILED',
    });
    const runs = Array.isArray(response?.workflow_runs)
      ? response.workflow_runs.filter((run) => String(run?.head_sha || '').toLowerCase() === sha)
      : [];
    const success = runs.find((run) => run?.status === 'completed' && run?.conclusion === 'success');
    if (success) {
      return Object.freeze({
        runId:Number(success.id),
        attempt,
        attempts,
      });
    }

    const terminal = runs.filter((run) => run?.status === 'completed');
    const active = runs.some((run) => run?.status !== 'completed');
    if (runs.length && terminal.length === runs.length && !active) {
      const conclusions = [...new Set(terminal.map((run) => String(run?.conclusion || 'unknown')))].sort();
      throw new CloudflareSyncDevPromotionError(
        `CF_SYNC_DEV_PROMOTION_FOUNDATION_NOT_SUCCESS:${conclusions.join(',')}`,
      );
    }

    if (attempt === attempts) {
      throw new CloudflareSyncDevPromotionError('CF_SYNC_DEV_PROMOTION_FOUNDATION_TIMEOUT');
    }
    console.log(`[sync-dev-promotion] waiting for Foundation exact SHA ${sha}: ${attempt}/${attempts}`);
    await sleep(delayMs);
  }

  throw new CloudflareSyncDevPromotionError('CF_SYNC_DEV_PROMOTION_FOUNDATION_TIMEOUT');
}

async function readGitRef({ repository, branch, token, apiUrl, fetchImpl, allowMissing }) {
  const result = await githubJson({
    fetchImpl,
    token,
    url:`${apiUrl}/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    method:'GET',
    expectedStatuses:allowMissing ? [200, 404] : [200],
    code:'CF_SYNC_DEV_PROMOTION_REF_READ_FAILED',
    returnStatus:true,
  });
  if (result.status === 404) return null;
  const sha = requiredSha(result.body?.object?.sha, 'CF_SYNC_DEV_PROMOTION_REF_SHA_INVALID');
  return Object.freeze({ sha });
}

async function githubJson(options) {
  const {
    fetchImpl,
    token,
    url,
    method,
    expectedStatuses,
    code,
    returnStatus = false,
  } = options;
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers:{
        accept:'application/vnd.github+json',
        authorization:`Bearer ${token}`,
        'x-github-api-version':'2022-11-28',
        ...(options.body ? { 'content-type':'application/json' } : {}),
      },
      ...(options.body ? { body:JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    throw new CloudflareSyncDevPromotionError(code, error);
  }
  if (!response || !expectedStatuses.includes(Number(response.status))) {
    throw new CloudflareSyncDevPromotionError(`${code}:${String(response?.status ?? 'UNKNOWN')}`);
  }
  let body = null;
  if (Number(response.status) !== 204 && Number(response.status) !== 404) {
    try {
      body = await response.json();
    } catch (error) {
      throw new CloudflareSyncDevPromotionError(`${code}:JSON_INVALID`, error);
    }
  }
  return returnStatus ? Object.freeze({ status:Number(response.status), body }) : body;
}

function requiredRepository(value) {
  const text = String(value ?? '').trim();
  if (!REPOSITORY_PATTERN.test(text)) {
    throw new CloudflareSyncDevPromotionError('CF_SYNC_DEV_PROMOTION_REPOSITORY_INVALID');
  }
  return text;
}

function requiredApiUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch (error) {
    throw new CloudflareSyncDevPromotionError('CF_SYNC_DEV_PROMOTION_API_URL_INVALID', error);
  }
  if (url.protocol !== 'https:') {
    throw new CloudflareSyncDevPromotionError('CF_SYNC_DEV_PROMOTION_API_URL_INVALID');
  }
  return url.toString().replace(/\/$/, '');
}

function requiredSha(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(text)) throw new CloudflareSyncDevPromotionError(code);
  return text;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CloudflareSyncDevPromotionError(code);
  return text;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new CloudflareSyncDevPromotionError(code);
  return number;
}

function nonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new CloudflareSyncDevPromotionError(code);
  return number;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await promoteVerifiedCloudflareSyncDevTrigger();
  console.log(JSON.stringify(result, null, 2));
}
