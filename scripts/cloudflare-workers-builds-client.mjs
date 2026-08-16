const API_BASE = 'https://api.cloudflare.com/client/v4';
const SHA40_PATTERN = /^[0-9a-f]{40}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 5_000;

export class CloudflareWorkersBuildsError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareWorkersBuildsError';
    this.code = code;
    this.cause = cause;
  }
}

export async function createExactCommitBuild(options = {}) {
  const accountId = requiredAccountId(options.accountId);
  const triggerUuid = requiredUuid(options.triggerUuid, 'CF_WORKERS_BUILDS_TRIGGER_UUID_INVALID');
  const commitSha = requiredSha(options.commitSha);
  const branch = optionalBranch(options.branch);
  const token = requiredToken(options.token);
  const fetchImpl = requiredFetch(options.fetchImpl ?? fetch);

  const payload = { commit_hash: commitSha };
  if (branch) payload.branch = branch;

  const body = await cloudflareJson({
    fetchImpl,
    token,
    url: `${API_BASE}/accounts/${encodeURIComponent(accountId)}/builds/triggers/${encodeURIComponent(triggerUuid)}/builds`,
    method: 'POST',
    json: payload,
    code: 'CF_WORKERS_BUILDS_CREATE_FAILED',
  });

  const buildUuid = requiredUuid(body?.result?.build_uuid, 'CF_WORKERS_BUILDS_BUILD_UUID_INVALID');
  return Object.freeze({
    accountId,
    triggerUuid,
    commitSha,
    branch,
    buildUuid,
    createdOn: optionalText(body?.result?.created_on),
  });
}

export async function getBuildByUuid(options = {}) {
  const accountId = requiredAccountId(options.accountId);
  const buildUuid = requiredUuid(options.buildUuid, 'CF_WORKERS_BUILDS_BUILD_UUID_INVALID');
  const token = requiredToken(options.token);
  const fetchImpl = requiredFetch(options.fetchImpl ?? fetch);

  const body = await cloudflareJson({
    fetchImpl,
    token,
    url: `${API_BASE}/accounts/${encodeURIComponent(accountId)}/builds/builds/${encodeURIComponent(buildUuid)}`,
    method: 'GET',
    code: 'CF_WORKERS_BUILDS_GET_FAILED',
  });

  if (!body?.result || typeof body.result !== 'object') {
    throw new CloudflareWorkersBuildsError('CF_WORKERS_BUILDS_RESULT_INVALID');
  }
  return body.result;
}

export function assertExactSuccessfulBuild(options = {}) {
  const build = options.build;
  if (!build || typeof build !== 'object') {
    throw new CloudflareWorkersBuildsError('CF_WORKERS_BUILDS_RESULT_INVALID');
  }

  const expectedBuildUuid = requiredUuid(options.buildUuid, 'CF_WORKERS_BUILDS_BUILD_UUID_INVALID');
  const expectedCommitSha = requiredSha(options.commitSha);
  const expectedTriggerUuid = requiredUuid(options.triggerUuid, 'CF_WORKERS_BUILDS_TRIGGER_UUID_INVALID');
  const expectedWorkerTag = optionalText(options.workerTag);

  const actualBuildUuid = requiredUuid(build.build_uuid, 'CF_WORKERS_BUILDS_BUILD_UUID_INVALID');
  if (actualBuildUuid !== expectedBuildUuid) {
    throw new CloudflareWorkersBuildsError(`CF_WORKERS_BUILDS_UUID_MISMATCH:${actualBuildUuid}:${expectedBuildUuid}`);
  }

  const status = optionalText(build.status);
  if (status !== 'stopped') {
    throw new CloudflareWorkersBuildsError(`CF_WORKERS_BUILDS_NOT_TERMINAL:${status || 'unknown'}`);
  }

  const outcome = optionalText(build.build_outcome);
  if (outcome !== 'success') {
    throw new CloudflareWorkersBuildsError(`CF_WORKERS_BUILDS_NOT_SUCCESS:${outcome || 'unknown'}`);
  }

  const actualCommitSha = requiredShaValue(
    build?.build_trigger_metadata?.commit_hash,
    'CF_WORKERS_BUILDS_COMMIT_SHA_INVALID',
  );
  if (actualCommitSha !== expectedCommitSha) {
    throw new CloudflareWorkersBuildsError(`CF_WORKERS_BUILDS_COMMIT_MISMATCH:${actualCommitSha}:${expectedCommitSha}`);
  }

  const actualTriggerUuid = requiredUuid(
    build?.trigger?.trigger_uuid,
    'CF_WORKERS_BUILDS_TRIGGER_IDENTITY_INVALID',
  );
  if (actualTriggerUuid !== expectedTriggerUuid) {
    throw new CloudflareWorkersBuildsError(`CF_WORKERS_BUILDS_TRIGGER_MISMATCH:${actualTriggerUuid}:${expectedTriggerUuid}`);
  }

  const actualWorkerTag = optionalText(build?.trigger?.external_script_id);
  if (expectedWorkerTag && actualWorkerTag !== expectedWorkerTag) {
    throw new CloudflareWorkersBuildsError(
      `CF_WORKERS_BUILDS_WORKER_MISMATCH:${actualWorkerTag || 'unknown'}:${expectedWorkerTag}`,
    );
  }

  return Object.freeze({
    buildUuid: actualBuildUuid,
    commitSha: actualCommitSha,
    triggerUuid: actualTriggerUuid,
    workerTag: actualWorkerTag,
    buildOutcome: outcome,
    status,
    buildTriggerSource: optionalText(build?.build_trigger_metadata?.build_trigger_source),
    repoName: optionalText(build?.build_trigger_metadata?.repo_name),
    branch: optionalText(build?.build_trigger_metadata?.branch),
  });
}

