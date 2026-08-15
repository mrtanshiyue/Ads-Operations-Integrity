import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoreDailySourceObjectStorageClassLayer } from '../cloudflare/runtime/store-daily-source-object-storage-class-api.js';
import { sourceR2ObjectStorageClassEvidence } from '../cloudflare/runtime/source-object-storage-class.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate27 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-etag-api.js'), 'utf8');
const gate28 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-storage-class-api.js'), 'utf8');
const helper = await readFile(path.join(root, 'cloudflare/runtime/source-object-storage-class.js'), 'utf8');
const webEntry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');
const KEY = 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/search-term/dt=2026-08-12/amazon-report-1.json.gz';
const ETAG = 'f77dc0eecdebcd774a2a22cb393ad2ff-2';
const GATE27_CONTRACT = {
  schemaVersion: 'store-search-term-source-object-etag-v1',
  storageBackend: 'r2',
  observedEtagSource: 'r2_head.etag',
  etagSemantic: 'object_upload_etag',
  verificationMethod: 'head_object_etag',
  eligibilityRule: 'validated_source_r2_object_version',
  evidenceRule: 'cloudflare_r2_object_etag_is_non_empty_string',
};

for (const storageClass of ['Standard', 'InfrequentAccess']) {
  assert.deepEqual(sourceR2ObjectStorageClassEvidence(
    { eligible: true },
    { observed: true, object: { storageClass } },
  ), { storageClass, observed: true, valid: true });
}

for (const storageClass of [null, undefined, '', ' ', 'standard', 'STANDARD', 'Archive', 42, { value: 'Standard' }]) {
  assert.deepEqual(sourceR2ObjectStorageClassEvidence(
    { eligible: true },
    { observed: true, object: { storageClass } },
  ), { storageClass: null, observed: false, valid: false });
}
assert.deepEqual(sourceR2ObjectStorageClassEvidence(
  { eligible: false },
  { observed: true, object: { storageClass: 'Standard' } },
), { storageClass: null, observed: false, valid: false });
assert.deepEqual(sourceR2ObjectStorageClassEvidence(
  { eligible: true },
  { observed: false, object: { storageClass: 'Standard' } },
), { storageClass: null, observed: false, valid: false });

function item(overrides = {}) {
  return {
    sourceR2ObjectKey: KEY,
    sourceR2ObjectEtag: ETAG,
    sourceR2ObjectEtagObserved: true,
    sourceR2ObjectEtagValid: true,
    ...overrides,
  };
}

