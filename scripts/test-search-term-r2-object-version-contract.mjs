import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoreDailySourceObjectVersionLayer } from '../cloudflare/runtime/store-daily-source-object-version-api.js';
import { sourceR2ObjectVersionEvidence } from '../cloudflare/runtime/source-object-version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate25 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-upload-timestamp-api.js'), 'utf8');
const gate26 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-version-api.js'), 'utf8');
const helper = await readFile(path.join(root, 'cloudflare/runtime/source-object-version.js'), 'utf8');
const webEntry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');
const KEY = 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/search-term/dt=2026-08-12/amazon-report-1.json.gz';
const VERSION = 'r2-version-specific-upload-1';
const GATE25_CONTRACT = {
  schemaVersion: 'store-search-term-source-object-upload-timestamp-v1',
  storageBackend: 'r2',
  observedTimestampSource: 'r2_head.uploaded',
  timestampType: 'date',
  timestampSemantic: 'object_upload_time',
  verificationMethod: 'head_object_uploaded_timestamp',
  eligibilityRule: 'validated_source_r2_object_byte_size_identity',
  evidenceRule: 'cloudflare_r2_uploaded_timestamp_is_valid_date',
};

assert.deepEqual(sourceR2ObjectVersionEvidence(
  { eligible: true },
  { observed: true, object: { version: VERSION } },
), { version: VERSION, observed: true, valid: true });

for (const version of [null, undefined, '', '   ', 42, { value: VERSION }]) {
  assert.deepEqual(sourceR2ObjectVersionEvidence(
    { eligible: true },
    { observed: true, object: { version } },
  ), { version: null, observed: false, valid: false });
}
assert.deepEqual(sourceR2ObjectVersionEvidence(
  { eligible: false },
  { observed: true, object: { version: VERSION } },
), { version: null, observed: false, valid: false });
assert.deepEqual(sourceR2ObjectVersionEvidence(
  { eligible: true },
  { observed: false, object: { version: VERSION } },
), { version: null, observed: false, valid: false });

function item(overrides = {}) {
  return {
    sourceR2ObjectKey: KEY,
    sourceR2ObjectUploadedAt: '2026-08-15T03:00:00.000Z',
    sourceR2ObjectUploadedAtObserved: true,
    sourceR2ObjectUploadTimestampValid: true,
    ...overrides,
  };
}

