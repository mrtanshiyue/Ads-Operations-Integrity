import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoreDailySourceObjectByteSizeLayer } from '../cloudflare/runtime/store-daily-source-object-byte-size-api.js';
import { sourceR2ObjectByteSizeIdentity } from '../cloudflare/runtime/source-object-byte-size.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate23 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-operational-metadata-api.js'), 'utf8');
const gate24 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-byte-size-api.js'), 'utf8');
const helper = await readFile(path.join(root, 'cloudflare/runtime/source-object-byte-size.js'), 'utf8');
const webEntry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');
const KEY = 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/search-term/dt=2026-08-12/amazon-report-1.json.gz';
const SIZE = 4096;
const GATE23_CONTRACT = {
  schemaVersion: 'store-search-term-source-object-operational-metadata-v1',
  storageBackend: 'r2',
  verificationMethod: 'head_custom_metadata_context',
  metadataKeys: ['store_code', 'profile_id', 'report_type', 'ad_product', 'run_id'],
  eligibilityRule: 'validated_source_r2_object_native_sha256_identity',
  identityRule: 'r2_operational_metadata_matches_validated_store_report_context',
};

assert.deepEqual(sourceR2ObjectByteSizeIdentity(
  { eligible: true, sourceContentBytes: SIZE },
  { observed: true, object: { size: SIZE } },
), {
  sourceContentBytes: SIZE,
  sourceR2ObjectSizeBytes: SIZE,
  observed: true,
  valid: true,
});
assert.deepEqual(sourceR2ObjectByteSizeIdentity(
  { eligible: true, sourceContentBytes: SIZE },
  { observed: true, object: { size: SIZE + 1 } },
), {
  sourceContentBytes: SIZE,
  sourceR2ObjectSizeBytes: SIZE + 1,
  observed: true,
  valid: false,
});
assert.equal(sourceR2ObjectByteSizeIdentity(
  { eligible: false, sourceContentBytes: SIZE },
  { observed: true, object: { size: SIZE } },
).observed, false);
for (const value of [null, undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4096']) {
  assert.equal(sourceR2ObjectByteSizeIdentity(
    { eligible: true, sourceContentBytes: value },
    { observed: true, object: { size: SIZE } },
  ).valid, false);
}
for (const value of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4096']) {
  const evidence = sourceR2ObjectByteSizeIdentity(
    { eligible: true, sourceContentBytes: SIZE },
    { observed: true, object: { size: value } },
  );
  assert.equal(evidence.observed, false);
  assert.equal(evidence.sourceR2ObjectSizeBytes, null);
  assert.equal(evidence.valid, false);
}

function controlDb(counters) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              counters.controlQueries += 1;
              assert.match(sql, /FROM stores/);
              assert.equal(params[0], 'store-dev-01');
              return { store_id: 'store-dev-01', d1_binding_key: 'STORE_01_DB', status: 'active' };
            },
          };
        },
      };
    },
  };
}

function storeDb(counters, { contentBytes = SIZE, includeReport = true } = {}) {
  return {
    prepare(sql) {
      assert.match(sql, /SELECT\s+job_id,\s*content_bytes\s+FROM report_jobs/i);
      assert.doesNotMatch(sql, /row_count|schema_version/i);
      counters.contentBytesQueries += 1;
      return {
        bind(...params) {
          counters.boundJobIds.push(params);
          return {
            async all() {
              return { results: includeReport ? [{ job_id: 'report-job-1', content_bytes: contentBytes }] : [] };
            },
          };
        },
      };
    },
  };
}

function bucket(calls, { size = SIZE, missing = false, throws = false } = {}) {
  return {
    async head(key) {
      calls.push(`head:${key}`);
      if (throws) throw new Error('head failed');
      if (missing) return null;
      return { key, size };
    },
    async get(key) {
      calls.push(`get:${key}`);
      throw new Error('Gate 24 must not call R2 GET');
    },
  };
}

function item(overrides = {}) {
  return {
    sourceReportJobId: 'report-job-1',
    sourceReportJobIdentityValid: true,
    sourceR2ObjectKey: KEY,
    sourceR2ObjectOperationalMetadataObserved: true,
    sourceR2ObjectOperationalMetadataIdentityValid: true,
    ...overrides,
  };
}

