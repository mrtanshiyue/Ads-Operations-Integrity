import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoreDailySourceObjectEtagLayer } from '../cloudflare/runtime/store-daily-source-object-etag-api.js';
import { sourceR2ObjectEtagEvidence } from '../cloudflare/runtime/source-object-etag.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate26 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-version-api.js'), 'utf8');
const gate27 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-etag-api.js'), 'utf8');
const helper = await readFile(path.join(root, 'cloudflare/runtime/source-object-etag.js'), 'utf8');
const webEntry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');
const KEY = 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/search-term/dt=2026-08-12/amazon-report-1.json.gz';
const VERSION = 'r2-version-specific-upload-1';
const ETAG = 'f77dc0eecdebcd774a2a22cb393ad2ff-2';
const GATE26_CONTRACT = {
  schemaVersion: 'store-search-term-source-object-version-v1',
  storageBackend: 'r2',
  observedVersionSource: 'r2_head.version',
  versionSemantic: 'specific_object_upload_version',
  verificationMethod: 'head_object_version',
  eligibilityRule: 'validated_source_r2_object_upload_timestamp',
  evidenceRule: 'cloudflare_r2_object_version_is_non_empty_string',
};

assert.deepEqual(sourceR2ObjectEtagEvidence(
  { eligible: true },
  { observed: true, object: { etag: ETAG } },
), { etag: ETAG, observed: true, valid: true });

assert.deepEqual(sourceR2ObjectEtagEvidence(
  { eligible: true },
  { observed: true, object: { etag: '  opaque-etag-value  ' } },
), { etag: '  opaque-etag-value  ', observed: true, valid: true }, 'ETag must be preserved exactly');

for (const etag of [null, undefined, '', '   ', 42, { value: ETAG }]) {
  assert.deepEqual(sourceR2ObjectEtagEvidence(
    { eligible: true },
    { observed: true, object: { etag } },
  ), { etag: null, observed: false, valid: false });
}
assert.deepEqual(sourceR2ObjectEtagEvidence(
  { eligible: false },
  { observed: true, object: { etag: ETAG } },
), { etag: null, observed: false, valid: false });
assert.deepEqual(sourceR2ObjectEtagEvidence(
  { eligible: true },
  { observed: false, object: { etag: ETAG } },
), { etag: null, observed: false, valid: false });

function item(overrides = {}) {
  return {
    sourceR2ObjectKey: KEY,
    sourceR2ObjectVersion: VERSION,
    sourceR2ObjectVersionObserved: true,
    sourceR2ObjectVersionValid: true,
    ...overrides,
  };
}

