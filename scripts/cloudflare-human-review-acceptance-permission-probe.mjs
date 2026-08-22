import { mkdir, writeFile } from 'node:fs/promises';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const PROD_BASE_URL = (process.env.PROD_BASE_URL || 'https://ads-operations-web-prod.tanshiyuesir.workers.dev').replace(/\/$/, '');
const PROD_ACCESS_DOMAIN = new URL(PROD_BASE_URL).hostname;
const PROD_ACCESS_APP_ID = required('PROD_ACCESS_APP_ID');
const CONTROL_DB_ID = process.env.PROD_CONTROL_DB_ID || '2122248c-1fd4-4ccd-b611-9f9d2f3decbf';
const PROD_TRIGGER_UUID = process.env.PROD_TRIGGER_UUID || 'fa90d482-de7b-466b-9ada-04404569ede9';
const DEV_WORKER = process.env.DEV_WORKER || 'ads-operations-web-dev';
const PROD_WORKER = process.env.PROD_WORKER || 'ads-operations-web-prod';
const PROD_SYNC_WORKER = process.env.PROD_SYNC_WORKER || 'ads-operations-sync-prod';
const PROD_WORKER_TAG = required('PROD_WORKER_TAG');
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/cloudflare-human-review-acceptance-permission-probe';

await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'cloudflare-human-review-acceptance-permission-probe-v2',
  runId: RUN_ID,
  targetAccountId: ACCOUNT_ID,
  targetProductionDomain: PROD_ACCESS_DOMAIN,
  targetProductionAccessAppId: PROD_ACCESS_APP_ID,
  startedAt: new Date().toISOString(),
  sideEffectPolicy: 'GET-only except D1 SELECT 1 query; no Access/D1/Worker/Build mutation',
  capabilities: {},
  runtime: {},
  checks: {},
  result: 'FAIL',
};

let failure = null;

try {
  const accessApp = await probe('productionAccessAppRead', `/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}`);
  receipt.runtime.productionAccessAppVisible = accessApp.status === 200;
  if (accessApp.status === 200 && accessApp.result) {
    receipt.runtime.productionAccessApp = {
      id: accessApp.result.id || null,
      name: accessApp.result.name || null,
      domain: accessApp.result.domain || null,
    };
    receipt.checks.productionAccessAppResolved = String(accessApp.result.domain || '').toLowerCase() === PROD_ACCESS_DOMAIN.toLowerCase();
  } else {
    receipt.checks.productionAccessAppResolved = false;
  }

  await probe('accessPoliciesRead', `/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies`);
  await probe('accessServiceTokensList', '/access/service_tokens');

  await probe('d1MetadataRead', `/d1/database/${encodeURIComponent(CONTROL_DB_ID)}`);
  await probeD1Select();

  const workers = await probe('workersScriptsRead', '/workers/scripts');
  const workerList = Array.isArray(workers.result) ? workers.result : [];
  const dev = workerList.find((worker) => worker?.id === DEV_WORKER);
  const prod = workerList.find((worker) => worker?.id === PROD_WORKER);
  const sync = workerList.find((worker) => worker?.id === PROD_SYNC_WORKER);
  receipt.runtime.expectedWorkersVisible = Boolean(dev?.id && prod?.id && sync?.id);
  if (receipt.runtime.expectedWorkersVisible) {
    receipt.runtime.workerTags = { dev: dev.tag || null, production: prod.tag || null, productionSync: sync.tag || null };
  }

  const devDeployments = await probe('devRuntimeMetadataRead', `/workers/scripts/${encodeURIComponent(DEV_WORKER)}/deployments`);
  const prodDeployments = await probe('productionRuntimeMetadataRead', `/workers/scripts/${encodeURIComponent(PROD_WORKER)}/deployments`);
  const syncSchedules = await probe('productionSyncSchedulesRead', `/workers/scripts/${encodeURIComponent(PROD_SYNC_WORKER)}/schedules`);
  receipt.runtime.devDeploymentCount = collectionSize(devDeployments.result);
  receipt.runtime.productionDeploymentCount = collectionSize(prodDeployments.result);
  receipt.runtime.productionSyncScheduleCount = collectionSize(syncSchedules.result);

  await probe('workersBuildTriggerMetadataRead', `/builds/triggers/${encodeURIComponent(PROD_TRIGGER_UUID)}/environment_variables`);
  const latestBuild = await probe('workersBuildMetadataRead', `/builds/builds/latest?external_script_ids=${encodeURIComponent(PROD_WORKER_TAG)}`);
  receipt.runtime.productionLatestBuildVisible = latestBuild.status === 200;

  const accessKeys = ['productionAccessAppRead', 'accessPoliciesRead', 'accessServiceTokensList'];
  const nonAccessKeys = [
    'd1MetadataRead',
    'd1SelectQuery',
    'workersScriptsRead',
    'devRuntimeMetadataRead',
    'productionRuntimeMetadataRead',
    'productionSyncSchedulesRead',
    'workersBuildTriggerMetadataRead',
    'workersBuildMetadataRead',
  ];

  const accessPass = accessKeys.every((key) => receipt.capabilities[key]?.ok === true) && receipt.checks.productionAccessAppResolved === true;
  const nonAccessPass = nonAccessKeys.every((key) => receipt.capabilities[key]?.ok === true);
  receipt.checks.accessApiReadCapability = accessPass;
  receipt.checks.d1WorkersBuildsRuntimeReadCapability = nonAccessPass;

  const accessDeniedOrHidden = accessKeys.some((key) => [403, 404].includes(receipt.capabilities[key]?.status));
  if (accessPass && nonAccessPass) {
    receipt.result = 'PASS';
  } else if (!accessPass && nonAccessPass && accessDeniedOrHidden) {
    receipt.result = 'BLOCKED_BY_CLOUDFLARE_ACCESS_TOKEN_PERMISSION';
  } else {
    receipt.result = 'FAIL';
  }
} catch (error) {
  failure = error;
  receipt.error = { message: scrub(error?.message || String(error)) };
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({
    result: receipt.result,
    checks: receipt.checks,
    capabilityStatuses: Object.fromEntries(Object.entries(receipt.capabilities).map(([key, value]) => [key, value.status])),
  }));
}

