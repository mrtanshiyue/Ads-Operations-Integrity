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

function storeDb() {
  return {
    prepare(sql) {
      assert.match(sql, /MAX\(st\.updated_at\) AS fact_mirror_updated_at/);
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
                  impressions: 100,
                  clicks: 10,
                  cost_micros: 1000000,
                  purchases: 2,
                  units_sold: 2,
                  sales_micros: 5000000,
                  sort_value: 1000000,
                }],
              };
            },
          };
        },
      };
    },
  };
}

const request = new Request('https://example.test/api/v1/stores/store-dev-01/search-terms-daily?startDate=2026-08-12&endDate=2026-08-12&limit=20', {
  method: 'GET',
  headers: { 'cf-ray': 'gate15-read-ray' },
});
const response = await handleStoreDailyApiRoute({
  request,
  env: { CONTROL_DB: controlDb(), STORE_01_DB: storeDb() },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(request.url),
});
assert.equal(response.status, 200);
const payload = await response.json();

assert.deepEqual(payload.factContract, {
  schemaVersion: 'store-search-term-fact-v1',
  mirrorTimestamp: 'search_term_daily.updated_at',
  mirrorAggregation: 'max',
});
assert.equal(payload.sourceContract.schemaVersion, 'store-targeting-source-v2');
assert.equal(payload.items[0].factMirrorUpdatedAt, '2026-08-14 09:35:29');
assert.equal(payload.items[0].currentBidSyncedAt, '2026-08-14 09:35:29');
assert.equal(payload.items[0].targetingSourceUpdatedAt, null);

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
const row = bridged.rows[0];
assert.equal(row.factMirrorUpdatedAt, '2026-08-14 09:35:29');
assert.equal(row.sourceProvenance.factSchemaVersion, 'store-search-term-fact-v1');
assert.equal(row.sourceProvenance.factMirrorUpdatedAt, '2026-08-14 09:35:29');
assert.equal(row.sourceProvenance.factMirrorUpdatedAtObserved, true);
assert.equal(row.sourceProvenance.factMirrorTimestampSemantic, 'latest_local_fact_row_updated_at');
assert.equal(bridged.governance.sourceEvidence.factContractObserved, true);
assert.equal(bridged.governance.sourceEvidence.factMirrorUpdatedAtObserved, true);
assert.equal(bridged.governance.sourceEvidence.factMirrorTimestampSemantic, 'latest_local_fact_row_updated_at');

bridgePayload = { ...payload, factContract: null };
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
assert.equal(bridged.rows[0].factMirrorUpdatedAt, null);
assert.equal(bridged.rows[0].sourceProvenance.factMirrorUpdatedAtObserved, false);
assert.equal(bridged.rows[0].sourceProvenance.factMirrorTimestampSemantic, null);
assert.equal(bridged.governance.sourceEvidence.factContractObserved, false);
assert.equal(bridged.governance.sourceEvidence.factMirrorUpdatedAtObserved, false);

for (const key of [
  'targetingIdentityReady', 'bidSourceColumnReady', 'bidValueNullabilityTrusted', 'adProductReady',
  'advertisedProductIdentityReady', 'attributionMaturityReady', 'bidGovernanceReady', 'campaignStudioReady',
]) assert.equal(bridged.governance.readiness[key], false, `${key} must remain closed`);
for (const item of bridged.rows) {
  assert.equal(item.bidValueTrusted, false);
  assert.equal(item.governanceReady, false);
}

assert.match(apiSource, /FACT_CONTRACT_VERSION = 'store-search-term-fact-v1'/);
assert.match(apiSource, /MAX\(st\.updated_at\) AS fact_mirror_updated_at/);
assert.match(apiSource, /mirrorTimestamp:\s*'search_term_daily\.updated_at'/);
assert.match(apiSource, /mirrorAggregation:\s*'max'/);
assert.match(bridgeSource, /FACT_MIRROR_TIMESTAMP_SEMANTIC = 'latest_local_fact_row_updated_at'/);
assert.match(bridgeSource, /factMirrorUpdatedAtObserved/);
assert.doesNotMatch(apiSource, /freshness|stale|freshThreshold|ageMs/i);
assert.doesNotMatch(bridgeSource, /freshness|stale|freshThreshold|ageMs/i);
assert.doesNotMatch(apiSource, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.match(bridgeSource, /bidValueTrusted:\s*false/);
assert.match(bridgeSource, /bidGovernanceReady:\s*false/);
assert.match(bridgeSource, /campaignStudioReady:\s*false/);

console.log(JSON.stringify({
  ok: true,
  gate: 15,
  contracts: [
    'daily-fact-mirror-timestamp-aggregated-with-max',
    'daily-fact-mirror-timestamp-lossless-api-pass-through',
    'fact-contract-semantic-explicit',
    'fact-contract-required-before-bridge-provenance',
    'fact-mirror-and-targeting-timestamps-remain-separated',
    'fact-timestamp-evidence-without-freshness-threshold',
    'governance-readiness-remains-closed',
    'store-d1-read-only',
  ],
}));