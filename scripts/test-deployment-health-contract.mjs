import assert from 'node:assert/strict';
import {
  handleDeploymentHealthRoute,
  runtimeVersionMetadata,
} from '../cloudflare/runtime/deployment-health.js';

const metadata = runtimeVersionMetadata({
  id: '11111111-2222-3333-4444-555555555555',
  tag: 'deployment-integrity-test',
  timestamp: '2026-08-16T08:55:00.000Z',
});
assert.deepEqual(metadata, {
  versionId: '11111111-2222-3333-4444-555555555555',
  versionTag: 'deployment-integrity-test',
  versionTimestamp: '2026-08-16T08:55:00.000Z',
});
assert.deepEqual(runtimeVersionMetadata(null), {
  versionId: null,
  versionTag: null,
  versionTimestamp: null,
});
assert.equal(
  runtimeVersionMetadata({ timestamp: new Date('2026-08-16T08:55:00.000Z') }).versionTimestamp,
  '2026-08-16T08:55:00.000Z',
);

const env = {
  APP_ENV: 'development',
  SYNC_TRIGGER_ENABLED: 'false',
  ASSETS: {},
  CONTROL_DB: {},
  STORE_01_DB: {},
  STORE_02_DB: {},
  DATA_BUCKET: {},
  AMAZON_SYNC_WORKFLOW: {},
  CF_VERSION_METADATA: {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    tag: 'exact-sha-test-tag',
    timestamp: '2026-08-16T08:56:00.000Z',
  },
  CLOUDFLARE_API_TOKEN: 'must-not-leak-cloudflare-token',
  AMAZON_CLIENT_SECRET: 'must-not-leak-amazon-secret',
};

const request = new Request('https://example.invalid/api/health', {
  method: 'GET',
  headers: { 'cf-ray': 'phase2-test-ray' },
});
const response = handleDeploymentHealthRoute({
  request,
  env,
  url: new URL(request.url),
});
assert.ok(response instanceof Response);
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.equal(response.headers.get('x-request-id'), 'phase2-test-ray');

const bodyText = await response.text();
assert.doesNotMatch(bodyText, /must-not-leak-cloudflare-token/);
assert.doesNotMatch(bodyText, /must-not-leak-amazon-secret/);
const body = JSON.parse(bodyText);
assert.deepEqual(body, {
  ok: true,
  service: 'ads-operations-web',
  environment: 'development',
  deployment: {
    versionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    versionTag: 'exact-sha-test-tag',
    versionTimestamp: '2026-08-16T08:56:00.000Z',
  },
  dependencies: {
    assets: true,
    controlDb: true,
    dataBucket: true,
    storeDatabases: 2,
    syncWorkflow: true,
  },
  syncTriggerEnabled: false,
});

const missingMetadataRequest = new Request('https://example.invalid/api/health');
const missingMetadataResponse = handleDeploymentHealthRoute({
  request: missingMetadataRequest,
  env: { APP_ENV: 'development', SYNC_TRIGGER_ENABLED: 'false' },
  url: new URL(missingMetadataRequest.url),
});
const missingMetadataBody = await missingMetadataResponse.json();
assert.deepEqual(missingMetadataBody.deployment, {
  versionId: null,
  versionTag: null,
  versionTimestamp: null,
});
assert.equal(missingMetadataBody.syncTriggerEnabled, false);

const nonHealth = new Request('https://example.invalid/api/v1/session');
assert.equal(handleDeploymentHealthRoute({ request: nonHealth, env, url: new URL(nonHealth.url) }), null);
const wrongMethod = new Request('https://example.invalid/api/health', { method: 'POST' });
assert.equal(handleDeploymentHealthRoute({ request: wrongMethod, env, url: new URL(wrongMethod.url) }), null);

console.log(JSON.stringify({
  ok: true,
  contract: 'deployment-health-v1',
  exactRuntimeVersionIdObservable: true,
  versionTagObservable: true,
  versionTimestampObservable: true,
  secretValuesExcluded: true,
  syncKillSwitchPreserved: true,
}, null, 2));
