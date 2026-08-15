import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoreDailySourceObjectUploadTimestampLayer } from '../cloudflare/runtime/store-daily-source-object-upload-timestamp-api.js';
import { sourceR2ObjectUploadTimestampEvidence } from '../cloudflare/runtime/source-object-upload-timestamp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate24 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-byte-size-api.js'), 'utf8');
const gate25 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-upload-timestamp-api.js'), 'utf8');
const helper = await readFile(path.join(root, 'cloudflare/runtime/source-object-upload-timestamp.js'), 'utf8');
const webEntry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');
const KEY = 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/search-term/dt=2026-08-12/amazon-report-1.json.gz';
const UPLOADED = new Date('2026-08-15T03:00:00.000Z');
const GATE24_CONTRACT = {
  schemaVersion: 'store-search-term-source-object-byte-size-v1',
  storageBackend: 'r2',
  expectedSizeSource: 'report_jobs.content_bytes',
  observedSizeSource: 'r2_head.size',
  sizeUnit: 'bytes',
  verificationMethod: 'head_object_size',
  eligibilityRule: 'validated_source_r2_object_operational_metadata_identity',
  identityRule: 'r2_object_size_matches_validated_d1_content_bytes',
};

assert.deepEqual(sourceR2ObjectUploadTimestampEvidence(
  { eligible: true },
  { observed: true, object: { uploaded: UPLOADED } },
), { uploadedAt: '2026-08-15T03:00:00.000Z', observed: true, valid: true });

for (const uploaded of [null, undefined, '2026-08-15T03:00:00Z', new Date('invalid')]) {
  assert.deepEqual(sourceR2ObjectUploadTimestampEvidence(
    { eligible: true },
    { observed: true, object: { uploaded } },
  ), { uploadedAt: null, observed: false, valid: false });
}
assert.deepEqual(sourceR2ObjectUploadTimestampEvidence(
  { eligible: false },
  { observed: true, object: { uploaded: UPLOADED } },
), { uploadedAt: null, observed: false, valid: false });

function item(overrides = {}) {
  return {
    sourceR2ObjectKey: KEY,
    sourceR2ObjectByteSizeObserved: true,
    sourceR2ObjectByteSizeIdentityValid: true,
    ...overrides,
  };
}