export async function waitForExactSuccessfulBuild(options = {}) {
  const attempts = positiveInteger(options.attempts ?? DEFAULT_ATTEMPTS, 'CF_WORKERS_BUILDS_ATTEMPTS_INVALID');
  const delayMs = nonNegativeInteger(options.delayMs ?? DEFAULT_DELAY_MS, 'CF_WORKERS_BUILDS_DELAY_INVALID');
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const build = await getBuildByUuid(options);
    const status = optionalText(build?.status);

    if (status === 'stopped') {
      const accepted = assertExactSuccessfulBuild({
        build,
        buildUuid: options.buildUuid,
        commitSha: options.commitSha,
        triggerUuid: options.triggerUuid,
        workerTag: options.workerTag,
      });
      return Object.freeze({ ...accepted, attempt, attempts });
    }

    if (!['queued', 'initializing', 'running'].includes(status || '')) {
      throw new CloudflareWorkersBuildsError(`CF_WORKERS_BUILDS_STATUS_INVALID:${status || 'unknown'}`);
    }
    if (attempt === attempts) {
      throw new CloudflareWorkersBuildsError('CF_WORKERS_BUILDS_TIMEOUT');
    }
    await sleep(delayMs);
  }

  throw new CloudflareWorkersBuildsError('CF_WORKERS_BUILDS_TIMEOUT');
}

async function cloudflareJson({ fetchImpl, token, url, method, json, code }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });
  } catch (error) {
    throw new CloudflareWorkersBuildsError(code, error);
  }

  if (!response || !response.ok) {
    throw new CloudflareWorkersBuildsError(`${code}:${String(response?.status ?? 'UNKNOWN')}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new CloudflareWorkersBuildsError(`${code}:JSON_INVALID`, error);
  }
  if (body?.success !== true) {
    const firstCode = body?.errors?.[0]?.code;
    throw new CloudflareWorkersBuildsError(`${code}:API:${String(firstCode ?? 'UNKNOWN')}`);
  }
  return body;
}

function requiredAccountId(value) {
  const text = String(value ?? '').trim();
  if (!ACCOUNT_ID_PATTERN.test(text)) {
    throw new CloudflareWorkersBuildsError('CF_WORKERS_BUILDS_ACCOUNT_ID_INVALID');
  }
  return text.toLowerCase();
}

function requiredSha(value) {
  return requiredShaValue(value, 'CF_WORKERS_BUILDS_COMMIT_SHA_INVALID');
}

function requiredShaValue(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!SHA40_PATTERN.test(text)) throw new CloudflareWorkersBuildsError(code);
  return text;
}

function requiredUuid(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(text)) throw new CloudflareWorkersBuildsError(code);
  return text;
}

function requiredToken(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new CloudflareWorkersBuildsError('CF_WORKERS_BUILDS_TOKEN_REQUIRED');
  return text;
}

function requiredFetch(value) {
  if (typeof value !== 'function') {
    throw new CloudflareWorkersBuildsError('CF_WORKERS_BUILDS_FETCH_INVALID');
  }
  return value;
}

function optionalBranch(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text.length > 255 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new CloudflareWorkersBuildsError('CF_WORKERS_BUILDS_BRANCH_INVALID');
  }
  return text;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new CloudflareWorkersBuildsError(code);
  return number;
}

function nonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new CloudflareWorkersBuildsError(code);
  return number;
}
