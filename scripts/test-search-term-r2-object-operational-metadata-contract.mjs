import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleStoreDailySourceObjectChecksumApiRoute } from '../cloudflare/runtime/store-daily-source-object-checksum-api.js';
import { createStoreDailySourceObjectOperationalMetadataLayer } from '../cloudflare/runtime/store-daily-source-object-operational-metadata-api.js';
import { sourceR2ObjectOperationalMetadataIdentity } from '../cloudflare/runtime/source-object-operational-metadata.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate22 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-checksum-api.js'), 'utf8');
const gate23 = await readFile(path.join(root, 'cloudflare/runtime/store-daily-source-object-operational-metadata-api.js'), 'utf8');
const helper = await readFile(path.join(root, 'cloudflare/runtime/source-object-operational-metadata.js'), 'utf8');
const webEntry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');
const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const KEY = 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/search-term/dt=2026-08-12/amazon-report-1.json.gz';
const buf = hex => Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)).buffer;
const VALID_METADATA = {
  sha256: SHA,
  store_code: 'DEV01',
  profile_id: 'profile-1',
  report_type: 'search-term',
  ad_product: 'SPONSORED_PRODUCTS',
  run_id: 'run-1',
  schema_version: 'v1',
};

assert.deepEqual(sourceR2ObjectOperationalMetadataIdentity({
  valid: true,
  storeCode: 'DEV01',
  profileId: 'profile-1',
  reportType: 'search-term',
  adProduct: 'SPONSORED_PRODUCTS',
  runId: 'run-1',
}, { observed: true, object: { customMetadata: VALID_METADATA } }), { observed: true, valid: true });
assert.deepEqual(sourceR2ObjectOperationalMetadataIdentity({ valid: false }, {
  observed: true,
  object: { customMetadata: VALID_METADATA },
}), { observed: false, valid: false });

function controlDb() {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM user_global_roles')) return { ok: 1 };
              if (sql.includes('FROM stores')) {
                assert.equal(params[0], 'store-dev-01');
                return {
                  store_id: 'store-dev-01',
                  store_code: 'DEV01',
                  d1_binding_key: 'STORE_01_DB',
                  status: 'active',
                };
              }
              throw new Error(`unexpected control query: ${sql}`);
            },
          };
        },
      };
    },
  };
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

function sourceReport(overrides = {}) {
  return {
    job_id: 'report-job-1', amazon_report_id: 'amazon-report-1', profile_id: 'profile-1', ad_product: 'SPONSORED_PRODUCTS',
    start_date: '2026-08-12', end_date: '2026-08-12', r2_object_key: KEY, content_sha256: SHA,
    ...overrides,
  };
}

function operationalReport(overrides = {}) {
  return {
    job_id: 'report-job-1', run_id: 'run-1', profile_id: 'profile-1', ad_product: 'SPONSORED_PRODUCTS', report_type: 'search-term',
    ...overrides,
  };
}

function storeDb({ facts = [fact()], source = {}, operational = {} } = {}, counters) {
  return {
    prepare(sql) {
      if (sql.includes('FROM report_jobs')) {
        if (/SELECT\s+job_id,\s*run_id,\s*profile_id,\s*ad_product,\s*report_type/i.test(sql)) {
          counters.operationalQueries += 1;
          return {
            bind(...params) {
              assert.deepEqual(params, ['report-job-1']);
              return { async all() { return { results: [operationalReport(operational)] }; } };
            },
          };
        }
        counters.sourceQueries += 1;
        return {
          bind(...params) {
            assert.deepEqual(params, ['report-job-1']);
            return { async all() { return { results: [sourceReport(source)] }; } };
          },
        };
      }
      assert.doesNotMatch(sql, /report_jobs/i);
      return { bind() { return { async all() { return { results: facts }; } }; } };
    },
  };
}

function bucket({ object, calls }) {
  return {
    async head(key) {
      calls.push(`head:${key}`);
      return object === undefined
        ? { key: KEY, customMetadata: { ...VALID_METADATA }, checksums: { sha256: buf(SHA) } }
        : object;
    },
    async get(key) {
      calls.push(`get:${key}`);
      throw new Error('Gate 23 must not call R2 GET');
    },
  };
}

async function payload({ dbOptions = {}, object, includeBucket = true } = {}) {
  const calls = [];
  const counters = { sourceQueries: 0, operationalQueries: 0 };
  const env = {
    CONTROL_DB: controlDb(),
    STORE_01_DB: storeDb(dbOptions, counters),
  };
  if (includeBucket) env.DATA_BUCKET = bucket({ object, calls });
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/search-terms-daily?startDate=2026-08-12&endDate=2026-08-12&limit=20');
  const url = new URL(request.url);
  const layer = createStoreDailySourceObjectOperationalMetadataLayer({ env, url });
  const gate22Response = await handleStoreDailySourceObjectChecksumApiRoute({
    request,
    env: layer.env,
    actor: { user_id: 'user-dev-owner' },
    url,
  });
  assert.equal(gate22Response.status, 200);
  const response = await layer.enrich(gate22Response);
  assert.equal(response.status, 200);
  return { body: await response.json(), calls, counters };
}

