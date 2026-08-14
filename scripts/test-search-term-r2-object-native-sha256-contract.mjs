import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleStoreDailySourceObjectChecksumApiRoute } from '../cloudflare/runtime/store-daily-source-object-checksum-api.js';
import { sourceR2ObjectNativeSha256Identity } from '../cloudflare/runtime/source-object-checksum.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate20 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-head-api.js'), 'utf8');
const gate21 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-metadata-api.js'), 'utf8');
const gate22 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-checksum-api.js'), 'utf8');
const helper = await readFile(path.join(root, 'cloudflare/runtime/source-object-checksum.js'), 'utf8');
const webEntry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');
const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const KEY = 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/search-term/dt=2026-08-12/amazon-report-1.json.gz';
const buf = hex => Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)).buffer;

assert.deepEqual(sourceR2ObjectNativeSha256Identity(
  { valid: true, sha256: SHA }, { valid: true },
  { observed: true, object: { checksums: { sha256: buf(SHA) } } },
), { observed: true, sha256: SHA, valid: true });
assert.equal(sourceR2ObjectNativeSha256Identity(
  { valid: true, sha256: SHA }, { valid: true },
  { observed: true, object: { checksums: { sha256: buf(OTHER) } } },
).valid, false);
for (const object of [{}, { checksums: {} }, { checksums: { sha256: new Uint8Array(31).buffer } }, { checksums: { sha256: 'bad' } }]) {
  assert.equal(sourceR2ObjectNativeSha256Identity(
    { valid: true, sha256: SHA }, { valid: true }, { observed: true, object },
  ).valid, false);
}
assert.equal(sourceR2ObjectNativeSha256Identity(
  { valid: true, sha256: SHA }, { valid: false },
  { observed: true, object: { checksums: { sha256: buf(SHA) } } },
).observed, false);

function controlDb() {
  return { prepare(sql) { return { bind(...params) { return { async first() {
    if (sql.includes('FROM user_global_roles')) return { ok: 1 };
    if (sql.includes('FROM stores')) {
      assert.equal(params[0], 'store-dev-01');
      return { store_id: 'store-dev-01', d1_binding_key: 'STORE_01_DB', status: 'active' };
    }
    throw new Error(`unexpected control query: ${sql}`);
  } }; } }; } };
}
function fact(overrides = {}) {
  return {
    group_key: 'g1', report_date: '2026-08-12', profile_id: 'profile-1', ad_product: 'SPONSORED_PRODUCTS',
    campaign_id: 'campaign-1', campaign_name: 'Campaign 1', ad_group_id: 'adgroup-1', ad_group_name: 'Ad group 1',
    keyword_id: 'keyword-1', keyword_text: 'reading glasses', keyword_match_type: 'EXACT', keyword_state: 'ENABLED',
    keyword_bid_micros: 2500000, keyword_source_updated_at: null, keyword_synced_at: '2026-08-14 09:35:29',
    target_id: null, target_type: null, target_expression_text: null, target_state: null, target_bid_micros: null,
    target_source_updated_at: null, target_synced_at: null, search_term: 'reading glasses', normalized_search_term: 'reading glasses',
    report_match_type: 'EXACT', fact_mirror_updated_at: '2026-08-14 09:35:29', fact_row_count: 1,
    source_report_job_non_null_count: 1, source_report_job_distinct_count: 1, source_report_job_id_candidate: 'report-job-1',
    impressions: 100, clicks: 10, cost_micros: 1000000, purchases: 2, units_sold: 2, sales_micros: 5000000,
    sort_value: 1000000, ...overrides,
  };
}
function storeDb(facts = [fact()]) {
  return { prepare(sql) {
    if (sql.includes('FROM report_jobs')) return { bind() { return { async all() { return { results: [{
      job_id: 'report-job-1', amazon_report_id: 'amazon-report-1', profile_id: 'profile-1', ad_product: 'SPONSORED_PRODUCTS',
      start_date: '2026-08-12', end_date: '2026-08-12', r2_object_key: KEY, content_sha256: SHA,
    }] }; } }; } };
    assert.doesNotMatch(sql, /report_jobs/i);
    return { bind() { return { async all() { return { results: facts }; } }; } };
  } };
}
async function payload({ object, facts } = {}) {
  const calls = [];
  const env = { CONTROL_DB: controlDb(), STORE_01_DB: storeDb(facts), DATA_BUCKET: {
    async head(key) { calls.push(`head:${key}`); return object === undefined ? {
      key: KEY, customMetadata: { sha256: SHA }, checksums: { sha256: buf(SHA) },
    } : object; },
    async get(key) { calls.push(`get:${key}`); throw new Error('R2 GET forbidden'); },
  } };
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/search-terms-daily?startDate=2026-08-12&endDate=2026-08-12&limit=20');
  const response = await handleStoreDailySourceObjectChecksumApiRoute({ request, env, actor: { user_id: 'user-dev-owner' }, url: new URL(request.url) });
  assert.equal(response.status, 200);
  return { body: await response.json(), calls };
}