async function payload({
  items = [item()],
  contract = GATE24_CONTRACT,
  object = { key: KEY, uploaded: UPLOADED },
  includeBucket = true,
  primeHead = true,
} = {}) {
  const calls = [];
  const env = {};
  if (includeBucket) {
    env.DATA_BUCKET = {
      async head(key) { calls.push(`head:${key}`); return object; },
      async get(key) { calls.push(`get:${key}`); throw new Error('Gate 25 R2 GET forbidden'); },
    };
  }
  const layer = createStoreDailySourceObjectUploadTimestampLayer({ env });
  if (primeHead && layer.env?.DATA_BUCKET) {
    try { await layer.env.DATA_BUCKET.head(KEY); } catch {}
  }
  const response = new Response(JSON.stringify({ sourceObjectByteSizeContract: contract, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const enriched = await layer.enrich(response);
  return { body: await enriched.json(), calls };
}

{
  const { body, calls } = await payload();
  assert.deepEqual(body.sourceObjectUploadTimestampContract, {
    schemaVersion: 'store-search-term-source-object-upload-timestamp-v1',
    storageBackend: 'r2',
    observedTimestampSource: 'r2_head.uploaded',
    timestampType: 'date',
    timestampSemantic: 'object_upload_time',
    verificationMethod: 'head_object_uploaded_timestamp',
    eligibilityRule: 'validated_source_r2_object_byte_size_identity',
    evidenceRule: 'cloudflare_r2_uploaded_timestamp_is_valid_date',
  });
  assert.equal(body.items[0].sourceR2ObjectUploadedAt, '2026-08-15T03:00:00.000Z');
  assert.equal(body.items[0].sourceR2ObjectUploadedAtObserved, true);
  assert.equal(body.items[0].sourceR2ObjectUploadTimestampValid, true);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const { body, calls } = await payload({
    items: [item({ sourceR2ObjectByteSizeIdentityValid: false })],
    primeHead: false,
  });
  assert.equal(body.items[0].sourceR2ObjectUploadedAt, null);
  assert.equal(body.items[0].sourceR2ObjectUploadedAtObserved, false);
  assert.equal(body.items[0].sourceR2ObjectUploadTimestampValid, false);
  assert.deepEqual(calls, []);
}

{
  const { body } = await payload({ object: { key: KEY, uploaded: '2026-08-15T03:00:00Z' } });
  assert.equal(body.items[0].sourceR2ObjectUploadedAtObserved, false);
  assert.equal(body.items[0].sourceR2ObjectUploadTimestampValid, false);
}

{
  const invalidContract = { ...GATE24_CONTRACT, identityRule: 'wrong' };
  const { body, calls } = await payload({ contract: invalidContract, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectUploadTimestampValid, false);
  assert.deepEqual(calls, []);
}

{
  const items = [item(), item({ searchTerm: 'second' })];
  const { body, calls } = await payload({ items });
  assert.equal(body.items.every((row) => row.sourceR2ObjectUploadTimestampValid === true), true);
  assert.deepEqual(calls, [`head:${KEY}`], 'Gate 20-25 must share one underlying R2 HEAD per key');
}

{
  const { body } = await payload({ includeBucket: false, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectUploadedAtObserved, false);
  assert.equal(body.items[0].sourceR2ObjectUploadTimestampValid, false);
}

assert.doesNotMatch(gate24, /UploadTimestamp|upload-timestamp|sourceR2ObjectUploadedAt/);
assert.match(gate25, /SOURCE_OBJECT_UPLOAD_TIMESTAMP_CONTRACT_VERSION = 'store-search-term-source-object-upload-timestamp-v1'/);
assert.match(gate25, /observedTimestampSource:\s*'r2_head\.uploaded'/);
assert.match(gate25, /timestampType:\s*'date'/);
assert.match(gate25, /timestampSemantic:\s*'object_upload_time'/);
assert.match(gate25, /verificationMethod:\s*'head_object_uploaded_timestamp'/);
assert.match(gate25, /eligibilityRule:\s*'validated_source_r2_object_byte_size_identity'/);
assert.match(gate25, /evidenceRule:\s*'cloudflare_r2_uploaded_timestamp_is_valid_date'/);
assert.match(helper, /uploaded instanceof Date/);
assert.doesNotMatch(`${gate25}\n${helper}`, /DATA_BUCKET\.get\s*\(|bucket\.get\s*\(|\.arrayBuffer\s*\(|\.text\s*\(/);
assert.doesNotMatch(gate25, /prepare\s*\(|SELECT\s+|row_count|schema_version/i);
assert.doesNotMatch(`${gate25}\n${helper}`, /freshness|stale|freshThreshold|ageMs|ageMinutes|downloaded_at|ingested_at|amazon_created_at/i);
assert.doesNotMatch(`${gate25}\n${helper}`, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.doesNotMatch(`${gate25}\n${helper}`, /targetingIdentityReady|bidSourceColumnReady|bidValueNullabilityTrusted|adProductReady|advertisedProductIdentityReady|attributionMaturityReady|bidGovernanceReady|campaignStudioReady/);
assert.match(webEntry, /const gate24Layer = createStoreDailySourceObjectByteSizeLayer\(\{ env, url \}\)/);
assert.match(webEntry, /createStoreDailySourceObjectOperationalMetadataLayer\(\{ env: gate24Layer\.env, url \}\)/);
assert.match(webEntry, /const gate25Layer = createStoreDailySourceObjectUploadTimestampLayer\(\{ env: gate23Layer\.env \}\)/);
assert.match(webEntry, /return gate23Layer\.enrich\(response\)/);
assert.match(webEntry, /return gate24Layer\.enrich\(gate23Response\)/);
assert.match(webEntry, /return gate25Layer\.enrich\(gate24Response\)/);

console.log(JSON.stringify({ ok: true, gate: 25, contracts: [
  'r2-object-upload-timestamp-contract-explicit',
  'gate24-byte-size-identity-required',
  'r2-head-uploaded-system-authority-required',
  'valid-r2-uploaded-date-observed',
  'missing-or-invalid-uploaded-fails-closed',
  'gate20-25-share-one-underlying-r2-head-per-key',
  'gate24-entry-boundary-preserved',
  'no-r2-get-or-body-consumption',
  'no-freshness-staleness-age-threshold',
  'no-d1-query-required',
  'no-row-count-or-schema-version-validation',
  'no-write-path-or-readiness-change',
] }));
