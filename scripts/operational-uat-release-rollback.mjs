import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const SCRIPT_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const DEFAULT_HEALTH_ATTEMPTS = 30;
const DEFAULT_HEALTH_DELAY_MS = 2000;

export class OperationalUatReleaseRollbackError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'OperationalUatReleaseRollbackError';
    this.code = code;
    this.cause = cause;
  }
}

export async function runOperationalUatReleaseRollback(options = {}) {
  const accountId = requiredAccountId(options.accountId);
  const token = requiredText(options.token, 'OP_UAT_ROLLBACK_TOKEN_REQUIRED');
  const scriptName = requiredScriptName(options.scriptName);
  const healthUrl = requiredHealthUrl(options.healthUrl);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const sleepImpl = typeof options.sleepImpl === 'function'
    ? options.sleepImpl
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const attempts = positiveInteger(options.healthAttempts ?? DEFAULT_HEALTH_ATTEMPTS, 'OP_UAT_ROLLBACK_ATTEMPTS_INVALID');
  const delayMs = nonNegativeInteger(options.healthDelayMs ?? DEFAULT_HEALTH_DELAY_MS, 'OP_UAT_ROLLBACK_DELAY_INVALID');

  const before = await listDeployments({ accountId, token, scriptName, fetchImpl });
  const restoreVersionId = activeSingleVersion(before);
  const rollbackVersionId = previousSingleVersion(before, restoreVersionId);
  const evidence = {
    schema: 'operational-uat-release-rollback-v1',
    caseId: 'failure.release-rollback',
    verified: false,
    amazonExecutionAttempted: false,
    crossStoreLeakageDetected: false,
    fabricatedZeroPerformance: false,
    businessFactPersistenceAttempted: false,
    failClosed: true,
    workerName: scriptName,
    restoreVersionId,
    rollbackVersionId,
    rollbackDeploymentId: null,
    restoreDeploymentId: null,
    rollbackRuntimeObserved: false,
    restoreRuntimeObserved: false,
    restoredInFinally: false,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  let primaryError = null;
  try {
    const rollback = await createDeployment({
      accountId,
      token,
      scriptName,
      versionId: rollbackVersionId,
      message: `Operational UAT rollback drill: ${restoreVersionId} -> ${rollbackVersionId}`,
      fetchImpl,
    });
    evidence.rollbackDeploymentId = rollback.deploymentId;
    await waitForRuntimeVersion({ healthUrl, expectedVersionId: rollbackVersionId, fetchImpl, sleepImpl, attempts, delayMs });
    evidence.rollbackRuntimeObserved = true;
  } catch (error) {
    primaryError = normalizeError(error);
  } finally {
    try {
      const restore = await createDeployment({
        accountId,
        token,
        scriptName,
        versionId: restoreVersionId,
        message: `Operational UAT restore after rollback drill: ${restoreVersionId}`,
        fetchImpl,
      });
      evidence.restoreDeploymentId = restore.deploymentId;
      evidence.restoredInFinally = true;
      await waitForRuntimeVersion({ healthUrl, expectedVersionId: restoreVersionId, fetchImpl, sleepImpl, attempts, delayMs });
      evidence.restoreRuntimeObserved = true;
    } catch (restoreError) {
      evidence.completedAt = new Date().toISOString();
      throw new OperationalUatReleaseRollbackError(
        `OP_UAT_ROLLBACK_RESTORE_FAILED:${normalizeError(restoreError)}`,
        primaryError ? new Error(primaryError) : restoreError,
      );
    }
  }

  evidence.completedAt = new Date().toISOString();
  if (primaryError) throw new OperationalUatReleaseRollbackError(`OP_UAT_ROLLBACK_PRIMARY_FAILED:${primaryError}`);
  evidence.verified = evidence.rollbackRuntimeObserved === true
    && evidence.restoreRuntimeObserved === true
    && evidence.restoredInFinally === true
    && evidence.rollbackVersionId !== evidence.restoreVersionId;
  if (!evidence.verified) throw new OperationalUatReleaseRollbackError('OP_UAT_ROLLBACK_EVIDENCE_INCOMPLETE');
  return Object.freeze(evidence);
}

export async function listDeployments({ accountId, token, scriptName, fetchImpl = fetch }) {
  const body = await cloudflareRequest({
    accountId,
    token,
    fetchImpl,
    method: 'GET',
    path: `/workers/scripts/${encodeURIComponent(scriptName)}/deployments`,
    code: 'OP_UAT_ROLLBACK_LIST_DEPLOYMENTS_FAILED',
  });
  const deployments = body?.result?.deployments;
  if (!Array.isArray(deployments) || deployments.length < 2) {
    throw new OperationalUatReleaseRollbackError('OP_UAT_ROLLBACK_DEPLOYMENT_HISTORY_INSUFFICIENT');
  }
  return deployments;
}

export function activeSingleVersion(deployments) {
  const active = deployments?.[0];
  const versions = Array.isArray(active?.versions) ? active.versions : [];
  if (versions.length !== 1 || Number(versions[0]?.percentage) !== 100) {
    throw new OperationalUatReleaseRollbackError('OP_UAT_ROLLBACK_ACTIVE_DEPLOYMENT_NOT_SINGLE_100');
  }
  return requiredUuid(versions[0].version_id, 'OP_UAT_ROLLBACK_ACTIVE_VERSION_INVALID');
}

export function previousSingleVersion(deployments, activeVersionId) {
  for (const deployment of deployments.slice(1)) {
    const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
    if (versions.length !== 1 || Number(versions[0]?.percentage) !== 100) continue;
    const candidate = requiredUuid(versions[0].version_id, 'OP_UAT_ROLLBACK_PREVIOUS_VERSION_INVALID');
    if (candidate !== activeVersionId) return candidate;
  }
  throw new OperationalUatReleaseRollbackError('OP_UAT_ROLLBACK_PREVIOUS_VERSION_NOT_FOUND');
}

export async function createDeployment({ accountId, token, scriptName, versionId, message, fetchImpl = fetch }) {
  const body = await cloudflareRequest({
    accountId,
    token,
    fetchImpl,
    method: 'POST',
    path: `/workers/scripts/${encodeURIComponent(scriptName)}/deployments`,
    code: 'OP_UAT_ROLLBACK_CREATE_DEPLOYMENT_FAILED',
    json: {
      strategy: 'percentage',
      versions: [{ percentage: 100, version_id: requiredUuid(versionId, 'OP_UAT_ROLLBACK_VERSION_INVALID') }],
      annotations: {
        'workers/message': String(message || '').slice(0, 900),
        'workers/triggered_by': 'operational-uat-release-rollback',
      },
    },
  });
  const result = body?.result;
  const deploymentId = requiredUuid(result?.id, 'OP_UAT_ROLLBACK_DEPLOYMENT_ID_INVALID');
  const deployed = Array.isArray(result?.versions) ? result.versions : [];
  if (deployed.length !== 1
      || Number(deployed[0]?.percentage) !== 100
      || requiredUuid(deployed[0]?.version_id, 'OP_UAT_ROLLBACK_DEPLOYED_VERSION_INVALID') !== versionId) {
    throw new OperationalUatReleaseRollbackError('OP_UAT_ROLLBACK_DEPLOYMENT_RECEIPT_INVALID');
  }
  return Object.freeze({ deploymentId, versionId });
}

export async function waitForRuntimeVersion({ healthUrl, expectedVersionId, fetchImpl = fetch, sleepImpl, attempts, delayMs }) {
  const expected = requiredUuid(expectedVersionId, 'OP_UAT_ROLLBACK_EXPECTED_VERSION_INVALID');
  let last = 'no_response';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const url = new URL(healthUrl);
      url.searchParams.set('__operationalUatRollback', `${Date.now()}-${attempt}`);
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache', 'user-agent': 'ads-operations-integrity-operational-uat-rollback/1.0' },
      });
      const text = await response.text();
      last = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      if (response.ok) {
        const payload = JSON.parse(text);
        const actual = String(payload?.deployment?.versionId || '').trim().toLowerCase();
        if (actual === expected) {
          return Object.freeze({ versionId: actual, environment: payload?.environment || null, ok: payload?.ok === true });
        }
      }
    } catch (error) {
      last = normalizeError(error);
    }
    if (attempt < attempts) await sleepImpl(delayMs);
  }
  throw new OperationalUatReleaseRollbackError(`OP_UAT_ROLLBACK_RUNTIME_VERSION_TIMEOUT:${expected}:${last}`);
}