async function payload({
  items = [item()],
  contract = GATE27_CONTRACT,
  object = { key: KEY, storageClass: 'Standard' },
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
        throw new Error('Gate 28 R2 GET forbidden');
      },
    };
  }
  const layer = createStoreDailySourceObjectStorageClassLayer({ env });
  if (primeHead && layer.env?.DATA_BUCKET) {
    try { await layer.env.DATA_BUCKET.head(KEY); } catch {}
  }
  const response = new Response(JSON.stringify({ sourceObjectEtagContract: contract, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const enriched = await layer.enrich(response);
  return { body: await enriched.json(), calls };
}

{
  const { body, calls } = await payload();
  assert.deepEqual(body.sourceObjectStorageClassContract, {
    schemaVersion: 'store-search-term-source-object-storage-class-v1',
    storageBackend: 'r2',
    observedStorageClassSource: 'r2_head.storageClass',
    storageClassSemantic: 'object_storage_class',
    supportedStorageClasses: ['Standard', 'InfrequentAccess'],
    verificationMethod: 'head_object_storage_class',
    eligibilityRule: 'validated_source_r2_object_etag',
    evidenceRule: 'cloudflare_r2_storage_class_is_supported',
  });
  assert.equal(body.items[0].sourceR2ObjectStorageClass, 'Standard');
  assert.equal(body.items[0].sourceR2ObjectStorageClassObserved, true);
  assert.equal(body.items[0].sourceR2ObjectStorageClassValid, true);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const { body } = await payload({ object: { key: KEY, storageClass: 'InfrequentAccess' } });
  assert.equal(body.items[0].sourceR2ObjectStorageClass, 'InfrequentAccess');
  assert.equal(body.items[0].sourceR2ObjectStorageClassObserved, true);
  assert.equal(body.items[0].sourceR2ObjectStorageClassValid, true);
}

{
  const { body, calls } = await payload({
    items: [item({ sourceR2ObjectEtagValid: false })],
    primeHead: false,
  });
  assert.equal(body.items[0].sourceR2ObjectStorageClass, null);
  assert.equal(body.items[0].sourceR2ObjectStorageClassObserved, false);
  assert.equal(body.items[0].sourceR2ObjectStorageClassValid, false);
  assert.deepEqual(calls, []);
}

{
  const invalidContract = { ...GATE27_CONTRACT, evidenceRule: 'wrong' };
  const { body, calls } = await payload({ contract: invalidContract, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectStorageClassValid, false);
  assert.deepEqual(calls, []);
}

for (const storageClass of [null, undefined, '', 'standard', 'STANDARD', 'Archive', 42]) {
  const { body } = await payload({ object: { key: KEY, storageClass } });
  assert.equal(body.items[0].sourceR2ObjectStorageClass, null);
  assert.equal(body.items[0].sourceR2ObjectStorageClassObserved, false);
  assert.equal(body.items[0].sourceR2ObjectStorageClassValid, false);
}

{
  const { body, calls } = await payload({ object: null });
  assert.equal(body.items[0].sourceR2ObjectStorageClassObserved, false);
  assert.equal(body.items[0].sourceR2ObjectStorageClassValid, false);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const { body, calls } = await payload({ headThrows: true });
  assert.equal(body.items[0].sourceR2ObjectStorageClassObserved, false);
  assert.equal(body.items[0].sourceR2ObjectStorageClassValid, false);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const items = [item(), item({ searchTerm: 'second' })];
  const { body, calls } = await payload({ items });
  assert.equal(body.items.every((row) => row.sourceR2ObjectStorageClassValid === true), true);
  assert.deepEqual(calls, [`head:${KEY}`], 'Gate 20-28 must share one underlying R2 HEAD per key');
}

{
  const { body, calls } = await payload({ primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectStorageClassObserved, false);
  assert.equal(body.items[0].sourceR2ObjectStorageClassValid, false);
  assert.deepEqual(calls, [], 'Gate 28 observation must not initiate an independent HEAD');
}

{
  const { body } = await payload({ includeBucket: false, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectStorageClassObserved, false);
  assert.equal(body.items[0].sourceR2ObjectStorageClassValid, false);
}

assert.doesNotMatch(gate27, /ObjectStorageClassContract|sourceR2ObjectStorageClass|head_object_storage_class/);
assert.match(gate28, /SOURCE_OBJECT_STORAGE_CLASS_CONTRACT_VERSION = 'store-search-term-source-object-storage-class-v1'/);
assert.match(gate28, /observedStorageClassSource:\s*'r2_head\.storageClass'/);
assert.match(gate28, /storageClassSemantic:\s*'object_storage_class'/);
assert.match(gate28, /supportedStorageClasses:\s*SUPPORTED_STORAGE_CLASSES/);
assert.match(gate28, /verificationMethod:\s*'head_object_storage_class'/);
assert.match(gate28, /eligibilityRule:\s*'validated_source_r2_object_etag'/);
assert.match(gate28, /evidenceRule:\s*'cloudflare_r2_storage_class_is_supported'/);
assert.match(helper, /new Set\(\['Standard', 'InfrequentAccess'\]\)/);
assert.doesNotMatch(`${gate28}\n${helper}`, /DATA_BUCKET\.get\s*\(|bucket\.get\s*\(|\.arrayBuffer\s*\(|\.text\s*\(/);
assert.doesNotMatch(gate28, /prepare\s*\(|SELECT\s+/i);
assert.doesNotMatch(`${gate28}\n${helper}`, /immutab|content_integrity|lifecycle_policy|policy_compliance/i);
assert.doesNotMatch(`${gate28}\n${helper}`, /freshness|stale|freshThreshold|ageMs|ageMinutes|downloaded_at|ingested_at|amazon_created_at/i);
assert.doesNotMatch(`${gate28}\n${helper}`, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.doesNotMatch(`${gate28}\n${helper}`, /targetingIdentityReady|bidSourceColumnReady|bidValueNullabilityTrusted|adProductReady|advertisedProductIdentityReady|attributionMaturityReady|bidGovernanceReady|campaignStudioReady/);
assert.match(webEntry, /const gate27Layer = createStoreDailySourceObjectEtagLayer\(\{ env: gate26Layer\.env \}\)/);
assert.match(webEntry, /const gate28Layer = createStoreDailySourceObjectStorageClassLayer\(\{ env: gate27Layer\.env \}\)/);
assert.match(webEntry, /handleStoreDailySourceObjectChecksumApiRoute\(\{ request, env: gate28Layer\.env, actor, url \}\)/);
assert.match(webEntry, /return gate27Layer\.enrich\(gate26Response\)/);
assert.match(webEntry, /return gate28Layer\.enrich\(gate27Response\)/);

console.log(JSON.stringify({ ok: true, gate: 28, contracts: [
  'r2-object-storage-class-contract-explicit',
  'gate27-etag-required',
  'r2-head-storage-class-system-authority-required',
  'supported-standard-observed',
  'supported-infrequent-access-observed',
  'missing-or-unsupported-storage-class-fails-closed',
  'storage-class-preserved-exactly',
  'gate20-28-share-one-underlying-r2-head-per-key',
  'gate27-entry-boundary-preserved',
  'no-r2-get-or-body-consumption',
  'no-d1-query-required',
  'no-immutability-content-integrity-or-lifecycle-policy-claim',
  'no-freshness-staleness-age-threshold',
  'no-write-path-or-readiness-change',
] }));
