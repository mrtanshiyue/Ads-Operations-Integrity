import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverWorkerDeploymentTopology } from './cloudflare-deployment-discovery-client.mjs';
import {
  createDeploymentReleaseTrace,
  serializeDeploymentReleaseTrace,
} from './deployment-integrity-receipt.mjs';

const SHA40_PATTERN = /^[0-9a-f]{40}$/i;
const ENVIRONMENTS = new Set(['development', 'production']);

export class CloudflareReleaseTraceAutomationError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareReleaseTraceAutomationError';
    this.code = code;
    this.cause = cause;
  }
}

export function releaseTraceFromTopology(topology, options = {}) {
  const expectedCommitSha = requiredSha(options.expectedCommitSha);
  const environment = requiredEnvironment(options.environment);
  const workerName = requiredText(options.workerName, 'RELEASE_TRACE_WORKER_NAME_REQUIRED');

  if (String(topology?.workerName || '') !== workerName) {
    throw new CloudflareReleaseTraceAutomationError(
      `RELEASE_TRACE_WORKER_MISMATCH:${String(topology?.workerName || 'missing')}:${workerName}`,
    );
  }

  const activeBuild = topology?.activeBuild || {};
  const activeDeployment = topology?.activeDeployment || {};
  const activeVersion = topology?.activeVersion || {};

  if (String(activeBuild.commitSha || '').toLowerCase() !== expectedCommitSha) {
    throw new CloudflareReleaseTraceAutomationError(
      `RELEASE_TRACE_COMMIT_NOT_LIVE:${String(activeBuild.commitSha || 'missing')}:${expectedCommitSha}`,
    );
  }
  if (String(activeBuild.outcome || '').toLowerCase() !== 'success') {
    throw new CloudflareReleaseTraceAutomationError(
      `RELEASE_TRACE_BUILD_NOT_SUCCESS:${String(activeBuild.outcome || activeBuild.status || 'missing')}`,
    );
  }
  if (String(activeDeployment.versionId || '').toLowerCase() !== String(activeVersion.versionId || '').toLowerCase()) {
    throw new CloudflareReleaseTraceAutomationError(
      `RELEASE_TRACE_VERSION_MISMATCH:${String(activeDeployment.versionId || 'missing')}:${String(activeVersion.versionId || 'missing')}`,
    );
  }
  if (Number(activeDeployment.percentage) !== 100) {
    throw new CloudflareReleaseTraceAutomationError(
      `RELEASE_TRACE_TRAFFIC_NOT_FULL:${String(activeDeployment.percentage ?? 'missing')}`,
    );
  }

  return createDeploymentReleaseTrace({
    gitCommitSha: expectedCommitSha,
    workersBuildUuid: activeBuild.buildUuid,
    workersBuildTriggerUuid: activeBuild.triggerUuid,
    workerVersionId: activeVersion.versionId,
    deploymentId: activeDeployment.deploymentId,
    deployedAt: requiredDeployedAt(activeDeployment.createdOn),
    environment,
    workerName,
  });
}

export async function waitForReleaseTrace(options = {}) {
  const expectedCommitSha = requiredSha(options.expectedCommitSha);
  const environment = requiredEnvironment(options.environment);
  const workerName = requiredText(options.workerName, 'RELEASE_TRACE_WORKER_NAME_REQUIRED');
  const accountId = requiredText(options.accountId, 'RELEASE_TRACE_ACCOUNT_ID_REQUIRED');
  const token = requiredText(options.token, 'RELEASE_TRACE_API_TOKEN_REQUIRED');
  const attempts = boundedInteger(options.attempts, 1, 120, 30);
  const delayMs = boundedInteger(options.delayMs, 0, 120000, 20000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const discover = options.discover ?? discoverWorkerDeploymentTopology;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const topology = await discover({ accountId, scriptName: workerName, token, fetchImpl });
      const trace = releaseTraceFromTopology(topology, { expectedCommitSha, environment, workerName });
      return Object.freeze({ trace, topology, attempt });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;
      await sleep(delayMs);
    }
  }

  throw new CloudflareReleaseTraceAutomationError(
    `RELEASE_TRACE_NOT_READY:${String(lastError?.code || lastError?.message || 'unknown')}`,
    lastError,
  );
}

export async function generateReleaseTraceFile(options = {}) {
  const result = await waitForReleaseTrace(options);
  const outputPath = resolve(requiredText(options.outputPath, 'RELEASE_TRACE_OUTPUT_PATH_REQUIRED'));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeDeploymentReleaseTrace(result.trace), 'utf8');
  return Object.freeze({ ...result, outputPath });
}

function isRetryable(error) {
  const code = String(error?.code || error?.message || '');
  return code.startsWith('RELEASE_TRACE_COMMIT_NOT_LIVE:')
    || code.startsWith('RELEASE_TRACE_BUILD_NOT_SUCCESS:')
    || code.startsWith('CF_DEPLOYMENT_DISCOVERY_');
}

function requiredSha(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!SHA40_PATTERN.test(text)) throw new CloudflareReleaseTraceAutomationError('RELEASE_TRACE_EXPECTED_SHA_INVALID');
  return text;
}
function requiredEnvironment(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!ENVIRONMENTS.has(text)) throw new CloudflareReleaseTraceAutomationError('RELEASE_TRACE_ENVIRONMENT_INVALID');
  return text;
}
function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CloudflareReleaseTraceAutomationError(code);
  return text;
}
function requiredDeployedAt(value) {
  const text = requiredText(value, 'RELEASE_TRACE_DEPLOYED_AT_REQUIRED');
  if (Number.isNaN(Date.parse(text))) throw new CloudflareReleaseTraceAutomationError('RELEASE_TRACE_DEPLOYED_AT_INVALID');
  return new Date(text).toISOString();
}
function boundedInteger(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new CloudflareReleaseTraceAutomationError('RELEASE_TRACE_POLL_CONFIG_INVALID');
  }
  return number;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const environment = process.env.RELEASE_TRACE_ENVIRONMENT;
  const workerName = process.env.RELEASE_TRACE_WORKER_NAME;
  const outputPath = process.env.RELEASE_TRACE_OUTPUT_PATH
    || `artifacts/cloudflare-release-trace-${String(environment || 'unknown').toLowerCase()}.json`;
  const result = await generateReleaseTraceFile({
    expectedCommitSha: process.env.EXPECTED_GIT_SHA || process.env.GITHUB_SHA,
    environment,
    workerName,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    outputPath,
    attempts: process.env.RELEASE_TRACE_ATTEMPTS,
    delayMs: process.env.RELEASE_TRACE_DELAY_MS,
  });
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: result.trace.schemaVersion,
    gitCommitSha: result.trace.gitCommitSha,
    workersBuildUuid: result.trace.workersBuildUuid,
    workersBuildTriggerUuid: result.trace.workersBuildTriggerUuid,
    workerVersionId: result.trace.workerVersionId,
    deploymentId: result.trace.deploymentId,
    environment: result.trace.environment,
    workerName: result.trace.workerName,
    attempts: result.attempt,
    outputPath: result.outputPath,
  }, null, 2));
}