async function cloudflareRequest({ accountId, token, fetchImpl, method, path, code, json = null }) {
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/accounts/${encodeURIComponent(accountId)}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });
  } catch (error) {
    throw new OperationalUatReleaseRollbackError(code, error);
  }
  let body = null;
  try { body = await response.json(); }
  catch (error) {
    throw new OperationalUatReleaseRollbackError(`${code}:JSON_INVALID`, error);
  }
  if (!response.ok || body?.success !== true) {
    const apiCode = body?.errors?.[0]?.code ?? 'UNKNOWN';
    throw new OperationalUatReleaseRollbackError(`${code}:HTTP_${response.status}:API_${apiCode}`);
  }
  return body;
}

function requiredAccountId(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(text)) throw new OperationalUatReleaseRollbackError('OP_UAT_ROLLBACK_ACCOUNT_ID_INVALID');
  return text;
}

function requiredScriptName(value) {
  const text = String(value || '').trim();
  if (!SCRIPT_PATTERN.test(text)) throw new OperationalUatReleaseRollbackError('OP_UAT_ROLLBACK_SCRIPT_NAME_INVALID');
  return text;
}

function requiredHealthUrl(value) {
  const url = new URL(requiredText(value, 'OP_UAT_ROLLBACK_HEALTH_URL_REQUIRED'));
  if (url.protocol !== 'https:' || url.pathname !== '/api/health') {
    throw new OperationalUatReleaseRollbackError('OP_UAT_ROLLBACK_HEALTH_URL_INVALID');
  }
  return url.toString();
}

