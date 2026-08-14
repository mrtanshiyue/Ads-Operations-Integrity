import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { handleStoreDailyApiRoute } from '../cloudflare/runtime/store-daily-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/store-daily-api.js'), 'utf8');
const bridgeSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-query-bridge-v1.js'), 'utf8');

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
    r2_object_key: 'amazon-ads/reports/profile-1/2026-08-12/report-job-1.json.gz',
    ...overrides,
  };
}

function storeDb({ fact = {}, report = {}, missingReport = false } = {}) {
  return {
    prepare(sql) {
      if (sql.includes('FROM report_jobs')) {
        assert.doesNotMatch(sql, /JOIN\s+report_jobs/i);
        assert.match(sql, /SELECT job_id, amazon_report_id, profile_id, ad_product, start_date, end_date, r2_object_key/);
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
    headers: { 'cf-ray': 'gate18-read-ray' },
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
assert.deepEqual(payload.sourceObjectContract, {
  schemaVersion: 'store-search-term-source-object-v1',
  r2ObjectKey: 'report_jobs.r2_object_key',
  storageBackend: 'r2',
  identityRule: 'validated_source_amazon_report_identity',
});
assert.equal(payload.items[0].sourceReportJobIdentityValid, true);
assert.equal(payload.items[0].sourceAmazonReportIdentityValid, true);
assert.equal(payload.items[0].sourceAmazonReportId, 'amazon-report-1');
assert.equal(payload.items[0].sourceR2ObjectKey, 'amazon-ads/reports/profile-1/2026-08-12/report-job-1.json.gz');
assert.equal(payload.items[0].sourceR2ObjectIdentityValid, true);
assert.equal(payload.items[0].currentBidSyncedAt, '2026-08-14 09:35:29');
assert.equal(payload.items[0].targetingSourceUpdatedAt, null);
assert.equal(payload.items[0].factMirrorUpdatedAt, '2026-08-14 09:35:29');

const missingObject = await apiPayload({ report: { r2_object_key: null } });
assert.equal(missingObject.items[0].sourceAmazonReportId, 'amazon-report-1');
assert.equal(missingObject.items[0].sourceAmazonReportIdentityValid, true);
assert.equal(missingObject.items[0].sourceR2ObjectKey, null);
assert.equal(missingObject.items[0].sourceR2ObjectIdentityValid, false);

for (const options of [
  { missingReport: true },
  { report: { amazon_report_id: null } },
  { report: { profile_id: 'profile-other' } },
  { report: { ad_product: 'SPONSORED_BRANDS' } },
  { report: { start_date: '2026-08-13', end_date: '2026-08-14' } },
]) {
  const invalid = await apiPayload(options);
  assert.equal(invalid.items[0].sourceAmazonReportIdentityValid, false);
  assert.equal(invalid.items[0].sourceR2ObjectKey, null);
  assert.equal(invalid.items[0].sourceR2ObjectIdentityValid, false);
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

let bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
let row = bridged.rows[0];
assert.equal(row.sourceAmazonReportId, 'amazon-report-1');
assert.equal(row.sourceR2ObjectKey, 'amazon-ads/reports/profile-1/2026-08-12/report-job-1.json.gz');
assert.equal(row.sourceProvenance.sourceObjectSchemaVersion, 'store-search-term-source-object-v1');
assert.equal(row.sourceProvenance.sourceR2ObjectIdentityValid, true);
assert.equal(row.sourceProvenance.sourceR2ObjectObserved, true);
assert.equal(bridged.governance.sourceEvidence.sourceObjectContractObserved, true);
assert.equal(bridged.governance.sourceEvidence.sourceR2ObjectIdentityObserved, true);
assert.equal(bridged.governance.sourceEvidence.sourceR2ObjectObserved, true);

bridgePayload = {
  ...payload,
  sourceObjectContract: { ...payload.sourceObjectContract, identityRule: 'any_report_object' },
};
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
row = bridged.rows[0];
assert.equal(row.sourceAmazonReportId, 'amazon-report-1');
assert.equal(row.sourceProvenance.sourceAmazonReportIdentityValid, true);
assert.equal(row.sourceR2ObjectKey, null);
assert.equal(row.sourceProvenance.sourceR2ObjectIdentityValid, false);
assert.equal(bridged.governance.sourceEvidence.sourceObjectContractObserved, false);

bridgePayload = { ...payload, sourceObjectContract: null };
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
assert.equal(bridged.rows[0].sourceAmazonReportId, 'amazon-report-1');
assert.equal(bridged.rows[0].sourceR2ObjectKey, null);

bridgePayload = { ...payload, sourceReportContract: null };
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
assert.equal(bridged.rows[0].sourceAmazonReportId, null);
assert.equal(bridged.rows[0].sourceR2ObjectKey, null);
assert.equal(bridged.rows[0].sourceProvenance.sourceR2ObjectIdentityValid, false);

for (const key of [
  'targetingIdentityReady', 'bidSourceColumnReady', 'bidValueNullabilityTrusted', 'adProductReady',
  'advertisedProductIdentityReady', 'attributionMaturityReady', 'bidGovernanceReady', 'campaignStudioReady',
]) assert.equal(bridged.governance.readiness[key], false, `${key} must remain closed`);
for (const item of bridged.rows) {
  assert.equal(item.bidValueTrusted, false);
  assert.equal(item.governanceReady, false);
}

assert.match(apiSource, /SOURCE_OBJECT_CONTRACT_VERSION = 'store-search-term-source-object-v1'/);
assert.match(apiSource, /r2ObjectKey:\s*'report_jobs\.r2_object_key'/);
assert.match(apiSource, /storageBackend:\s*'r2'/);
assert.match(apiSource, /identityRule:\s*'validated_source_amazon_report_identity'/);
assert.match(apiSource, /SELECT job_id, amazon_report_id, profile_id, ad_product, start_date, end_date, r2_object_key/);
assert.match(bridgeSource, /identityRule === 'validated_source_amazon_report_identity'/);
assert.match(bridgeSource, /sourceR2ObjectIdentityObserved/);
assert.doesNotMatch(apiSource, /JOIN\s+report_jobs/i);
assert.doesNotMatch(apiSource, /content_sha256|content_bytes|request_fingerprint|request_json|row_count AS report_job|status AS report_job_status/i);
assert.doesNotMatch(apiSource, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.doesNotMatch(bridgeSource, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.doesNotMatch(apiSource, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW|DATA_BUCKET/);
assert.match(bridgeSource, /bidValueTrusted:\s*false/);
assert.match(bridgeSource, /bidGovernanceReady:\s*false/);
assert.match(bridgeSource, /campaignStudioReady:\s*false/);

console.log(JSON.stringify({
  ok: true,
  gate: 18,
  contracts: [
    'r2-object-key-provenance-explicit',
    'r2-object-provenance-after-amazon-report-identity',
    'missing-r2-object-key-fails-closed',
    'invalid-amazon-report-identity-blocks-r2-object-provenance',
    'source-object-contract-required-before-bridge-provenance',
    'gate17-amazon-report-identity-preserved',
    'report-content-metadata-not-expanded',
    'no-r2-object-read-introduced',
    'no-freshness-threshold-introduced',
    'governance-readiness-remains-closed',
    'store-d1-read-only',
  ],
}));