import assert from 'node:assert/strict';
import {
  normalizeRuntimeRoute,
  runtimeEvidenceHeaders,
  runtimeEvidenceRecord,
  runtimeWorkerVersion,
} from '../cloudflare/runtime/runtime-observed-entry.js';

assert.equal(
  normalizeRuntimeRoute('/api/v1/stores/store-secret/csv-analytics/search-term'),
  '/api/v1/stores/:store/csv-analytics/:dimension',
);
assert.equal(
  normalizeRuntimeRoute('/api/v1/stores/store-secret/imports/import-secret/errors'),
  '/api/v1/stores/:store/imports/:resource',
);
assert.equal(normalizeRuntimeRoute('/not-api/private.csv'), 'asset');
assert.equal(runtimeWorkerVersion({ CF_VERSION_METADATA: { id: 'version-123' } }), 'version-123');

const request = new Request('https://example.test/api/v1/stores/store-secret/csv-analytics/search-term?q=sensitive-search-term', {
  method: 'GET',
  headers: {
    'cf-ray': 'ray-123',
    authorization: 'Bearer must-not-appear',
  },
});
const url = new URL(request.url);
const record = runtimeEvidenceRecord({
  request,
  env: { APP_ENV: 'production' },
  url,
  workerVersion: 'version-123',
  status: 200,
  durationMs: 17,
  errorCode: null,
});

assert.deepEqual(record, {
  event: 'runtime_request_evidence',
  service: 'ads-operations-web-prod',
  environment: 'production',
  workerVersion: 'version-123',
  cfRay: 'ray-123',
  method: 'GET',
  routeClass: '/api/v1/stores/:store/csv-analytics/:dimension',
  status: 200,
  durationMs: 17,
  errorCode: null,
});

const serialized = JSON.stringify(record);
assert.equal(serialized.includes('store-secret'), false);
assert.equal(serialized.includes('sensitive-search-term'), false);
assert.equal(serialized.includes('must-not-appear'), false);
assert.equal(serialized.includes('authorization'), false);

const evidenceHeaders = runtimeEvidenceHeaders(record);
assert.deepEqual(evidenceHeaders, {
  'x-runtime-worker-version': 'version-123',
  'x-runtime-route-class': '/api/v1/stores/:store/csv-analytics/:dimension',
  'x-runtime-duration-ms': '17',
  'x-runtime-error-code': '',
  'x-runtime-evidence-channel': 'response-headers',
});
const headerSerialized = JSON.stringify(evidenceHeaders);
assert.equal(headerSerialized.includes('store-secret'), false);
assert.equal(headerSerialized.includes('sensitive-search-term'), false);
assert.equal(headerSerialized.includes('must-not-appear'), false);
assert.equal(headerSerialized.includes('authorization'), false);

console.log(JSON.stringify({
  ok: true,
  contract: 'runtime-request-evidence',
  channel: 'response-headers',
  persistentRequestLogsRequired: false,
  rawRequestMetadataPersisted: false,
  record,
  evidenceHeaders,
}));
