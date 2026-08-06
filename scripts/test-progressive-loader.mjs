import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const loader = readFileSync(new URL('../assets/private-cloud-warehouse-v4.js', import.meta.url), 'utf8');
const query = readFileSync(new URL('../assets/private-cloud-query-v1.js', import.meta.url), 'utf8');

const section = (source, startNeedle, endNeedle) => {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Missing section start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing section end: ${endNeedle}`);
  return source.slice(start, end);
};

assert.match(loader, /const LOADER_VERSION = '4\.3\.0'/);
assert.match(query, /const CLIENT_VERSION = '1\.2\.0'/);
assert.match(loader, /const FETCH_CONCURRENCY = 1/);
assert.match(loader, /loadingStrategy: 'query-first-progressive-v1'/);
assert.match(loader, /btnPrivateCloudCurrentMonth/);
assert.match(loader, /btnPrivateCloudRecentMonths/);
assert.match(loader, /btnPrivateCloudFullHistory/);
assert.match(loader, /loadFullHistory: \(\) => loadRawRange\(\{ mode: 'full' \}\)/);
assert.match(loader, /dataFingerprint/);
assert.match(query, /\/api\/v1\/query\/bootstrap/);
assert.match(query, /If-None-Match/);

const connect = section(
  loader,
  '  async function connectPrivateCloudOverview',
  '\n\n  function renderBootstrap',
);
assert.match(connect, /fetchBootstrap/);
assert.doesNotMatch(connect, /\/manifest\?/);
assert.doesNotMatch(connect, /fetchManifestEntry/);
assert.doesNotMatch(connect, /__LR_IMPORT_MULTIPLE_FILES__/);
assert.doesNotMatch(connect, /responseType: 'blob'/);

const raw = section(
  loader,
  '  async function loadRawRange',
  '\n\n  const extractRows',
);
assert.match(raw, /\/manifest\?/);
assert.match(raw, /fetchManifestEntry/);
assert.match(raw, /__LR_IMPORT_MULTIPLE_FILES__/);
assert.match(raw, /fromMonth/);
assert.match(raw, /toMonth/);

const bridge = section(
  loader,
  '  const queryRequest = async',
  '\n\n  const scheduleScopeReload',
);
assert.match(bridge, /path\.startsWith\('\/api\/v1\/query\/'\)/);
assert.match(bridge, /memoryCredential\.get\(\)/);

for (const forbidden of [
  'sessionStorage',
  'lr_private_cloud_password',
  "headers.set('Cache-Control'",
  'FETCH_CONCURRENCY = 2',
]) {
  assert.equal(loader.includes(forbidden), false, `Forbidden loader pattern: ${forbidden}`);
  assert.equal(query.includes(forbidden), false, `Forbidden query pattern: ${forbidden}`);
}

console.log('Progressive Query-first loader invariants passed');
