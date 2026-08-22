import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const SHA40 = /^[0-9a-f]{40}$/i;

export function buildProductionClosureStatus(input = {}) {
  const mainSha = requiredSha(input.mainSha, 'CLOSURE_OBSERVABILITY_MAIN_SHA_INVALID');
  const dev = normalizeRuntime(input.dev, 'DEV');
  const prod = normalizeRuntime(input.prod, 'PROD');
  const hardOff = normalizeHardOff(input.hardOff);

  const devExactMain = dev.sourceCommit === mainSha;
  const prodExactMain = prod.sourceCommit === mainSha;
  const bothFullTraffic = dev.traffic === 100 && prod.traffic === 100;
  const runtimeParity = devExactMain && prodExactMain && bothFullTraffic;
  const stagedRuntimeDrift = dev.sourceCommit !== prod.sourceCommit;

  const blockers = [];
  if (!devExactMain) blockers.push('dev_not_exact_main');
  if (!prodExactMain) blockers.push('production_not_exact_main');
  if (dev.traffic !== 100) blockers.push('dev_traffic_not_100_percent');
  if (prod.traffic !== 100) blockers.push('production_traffic_not_100_percent');
  if (hardOff.status !== 'HARD_OFF') blockers.push('amazon_transport_not_hard_off');

  const formalGate = runtimeParity && hardOff.status === 'HARD_OFF'
    ? 'requires_formal_rerun'
    : 'blocked_by_live_runtime_gate';

  return deepFreeze({
    schemaVersion: 'production-closure-observability-v1',
    authority: 'live-cloudflare-control-plane-read-only',
    generatedAt: requiredText(input.generatedAt, 'CLOSURE_OBSERVABILITY_GENERATED_AT_REQUIRED'),
    canonicalMainSha: mainSha,
    development: dev,
    production: prod,
    runtimeParity: {
      status: runtimeParity ? 'exact_main_100_percent' : 'blocked',
      devExactMain,
      prodExactMain,
      bothFullTraffic,
      stagedRuntimeDrift,
    },
    amazonHardOff: hardOff,
    productionSyncSchedules: hardOff.schedules,
    formalClosure: {
      releaseTrace: formalGate,
      driftReceipt: formalGate,
      productionBaseline: formalGate,
      finalClosure: blockers.length === 0 ? 'requires_formal_evidence' : 'blocked',
      note: blockers.length === 0
        ? 'Live runtime gates are satisfied; formal Release Trace, Drift Receipt, Production Baseline, and acceptance evidence must still be generated separately.'
        : 'Formal closure cannot be green while live runtime or Amazon HARD-OFF gates are blocked.',
    },
    blockers: [...new Set(blockers)].sort(),
  });
}