function requiredUuid(value, code) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(text)) throw new OperationalUatReleaseRollbackError(code);
  return text;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new OperationalUatReleaseRollbackError(code);
  return text;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new OperationalUatReleaseRollbackError(code);
  return number;
}

function nonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new OperationalUatReleaseRollbackError(code);
  return number;
}

function normalizeError(error) {
  return String(error?.code || error?.message || error || 'unknown_error').slice(0, 500);
}

async function main() {
  const confirmation = String(process.env.OPERATIONAL_UAT_ROLLBACK_CONFIRM || '').trim();
  if (confirmation !== 'ROLLBACK_AND_RESTORE_PRODUCTION') {
    throw new OperationalUatReleaseRollbackError('OP_UAT_ROLLBACK_CONFIRMATION_REQUIRED');
  }
  const outputPath = String(process.env.OPERATIONAL_UAT_ROLLBACK_OUTPUT || 'artifacts/operational-uat-release-rollback.json').trim();
  const evidence = await runOperationalUatReleaseRollback({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    scriptName: process.env.OPERATIONAL_UAT_WORKER_NAME || 'ads-operations-web-prod',
    healthUrl: process.env.OPERATIONAL_UAT_HEALTH_URL || 'https://ads-operations-web-prod.tanshiyuesir.workers.dev/api/health',
    healthAttempts: process.env.OPERATIONAL_UAT_HEALTH_ATTEMPTS || DEFAULT_HEALTH_ATTEMPTS,
    healthDelayMs: process.env.OPERATIONAL_UAT_HEALTH_DELAY_MS || DEFAULT_HEALTH_DELAY_MS,
  });
  await fs.mkdir(new URL('../artifacts/', import.meta.url), { recursive: true }).catch(() => {});
  await fs.mkdir(outputPath.includes('/') ? outputPath.slice(0, outputPath.lastIndexOf('/')) : '.', { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(evidence));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      caseId: 'failure.release-rollback',
      error: normalizeError(error),
      amazonExecutionAttempted: false,
      businessFactPersistenceAttempted: false,
    }));
    process.exitCode = 1;
  });
}
