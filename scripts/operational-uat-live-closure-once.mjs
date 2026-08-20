import fs from 'node:fs/promises';
import { discoverWorkerDeploymentTopology } from './cloudflare-deployment-discovery-client.mjs';
import { runOperationalUatReleaseRollback } from './operational-uat-release-rollback.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const accountId = required(process.env.CLOUDFLARE_ACCOUNT_ID, 'account_id_missing');
const apiToken = required(process.env.CLOUDFLARE_API_TOKEN, 'api_token_missing');
const githubToken = required(process.env.GITHUB_TOKEN, 'github_token_missing');
const expectedMain = required(process.env.EXPECTED_MAIN_SHA, 'expected_main_missing').toLowerCase();
const expectedVersion = required(process.env.EXPECTED_PRODUCTION_VERSION, 'expected_version_missing').toLowerCase();
const uatAud = required(process.env.UAT_ACCESS_AUD, 'uat_aud_missing').toLowerCase();
const host = required(process.env.PRODUCTION_HOST, 'production_host_missing');
const runTag = `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
const serviceName = `operational-uat-live-${runTag}`;
const appName = `operational-uat-live-${runTag}`;
const liveProbeUrl = `https://${host}/api/v1/operational-uat/live-probe`;
const healthUrl = `https://${host}/api/health`;
const cases = [
  'csv.duplicate-import',
  'csv.missing-identifiers',
  'csv.date-gaps',
  'csv.import-overlap',
  'permission.store-access-mismatch',
  'failure.d1-query',
  'failure.stale-request',
  'failure.worker-error',
  'failure.missing-binding',
];

const state = {
  serviceTokenId: null,
  serviceClientId: null,
  serviceClientSecret: null,
  accessAppId: null,
  accessPolicyId: null,
};
const evidence = {
  schema: 'operational-uat-live-closure-v2',
  strictBaselineBefore: 21,
  expectedMainSha: expectedMain,
  expectedProductionVersion: expectedVersion,
  productionAmazonHardOff: false,
  failClosed: true,
  amazonExecutionAttempted: false,
  businessFactMutationAttempted: false,
  persistentActorMutationAttempted: false,
  liveCases: [],
  rollback: null,
  cleanup: null,
  completed: false,
};
let primaryError = null;

try {
  await assertExactMainAndProduction();
  await assertNoPreexistingUatApp();

  const service = await cf('/access/service_tokens', {
    method: 'POST',
    json: { name: serviceName, duration: '1h' },
  });
  state.serviceTokenId = required(service?.id, 'service_token_id_missing');
  state.serviceClientId = required(service?.client_id, 'service_client_id_missing');
  state.serviceClientSecret = required(service?.client_secret, 'service_client_secret_missing');
  if (!state.serviceClientId.endsWith('.access')) throw new Error('service_client_id_shape_invalid');
  console.log(`::add-mask::${state.serviceClientId}`);
  console.log(`::add-mask::${state.serviceClientSecret}`);

  const app = await cf('/access/apps', {
    method: 'POST',
    json: {
      name: appName,
      type: 'self_hosted',
      aud: uatAud,
      session_duration: '1h',
      app_launcher_visible: false,
      destinations: [
        { type: 'public', uri: `${host}/api/v1/operational-uat/live-probe` },
        { type: 'public', uri: `${host}/api/health` },
      ],
    },
  });
  state.accessAppId = required(app?.id, 'access_app_id_missing');
  if (String(app?.aud || '').toLowerCase() !== uatAud) throw new Error('access_app_audience_mismatch');

  const policy = await cf(`/access/apps/${encodeURIComponent(state.accessAppId)}/policies`, {
    method: 'POST',
    json: {
      name: `${appName}-service-auth`,
      decision: 'non_identity',
      precedence: 1,
      include: [{ service_token: { token_id: state.serviceTokenId } }],
    },
  });
  state.accessPolicyId = required(policy?.id, 'access_policy_id_missing');

  const health = await waitForHealth();
  evidence.productionAmazonHardOff = health?.syncTriggerEnabled === false;
  evidence.health = {
    ok: health?.ok === true,
    environment: health?.environment || null,
    versionId: health?.deployment?.versionId || null,
    syncTriggerEnabled: health?.syncTriggerEnabled ?? null,
  };

  for (const caseId of cases) {
    try {
      const row = await callCase(caseId);
      evidence.liveCases.push(row);
      console.log(JSON.stringify({
        event: 'operational_uat_live_case',
        caseId,
        verified: row.verified,
        status: row.status,
        runtimeVersion: row.runtimeVersion,
      }));
    } catch (error) {
      evidence.liveCases.push({
        caseId,
        verified: false,
        error: normalizeError(error),
      });
    }
  }

  const accessAwareFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === host && url.pathname === '/api/health') return serviceFetch(url, init);
    return fetch(input, init);
  };
  try {
    evidence.rollback = await runOperationalUatReleaseRollback({
      accountId,
      token: apiToken,
      scriptName: 'ads-operations-web-prod',
      healthUrl,
      fetchImpl: accessAwareFetch,
      sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      healthAttempts: 30,
      healthDelayMs: 2000,
    });
  } catch (error) {
    evidence.rollback = {
      caseId: 'failure.release-rollback',
      verified: false,
      error: normalizeError(error),
    };
  }

  const verifiedCaseCount = evidence.liveCases.filter((row) => row.verified === true).length;
  const verifiedRollback = evidence.rollback?.verified === true;
  evidence.strictLivePassAfter = 21 + verifiedCaseCount + (verifiedRollback ? 1 : 0);
  evidence.completed = verifiedCaseCount === 9
    && verifiedRollback
    && evidence.productionAmazonHardOff === true;
  if (!evidence.completed) primaryError = new Error(`operational_uat_incomplete:${evidence.strictLivePassAfter}/31`);
} catch (error) {
  primaryError = error;
} finally {
  evidence.cleanup = await cleanup();
  evidence.cleanupVerified = evidence.cleanup.appAbsentVerified
    && evidence.cleanup.serviceTokenAbsentVerified
    && evidence.cleanup.errors.length === 0;
  if (!evidence.cleanupVerified && !primaryError) primaryError = new Error('operational_uat_cleanup_incomplete');
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/operational-uat-live-closure.json', `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    event: 'operational_uat_live_closure_summary',
    completed: evidence.completed,
    strictLivePassAfter: evidence.strictLivePassAfter ?? 21,
    productionAmazonHardOff: evidence.productionAmazonHardOff,
    cleanupVerified: evidence.cleanupVerified,
    liveCases: evidence.liveCases.map((row) => ({ caseId: row.caseId, verified: row.verified, status: row.status ?? null })),
    rollbackVerified: evidence.rollback?.verified === true,
    amazonExecutionAttempted: false,
    persistentActorMutationAttempted: false,
  }, null, 2));
}