{
  const { body, calls, counters } = await payload();
  assert.deepEqual(body.sourceObjectOperationalMetadataContract, {
    schemaVersion: 'store-search-term-source-object-operational-metadata-v1',
    storageBackend: 'r2',
    verificationMethod: 'head_custom_metadata_context',
    metadataKeys: ['store_code', 'profile_id', 'report_type', 'ad_product', 'run_id'],
    eligibilityRule: 'validated_source_r2_object_native_sha256_identity',
    identityRule: 'r2_operational_metadata_matches_validated_store_report_context',
  });
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumSha256IdentityValid, true);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataObserved, true);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataIdentityValid, true);
  assert.deepEqual(calls, [`head:${KEY}`]);
  assert.equal(counters.operationalQueries, 1);
}

for (const key of ['store_code', 'profile_id', 'report_type', 'ad_product', 'run_id']) {
  const metadata = { ...VALID_METADATA, [key]: `wrong-${key}` };
  const { body, calls } = await payload({ object: { key: KEY, customMetadata: metadata, checksums: { sha256: buf(SHA) } } });
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataObserved, true, `${key} mismatch must still be observed`);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataIdentityValid, false, `${key} mismatch must fail closed`);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

for (const key of ['store_code', 'profile_id', 'report_type', 'ad_product', 'run_id']) {
  const metadata = { ...VALID_METADATA };
  delete metadata[key];
  const { body } = await payload({ object: { key: KEY, customMetadata: metadata, checksums: { sha256: buf(SHA) } } });
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataObserved, true);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataIdentityValid, false, `${key} missing must fail closed`);
}

{
  const { body } = await payload({ dbOptions: { operational: { run_id: null } } });
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataObserved, false);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataIdentityValid, false);
}

{
  const { body, calls } = await payload({
    object: { key: KEY, customMetadata: { ...VALID_METADATA }, checksums: { sha256: buf(OTHER) } },
  });
  assert.equal(body.items[0].sourceR2ObjectNativeChecksumSha256IdentityValid, false);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataObserved, false);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataIdentityValid, false);
  assert.deepEqual(calls, [`head:${KEY}`]);
}

{
  const facts = [fact({
    source_report_job_non_null_count: 0,
    source_report_job_distinct_count: 0,
    source_report_job_id_candidate: null,
  })];
  const { body, calls, counters } = await payload({ dbOptions: { facts } });
  assert.equal(body.items[0].sourceReportJobIdentityValid, false);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataObserved, false);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataIdentityValid, false);
  assert.deepEqual(calls, []);
  assert.equal(counters.operationalQueries, 0);
}

{
  const facts = [
    fact({ group_key: 'g1' }),
    fact({ group_key: 'g2', search_term: 'reading glasses 2', normalized_search_term: 'reading glasses 2', sort_value: 900000 }),
  ];
  const { body, calls, counters } = await payload({ dbOptions: { facts } });
  assert.equal(body.items.length, 2);
  assert.equal(body.items.every(item => item.sourceR2ObjectOperationalMetadataIdentityValid === true), true);
  assert.deepEqual(calls, [`head:${KEY}`], 'Gate 20-23 must share one underlying R2 HEAD per key');
  assert.equal(counters.operationalQueries, 1);
}

{
  const { body, calls } = await payload({ includeBucket: false });
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataObserved, false);
  assert.equal(body.items[0].sourceR2ObjectOperationalMetadataIdentityValid, false);
  assert.deepEqual(calls, []);
}

assert.doesNotMatch(gate22, /OperationalMetadata|operational-metadata|store_code|report_type|run_id/);
assert.match(gate23, /SOURCE_OBJECT_OPERATIONAL_METADATA_CONTRACT_VERSION = 'store-search-term-source-object-operational-metadata-v1'/);
assert.match(gate23, /verificationMethod:\s*'head_custom_metadata_context'/);
assert.match(gate23, /metadataKeys:\s*OPERATIONAL_METADATA_KEYS/);
assert.match(gate23, /eligibilityRule:\s*'validated_source_r2_object_native_sha256_identity'/);
assert.match(gate23, /identityRule:\s*'r2_operational_metadata_matches_validated_store_report_context'/);
assert.match(gate23, /SELECT job_id, run_id, profile_id, ad_product, report_type/);
assert.doesNotMatch(gate23, /schema_version/);
assert.match(helper, /store_code/);
assert.match(helper, /profile_id/);
assert.match(helper, /report_type/);
assert.match(helper, /ad_product/);
assert.match(helper, /run_id/);
assert.doesNotMatch(`${gate23}\n${helper}`, /DATA_BUCKET\.get\s*\(|bucket\.get\s*\(|\.arrayBuffer\s*\(|\.text\s*\(/);
assert.doesNotMatch(`${gate23}\n${helper}`, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.doesNotMatch(`${gate23}\n${helper}`, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.match(webEntry, /handleStoreDailySourceObjectMetadataApiRoute/);
assert.match(webEntry, /const response = await handleStoreDailySourceObjectChecksumApiRoute/);
assert.match(webEntry, /createStoreDailySourceObjectOperationalMetadataLayer/);
assert.match(webEntry, /return gate23Layer\.enrich\(response\)/);

console.log(JSON.stringify({ ok: true, gate: 23, contracts: [
  'r2-operational-metadata-context-contract-explicit',
  'gate22-native-sha256-identity-required',
  'store-code-context-must-match',
  'profile-context-must-match',
  'report-type-context-must-match',
  'ad-product-context-must-match',
  'run-id-context-must-match',
  'missing-operational-metadata-fails-closed',
  'gate20-23-share-one-underlying-r2-head-per-key',
  'gate22-entry-boundary-preserved',
  'schema-version-not-falsely-validated',
  'no-r2-get-or-body-consumption',
  'no-write-path-or-readiness-change',
] }));