if (receipt.result !== 'PASS') {
  if (failure) console.error(scrub(failure?.message || String(failure)));
  process.exitCode = 1;
}

async function probe(name, path) {
  const response = await cf(path, { method: 'GET' });
  receipt.capabilities[name] = capabilitySummary(response);
  return { status: response.status, result: response.body?.result };
}

async function probeD1Select() {
  const path = `/d1/database/${encodeURIComponent(CONTROL_DB_ID)}/query`;
  const response = await cf(path, {
    method: 'POST',
    body: { sql: 'SELECT 1 AS permission_probe' },
    allowReadOnlyD1Query: true,
  });
  receipt.capabilities.d1SelectQuery = capabilitySummary(response);
}

function capabilitySummary(response) {
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300 && response.body?.success !== false,
    errorCodes: Array.isArray(response.body?.errors)
      ? response.body.errors.map((error) => error?.code).filter((value) => value != null)
      : [],
  };
}

async function cf(path, { method, body = undefined, allowReadOnlyD1Query = false }) {
  if (method !== 'GET') {
    const sql = String(body?.sql || '').trim();
    const d1ReadOnly = allowReadOnlyD1Query
      && method === 'POST'
      && /\/d1\/database\/[^/]+\/query$/.test(path)
      && /^SELECT\s+1\s+AS\s+permission_probe\s*;?$/i.test(sql);
    if (!d1ReadOnly) throw new Error(`Probe refused non-read-only Cloudflare request: ${method} ${path}`);
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

function collectionSize(result) {
  if (Array.isArray(result)) return result.length;
  if (Array.isArray(result?.deployments)) return result.deployments.length;
  if (Array.isArray(result?.schedules)) return result.schedules.length;
  return null;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function scrub(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/CF-Access-Client-Secret[^\s,]*/gi, 'CF-Access-Client-Secret=[REDACTED]');
}
