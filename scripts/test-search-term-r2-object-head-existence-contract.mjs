import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleStoreDailySourceObjectHeadApiRoute } from '../cloudflare/runtime/store-daily-source-object-head-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/store-daily-api.js'), 'utf8');
const wrapperSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/store-daily-source-object-head-api.js'), 'utf8');
const headSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/source-object-head.js'), 'utf8');
const VALID_SHA256 = 'a'.repeat(64);
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

function bucket({ result = { key: R2_KEY }, error = null, calls }) {
  return {
    async head(key) {
      calls.push(key);
      if (error) throw error;
      return result;
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
    headers: { 'cf-ray': 'gate20-read-ray' },
  });
  const response = await handleStoreDailySourceObjectHeadApiRoute({
    request,
    env,
    actor: { user_id: 'user-dev-owner' },
    url: new URL(request.url),
  });
  assert.equal(response.status, 200);
  return { payload: await response.json(), calls };
}

{
  const { payload, calls } = await apiPayload();
  assert.deepEqual(payload.sourceObjectHeadContract, {
    schemaVersion: 'store-search-term-source-object-head-v1',
    storageBackend: 'r2',
    verificationMethod: 'head',
    eligibilityRule: 'validated_source_content_sha256',
    identityRule: 'head_key_matches_validated_source_r2_object_key',
  });
  assert.equal(payload.items[0].sourceContentSha256IdentityValid, true);
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, true);
  assert.equal(payload.items[0].sourceR2ObjectExists, true);
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, true);
  assert.deepEqual(calls, [R2_KEY]);
}

{
  const { payload, calls } = await apiPayload({ bucketOptions: { result: null } });
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, true);
  assert.equal(payload.items[0].sourceR2ObjectExists, false);
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, false);
  assert.deepEqual(calls, [R2_KEY]);
}

{
  const { payload } = await apiPayload({ bucketOptions: { result: { key: `${R2_KEY}.other` } } });
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, true);
  assert.equal(payload.items[0].sourceR2ObjectExists, true);
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, false);
}

{
  const { payload, calls } = await apiPayload({ bucketOptions: { error: new Error('r2_unavailable') } });
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectExists, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, false);
  assert.deepEqual(calls, [R2_KEY]);
}

{
  const { payload, calls } = await apiPayload({ includeBucket: false });
  assert.equal(payload.items[0].sourceR2ObjectHeadObserved, false);
  assert.equal(payload.items[0].sourceR2ObjectExists, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, false);
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
  assert.equal(payload.items[0].sourceR2ObjectExists, null);
  assert.equal(payload.items[0].sourceR2ObjectHeadIdentityValid, false);
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
  assert.deepEqual(calls, [R2_KEY], 'identical validated object keys must be HEADed once per API request');
}

assert.doesNotMatch(apiSource, /DATA_BUCKET/);
assert.match(wrapperSource, /SOURCE_OBJECT_HEAD_CONTRACT_VERSION = 'store-search-term-source-object-head-v1'/);
assert.match(wrapperSource, /verificationMethod:\s*'head'/);
assert.match(wrapperSource, /eligibilityRule:\s*'validated_source_content_sha256'/);
assert.match(wrapperSource, /identityRule:\s*'head_key_matches_validated_source_r2_object_key'/);
assert.match(wrapperSource, /sourceR2ObjectHeadObserved/);
assert.match(wrapperSource, /sourceR2ObjectExists/);
assert.match(wrapperSource, /sourceR2ObjectHeadIdentityValid/);
assert.match(wrapperSource, /DATA_BUCKET:\s*_dataBucket/);
assert.match(headSource, /env\?\.DATA_BUCKET/);
assert.match(headSource, /bucket\.head\(key\)/);
assert.doesNotMatch(headSource, /bucket\.get\s*\(/);
assert.doesNotMatch(headSource, /\.arrayBuffer\s*\(|\.text\s*\(|\.json\s*\(/);
assert.doesNotMatch(`${wrapperSource}\n${headSource}`, /content_bytes|row_count AS report_job|status AS report_job_status|request_fingerprint|request_json/i);
assert.doesNotMatch(`${wrapperSource}\n${headSource}`, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.doesNotMatch(`${apiSource}\n${wrapperSource}\n${headSource}`, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);

console.log(JSON.stringify({
  ok: true,
  gate: 20,
  contracts: [
    'r2-head-existence-contract-explicit',
    'r2-head-after-gate19-content-identity',
    'r2-head-key-must-match-d1-provenance',
    'missing-r2-object-observed-fails-closed',
    'r2-head-error-fails-closed',
    'missing-r2-binding-fails-closed',
    'invalid-gate19-evidence-skips-r2-head',
    'duplicate-r2-heads-deduplicated',
    'no-r2-get-or-body-read',
    'no-report-metadata-expansion',
    'no-freshness-threshold-introduced',
    'store-d1-read-only',
  ],
}));
