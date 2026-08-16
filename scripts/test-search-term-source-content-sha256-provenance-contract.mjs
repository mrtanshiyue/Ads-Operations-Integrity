import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { handleStoreDailyApiRoute } from '../cloudflare/runtime/store-daily-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/store-daily-api.js'), 'utf8');
const bridgeSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-query-bridge-v1.js'), 'utf8');
const VALID_SHA256 = 'a'.repeat(64);

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
    r2_object_key: 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/search-term/dt=2026-08-12/amazon-report-1.json.gz',
    content_sha256: VALID_SHA256,
    ...overrides,
  };
}

function storeDb({ fact = {}, report = {}, missingReport = false } = {}) {
  return {
    prepare(sql) {
      if (sql.includes('FROM report_jobs')) {
        assert.doesNotMatch(sql, /JOIN\s+report_jobs/i);
        assert.match(sql, /SELECT job_id, amazon_report_id, profile_id, ad_product, start_date, end_date, r2_object_key, content_sha256/);
        assert.match(sql, /WHERE job_id IN \(\?1\)/);
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
              return { results: [factRow(fact)] };
            },
          };
        },
      };
    },
  };
}

async function apiPayload(options = {}) {
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/search-terms-daily?startDate=2026-08-12&endDate=2026-08-12&limit=20', {
    method: 'GET',
    headers: { 'cf-ray': 'gate19-read-ray' },
  });
  const response = await handleStoreDailyApiRoute({
    request,
    env: { CONTROL_DB: controlDb(), STORE_01_DB: storeDb(options) },
    actor: { user_id: 'user-dev-owner' },
    url: new URL(request.url),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const payload = await apiPayload();
assert.deepEqual(payload.sourceContentContract, {
  schemaVersion: 'store-search-term-source-content-v1',
  contentSha256: 'report_jobs.content_sha256',
  digestAlgorithm: 'sha256',
  identityRule: 'validated_source_r2_object_identity',
});
assert.equal(payload.items[0].sourceReportJobIdentityValid, true);
assert.equal(payload.items[0].sourceAmazonReportIdentityValid, true);
assert.equal(payload.items[0].sourceR2ObjectIdentityValid, true);
assert.equal(payload.items[0].sourceContentSha256, VALID_SHA256);
assert.equal(payload.items[0].sourceContentSha256IdentityValid, true);

for (const badDigest of [null, '', 'a'.repeat(63), 'g'.repeat(64)]) {
  const invalid = await apiPayload({ report: { content_sha256: badDigest } });
  assert.equal(invalid.items[0].sourceR2ObjectIdentityValid, true);
  assert.notEqual(invalid.items[0].sourceR2ObjectKey, null);
  assert.equal(invalid.items[0].sourceContentSha256, null);
  assert.equal(invalid.items[0].sourceContentSha256IdentityValid, false);
}

const missingObject = await apiPayload({ report: { r2_object_key: null } });
assert.equal(missingObject.items[0].sourceAmazonReportIdentityValid, true);
assert.equal(missingObject.items[0].sourceR2ObjectIdentityValid, false);
assert.equal(missingObject.items[0].sourceContentSha256, null);
assert.equal(missingObject.items[0].sourceContentSha256IdentityValid, false);

for (const options of [
  { missingReport: true },
  { report: { amazon_report_id: null } },
  { report: { profile_id: 'profile-other' } },
  { report: { ad_product: 'SPONSORED_BRANDS' } },
  { report: { start_date: '2026-08-13', end_date: '2026-08-14' } },
]) {
  const invalid = await apiPayload(options);
  assert.equal(invalid.items[0].sourceContentSha256, null);
  assert.equal(invalid.items[0].sourceContentSha256IdentityValid, false);
}

let bridgePayload = payload;
const window = {
  location: { origin: 'https://example.test' },
  CloudflareNativeAPI: {
    async stores() {
      return { stores: [{ store_id: 'store-dev-01', store_code: 'DEV01', display_name: 'Development Store', marketplace_code: 'US' }] };
    },
    async searchTermsDaily() { return bridgePayload; },
  },
  dispatchEvent() { return true; },
};
class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
}
vm.runInNewContext(bridgeSource, { window, CustomEvent, URL, console, setTimeout, clearTimeout });
assert.equal(window.CloudflareNativeQueryBridge.version, '1.4.0');

let bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
let row = bridged.rows[0];
assert.equal(row.sourceR2ObjectKey, payload.items[0].sourceR2ObjectKey);
assert.equal(row.sourceContentSha256, VALID_SHA256);
assert.equal(row.sourceProvenance.sourceContentSchemaVersion, 'store-search-term-source-content-v1');
assert.equal(row.sourceProvenance.sourceContentSha256IdentityValid, true);
assert.equal(row.sourceProvenance.sourceContentSha256Observed, true);
assert.equal(bridged.governance.sourceEvidence.sourceContentContractObserved, true);
assert.equal(bridged.governance.sourceEvidence.sourceContentSha256IdentityObserved, true);
assert.equal(bridged.governance.sourceEvidence.sourceContentSha256Observed, true);

bridgePayload = {
  ...payload,
  sourceContentContract: { ...payload.sourceContentContract, identityRule: 'any_source_object' },
};
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
row = bridged.rows[0];
assert.equal(row.sourceR2ObjectKey, payload.items[0].sourceR2ObjectKey);
assert.equal(row.sourceProvenance.sourceR2ObjectIdentityValid, true);
assert.equal(row.sourceContentSha256, null);
assert.equal(row.sourceProvenance.sourceContentSha256IdentityValid, false);
assert.equal(bridged.governance.sourceEvidence.sourceContentContractObserved, false);

bridgePayload = { ...payload, sourceContentContract: null };
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
assert.equal(bridged.rows[0].sourceR2ObjectKey, payload.items[0].sourceR2ObjectKey);
assert.equal(bridged.rows[0].sourceContentSha256, null);

bridgePayload = { ...payload, sourceObjectContract: null };
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
assert.equal(bridged.rows[0].sourceR2ObjectKey, null);
assert.equal(bridged.rows[0].sourceContentSha256, null);

for (const key of [
  'targetingIdentityReady', 'bidSourceColumnReady', 'bidValueNullabilityTrusted', 'adProductReady',
  'advertisedProductIdentityReady', 'attributionMaturityReady', 'bidGovernanceReady', 'campaignStudioReady',
]) assert.equal(bridged.governance.readiness[key], false, `${key} must remain closed`);
for (const item of bridged.rows) {
  assert.equal(item.bidValueTrusted, false);
  assert.equal(item.governanceReady, false);
}

assert.match(apiSource, /SOURCE_CONTENT_CONTRACT_VERSION = 'store-search-term-source-content-v1'/);
assert.match(apiSource, /contentSha256:\s*'report_jobs\.content_sha256'/);
assert.match(apiSource, /digestAlgorithm:\s*'sha256'/);
assert.match(apiSource, /identityRule:\s*'validated_source_r2_object_identity'/);
assert.match(apiSource, /SELECT job_id, amazon_report_id, profile_id, ad_product, start_date, end_date, r2_object_key, content_sha256/);
assert.match(apiSource, /\^\[0-9a-f\]\{64\}\$\/i/);
assert.match(bridgeSource, /const VERSION = '1\.4\.0'/);
assert.match(bridgeSource, /identityRule === 'validated_source_r2_object_identity'/);
assert.match(bridgeSource, /sourceContentSha256IdentityObserved/);
assert.doesNotMatch(apiSource, /JOIN\s+report_jobs/i);
assert.doesNotMatch(apiSource, /content_bytes|row_count AS report_job|status AS report_job_status|request_fingerprint|request_json/i);
assert.doesNotMatch(apiSource, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.doesNotMatch(bridgeSource, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.doesNotMatch(apiSource, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW|DATA_BUCKET/);
assert.doesNotMatch(bridgeSource, /DATA_BUCKET/);
assert.match(bridgeSource, /bidValueTrusted:\s*false/);
assert.match(bridgeSource, /bidGovernanceReady:\s*false/);
assert.match(bridgeSource, /campaignStudioReady:\s*false/);

console.log(JSON.stringify({
  ok: true,
  gate: 19,
  contracts: [
    'source-content-sha256-provenance-explicit',
    'sha256-provenance-after-r2-object-identity',
    'missing-content-sha256-fails-closed',
    'malformed-content-sha256-fails-closed',
    'invalid-r2-object-identity-blocks-content-sha256',
    'source-content-contract-required-before-bridge-provenance',
    'gate18-r2-object-identity-preserved',
    'report-content-metadata-not-expanded-beyond-sha256',
    'no-r2-object-read-introduced',
    'no-freshness-threshold-introduced',
    'governance-readiness-remains-closed',
    'store-d1-read-only',
  ],
}));