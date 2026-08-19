const SHA40_PATTERN = /^[0-9a-f]{40}$/i;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const WORKER_TAG_PATTERN = /^[0-9a-f]{32}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export class DeploymentIntegrityReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DeploymentIntegrityReceiptError';
    this.code = code;
  }
}

export function createDeploymentIntegrityReceipt(input = {}) {
  const repository = requiredRepository(input.repository);
  const commitSha = requiredSha(input.commitSha, 'DEPLOYMENT_RECEIPT_COMMIT_SHA_INVALID');
  const githubWorkflowRunId = requiredPositiveInteger(
    input.githubWorkflowRunId,
    'DEPLOYMENT_RECEIPT_GITHUB_RUN_ID_INVALID',
  );
  const githubRequiredContext = requiredText(
    input.githubRequiredContext,
    'DEPLOYMENT_RECEIPT_GITHUB_CONTEXT_INVALID',
    255,
  );
  const cloudflareAccountId = requiredAccountId(input.cloudflareAccountId);
  const workerName = requiredWorkerName(input.workerName);
  const workerTag = requiredWorkerTag(input.workerTag);
  const triggerUuid = requiredUuid(input.triggerUuid, 'DEPLOYMENT_RECEIPT_TRIGGER_UUID_INVALID');
  const buildUuid = requiredUuid(input.buildUuid, 'DEPLOYMENT_RECEIPT_BUILD_UUID_INVALID');
  const buildOutcome = requiredText(input.buildOutcome, 'DEPLOYMENT_RECEIPT_BUILD_OUTCOME_INVALID', 64);
  if (buildOutcome !== 'success') {
    throw new DeploymentIntegrityReceiptError(`DEPLOYMENT_RECEIPT_BUILD_NOT_SUCCESS:${buildOutcome}`);
  }
  const buildCommitSha = requiredSha(
    input.buildCommitSha,
    'DEPLOYMENT_RECEIPT_BUILD_COMMIT_SHA_INVALID',
  );
  if (buildCommitSha !== commitSha) {
    throw new DeploymentIntegrityReceiptError(
      `DEPLOYMENT_RECEIPT_COMMIT_MISMATCH:${buildCommitSha}:${commitSha}`,
    );
  }
  const versionId = requiredUuid(input.versionId, 'DEPLOYMENT_RECEIPT_VERSION_ID_INVALID');
  const deploymentId = requiredUuid(input.deploymentId, 'DEPLOYMENT_RECEIPT_DEPLOYMENT_ID_INVALID');
  const liveRuntimeVersionId = requiredUuid(
    input.liveRuntimeVersionId,
    'DEPLOYMENT_RECEIPT_LIVE_VERSION_ID_INVALID',
  );
  if (liveRuntimeVersionId !== versionId) {
    throw new DeploymentIntegrityReceiptError(
      `DEPLOYMENT_RECEIPT_LIVE_VERSION_MISMATCH:${liveRuntimeVersionId}:${versionId}`,
    );
  }
  const acceptedAt = requiredIsoTimestamp(input.acceptedAt);

  return deepFreeze({
    schemaVersion: 'cloudflare-deployment-receipt-v1',
    repository,
    commitSha,
    githubWorkflowRunId,
    githubRequiredContext,
    cloudflareAccountId,
    workerName,
    workerTag,
    triggerUuid,
    buildUuid,
    buildOutcome,
    buildCommitSha,
    versionId,
    deploymentId,
    liveRuntimeVersionId,
    acceptedAt,
  });
}