export function renderProductionClosureMarkdown(status) {
  const flag = (value) => value ? 'PASS' : 'BLOCKED';
  const rows = [
    ['Canonical main', `\`${status.canonicalMainSha}\``],
    ['Dev source', `\`${status.development.sourceCommit}\``],
    ['Dev version', `\`${status.development.versionId}\``],
    ['Dev traffic', `${status.development.traffic}%`],
    ['Production source', `\`${status.production.sourceCommit}\``],
    ['Production version', `\`${status.production.versionId}\``],
    ['Production traffic', `${status.production.traffic}%`],
    ['Dev exact-main', flag(status.runtimeParity.devExactMain)],
    ['Production exact-main', flag(status.runtimeParity.prodExactMain)],
    ['Staged runtime drift', status.runtimeParity.stagedRuntimeDrift ? 'YES' : 'NO'],
    ['Amazon HARD-OFF', status.amazonHardOff.status],
    ['Production Sync schedules', String(status.productionSyncSchedules.length)],
    ['Release Trace', status.formalClosure.releaseTrace],
    ['Drift Receipt', status.formalClosure.driftReceipt],
    ['Production Baseline', status.formalClosure.productionBaseline],
    ['Final closure', status.formalClosure.finalClosure],
  ];
  return [
    '# Production Closure Observability',
    '',
    `Generated: ${status.generatedAt}`,
    '',
    '| Signal | Live status |',
    '| --- | --- |',
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    '',
    `Blockers: ${status.blockers.length ? status.blockers.map((value) => `\`${value}\``).join(', ') : 'none from live runtime gates'}`,
    '',
    `> ${status.formalClosure.note}`,
    '',
    'This receipt is read-only observability. It does not deploy, write D1, mutate Access, trigger Sync, call Amazon, or replace formal Release Trace / Drift Receipt / Production Baseline evidence.',
    '',
  ].join('\n');
}

export async function collectProductionClosureStatus(options = {}) {
  const accountId = requiredText(options.accountId, 'CLOSURE_OBSERVABILITY_ACCOUNT_ID_REQUIRED');
  const token = requiredText(options.token, 'CLOSURE_OBSERVABILITY_TOKEN_REQUIRED');
  const mainSha = requiredSha(options.mainSha, 'CLOSURE_OBSERVABILITY_MAIN_SHA_INVALID');
  const fetchImpl = options.fetchImpl || fetch;
  const devWorker = options.devWorker || 'ads-operations-web-dev';
  const prodWorker = options.prodWorker || 'ads-operations-web-prod';
  const syncWorker = options.syncWorker || 'ads-operations-sync-prod';

  const workersBody = await cfGet({ accountId, token, fetchImpl, path: '/workers/scripts' });
  const workers = Array.isArray(workersBody?.result) ? workersBody.result : [];
  const workerTagByName = new Map(workers.map((worker) => [String(worker?.id || ''), String(worker?.tag || '')]));

  const [dev, prod, syncDeployment, syncSchedulesBody] = await Promise.all([
    collectRuntime({ accountId, token, fetchImpl, workerName: devWorker, workerTag: workerTagByName.get(devWorker) }),
    collectRuntime({ accountId, token, fetchImpl, workerName: prodWorker, workerTag: workerTagByName.get(prodWorker) }),
    getActiveDeployment({ accountId, token, fetchImpl, workerName: syncWorker }),
    cfGet({ accountId, token, fetchImpl, path: `/workers/scripts/${encodeURIComponent(syncWorker)}/schedules` }),
  ]);

  const [prodVersion, syncVersion] = await Promise.all([
    getVersion({ accountId, token, fetchImpl, workerName: prodWorker, versionId: prod.versionId }),
    getVersion({ accountId, token, fetchImpl, workerName: syncWorker, versionId: syncDeployment.versionId }),
  ]);

  const schedules = Array.isArray(syncSchedulesBody?.result?.schedules)
    ? syncSchedulesBody.result.schedules
    : Array.isArray(syncSchedulesBody?.result)
      ? syncSchedulesBody.result
      : null;
  if (!schedules) throw new Error('CLOSURE_OBSERVABILITY_SYNC_SCHEDULES_INVALID');

  const prodEnv = normalizeBindings(prodVersion);
  const syncEnv = normalizeBindings(syncVersion);

  return buildProductionClosureStatus({
    mainSha,
    generatedAt: new Date().toISOString(),
    dev,
    prod,
    hardOff: {
      syncTriggerEnabled: prodEnv.SYNC_TRIGGER_ENABLED,
      amazonAdsEnabled: syncEnv.AMAZON_ADS_ENABLED,
      phase5SingleRunPermitId: prodEnv.PHASE5_SINGLE_RUN_PERMIT_ID,
      phase5SingleRunReportDate: prodEnv.PHASE5_SINGLE_RUN_REPORT_DATE,
      schedules,
    },
  });
}

async function collectRuntime({ accountId, token, fetchImpl, workerName, workerTag }) {
  const tag = requiredText(workerTag, `CLOSURE_OBSERVABILITY_WORKER_TAG_REQUIRED:${workerName}`);
  const deployment = await getActiveDeployment({ accountId, token, fetchImpl, workerName });
  const buildsBody = await cfGet({
    accountId,
    token,
    fetchImpl,
    path: `/builds/builds?version_ids=${encodeURIComponent(deployment.versionId)}`,
  });
  const builds = buildsBody?.result?.builds;
  const build = builds && typeof builds === 'object' ? builds[deployment.versionId] : null;
  if (!build) throw new Error(`CLOSURE_OBSERVABILITY_ACTIVE_BUILD_MISSING:${workerName}`);
  const buildWorkerTag = String(build?.trigger?.external_script_id || '').trim();
  if (buildWorkerTag && buildWorkerTag !== tag) {
    throw new Error(`CLOSURE_OBSERVABILITY_BUILD_WORKER_MISMATCH:${workerName}`);
  }
  return {
    workerName,
    workerTag: tag,
    sourceCommit: requiredSha(build?.build_trigger_metadata?.commit_hash, `CLOSURE_OBSERVABILITY_SOURCE_SHA_INVALID:${workerName}`),
    buildUuid: requiredText(build?.build_uuid, `CLOSURE_OBSERVABILITY_BUILD_UUID_REQUIRED:${workerName}`),
    deploymentId: deployment.deploymentId,
    versionId: deployment.versionId,
    traffic: deployment.traffic,
    buildOutcome: String(build?.build_outcome || ''),
    buildTriggerSource: String(build?.build_trigger_metadata?.build_trigger_source || ''),
    buildTriggerUuid: String(build?.trigger?.trigger_uuid || ''),
  };
}

async function getActiveDeployment({ accountId, token, fetchImpl, workerName }) {
  const body = await cfGet({
    accountId,
    token,
    fetchImpl,
    path: `/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
  });
  const deployments = Array.isArray(body?.result?.deployments) ? body.result.deployments : [];
  if (!deployments.length) throw new Error(`CLOSURE_OBSERVABILITY_DEPLOYMENT_MISSING:${workerName}`);
  const active = deployments[0];
  const versions = Array.isArray(active?.versions) ? active.versions : [];
  if (versions.length !== 1) throw new Error(`CLOSURE_OBSERVABILITY_MULTI_VERSION_TRAFFIC:${workerName}`);
  return {
    deploymentId: requiredText(active?.id, `CLOSURE_OBSERVABILITY_DEPLOYMENT_ID_REQUIRED:${workerName}`),
    versionId: requiredText(versions[0]?.version_id, `CLOSURE_OBSERVABILITY_VERSION_ID_REQUIRED:${workerName}`),
    traffic: Number(versions[0]?.percentage),
  };
}