async function payload({
  items = [item()],
  contract = GATE26_CONTRACT,
  object = { key: KEY, etag: ETAG },
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
        throw new Error('Gate 27 R2 GET forbidden');
      },
    };
  }
  const layer = createStoreDailySourceObjectEtagLayer({ env });
  if (primeHead && layer.env?.DATA_BUCKET) {
    try { await layer.env.DATA_BUCKET.head(KEY); } catch {}
  }
  const response = new Response(JSON.stringify({ sourceObjectVersionContract: contract, items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const enriched = await layer.enrich(response);
  return { body: await enriched.json(), calls };
}

{
  const { body, calls } = await payload();
  assert.deepEqual(body.sourceObjectEtagContract, {
    schemaVersion: 'store-search-term-source-object-etag-v1',
    storageBackend: 'r2',
    observedEtagSource: 'r2_head.etag',
    etagSemantic: 'object_upload_etag',
    verificationMethod: 'head_object_etag',
    eligibilityRule: 'validated_source_r2_object_version',
    evidenceRule: 'cloudflare_r2_object_etag_is_non_empty_string',
  });
  assert.equal(body.items[0].sourceR2ObjectEtag, ETAG);
  assert.equal(body.items[0].sourceR2ObjectEtagObserved, true);
  assert.equal(body.items[0].sourceR2ObjectEtagValid, true);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const { body, calls } = await payload({
    items: [item({ sourceR2ObjectVersionValid: false })],
    primeHead: false,
  });
  assert.equal(body.items[0].sourceR2ObjectEtag, null);
  assert.equal(body.items[0].sourceR2ObjectEtagObserved, false);
  assert.equal(body.items[0].sourceR2ObjectEtagValid, false);
  assert.deepEqual(calls, []);
}

{
  const invalidContract = { ...GATE26_CONTRACT, evidenceRule: 'wrong' };
  const { body, calls } = await payload({ contract: invalidContract, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectEtagValid, false);
  assert.deepEqual(calls, []);
}

for (const etag of [null, undefined, '', '   ', 42]) {
  const { body } = await payload({ object: { key: KEY, etag } });
  assert.equal(body.items[0].sourceR2ObjectEtag, null);
  assert.equal(body.items[0].sourceR2ObjectEtagObserved, false);
  assert.equal(body.items[0].sourceR2ObjectEtagValid, false);
}

{
  const { body, calls } = await payload({ object: null });
  assert.equal(body.items[0].sourceR2ObjectEtagObserved, false);
  assert.equal(body.items[0].sourceR2ObjectEtagValid, false);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const { body, calls } = await payload({ headThrows: true });
  assert.equal(body.items[0].sourceR2ObjectEtagObserved, false);
  assert.equal(body.items[0].sourceR2ObjectEtagValid, false);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const items = [item(), item({ searchTerm: 'second' })];
  const { body, calls } = await payload({ items });
  assert.equal(body.items.every((row) => row.sourceR2ObjectEtagValid === true), true);
  assert.deepEqual(calls, [`head:${KEY}`], 'Gate 20-27 must share one underlying R2 HEAD per key');
}

{
  const { body, calls } = await payload({ primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectEtagObserved, false);
  assert.equal(body.items[0].sourceR2ObjectEtagValid, false);
  assert.deepEqual(calls, [], 'Gate 27 observation must not initiate an independent HEAD');
}

{
  const { body } = await payload({ includeBucket: false, primeHead: false });
  assert.equal(body.items[0].sourceR2ObjectEtagObserved, false);
  assert.equal(body.items[0].sourceR2ObjectEtagValid, false);
}

assert.doesNotMatch(gate26, /ObjectEtagContract|sourceR2ObjectEtag|head_object_etag/);
assert.match(gate27, /SOURCE_OBJECT_ETAG_CONTRACT_VERSION = 'store-search-term-source-object-etag-v1'/);
assert.match(gate27, /observedEtagSource:\s*'r2_head\.etag'/);
assert.match(gate27, /etagSemantic:\s*'object_upload_etag'/);
assert.match(gate27, /verificationMethod:\s*'head_object_etag'/);
assert.match(gate27, /eligibilityRule:\s*'validated_source_r2_object_version'/);
assert.match(gate27, /evidenceRule:\s*'cloudflare_r2_object_etag_is_non_empty_string'/);
assert.match(helper, /typeof etag !== 'string'/);
assert.match(helper, /etag\.trim\(\)\.length === 0/);
assert.doesNotMatch(`${gate27}\n${helper}`, /DATA_BUCKET\.get\s*\(|bucket\.get\s*\(|\.arrayBuffer\s*\(|\.text\s*\(/);
assert.doesNotMatch(gate27, /prepare\s*\(|SELECT\s+/i);
assert.doesNotMatch(`${gate27}\n${helper}`, /sha256|digestAlgorithm|content_digest|content_hash|contentSha256/i);
assert.doesNotMatch(`${gate27}\n${helper}`, /freshness|stale|freshThreshold|ageMs|ageMinutes|downloaded_at|ingested_at|amazon_created_at/i);
assert.doesNotMatch(`${gate27}\n${helper}`, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.doesNotMatch(`${gate27}\n${helper}`, /targetingIdentityReady|bidSourceColumnReady|bidValueNullabilityTrusted|adProductReady|advertisedProductIdentityReady|attributionMaturityReady|bidGovernanceReady|campaignStudioReady/);
assert.match(webEntry, /const gate26Layer = createStoreDailySourceObjectVersionLayer\(\{ env: gate25Layer\.env \}\)/);
assert.match(webEntry, /const gate27Layer = createStoreDailySourceObjectEtagLayer\(\{ env: gate26Layer\.env \}\)/);
assert.match(webEntry, /handleStoreDailySourceObjectChecksumApiRoute\(\{ request, env: gate27Layer\.env, actor, url \}\)/);
assert.match(webEntry, /return gate26Layer\.enrich\(gate25Response\)/);
assert.match(webEntry, /return gate27Layer\.enrich\(gate26Response\)/);

console.log(JSON.stringify({ ok: true, gate: 27, contracts: [
  'r2-object-etag-contract-explicit',
  'gate26-version-required',
  'r2-head-etag-system-authority-required',
  'non-empty-etag-observed',
  'missing-or-invalid-etag-fails-closed',
  'etag-preserved-exactly',
  'gate20-27-share-one-underlying-r2-head-per-key',
  'gate26-entry-boundary-preserved',
  'no-r2-get-or-body-consumption',
  'no-d1-query-required',
  'no-sha256-or-stable-content-digest-claim',
  'no-freshness-staleness-age-threshold',
  'no-write-path-or-readiness-change',
] }));
