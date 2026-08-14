import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleStoreDailySourceObjectMetadataApiRoute } from '../cloudflare/runtime/store-daily-source-object-metadata-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/store-daily-api.js'), 'utf8');
const gate20WrapperSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/store-daily-source-object-head-api.js'), 'utf8');
const headSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/source-object-head.js'), 'utf8');
const wrapperSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/store-daily-source-object-metadata-api.js'), 'utf8');
const metadataSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/source-object-metadata.js'), 'utf8');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const VALID_SHA256 = 'a'.repeat(64);
const OTHER_SHA256 = 'b'.repeat(64);
const R2_KEY = 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/search-term/dt=2026-08-12/amazon-report-1.json.gz';

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
                return { store_id: 'store-dev-01', d1_binding_key: 'STORE_01_DB', status: 'active' };
              }
              throw new Error(`unexpected control query: ${sql}`);
            },
          };
        },
      };
    },
  };
}

function factRow(overrides = {}) {
  return {
    group_key: 'g-keyword',
    report_date: '2026-08-12',
    profile_id: 'profile-1',
    ad_product: 'SPONSORED_PRODUCTS',
    campaign_id: 'campaign-1',
    campaign_name: 'Campaign 1',
    ad_group_id: 'adgroup-1',
    ad_group_name: 'Ad group 1',
    keyword_id: 'keyword-1',
    keyword_text: 'reading glasses',
    keyword_match_type: 'EXACT',
    keyword_state: 'ENABLED',
    keyword_bid_micros: 2500000,
    keyword_source_updated_at: null,
    keyword_synced_at: '2026-08-14 09:35:29',
    target_id: null,
    target_type: null,
    target_expression_text: null,
    target_state: null,
    target_bid_micros: null,
    target_source_updated_at: null,
    target_synced_at: null,
    search_term: 'reading glasses',
    normalized_search_term: 'reading glasses',
    report_match_type: 'EXACT',
    fact_mirror_updated_at: '2026-08-14 09:35:29',
    fact_row_count: 1,
    source_report_job_non_null_count: 1,
    source_report_job_distinct_count: 1,
    source_report_job_id_candidate: 'report-job-1',
    impressions: 100,
    clicks: 10,
    cost_micros: 1000000,
    purchases: 2,
    units_sold: 2,
    sales_micros: 5000000,
    sort_value: 1000000,
    ...overrides,
  };
}

function reportJob(overrides = {}) {
  return {
    job_id: 'report-job-1',
    amazon_report_id: 'amazon-report-1',
    profile_id: 'profile-1',
    ad_product: 'SPONSORED_PRODUCTS',
    start_date: '2026-08-12',
    end_date: '2026-08-12',
    r2_object_key: R2_KEY,
    content_sha256: VALID_SHA256,
    ...overrides,
  };
}

function storeDb({ facts, report = {}, missingReport = false } = {}) {
  const factRows = facts || [factRow()];
  return {
    prepare(sql) {
      if (sql.includes('FROM report_jobs')) {
        assert.doesNotMatch(sql, /JOIN\s+report_jobs/i);
        assert.match(sql, /SELECT job_id, amazon_report_id, profile_id, ad_product, start_date, end_date, r2_object_key, content_sha256/);
        return {
          bind(...params) {
            assert.deepEqual(params, ['report-job-1']);
            return {
              async all() {
                return { results: missingReport ? [] : [reportJob(report)] };
              },
            };
          },
        };
      }
      assert.doesNotMatch(sql, /report_jobs/i);
      return {
        bind() {
          return {
            async all() {
              return { results: factRows };
            },
          };
        },
      };
    },
  };
}

function bucket({ result, error = null, calls }) {
  const object = result === undefined
    ? { key: R2_KEY, customMetadata: { sha256: VALID_SHA256 } }
    : result;
  return {
    async head(key) {
      calls.push(key);
      if (error) throw error;
      return object;
    },
  };
}