async function payload({
  items = [item()],
  contract = GATE23_CONTRACT,
  contentBytes = SIZE,
  includeReport = true,
  includeBucket = true,
  r2Size = SIZE,
  r2Missing = false,
  r2Throws = false,
  primeHead = true,
} = {}) {
  const calls = [];
  const counters = { controlQueries: 0, contentBytesQueries: 0, boundJobIds: [] };
  const env = {
    CONTROL_DB: controlDb(counters),
    STORE_01_DB: storeDb(counters, { contentBytes, includeReport }),
  };
  if (includeBucket) env.DATA_BUCKET = bucket(calls, { size: r2Size, missing: r2Missing, throws: r2Throws });
  const url = new URL('https://example.test/api/v1/stores/store-dev-01/search-terms-daily');
  const layer = createStoreDailySourceObjectByteSizeLayer({ env, url });
  if (primeHead && layer.env?.DATA_BUCKET && items.some(x => x.sourceR2ObjectKey === KEY)) {
    try { await layer.env.DATA_BUCKET.head(KEY); } catch {}
  }
  const response = new Response(JSON.stringify({ sourceObjectOperationalMetadataContract: contract, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const enriched = await layer.enrich(response);
  return { body: await enriched.json(), calls, counters };
}

{
  const { body, calls, counters } = await payload();
  assert.deepEqual(body.sourceObjectByteSizeContract, {
    schemaVersion: 'store-search-term-source-object-byte-size-v1',
    storageBackend: 'r2',
    expectedSizeSource: 'report_jobs.content_bytes',
    observedSizeSource: 'r2_head.size',
    sizeUnit: 'bytes',
    verificationMethod: 'head_object_size',
    eligibilityRule: 'validated_source_r2_object_operational_metadata_identity',
    identityRule: 'r2_object_size_matches_validated_d1_content_bytes',
  });
  assert.equal(body.items[0].sourceContentBytes, SIZE);
  assert.equal(body.items[0].sourceR2ObjectSizeBytes, SIZE);
  assert.equal(body.items[0].sourceR2ObjectByteSizeObserved, true);
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, true);
  assert.deepEqual(calls, [`head:${KEY}`]);
  assert.equal(counters.contentBytesQueries, 1);
  assert.deepEqual(counters.boundJobIds, [['report-job-1']]);
}

{
  const { body, calls } = await payload({ r2Size: SIZE + 1 });
  assert.equal(body.items[0].sourceContentBytes, SIZE);
  assert.equal(body.items[0].sourceR2ObjectSizeBytes, SIZE + 1);
  assert.equal(body.items[0].sourceR2ObjectByteSizeObserved, true);
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, false);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const { body } = await payload({ contentBytes: null });
  assert.equal(body.items[0].sourceContentBytes, null);
  assert.equal(body.items[0].sourceR2ObjectSizeBytes, SIZE);
  assert.equal(body.items[0].sourceR2ObjectByteSizeObserved, true);
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, false);
}

{
  const { body } = await payload({ r2Size: -1 });
  assert.equal(body.items[0].sourceR2ObjectSizeBytes, null);
  assert.equal(body.items[0].sourceR2ObjectByteSizeObserved, false);
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, false);
}

{
  const { body, calls, counters } = await payload({
    items: [item({ sourceR2ObjectOperationalMetadataIdentityValid: false })],
    primeHead: false,
  });
  assert.equal(body.items[0].sourceContentBytes, null);
  assert.equal(body.items[0].sourceR2ObjectSizeBytes, null);
  assert.equal(body.items[0].sourceR2ObjectByteSizeObserved, false);
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, false);
  assert.deepEqual(calls, []);
  assert.equal(counters.controlQueries, 0);
  assert.equal(counters.contentBytesQueries, 0);
}

{
  const invalidContract = { ...GATE23_CONTRACT, identityRule: 'wrong' };
  const { body, counters } = await payload({ contract: invalidContract, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, false);
  assert.equal(counters.contentBytesQueries, 0);
}

{
  const { body } = await payload({ includeReport: false });
  assert.equal(body.items[0].sourceContentBytes, null);
  assert.equal(body.items[0].sourceR2ObjectSizeBytes, SIZE);
  assert.equal(body.items[0].sourceR2ObjectByteSizeObserved, true);
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, false);
}

