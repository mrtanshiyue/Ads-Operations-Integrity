const API_BASE = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const WORKER_TAG_PATTERN = /^[0-9a-f]{32}$/i;
const SHA40_PATTERN = /^[0-9a-f]{40}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CloudflareDeploymentDiscoveryError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareDeploymentDiscoveryError';
    this.code = code;
    this.cause = cause;
  }
}

export async function discoverWorkerDeploymentTopology(options = {}) {
  const accountId = requiredAccountId(options.accountId);
  const scriptName = requiredScriptName(options.scriptName);
  const token = requiredToken(options.token);
  const fetchImpl = requiredFetch(options.fetchImpl ?? fetch);

  const worker = await resolveWorker({ accountId, scriptName, token, fetchImpl });
  const triggers = await listWorkerTriggers({ accountId, workerTag: worker.workerTag, token, fetchImpl });
  const deployment = await getActiveSingleVersionDeployment({ accountId, scriptName, token, fetchImpl });
  const version = await getVersionDetail({
    accountId,
    scriptName,
    versionId: deployment.versionId,
    token,
    fetchImpl,
  });
  const build = await getBuildForVersion({
    accountId,
    versionId: deployment.versionId,
    token,
    fetchImpl,
  });

  const buildTriggerUuid = requiredUuid(
    build?.trigger?.trigger_uuid,
    'CF_DEPLOYMENT_DISCOVERY_BUILD_TRIGGER_INVALID',
  );
  const buildWorkerTag = requiredWorkerTag(
    build?.trigger?.external_script_id,
    'CF_DEPLOYMENT_DISCOVERY_BUILD_WORKER_TAG_INVALID',
  );
  if (buildWorkerTag !== worker.workerTag) {
    throw new CloudflareDeploymentDiscoveryError(
      `CF_DEPLOYMENT_DISCOVERY_BUILD_WORKER_MISMATCH:${buildWorkerTag}:${worker.workerTag}`,
    );
  }

  const matchedTrigger = triggers.find((trigger) => trigger.triggerUuid === buildTriggerUuid);
  if (!matchedTrigger) {
    throw new CloudflareDeploymentDiscoveryError(
      `CF_DEPLOYMENT_DISCOVERY_BUILD_TRIGGER_NOT_LISTED:${buildTriggerUuid}`,
    );
  }

  const buildUuid = requiredUuid(build?.build_uuid, 'CF_DEPLOYMENT_DISCOVERY_BUILD_UUID_INVALID');
  const buildCommitSha = requiredSha(build?.build_trigger_metadata?.commit_hash);
  const buildStatus = optionalText(build?.status);
  const buildOutcome = optionalText(build?.build_outcome);

  return Object.freeze({
    schemaVersion: 'cloudflare-deployment-discovery-v1',
    accountId,
    workerName: worker.workerName,
    workerTag: worker.workerTag,
    triggers,
    activeDeployment: Object.freeze({
      deploymentId: deployment.deploymentId,
      versionId: deployment.versionId,
      percentage: deployment.percentage,
      source: deployment.source,
      strategy: deployment.strategy,
      createdOn: deployment.createdOn,
    }),
    activeVersion: Object.freeze({
      versionId: version.versionId,
      number: version.number,
      source: version.source,
      createdOn: version.createdOn,
      modifiedOn: version.modifiedOn,
    }),
    activeBuild: Object.freeze({
      buildUuid,
      status: buildStatus,
      outcome: buildOutcome,
      commitSha: buildCommitSha,
      branch: optionalText(build?.build_trigger_metadata?.branch),
      triggerSource: optionalText(build?.build_trigger_metadata?.build_trigger_source),
      triggerUuid: buildTriggerUuid,
      workerTag: buildWorkerTag,
      repoName: optionalText(build?.build_trigger_metadata?.repo_name),
    }),
  });
}

export function assertLiveRuntimeVersion(options = {}) {
  const expectedVersionId = requiredUuid(
    options.versionId,
    'CF_DEPLOYMENT_DISCOVERY_VERSION_ID_INVALID',
  );
  const actualVersionId = optionalText(options.health?.deployment?.versionId)?.toLowerCase() || null;
  if (!actualVersionId || !UUID_PATTERN.test(actualVersionId)) {
    throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_LIVE_VERSION_MISSING');
  }
  if (actualVersionId !== expectedVersionId) {
    throw new CloudflareDeploymentDiscoveryError(
      `CF_DEPLOYMENT_DISCOVERY_LIVE_VERSION_MISMATCH:${actualVersionId}:${expectedVersionId}`,
    );
  }
  return Object.freeze({
    versionId: actualVersionId,
    versionTag: optionalText(options.health?.deployment?.versionTag),
    versionTimestamp: optionalText(options.health?.deployment?.versionTimestamp),
  });
}

