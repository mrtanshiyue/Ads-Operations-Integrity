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

function storeDb(overrides = {}) {
  return {
    prepare(sql) {
      assert.match(sql, /lineage_validated AS/);
      assert.match(sql, /validated_source_report_job_id/);
      assert.match(sql, /LEFT JOIN \(\s*SELECT job_id, amazon_report_id, profile_id, ad_product, start_date, end_date\s*FROM report_jobs\s*\) rj ON rj\.job_id = lv\.validated_source_report_job_id/);
      assert.match(sql, /rj\.amazon_report_id AS source_amazon_report_id/);
      return {
        bind() {
          return {
            async all() {
              return {
                results: [{
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
                  validated_source_report_job_id: 'report-job-1',
                  report_job_id: 'report-job-1',
                  source_amazon_report_id: 'amazon-report-1',
                  report_job_profile_id: 'profile-1',
                  report_job_ad_product: 'SPONSORED_PRODUCTS',
                  report_job_start_date: '2026-08-12',
                  report_job_end_date: '2026-08-12',
                  impressions: 100,
                  clicks: 10,
                  cost_micros: 1000000,
                  purchases: 2,
                  units_sold: 2,
                  sales_micros: 5000000,
                  sort_value: 1000000,
                  ...overrides,
                }],
              };
            },
          };
        },
      };
    },
  };
}