{
  const two = [item(), item({ searchTerm: 'second' })];
  const { body, calls, counters } = await payload({ items: two });
  assert.equal(body.items.length, 2);
  assert.equal(body.items.every(x => x.sourceR2ObjectByteSizeIdentityValid === true), true);
  assert.deepEqual(calls, [`head:${KEY}`], 'Gate 20-24 must share one underlying R2 HEAD per key');
  assert.equal(counters.contentBytesQueries, 1);
  assert.deepEqual(counters.boundJobIds, [['report-job-1']]);
}

{
  const { body } = await payload({ r2Missing: true });
  assert.equal(body.items[0].sourceR2ObjectByteSizeObserved, false);
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, false);
}

{
  const { body } = await payload({ r2Throws: true });
  assert.equal(body.items[0].sourceR2ObjectByteSizeObserved, false);
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, false);
}

{
  const { body } = await payload({ includeBucket: false, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectByteSizeObserved, false);
  assert.equal(body.items[0].sourceR2ObjectByteSizeIdentityValid, false);
}

assert.doesNotMatch(gate23, /ByteSize|byte-size|content_bytes|sourceR2ObjectSizeBytes/);
assert.match(gate24, /SOURCE_OBJECT_BYTE_SIZE_CONTRACT_VERSION = 'store-search-term-source-object-byte-size-v1'/);
assert.match(gate24, /expectedSizeSource:\s*'report_jobs\.content_bytes'/);
assert.match(gate24, /observedSizeSource:\s*'r2_head\.size'/);
assert.match(gate24, /sizeUnit:\s*'bytes'/);
assert.match(gate24, /verificationMethod:\s*'head_object_size'/);
assert.match(gate24, /eligibilityRule:\s*'validated_source_r2_object_operational_metadata_identity'/);
assert.match(gate24, /identityRule:\s*'r2_object_size_matches_validated_d1_content_bytes'/);
assert.match(gate24, /SELECT job_id, content_bytes/);
assert.doesNotMatch(`${gate24}\n${helper}`, /DATA_BUCKET\.get\s*\(|bucket\.get\s*\(|\.arrayBuffer\s*\(|\.text\s*\(|\.json\s*\(\s*\)\s*;?\s*\/\/ body/i);
assert.doesNotMatch(gate24, /row_count|schema_version/);
assert.doesNotMatch(`${gate24}\n${helper}`, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.doesNotMatch(`${gate24}\n${helper}`, /freshness|stale|freshThreshold|ageMs|ageMinutes|downloaded_at|ingested_at/i);
assert.doesNotMatch(`${gate24}\n${helper}`, /targetingIdentityReady|bidSourceColumnReady|bidValueNullabilityTrusted|adProductReady|advertisedProductIdentityReady|attributionMaturityReady|bidGovernanceReady|campaignStudioReady/);
assert.match(webEntry, /createStoreDailySourceObjectByteSizeLayer/);
assert.match(webEntry, /const gate24Layer = createStoreDailySourceObjectByteSizeLayer\(\{ env, url \}\)/);
assert.match(webEntry, /createStoreDailySourceObjectOperationalMetadataLayer\(\{ env: gate24Layer\.env, url \}\)/);
assert.match(webEntry, /return gate23Layer\.enrich\(response\)/);
assert.match(webEntry, /return gate24Layer\.enrich\(gate23Response\)/);

console.log(JSON.stringify({ ok: true, gate: 24, contracts: [
  'r2-object-byte-size-contract-explicit',
  'gate23-operational-metadata-identity-required',
  'd1-content-bytes-authority-required',
  'r2-head-size-exact-equality-required',
  'size-mismatch-fails-closed',
  'missing-content-bytes-fails-closed',
  'missing-or-invalid-r2-size-fails-closed',
  'gate20-24-share-one-underlying-r2-head-per-key',
  'gate23-entry-boundary-preserved',
  'no-r2-get-or-body-consumption',
  'no-row-count-or-schema-version-validation',
  'no-write-path-or-readiness-change',
] }));