export function createDeploymentReleaseTrace(input = {}) {
  const gitCommitSha = requiredSha(input.gitCommitSha, 'RELEASE_TRACE_GIT_COMMIT_SHA_INVALID');
  const workersBuildUuid = requiredUuid(input.workersBuildUuid, 'RELEASE_TRACE_BUILD_UUID_INVALID');
  const workersBuildTriggerUuid = requiredUuid(input.workersBuildTriggerUuid, 'RELEASE_TRACE_TRIGGER_UUID_INVALID');
  const workerVersionId = requiredUuid(input.workerVersionId, 'RELEASE_TRACE_VERSION_ID_INVALID');
  const deploymentId = requiredUuid(input.deploymentId, 'RELEASE_TRACE_DEPLOYMENT_ID_INVALID');
  const deployedAt = requiredRfc3339UtcTimestamp(input.deployedAt, 'RELEASE_TRACE_DEPLOYED_AT_INVALID');
  const environment = requiredEnvironment(input.environment);
  const workerName = requiredWorkerName(input.workerName);

  return deepFreeze({
    schemaVersion: 'cloudflare-release-trace-v1',
    gitCommitSha,
    workersBuildUuid,
    workersBuildTriggerUuid,
    workerVersionId,
    deploymentId,
    deployedAt,
    environment,
    workerName,
  });
}

export function releaseTraceFromDeploymentIntegrityReceipt(receipt, deployment = {}) {
  const validated = createDeploymentIntegrityReceipt(receipt);
  return createDeploymentReleaseTrace({
    gitCommitSha: validated.commitSha,
    workersBuildUuid: validated.buildUuid,
    workersBuildTriggerUuid: validated.triggerUuid,
    workerVersionId: validated.versionId,
    deploymentId: validated.deploymentId,
    deployedAt: deployment.deployedAt ?? validated.acceptedAt,
    environment: deployment.environment,
    workerName: validated.workerName,
  });
}

export function serializeDeploymentIntegrityReceipt(receipt) {
  const validated = createDeploymentIntegrityReceipt(receipt);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function serializeDeploymentReleaseTrace(trace) {
  const validated = createDeploymentReleaseTrace(trace);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

function requiredRepository(value) {
  const text = requiredText(value, 'DEPLOYMENT_RECEIPT_REPOSITORY_INVALID', 255);
  if (!REPOSITORY_PATTERN.test(text)) {
    throw new DeploymentIntegrityReceiptError('DEPLOYMENT_RECEIPT_REPOSITORY_INVALID');
  }
  return text;
}

function requiredAccountId(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(text)) {
    throw new DeploymentIntegrityReceiptError('DEPLOYMENT_RECEIPT_ACCOUNT_ID_INVALID');
  }
  return text;
}

function requiredWorkerName(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 255 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new DeploymentIntegrityReceiptError('DEPLOYMENT_RECEIPT_WORKER_NAME_INVALID');
  }
  return text;
}

function requiredWorkerTag(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!WORKER_TAG_PATTERN.test(text)) {
    throw new DeploymentIntegrityReceiptError('DEPLOYMENT_RECEIPT_WORKER_TAG_INVALID');
  }
  return text;
}

function requiredEnvironment(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!['development', 'production'].includes(text)) {
    throw new DeploymentIntegrityReceiptError('RELEASE_TRACE_ENVIRONMENT_INVALID');
  }
  return text;
}

function requiredUuid(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(text)) throw new DeploymentIntegrityReceiptError(code);
  return text;
}

function requiredSha(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!SHA40_PATTERN.test(text)) throw new DeploymentIntegrityReceiptError(code);
  return text;
}

function requiredPositiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new DeploymentIntegrityReceiptError(code);
  }
  return number;
}

function requiredText(value, code, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new DeploymentIntegrityReceiptError(code);
  }
  return text;
}

function requiredIsoTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new DeploymentIntegrityReceiptError('DEPLOYMENT_RECEIPT_ACCEPTED_AT_INVALID');
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    throw new DeploymentIntegrityReceiptError('DEPLOYMENT_RECEIPT_ACCEPTED_AT_INVALID');
  }
  return text;
}

function requiredRfc3339UtcTimestamp(value, code) {
  const text = String(value ?? '').trim();
  if (!RFC3339_UTC_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw new DeploymentIntegrityReceiptError(code);
  }
  return text;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