async function apiPayload(overrides = {}) {
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/search-terms-daily?startDate=2026-08-12&endDate=2026-08-12&limit=20', {
    method: 'GET',
    headers: { 'cf-ray': 'gate17-read-ray' },
  });
  const response = await handleStoreDailyApiRoute({
    request,
    env: { CONTROL_DB: controlDb(), STORE_01_DB: storeDb(overrides) },
    actor: { user_id: 'user-dev-owner' },
    url: new URL(request.url),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const payload = await apiPayload();
assert.deepEqual(payload.factLineageContract, {
  schemaVersion: 'store-search-term-fact-lineage-v1',
  sourceReportJobId: 'search_term_daily.source_report_job_id',
  sourceReportJobAggregation: 'unanimous_non_null',
});
assert.deepEqual(payload.sourceReportContract, {
  schemaVersion: 'store-search-term-source-report-v1',
  sourceReportJobId: 'report_jobs.job_id',
  amazonReportId: 'report_jobs.amazon_report_id',
  joinRule: 'validated_source_report_job_id',
  contextRule: 'profile_ad_product_date_covered',
});
assert.equal(payload.items[0].sourceReportJobId, 'report-job-1');
assert.equal(payload.items[0].sourceReportJobIdentityValid, true);
assert.equal(payload.items[0].sourceAmazonReportId, 'amazon-report-1');
assert.equal(payload.items[0].sourceAmazonReportIdentityValid, true);
assert.equal(payload.items[0].factMirrorUpdatedAt, '2026-08-14 09:35:29');
assert.equal(payload.items[0].currentBidSyncedAt, '2026-08-14 09:35:29');
assert.equal(payload.items[0].targetingSourceUpdatedAt, null);

for (const overrides of [
  { report_job_id: null },
  { source_amazon_report_id: null },
  { report_job_profile_id: 'profile-other' },
  { report_job_ad_product: 'SPONSORED_BRANDS' },
  { report_job_start_date: '2026-08-13', report_job_end_date: '2026-08-14' },
  {
    fact_row_count: 2,
    source_report_job_non_null_count: 2,
    source_report_job_distinct_count: 2,
    source_report_job_id_candidate: 'report-job-1',
  },
]) {
  const invalid = await apiPayload(overrides);
  assert.equal(invalid.items[0].sourceAmazonReportId, null);
  assert.equal(invalid.items[0].sourceAmazonReportIdentityValid, false);
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
assert.equal(row.sourceReportJobId, 'report-job-1');
assert.equal(row.sourceAmazonReportId, 'amazon-report-1');
assert.equal(row.sourceProvenance.sourceReportSchemaVersion, 'store-search-term-source-report-v1');
assert.equal(row.sourceProvenance.sourceAmazonReportIdentityValid, true);
assert.equal(row.sourceProvenance.sourceAmazonReportId, 'amazon-report-1');
assert.equal(row.sourceProvenance.sourceAmazonReportObserved, true);
assert.equal(bridged.governance.sourceEvidence.sourceReportContractObserved, true);
assert.equal(bridged.governance.sourceEvidence.sourceAmazonReportIdentityObserved, true);
assert.equal(bridged.governance.sourceEvidence.sourceAmazonReportObserved, true);

bridgePayload = {
  ...payload,
  sourceReportContract: {
    ...payload.sourceReportContract,
    joinRule: 'any_job_id',
  },
};
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
row = bridged.rows[0];
assert.equal(row.sourceReportJobId, 'report-job-1');
assert.equal(row.sourceProvenance.sourceReportJobIdentityValid, true);
assert.equal(row.sourceAmazonReportId, null);
assert.equal(row.sourceProvenance.sourceAmazonReportIdentityValid, false);
assert.equal(row.sourceProvenance.sourceAmazonReportObserved, false);
assert.equal(bridged.governance.sourceEvidence.sourceReportContractObserved, false);

bridgePayload = { ...payload, sourceReportContract: null };
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
assert.equal(bridged.rows[0].sourceReportJobId, 'report-job-1');
assert.equal(bridged.rows[0].sourceAmazonReportId, null);

bridgePayload = { ...payload, factLineageContract: null };
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
assert.equal(bridged.rows[0].sourceReportJobId, null);
assert.equal(bridged.rows[0].sourceAmazonReportId, null);
assert.equal(bridged.rows[0].sourceProvenance.sourceAmazonReportIdentityValid, false);

for (const key of [
  'targetingIdentityReady', 'bidSourceColumnReady', 'bidValueNullabilityTrusted', 'adProductReady',
  'advertisedProductIdentityReady', 'attributionMaturityReady', 'bidGovernanceReady', 'campaignStudioReady',
]) assert.equal(bridged.governance.readiness[key], false, `${key} must remain closed`);
for (const item of bridged.rows) {
  assert.equal(item.bidValueTrusted, false);
  assert.equal(item.governanceReady, false);
}

assert.match(apiSource, /SOURCE_REPORT_CONTRACT_VERSION = 'store-search-term-source-report-v1'/);
assert.match(apiSource, /lineage_validated AS/);
assert.match(apiSource, /LEFT JOIN \(\s*SELECT job_id, amazon_report_id, profile_id, ad_product, start_date, end_date\s*FROM report_jobs\s*\) rj ON rj\.job_id = lv\.validated_source_report_job_id/);
assert.match(apiSource, /amazonReportId:\s*'report_jobs\.amazon_report_id'/);
assert.match(apiSource, /contextRule:\s*'profile_ad_product_date_covered'/);
assert.match(bridgeSource, /joinRule === 'validated_source_report_job_id'/);
assert.match(bridgeSource, /sourceAmazonReportIdentityObserved/);
assert.doesNotMatch(apiSource, /r2_object_key|content_sha256|request_fingerprint|request_json|row_count AS report_job/i);
assert.doesNotMatch(apiSource, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.doesNotMatch(bridgeSource, /freshness|stale|freshThreshold|ageMs|ageMinutes/i);
assert.doesNotMatch(apiSource, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.match(bridgeSource, /bidValueTrusted:\s*false/);
assert.match(bridgeSource, /bidGovernanceReady:\s*false/);
assert.match(bridgeSource, /campaignStudioReady:\s*false/);

console.log(JSON.stringify({
  ok: true,
  gate: 17,
  contracts: [
    'amazon-report-id-provenance-explicit',
    'report-job-join-after-lineage-validation',
    'report-job-context-profile-consistent',
    'report-job-context-ad-product-consistent',
    'report-job-date-coverage-consistent',
    'missing-amazon-report-id-fails-closed',
    'source-report-contract-required-before-bridge-provenance',
    'gate16-lineage-preserved',
    'report-job-metadata-not-expanded',
    'no-freshness-threshold-introduced',
    'governance-readiness-remains-closed',
    'store-d1-read-only',
  ],
}));