async function resolveWorker({ accountId, scriptName, token, fetchImpl }) {
  const body = await cloudflareGet({
    accountId,
    token,
    fetchImpl,
    path: '/workers/scripts',
    code: 'CF_DEPLOYMENT_DISCOVERY_WORKERS_FAILED',
  });
  const workers = Array.isArray(body?.result) ? body.result : null;
  if (!workers) throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_WORKERS_INVALID');

  const matches = workers.filter((worker) => optionalText(worker?.id) === scriptName);
  if (matches.length !== 1) {
    throw new CloudflareDeploymentDiscoveryError(
      `CF_DEPLOYMENT_DISCOVERY_WORKER_MATCH_INVALID:${matches.length}`,
    );
  }
  return Object.freeze({
    workerName: scriptName,
    workerTag: requiredWorkerTag(matches[0]?.tag, 'CF_DEPLOYMENT_DISCOVERY_WORKER_TAG_INVALID'),
  });
}

async function listWorkerTriggers({ accountId, workerTag, token, fetchImpl }) {
  const body = await cloudflareGet({
    accountId,
    token,
    fetchImpl,
    path: `/builds/workers/${encodeURIComponent(workerTag)}/triggers`,
    code: 'CF_DEPLOYMENT_DISCOVERY_TRIGGERS_FAILED',
  });
  const rows = Array.isArray(body?.result) ? body.result : null;
  if (!rows || rows.length < 1) {
    throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_TRIGGERS_INVALID');
  }

  return Object.freeze(rows.map((row) => {
    const externalScriptId = requiredWorkerTag(
      row?.external_script_id,
      'CF_DEPLOYMENT_DISCOVERY_TRIGGER_WORKER_TAG_INVALID',
    );
    if (externalScriptId !== workerTag) {
      throw new CloudflareDeploymentDiscoveryError(
        `CF_DEPLOYMENT_DISCOVERY_TRIGGER_WORKER_MISMATCH:${externalScriptId}:${workerTag}`,
      );
    }
    return Object.freeze({
      triggerUuid: requiredUuid(row?.trigger_uuid, 'CF_DEPLOYMENT_DISCOVERY_TRIGGER_UUID_INVALID'),
      triggerName: optionalText(row?.trigger_name),
      externalScriptId,
      branchIncludes: safeStringArray(row?.branch_includes),
      branchExcludes: safeStringArray(row?.branch_excludes),
      buildCommand: optionalText(row?.build_command),
      deployCommand: optionalText(row?.deploy_command),
      rootDirectory: optionalText(row?.root_directory),
    });
  }));
}

async function getActiveSingleVersionDeployment({ accountId, scriptName, token, fetchImpl }) {
  const body = await cloudflareGet({
    accountId,
    token,
    fetchImpl,
    path: `/workers/scripts/${encodeURIComponent(scriptName)}/deployments`,
    code: 'CF_DEPLOYMENT_DISCOVERY_DEPLOYMENTS_FAILED',
  });
  const deployments = Array.isArray(body?.result?.deployments) ? body.result.deployments : null;
  if (!deployments || deployments.length < 1) {
    throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_DEPLOYMENTS_INVALID');
  }

  const active = deployments[0];
  const versions = Array.isArray(active?.versions) ? active.versions : null;
  if (!versions || versions.length !== 1) {
    throw new CloudflareDeploymentDiscoveryError(
      `CF_DEPLOYMENT_DISCOVERY_NOT_SINGLE_VERSION:${versions?.length ?? 0}`,
    );
  }
  const percentage = Number(versions[0]?.percentage);
  if (percentage !== 100) {
    throw new CloudflareDeploymentDiscoveryError(
      `CF_DEPLOYMENT_DISCOVERY_NOT_FULL_TRAFFIC:${String(versions[0]?.percentage ?? 'unknown')}`,
    );
  }

  return Object.freeze({
    deploymentId: requiredUuid(active?.id, 'CF_DEPLOYMENT_DISCOVERY_DEPLOYMENT_ID_INVALID'),
    versionId: requiredUuid(versions[0]?.version_id, 'CF_DEPLOYMENT_DISCOVERY_VERSION_ID_INVALID'),
    percentage,
    source: optionalText(active?.source),
    strategy: optionalText(active?.strategy),
    createdOn: optionalText(active?.created_on),
  });
}