async function apiPayload({ dbOptions = {}, bucketOptions, includeBucket = true } = {}) {
  const calls = [];
  const env = {
    CONTROL_DB: controlDb(),
    STORE_01_DB: storeDb(dbOptions),
  };
  if (includeBucket) env.DATA_BUCKET = bucket({ calls, ...(bucketOptions || {}) });
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/search-terms-daily?startDate=2026-08-12&endDate=2026-08-12&limit=20', {
    method: 'GET',
    headers: { 'cf-ray': 'gate21-read-ray' },
  });
  const response = await handleStoreDailySourceObjectMetadataApiRoute({
    request,
    env,
    actor: { user_id: 'user-dev-owner' },
    url: new URL(request.url),
  });
  assert.equal(response.status, 200);
  return { payload: await response.json(), calls };
}

{
  const { payload, calls } = await apiPayload({
    bucketOptions: { result: { key: R2_KEY, customMetadata: { sha256: VALID_SHA256.toUpperCase() } } },
  });
  assert.deepEqual(payload.sourceObjectHeadContract, {
    schemaVersion: 'store-search-term-source-object-head-v1',
    storageBackend: 'r2',
    verificationMethod: 'head',
    eligibilityRule: 'validated_source_content_sha256',
    identityRule: 'head_key_matches_validated_source_r2_object_key',
  });
  assert.deepEqual(payload.sourceObjectMetadataContract, {
    schemaVersion: 'store-search-term-source-object-metadata-v1',
    storageBackend: 'r2',
    verificationMethod: 'head_custom_metadata',
    metadataKey: 'sha256',
    eligibilityRule: 'validated_source_r2_object_head_identity',
    identityRule: 'r2_custom_metadata_sha256_matches_validated_d1_content_sha256',
  });
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, true);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataObserved, true);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256, VALID_SHA256);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, true);
  assert.deepEqual(calls, [R2_KEY]);
}

{
  const { payload } = await apiPayload({
    bucketOptions: { result: { key: R2_KEY, customMetadata: { sha256: OTHER_SHA256 } } },
  });
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataObserved, true);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256, OTHER_SHA256);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, false);
}

for (const result of [
  { key: R2_KEY },
  { key: R2_KEY, customMetadata: {} },
  { key: R2_KEY, customMetadata: { sha256: 'a'.repeat(63) } },
  { key: R2_KEY, customMetadata: { sha256: 'a'.repeat(65) } },
  { key: R2_KEY, customMetadata: { sha256: 'g'.repeat(64) } },
  { key: R2_KEY, customMetadata: 'invalid' },
]) {
  const { payload } = await apiPayload({ bucketOptions: { result } });
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, true);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataObserved, true);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, false);
}

{
  const { payload, calls } = await apiPayload({ bucketOptions: { result: null } });
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, true);
  assert.equal(payload.items[0].sourceR2ObjectExists, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, false);
  assert.deepEqual(calls, [R2_KEY]);
}

{
  const { payload } = await apiPayload({
    bucketOptions: { result: { key: `${R2_KEY}.other`, customMetadata: { sha256: VALID_SHA256 } } },
  });
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, true);
  assert.equal(payload.items[0].sourceR2ObjectExists, true);
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, false);
}

{
  const { payload, calls } = await apiPayload({ bucketOptions: { error: new Error('r2_unavailable') } });
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectExists, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, false);
  assert.deepEqual(calls, [R2_KEY]);
}

{
  const { payload, calls } = await apiPayload({ includeBucket: false });
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectExists, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, false);
  assert.deepEqual(calls, []);
}

for (const dbOptions of [
  { report: { content_sha256: null } },
  { report: { content_sha256: 'a'.repeat(63) } },
  { report: { r2_object_key: null } },
  { report: { amazon_report_id: null } },
  { report: { profile_id: 'profile-other' } },
  { missingReport: true },
]) {
  const { payload, calls } = await apiPayload({ dbOptions });
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadMetadataSha256IdentityValid, false);
  assert.deepEqual(calls, [], 'R2 HEAD must not run before Gate 19 eligibility is valid');
}