if (primaryError) throw primaryError;

async function assertExactMainAndProduction() {
  const response = await fetch('https://api.github.com/repos/mrtanshiyue/Ads-Operations-Integrity/branches/main', {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${githubToken}` },
  });
  if (!response.ok) throw new Error(`github_main_http_${response.status}`);
  const liveMain = String((await response.json())?.commit?.sha || '').toLowerCase();
  if (liveMain !== expectedMain) throw new Error(`main_drift:${liveMain}:${expectedMain}`);
  const topology = await discoverWorkerDeploymentTopology({
    accountId,
    scriptName: 'ads-operations-web-prod',
    token: apiToken,
  });
  if (String(topology?.activeBuild?.commitSha || '').toLowerCase() !== expectedMain
      || String(topology?.activeVersion?.versionId || '').toLowerCase() !== expectedVersion
      || Number(topology?.activeDeployment?.percentage) !== 100
      || String(topology?.activeBuild?.outcome || '').toLowerCase() !== 'success') {
    throw new Error('production_topology_precondition_failed');
  }
}

async function assertNoPreexistingUatApp() {
  const apps = await cf(`/access/apps?aud=${encodeURIComponent(uatAud)}&per_page=50&page=1`);
  if (Array.isArray(apps) && apps.some((app) => String(app?.aud || '').toLowerCase() === uatAud)) {
    throw new Error('uat_secondary_audience_already_has_application');
  }
}

async function waitForHealth() {
  let last = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const response = await serviceFetch(`${healthUrl}?uatMachineAuth=${Date.now()}-${attempt}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    last = {
      status: response.status,
      contentType,
      location: response.headers.get('location') || null,
      text: text.slice(0, 160),
    };
    if (response.ok && /application\/json/i.test(contentType)) {
      const payload = JSON.parse(text);
      if (String(payload?.deployment?.versionId || '').toLowerCase() === expectedVersion
          && payload?.environment === 'production'
          && payload?.syncTriggerEnabled === false) {
        return payload;
      }
    }
    if (attempt < 30) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`machine_auth_health_not_ready:${JSON.stringify(last)}`);
}

async function callCase(caseId) {
  const response = await serviceFetch(`${liveProbeUrl}?case=${encodeURIComponent(caseId)}&nonce=${Date.now()}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-operational-uat-confirm': 'non-amazon-live-probe-v1',
    },
    body: JSON.stringify({ caseId }),
  });
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (!/application\/json/i.test(contentType)) {
    throw new Error(`${caseId}:non_json_http_${response.status}:location_${response.headers.get('location') || 'none'}`);
  }
  const payload = JSON.parse(text);
  const runtimeVersion = String(response.headers.get('x-runtime-worker-version') || '').toLowerCase();
  const routeClass = response.headers.get('x-runtime-route-class') || null;
  const verified = payload?.caseId === caseId
    && payload?.verified === true
    && payload?.amazonExecutionAttempted === false
    && payload?.crossStoreLeakageDetected === false
    && payload?.fabricatedZeroPerformance === false
    && payload?.businessFactPersistenceAttempted === false
    && payload?.failClosed === true
    && payload?.authorizationMode === 'secondary_access_service_token'
    && payload?.persistentActorBindingRequired === false
    && runtimeVersion === expectedVersion
    && routeClass === '/api/v1/operational-uat/live-probe';
  return {
    caseId,
    verified,
    status: response.status,
    runtimeVersion,
    routeClass,
    runtimeErrorCode: response.headers.get('x-runtime-error-code') || null,
    authorizationMode: payload?.authorizationMode || null,
    persistentActorBindingRequired: payload?.persistentActorBindingRequired ?? null,
    observed: payload?.observed || null,
    flags: {
      amazonExecutionAttempted: payload?.amazonExecutionAttempted ?? null,
      crossStoreLeakageDetected: payload?.crossStoreLeakageDetected ?? null,
      fabricatedZeroPerformance: payload?.fabricatedZeroPerformance ?? null,
      businessFactPersistenceAttempted: payload?.businessFactPersistenceAttempted ?? null,
      failClosed: payload?.failClosed ?? null,
    },
  };
}

async function serviceFetch(input, init = {}) {
  if (!state.serviceClientId || !state.serviceClientSecret) throw new Error('service_credentials_unavailable');
  const headers = new Headers(init.headers || {});
  headers.set('CF-Access-Client-Id', state.serviceClientId);
  headers.set('CF-Access-Client-Secret', state.serviceClientSecret);
  headers.set('cache-control', 'no-cache');
  return fetch(input, { ...init, headers, redirect: 'manual', cache: 'no-store' });
}

async function cleanup() {
  const result = {
    appDeleteAttempted: false,
    serviceTokenDeleteAttempted: false,
    appAbsentVerified: false,
    serviceTokenAbsentVerified: false,
    errors: [],
  };
  if (state.accessAppId) {
    result.appDeleteAttempted = true;
    try {
      await cf(`/access/apps/${encodeURIComponent(state.accessAppId)}`, { method: 'DELETE' });
    } catch (error) {
      result.errors.push(`app_delete:${normalizeError(error)}`);
    }
  }
  if (state.serviceTokenId) {
    result.serviceTokenDeleteAttempted = true;
    try {
      await cf(`/access/service_tokens/${encodeURIComponent(state.serviceTokenId)}`, { method: 'DELETE' });
    } catch (error) {
      result.errors.push(`token_delete:${normalizeError(error)}`);
    }
  }
  try {
    const apps = await cf(`/access/apps?aud=${encodeURIComponent(uatAud)}&per_page=50&page=1`);
    result.appAbsentVerified = Array.isArray(apps)
      && apps.every((app) => app?.id !== state.accessAppId && String(app?.aud || '').toLowerCase() !== uatAud);
  } catch (error) {
    result.errors.push(`app_verify:${normalizeError(error)}`);
  }
  try {
    const tokens = await cf('/access/service_tokens?per_page=100&page=1');
    result.serviceTokenAbsentVerified = Array.isArray(tokens)
      && tokens.every((token) => token?.id !== state.serviceTokenId);
  } catch (error) {
    result.errors.push(`token_verify:${normalizeError(error)}`);
  }
  return result;
}

async function cf(path, { method = 'GET', json = undefined } = {}) {
  const response = await fetch(`${API}/accounts/${encodeURIComponent(accountId)}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiToken}`,
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok || body?.success !== true) {
    const code = body?.errors?.[0]?.code ?? 'UNKNOWN';
    const message = String(body?.errors?.[0]?.message || '').slice(0, 180);
    throw new Error(`cloudflare_${method}_${path}_http_${response.status}_api_${code}:${message}`);
  }
  return body.result;
}

function required(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new Error(code);
  return text;
}

function normalizeError(error) {
  return String(error?.code || error?.message || error || 'unknown_error').slice(0, 500);
}