async function getVersionDetail({ accountId, scriptName, versionId, token, fetchImpl }) {
  const body = await cloudflareGet({
    accountId,
    token,
    fetchImpl,
    path: `/workers/scripts/${encodeURIComponent(scriptName)}/versions/${encodeURIComponent(versionId)}`,
    code: 'CF_DEPLOYMENT_DISCOVERY_VERSION_FAILED',
  });
  const result = body?.result;
  if (!result || typeof result !== 'object') {
    throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_VERSION_INVALID');
  }
  const actualVersionId = requiredUuid(result.id, 'CF_DEPLOYMENT_DISCOVERY_VERSION_ID_INVALID');
  if (actualVersionId !== versionId) {
    throw new CloudflareDeploymentDiscoveryError(
      `CF_DEPLOYMENT_DISCOVERY_VERSION_MISMATCH:${actualVersionId}:${versionId}`,
    );
  }
  return Object.freeze({
    versionId: actualVersionId,
    number: Number.isFinite(Number(result.number)) ? Number(result.number) : null,
    source: optionalText(result?.metadata?.source),
    createdOn: optionalText(result?.metadata?.created_on),
    modifiedOn: optionalText(result?.metadata?.modified_on),
  });
}

async function getBuildForVersion({ accountId, versionId, token, fetchImpl }) {
  const body = await cloudflareGet({
    accountId,
    token,
    fetchImpl,
    path: `/builds/builds?version_ids=${encodeURIComponent(versionId)}`,
    code: 'CF_DEPLOYMENT_DISCOVERY_VERSION_BUILD_FAILED',
  });
  const builds = body?.result?.builds;
  if (!builds || typeof builds !== 'object' || Array.isArray(builds)) {
    throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_VERSION_BUILDS_INVALID');
  }
  const build = builds[versionId];
  if (!build || typeof build !== 'object') {
    throw new CloudflareDeploymentDiscoveryError(
      `CF_DEPLOYMENT_DISCOVERY_VERSION_BUILD_MISSING:${versionId}`,
    );
  }
  return build;
}

async function cloudflareGet({ accountId, token, fetchImpl, path, code }) {
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/accounts/${encodeURIComponent(accountId)}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    throw new CloudflareDeploymentDiscoveryError(code, error);
  }
  if (!response || !response.ok) {
    throw new CloudflareDeploymentDiscoveryError(`${code}:${String(response?.status ?? 'UNKNOWN')}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new CloudflareDeploymentDiscoveryError(`${code}:JSON_INVALID`, error);
  }
  if (body?.success !== true) {
    const firstCode = body?.errors?.[0]?.code;
    throw new CloudflareDeploymentDiscoveryError(`${code}:API:${String(firstCode ?? 'UNKNOWN')}`);
  }
  return body;
}

function requiredAccountId(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(text)) {
    throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_ACCOUNT_ID_INVALID');
  }
  return text;
}

function requiredScriptName(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 255 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_SCRIPT_NAME_INVALID');
  }
  return text;
}

function requiredWorkerTag(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!WORKER_TAG_PATTERN.test(text)) throw new CloudflareDeploymentDiscoveryError(code);
  return text;
}

function requiredUuid(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(text)) throw new CloudflareDeploymentDiscoveryError(code);
  return text;
}

function requiredSha(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!SHA40_PATTERN.test(text)) {
    throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_BUILD_COMMIT_INVALID');
  }
  return text;
}

function requiredToken(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_TOKEN_REQUIRED');
  return text;
}

function requiredFetch(value) {
  if (typeof value !== 'function') {
    throw new CloudflareDeploymentDiscoveryError('CF_DEPLOYMENT_DISCOVERY_FETCH_INVALID');
  }
  return value;
}

function safeStringArray(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.map((entry) => String(entry ?? '').trim()).filter(Boolean));
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}
