import assert from 'node:assert/strict';
import {
  OperationalUatReleaseRollbackError,
  activeSingleVersion,
  previousSingleVersion,
  runOperationalUatReleaseRollback,
} from './operational-uat-release-rollback.mjs';

const ACTIVE = '11111111-1111-4111-8111-111111111111';
const PREVIOUS = '22222222-2222-4222-8222-222222222222';
const SPLIT = '33333333-3333-4333-8333-333333333333';
const DEPLOY_ROLLBACK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEPLOY_RESTORE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const SCRIPT = 'ads-operations-web-prod';
const HEALTH = 'https://ads-operations-web-prod.example.workers.dev/api/health';

const topology = [
  deployment('current', ACTIVE, 100),
  { id: 'split', versions: [{ version_id: SPLIT, percentage: 50 }, { version_id: PREVIOUS, percentage: 50 }] },
  deployment('previous', PREVIOUS, 100),
];
assert.equal(activeSingleVersion(topology), ACTIVE);
assert.equal(previousSingleVersion(topology, ACTIVE), PREVIOUS);

const happy = fakeCloudflare({ healthFailureForRollback: false });
const evidence = await runOperationalUatReleaseRollback({
  accountId: ACCOUNT,
  token: 'test-token',
  scriptName: SCRIPT,
  healthUrl: HEALTH,
  fetchImpl: happy.fetchImpl,
  sleepImpl: async () => {},
  healthAttempts: 2,
  healthDelayMs: 0,
});
assert.equal(evidence.caseId, 'failure.release-rollback');
assert.equal(evidence.verified, true);
assert.equal(evidence.rollbackVersionId, PREVIOUS);
assert.equal(evidence.restoreVersionId, ACTIVE);
assert.equal(evidence.rollbackRuntimeObserved, true);
assert.equal(evidence.restoreRuntimeObserved, true);
assert.equal(evidence.restoredInFinally, true);
assert.equal(evidence.deploymentForceApplied, true);
assert.equal(evidence.deploymentReceiptVerifiedByReadback, true);
assert.equal(evidence.amazonExecutionAttempted, false);
assert.equal(evidence.businessFactPersistenceAttempted, false);
assert.deepEqual(happy.deployedVersions, [PREVIOUS, ACTIVE]);
assert.deepEqual(happy.readbackDeploymentIds, [DEPLOY_ROLLBACK, DEPLOY_RESTORE]);
assert.equal(happy.currentVersion(), ACTIVE);

const failure = fakeCloudflare({ healthFailureForRollback: true });
await assert.rejects(
  runOperationalUatReleaseRollback({
    accountId: ACCOUNT,
    token: 'test-token',
    scriptName: SCRIPT,
    healthUrl: HEALTH,
    fetchImpl: failure.fetchImpl,
    sleepImpl: async () => {},
    healthAttempts: 1,
    healthDelayMs: 0,
  }),
  (error) => error instanceof OperationalUatReleaseRollbackError
    && String(error.code).startsWith('OP_UAT_ROLLBACK_PRIMARY_FAILED:'),
);
assert.deepEqual(failure.deployedVersions, [PREVIOUS, ACTIVE], 'restore must run after rollback verification failure');
assert.deepEqual(failure.readbackDeploymentIds, [DEPLOY_ROLLBACK, DEPLOY_RESTORE], 'both deployment receipts must be verified by readback');
assert.equal(failure.currentVersion(), ACTIVE, 'restore version must be active after failure path');

console.log(JSON.stringify({
  ok: true,
  contract: 'operational-uat-release-rollback',
  realDeploymentRequired: true,
  forceDeploymentRequired: true,
  deploymentReceiptReadbackRequired: true,
  restoreInFinally: true,
  noAmazonExecution: true,
}));

function fakeCloudflare({ healthFailureForRollback }) {
  let current = ACTIVE;
  let deployCount = 0;
  const deployedVersions = [];
  const deploymentReceipts = new Map();
  const readbackDeploymentIds = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.cloudflare.com' && init.method === 'GET' && url.pathname.endsWith('/deployments')) {
      return jsonResponse({ success: true, result: { deployments: topology } });
    }
    if (url.hostname === 'api.cloudflare.com' && init.method === 'POST' && url.pathname.endsWith('/deployments')) {
      assert.equal(url.searchParams.get('force'), 'true', 'rollback/restore deployment must explicitly force older-version activation');
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body.annotations || {}), ['workers/message'], 'deployment request must not spoof server-owned annotations');
      const version = body.versions[0].version_id;
      deployedVersions.push(version);
      current = version;
      deployCount += 1;
      const id = deployCount === 1 ? DEPLOY_ROLLBACK : DEPLOY_RESTORE;
      deploymentReceipts.set(id, deployment(id, version, 100));
      return jsonResponse({ success: true, result: { id } });
    }
    if (url.hostname === 'api.cloudflare.com' && init.method === 'GET' && /\/deployments\/[0-9a-f-]+$/i.test(url.pathname)) {
      const id = url.pathname.split('/').pop();
      readbackDeploymentIds.push(id);
      const receipt = deploymentReceipts.get(id);
      if (!receipt) return jsonResponse({ success: false, errors: [{ code: 1001, message: 'missing deployment' }], result: null }, 404);
      return jsonResponse({ success: true, result: receipt });
    }
    if (url.pathname === '/api/health') {
      const visible = healthFailureForRollback && current === PREVIOUS ? ACTIVE : current;
      return jsonResponse({ ok: true, environment: 'production', deployment: { versionId: visible } });
    }
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
  };
  return { fetchImpl, deployedVersions, readbackDeploymentIds, currentVersion: () => current };
}

function deployment(id, versionId, percentage) {
  return { id, strategy: 'percentage', versions: [{ version_id: versionId, percentage }] };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
