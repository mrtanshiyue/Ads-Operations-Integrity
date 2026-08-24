import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { collectProductionClosureStatus } from './production-closure-observability.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA = required('EXPECTED_MAIN_SHA');
const OUT = 'artifacts/live-current-main-runtime-acceptance';

await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'current-main-web-runtime-promotion-v1',
  expectedCanonicalMain: EXPECTED_MAIN_SHA,
  startedAt: new Date().toISOString(),
  before: null,
  triggered: [],
  after: null,
  result: 'FAIL',
};

try {
  const before = await collectProductionClosureStatus({
    accountId: ACCOUNT_ID,
    token: API_TOKEN,
    mainSha: EXPECTED_MAIN_SHA,
  });
  receipt.before = before;
  assert.equal(before.amazonHardOff.status, 'HARD_OFF', 'Amazon HARD-OFF must be green before web runtime promotion');
  assert.equal(before.productionSyncSchedules.length, 0, 'Production Sync schedules must stay empty');
  assert.equal(before.development.traffic, 100, 'Development must be single-version 100% traffic before promotion');
  assert.equal(before.production.traffic, 100, 'Production must be single-version 100% traffic before promotion');

  if (!before.runtimeParity.devExactMain) {
    receipt.triggered.push(await triggerExactMainBuild('development', before.development));
  }
  if (!before.runtimeParity.prodExactMain) {
    receipt.triggered.push(await triggerExactMainBuild('production', before.production));
  }

  let after = before;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    after = await collectProductionClosureStatus({
      accountId: ACCOUNT_ID,
      token: API_TOKEN,
      mainSha: EXPECTED_MAIN_SHA,
    });
    receipt.after = after;
    if (after.blockers.length === 0
      && after.runtimeParity.status === 'exact_main_100_percent'
      && after.amazonHardOff.status === 'HARD_OFF') break;
    await sleep(15_000);
  }

  assert(receipt.after, 'Post-promotion live control-plane receipt missing');
  assert.deepEqual(receipt.after.blockers, [], `Post-promotion blockers: ${receipt.after.blockers.join(',')}`);
  assert.equal(receipt.after.development.sourceCommit, EXPECTED_MAIN_SHA);
  assert.equal(receipt.after.production.sourceCommit, EXPECTED_MAIN_SHA);
  assert.equal(receipt.after.runtimeParity.status, 'exact_main_100_percent');
  assert.equal(receipt.after.amazonHardOff.status, 'HARD_OFF');
  assert.equal(receipt.after.productionSyncSchedules.length, 0);
  receipt.result = 'PASS';
} catch (error) {
  receipt.error = { message: scrub(error?.message || String(error)), stack: scrub(String(error?.stack || '')).slice(0, 8000) };
  throw error;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/promotion.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}

async function triggerExactMainBuild(environment, runtime) {
  const triggerUuid = String(runtime?.buildTriggerUuid || '').trim();
  assert.match(triggerUuid, /^[0-9a-f-]{36}$/i, `${environment} build trigger UUID missing`);
  const payload = await cf(`/builds/triggers/${encodeURIComponent(triggerUuid)}/builds`, {
    method: 'POST',
    body: { branch: 'main', commit_hash: EXPECTED_MAIN_SHA },
  });
  const result = payload?.result || {};
  const buildUuid = String(result?.build_uuid || result?.uuid || result?.id || '').trim();
  return {
    environment,
    workerName: runtime.workerName,
    triggerUuid,
    requestedBranch: 'main',
    requestedCommit: EXPECTED_MAIN_SHA,
    buildUuid: buildUuid || null,
  };
}

async function cf(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const code = payload?.errors?.[0]?.code || response.status;
    const message = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`cloudflare_build_trigger_failed:${code}:${scrub(message)}`);
  }
  return payload;
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function scrub(value) {
  let text = String(value || '');
  if (API_TOKEN) text = text.split(API_TOKEN).join('[REDACTED_API_TOKEN]');
  return text.replace(/[\r\n\t]+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