{
  const { body, calls } = await payload();
  assert.deepEqual(body.sourceObjectNativeChecksumContract, {
    schemaVersion: 'store-search-term-source-object-native-checksum-v1', storageBackend: 'r2',
    verificationMethod: 'head_native_checksum', checksumField: 'checksums.sha256', digestAlgorithm: 'sha256',
    eligibilityRule: 'validated_source_r2_object_head_metadata_sha256_identity',
    identityRule: 'r2_native_sha256_checksum_matches_validated_d1_content_sha256',
  });
  assert.equal(body.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, true);
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumObserved, true);
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumSha256, SHA);
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumSha256IdentityValid, true);
  assert.deepEqual(calls, [`head:${KEY}`]);
}
{
  const { body } = await payload({ object: { key: KEY, customMetadata: { sha256: SHA } } });
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumObserved, false);
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumSha256, null);
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumSha256IdentityValid, false);
}
{
  const { body } = await payload({ object: { key: KEY, customMetadata: { sha256: OTHER }, checksums: { sha256: buf(SHA) } } });
  assert.equal(body.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, false);
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumObserved, false);
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumSha256IdentityValid, false);
}
{
  const facts = [fact({ group_key: 'g1' }), fact({ group_key: 'g2', search_term: 'reading glasses 2', normalized_search_term: 'reading glasses 2', sort_value: 900000 })];
  const { body, calls } = await payload({ facts });
  assert.equal(body.items.length, 2);
  assert.equal(body.items.every(item => item.sourceR2ObjectNativeChecksumSha256IdentityValid === true), true);
  assert.deepEqual(calls, [`head:${KEY}`], 'Gate 20-22 must share one underlying R2 HEAD per key');
}

assert.doesNotMatch(gate20, /checksums|sourceObjectNativeChecksumContract|sourceR2ObjectNativeChecksum/);
assert.doesNotMatch(gate21, /checksums|sourceObjectNativeChecksumContract|sourceR2ObjectNativeChecksum/);
assert.match(gate22, /SOURCE_OBJECT_NATIVE_CHECKSUM_CONTRACT_VERSION = 'store-search-term-source-object-native-checksum-v1'/);
assert.match(gate22, /verificationMethod:\s*'head_native_checksum'/);
assert.match(gate22, /checksumField:\s*'checksums\.sha256'/);
assert.match(gate22, /eligibilityRule:\s*'validated_source_r2_object_head_metadata_sha256_identity'/);
assert.match(gate22, /identityRule:\s*'r2_native_sha256_checksum_matches_validated_d1_content_sha256'/);
assert.match(helper, /observation\.object\.checksums/);
assert.match(helper, /bytes\.byteLength !== 32/);
assert.doesNotMatch(`${gate22}\n${helper}`, /DATA_BUCKET\.get\s*\(|bucket\.get\s*\(|\.arrayBuffer\s*\(|\.text\s*\(/);
assert.doesNotMatch(`${gate22}\n${helper}`, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.doesNotMatch(`${gate22}\n${helper}`, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.match(webEntry, /handleStoreDailySourceObjectChecksumApiRoute/);
assert.doesNotMatch(webEntry, /handleStoreDailySourceObjectMetadataApiRoute/);

console.log(JSON.stringify({ ok: true, gate: 22, contracts: [
  'r2-native-sha256-checksum-contract-explicit', 'gate21-metadata-sha256-identity-required',
  'native-sha256-must-match-d1-content-sha256', 'missing-native-sha256-fails-closed',
  'native-sha256-mismatch-fails-closed', 'gate20-22-share-one-underlying-r2-head-per-key',
  'no-r2-get-or-body-consumption', 'no-write-path-or-readiness-change',
] }));