async function getVersion({ accountId, token, fetchImpl, workerName, versionId }) {
  const body = await cfGet({
    accountId,
    token,
    fetchImpl,
    path: `/workers/workers/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(versionId)}`,
  });
  if (!body?.result || typeof body.result !== 'object') {
    throw new Error(`CLOSURE_OBSERVABILITY_VERSION_INVALID:${workerName}`);
  }
  return body.result;
}

async function cfGet({ accountId, token, fetchImpl, path }) {
  const response = await fetchImpl(`${API_BASE}/accounts/${encodeURIComponent(accountId)}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (!response?.ok) throw new Error(`CLOSURE_OBSERVABILITY_CLOUDFLARE_GET_FAILED:${response?.status ?? 'UNKNOWN'}:${path}`);
  const body = await response.json();
  if (body?.success !== true) throw new Error(`CLOSURE_OBSERVABILITY_CLOUDFLARE_API_FAILED:${path}`);
  return body;
}

function normalizeRuntime(value, label) {
  const traffic = Number(value?.traffic);
  if (!Number.isFinite(traffic)) throw new Error(`CLOSURE_OBSERVABILITY_${label}_TRAFFIC_INVALID`);
  return deepFreeze({
    workerName: requiredText(value?.workerName, `CLOSURE_OBSERVABILITY_${label}_WORKER_REQUIRED`),
    workerTag: requiredText(value?.workerTag, `CLOSURE_OBSERVABILITY_${label}_WORKER_TAG_REQUIRED`),
    sourceCommit: requiredSha(value?.sourceCommit, `CLOSURE_OBSERVABILITY_${label}_SOURCE_SHA_INVALID`),
    buildUuid: requiredText(value?.buildUuid, `CLOSURE_OBSERVABILITY_${label}_BUILD_UUID_REQUIRED`),
    deploymentId: requiredText(value?.deploymentId, `CLOSURE_OBSERVABILITY_${label}_DEPLOYMENT_ID_REQUIRED`),
    versionId: requiredText(value?.versionId, `CLOSURE_OBSERVABILITY_${label}_VERSION_ID_REQUIRED`),
    traffic,
    buildOutcome: String(value?.buildOutcome || ''),
    buildTriggerSource: String(value?.buildTriggerSource || ''),
    buildTriggerUuid: String(value?.buildTriggerUuid || ''),
  });
}

function normalizeHardOff(value = {}) {
  const syncTriggerEnabled = normalizeBooleanText(value.syncTriggerEnabled, 'SYNC_TRIGGER_ENABLED');
  const amazonAdsEnabled = normalizeBooleanText(value.amazonAdsEnabled, 'AMAZON_ADS_ENABLED');
  const phase5SingleRunPermitId = String(value.phase5SingleRunPermitId ?? '');
  const phase5SingleRunReportDate = String(value.phase5SingleRunReportDate ?? '');
  if (!Array.isArray(value.schedules)) throw new Error('CLOSURE_OBSERVABILITY_SCHEDULES_INVALID');
  const schedules = [...value.schedules];
  const status = syncTriggerEnabled === false
    && amazonAdsEnabled === false
    && phase5SingleRunPermitId === ''
    && phase5SingleRunReportDate === ''
    && schedules.length === 0
    ? 'HARD_OFF'
    : 'VIOLATION';
  return deepFreeze({
    status,
    syncTriggerEnabled,
    amazonAdsEnabled,
    phase5SingleRunPermitId,
    phase5SingleRunReportDate,
    schedules,
  });
}

function normalizeBooleanText(value, key) {
  if (value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new Error(`CLOSURE_OBSERVABILITY_${key}_INVALID`);
}

function normalizeBindings(version) {
  const out = {};
  if (version?.env && typeof version.env === 'object') {
    for (const [name, binding] of Object.entries(version.env)) {
      if (binding?.type === 'plain_text') out[name] = String(binding.text ?? '');
    }
  }
  if (Array.isArray(version?.bindings)) {
    for (const binding of version.bindings) {
      if (binding?.type === 'plain_text' && binding?.name) out[binding.name] = String(binding.text ?? '');
    }
  }
  return out;
}

function requiredSha(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(text)) throw new Error(code);
  return text;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(code);
  return text;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

async function main() {
  const outputArg = process.argv.indexOf('--output');
  const summaryArg = process.argv.indexOf('--summary');
  const status = await collectProductionClosureStatus({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    mainSha: process.env.EXPECTED_MAIN_SHA,
  });
  const json = `${JSON.stringify(status, null, 2)}\n`;
  const markdown = renderProductionClosureMarkdown(status);
  if (outputArg >= 0 && process.argv[outputArg + 1]) await fs.writeFile(process.argv[outputArg + 1], json);
  else process.stdout.write(json);
  if (summaryArg >= 0 && process.argv[summaryArg + 1]) await fs.writeFile(process.argv[summaryArg + 1], markdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