{
  const facts = [
    factRow({ group_key: 'g-1', search_term: 'reading glasses one', normalized_search_term: 'reading glasses one' }),
    factRow({ group_key: 'g-2', search_term: 'reading glasses two', normalized_search_term: 'reading glasses two', sort_value: 900000 }),
  ];
  const { payload, calls } = await apiPayload({ dbOptions: { facts } });
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items.every((item) => item.sourceR2ObjectHeadIdentityValid === true), true);
  assert.equal(payload.items.every((item) => item.sourceR2ObjectHeadMetadataSha256IdentityValid === true), true);
  assert.deepEqual(calls, [R2_KEY], 'Gate 20 and Gate 21 must share one deduplicated HEAD observation');
}

assert.doesNotMatch(apiSource, /DATA_BUCKET/);
assert.doesNotMatch(gate20WrapperSource, /customMetadata|sourceObjectMetadataContract|sourceR2ObjectHeadMetadata/);
assert.match(wrapperSource, /SOURCE_OBJECT_METADATA_CONTRACT_VERSION = 'store-search-term-source-object-metadata-v1'/);
assert.match(wrapperSource, /verificationMethod:\s*'head_custom_metadata'/);
assert.match(wrapperSource, /metadataKey:\s*'sha256'/);
assert.match(wrapperSource, /eligibilityRule:\s*'validated_source_r2_object_head_identity'/);
assert.match(wrapperSource, /identityRule:\s*'r2_custom_metadata_sha256_matches_validated_d1_content_sha256'/);
assert.match(wrapperSource, /sourceR2ObjectHeadObserved/);
assert.match(wrapperSource, /sourceR2ObjectHeadMetadataObserved/);
assert.match(wrapperSource, /sourceR2ObjectHeadMetadataSha256IdentityValid/);
assert.match(wrapperSource, /DATA_BUCKET:\s*_dataBucket/);
assert.match(headSource, /bucket\.head\(key\)/);
assert.doesNotMatch(wrapperSource, /bucket\.head\s*\(/);
assert.doesNotMatch(`${wrapperSource}\n${metadataSource}\n${headSource}`, /bucket\.get\s*\(|\.arrayBuffer\s*\(|\.text\s*\(|\.json\s*\(/);
assert.doesNotMatch(`${wrapperSource}\n${metadataSource}`, /checksums/i);
assert.doesNotMatch(`${wrapperSource}\n${metadataSource}`, /content_bytes|row_count AS report_job|status AS report_job_status|request_fingerprint|request_json/i);
assert.doesNotMatch(`${wrapperSource}\n${metadataSource}`, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.doesNotMatch(`${apiSource}\n${wrapperSource}\n${metadataSource}`, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.match(webEntrySource, /handleStoreDailySourceObjectMetadataApiRoute/);
assert.doesNotMatch(webEntrySource, /handleStoreDailySourceObjectHeadApiRoute/);

console.log(JSON.stringify({
  ok: true,
  gate: 21,
  contracts: [
    'r2-head-custom-metadata-sha256-contract-explicit',
    'gate20-head-identity-required',
    'metadata-sha256-must-match-d1-content-sha256',
    'metadata-sha256-canonicalized-lowercase',
    'missing-metadata-fails-closed',
    'malformed-metadata-sha256-fails-closed',
    'metadata-sha256-mismatch-fails-closed',
    'missing-r2-object-skips-metadata-identity',
    'r2-head-key-mismatch-skips-metadata-identity',
    'r2-head-error-fails-closed',
    'missing-r2-binding-fails-closed',
    'invalid-gate19-evidence-skips-r2-head',
    'gate20-gate21-share-single-deduplicated-head',
    'no-r2-get-or-body-read',
    'no-r2-native-checksum-scope-expansion',
    'no-report-metadata-expansion',
    'no-freshness-threshold-introduced',
    'store-d1-read-only',
  ],
}));