async function payload({
  items = [item()],
  contract = GATE25_CONTRACT,
  object = { key: KEY, version: VERSION },
  includeBucket = true,
  headThrows = false,
  primeHead = true,
} = {}) {
  const calls = [];
  const env = {};
  if (includeBucket) {
    env.DATA_BUCKET = {
      async head(key) {
        calls.push(`head:${key}`);
        if (headThrows) throw new Error('head failed');
        return object;
      },
      async get(key) {
        calls.push(`get:${key}`);
        throw new Error('Gate 26 R2 GET forbidden');
      },
    };
  }
  const layer = createStoreDailySourceObjectVersionLayer({ env });
  if (primeHead && layer.env?.DATA_BUCKET) {
    try { await layer.env.DATA_BUCKET.head(KEY); } catch {}
  }
  const response = new Response(JSON.stringify({ sourceObjectUploadTimestampContract: contract, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const enriched = await layer.enrich(response);
  return { body: await enriched.json(), calls };
}

{
  const { body, calls } = await payload();
  assert.deepEqual(body.sourceObjectVersionContract, {
    schemaVersion: 'store-search-term-source-object-version-v1',
    storageBackend: 'r2',
    observedVersionSource: 'r2_head.version',
    versionSemantic: 'specific_object_upload_version',
    verificationMethod: 'head_object_version',
    eligibilityRule: 'validated_source_r2_object_upload_timestamp',
    evidenceRule: 'cloudflare_r2_object_version_is_non_empty_string',
  });
  assert.equal(body.items[0].sourceR2ObjectVersion, VERSION);
  assert.equal(body.items[0].sourceR2ObjectVersionObserved, true);
  assert.equal(body.items[0].sourceR2ObjectVersionValid, true);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const { body, calls } = await payload({
    items: [item({ sourceR2ObjectUploadTimestampValid: false })],
    primeHead: false,
  });
  assert.equal(body.items[0].sourceR2ObjectVersion, null);
  assert.equal(body.items[0].sourceR2ObjectVersionObserved, false);
  assert.equal(body.items[0].sourceR2ObjectVersionValid, false);
  assert.deepEqual(calls, []);
}

{
  const invalidContract = { ...GATE25_CONTRACT, evidenceRule: 'wrong' };
  const { body, calls } = await payload({ contract: invalidContract, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectVersionValid, false);
  assert.deepEqual(calls, []);
}

for (const version of [null, undefined, '', '   ', 42]) {
  const { body } = await payload({ object: { key: KEY, version } });
  assert.equal(body.items[0].sourceR2ObjectVersion, null);
  assert.equal(body.items[0].sourceR2ObjectVersionObserved, false);
  assert.equal(body.items[0].sourceR2ObjectVersionValid, false);
}

{
  const { body, calls } = await payload({ object: null });
  assert.equal(body.items[0].sourceR2ObjectVersionObserved, false);
  assert.equal(body.items[0].sourceR2ObjectVersionValid, false);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const { body, calls } = await payload({ headThrows: true });
  assert.equal(body.items[0].sourceR2ObjectVersionObserved, false);
  assert.equal(body.items[0].sourceR2ObjectVersionValid, false);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const items = [item(), item({ searchTerm: 'second' })];
  const { body, calls } = await payload({ items });
  assert.equal(body.items.every((row) => row.sourceR2ObjectVersionValid === true), true);
  assert.deepEqual(calls, [`head:${KEY}`], 'Gate 20-26 must share one underlying R2 HEAD per key');
}

{
  const { body, calls } = await payload({ primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectVersionObserved, false);
  assert.equal(body.items[0].sourceR2ObjectVersionValid, false);
  assert.deepEqual(calls, [], 'Gate 26 observation must not initiate an independent HEAD');
}

{
  const { body } = await payload({ includeBucket: false, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectVersionObserved, false);
  assert.equal(body.items[0].sourceR2ObjectVersionValid, false);
}

assert.doesNotMatch(gate25, /ObjectVersionContract|sourceR2ObjectVersion|head_object_version/);
assert.match(gate26, /SOURCE_OBJECT_VERSION_CONTRACT_VERSION = 'store-search-term-source-object-version-v1'/);
assert.match(gate26, /observedVersionSource:\s*'r2_head\.version'/);
assert.match(gate26, /versionSemantic:\s*'specific_object_upload_version'/);
assert.match(gate26, /verificationMethod:\s*'head_object_version'/);
assert.match(gate26, /eligibilityRule:\s*'validated_source_r2_object_upload_timestamp'/);
assert.match(gate26, /evidenceRule:\s*'cloudflare_r2_object_version_is_non_empty_string'/);
assert.match(helper, /typeof version !== 'string'/);
assert.match(helper, /version\.trim\(\)\.length === 0/);
assert.doesNotMatch(`${gate26}\n${helper}`, /DATA_BUCKET\.get\s*\(|bucket\.get\s*\(|\.arrayBuffer\s*\(|\.text\s*\(/);
assert.doesNotMatch(gate26, /prepare\s*\(|SELECT\s+/i);
assert.doesNotMatch(`${gate26}\n${helper}`, /\betag\b|\bchecksum\b|sha256|content_integrity/i);
assert.doesNotMatch(`${gate26}\n${helper}`, /freshness|stale|freshThreshold|ageMs|ageMinutes|downloaded_at|ingested_at|amazon_created_at/i);
assert.doesNotMatch(`${gate26}\n${helper}`, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.doesNotMatch(`${gate26}\n${helper}`, /targetingIdentityReady|bidSourceColumnReady|bidValueNullabilityTrusted|adProductReady|advertisedProductIdentityReady|attributionMaturityReady|bidGovernanceReady|campaignStudioReady/);
assert.match(webEntry, /const gate24Layer = createStoreDailySourceObjectByteSizeLayer\(\{ env, url \}\)/);
assert.match(webEntry, /createStoreDailySourceObjectOperationalMetadataLayer\(\{ env: gate24Layer\.env, url \}\)/);
assert.match(webEntry, /const gate25Layer = createStoreDailySourceObjectUploadTimestampLayer\(\{ env: gate23Layer\.env \}\)/);
assert.match(webEntry, /const gate26Layer = createStoreDailySourceObjectVersionLayer\(\{ env: gate25Layer\.env \}\)/);
assert.match(webEntry, /const gate27Layer = createStoreDailySourceObjectEtagLayer\(\{ env: gate26Layer\.env \}\)/);
assert.match(webEntry, /handleStoreDailySourceObjectChecksumApiRoute\(\{ request, env: gate27Layer\.env, actor, url \}\)/);
assert.match(webEntry, /return gate23Layer\.enrich\(response\)/);
assert.match(webEntry, /return gate24Layer\.enrich\(gate23Response\)/);
assert.match(webEntry, /return gate25Layer\.enrich\(gate24Response\)/);
assert.match(webEntry, /return gate26Layer\.enrich\(gate25Response\)/);

console.log(JSON.stringify({ ok: true, gate: 26, contracts: [
  'r2-object-version-contract-explicit',
  'gate25-upload-timestamp-required',
  'r2-head-version-system-authority-required',
  'non-empty-version-observed',
  'missing-or-invalid-version-fails-closed',
  'gate20-26-share-one-underlying-r2-head-per-key',
  'gate25-entry-boundary-preserved',
  'no-r2-get-or-body-consumption',
  'no-d1-query-required',
  'no-etag-checksum-or-content-integrity-claim',
  'no-freshness-staleness-age-threshold',
  'no-write-path-or-readiness-change',
] }));
