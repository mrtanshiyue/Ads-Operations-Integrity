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
      assert.match(sql, /st\.ad_product/);
      assert.match(sql, /k\.bid_micros AS keyword_bid_micros/);
      assert.match(sql, /t\.bid_micros AS target_bid_micros/);
      return {
        bind() {
          return {
            async all() {
              return {
                results: [
                  {
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
                    keyword_bid_micros: 0,
                    target_id: null,
                    target_type: null,
                    target_expression_text: null,
                    target_state: null,
                    target_bid_micros: null,
                    search_term: 'reading glasses',
                    normalized_search_term: 'reading glasses',
                    report_match_type: 'EXACT',
                    impressions: 100,
                    clicks: 10,
                    cost_micros: 1000000,
                    purchases: 2,
                    units_sold: 2,
                    sales_micros: 5000000,
                    sort_value: 1000000,
                  },
                  {
                    group_key: 'g-target',
                    report_date: '2026-08-12',
                    profile_id: 'profile-1',
                    ad_product: 'SPONSORED_PRODUCTS',
                    campaign_id: 'campaign-1',
                    campaign_name: 'Campaign 1',
                    ad_group_id: 'adgroup-1',
                    ad_group_name: 'Ad group 1',
                    keyword_id: null,
                    keyword_text: null,
                    keyword_match_type: null,
                    keyword_state: null,
                    keyword_bid_micros: null,
                    target_id: 'target-1',
                    target_type: 'PRODUCT_TARGETING',
                    target_expression_text: 'asin="B000000001"',
                    target_state: 'ENABLED',
                    target_bid_micros: null,
                    search_term: 'reader glasses',
                    normalized_search_term: 'reader glasses',
                    report_match_type: null,
                    impressions: 50,
                    clicks: 5,
                    cost_micros: 500000,
                    purchases: 1,
                    units_sold: 1,
                    sales_micros: 2000000,
                    sort_value: 500000,
                  },
                ],
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
  headers: { 'cf-ray': 'gate12-read-ray' },
});
const response = await handleStoreDailyApiRoute({
  request,
  env: { CONTROL_DB: controlDb(), STORE_01_DB: storeDb() },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(request.url),
});
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.equal(response.headers.get('x-request-id'), 'gate12-read-ray');
const payload = await response.json();
assert.deepEqual(payload.sourceContract, {
  schemaVersion: 'store-targeting-source-v1',
  identityRule: 'keyword_xor_target',
  bidUnit: 'micros',
  bidNullability: 'preserved',
});
assert.equal(payload.items.length, 2);
assert.deepEqual({
  adProduct: payload.items[0].adProduct,
  targetingKind: payload.items[0].targetingKind,
  targetingIdentityValid: payload.items[0].targetingIdentityValid,
  targetingState: payload.items[0].targetingState,
  currentBidMicros: payload.items[0].currentBidMicros,
  bidSource: payload.items[0].bidSource,
}, {
  adProduct: 'SPONSORED_PRODUCTS',
  targetingKind: 'keyword',
  targetingIdentityValid: true,
  targetingState: 'ENABLED',
  currentBidMicros: 0,
  bidSource: 'keyword',
});
assert.deepEqual({
  targetingKind: payload.items[1].targetingKind,
  targetingIdentityValid: payload.items[1].targetingIdentityValid,
  currentBidMicros: payload.items[1].currentBidMicros,
  bidSource: payload.items[1].bidSource,
}, {
  targetingKind: 'target',
  targetingIdentityValid: true,
  currentBidMicros: null,
  bidSource: 'target',
});

const events = [];
const window = {
  location: { origin: 'https://example.test' },
  CloudflareNativeAPI: {
    async stores() {
      return { stores: [{ store_id: 'store-dev-01', store_code: 'DEV01', display_name: 'Development Store', marketplace_code: 'US' }] };
    },
    async searchTermsDaily() {
      return payload;
    },
  },
  dispatchEvent(event) { events.push(event); return true; },
};
class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
}
vm.runInNewContext(bridgeSource, { window, CustomEvent, URL, console, setTimeout, clearTimeout });
assert.equal(window.CloudflareNativeQueryBridge.version, '1.3.0');
const bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
assert.equal(bridged.rows.length, 2);
const keywordRow = bridged.rows.find((row) => row.targetingId === 'keyword-1');
const targetRow = bridged.rows.find((row) => row.targetingId === 'target-1');
assert.equal(keywordRow.adProduct, 'SPONSORED_PRODUCTS');
assert.equal(keywordRow.currentBid, 0);
assert.equal(keywordRow.bid, 0);
assert.equal(keywordRow.sourceProvenance.targetingIdentityValid, true);
assert.equal(keywordRow.sourceProvenance.bidNullabilityPreserved, true);
assert.equal(keywordRow.sourceProvenance.bidMicros, 0);
assert.equal(targetRow.currentBid, null);
assert.equal(targetRow.sourceProvenance.bidSource, 'target');
assert.equal(targetRow.sourceProvenance.bidMicros, null);
assert.equal(bridged.governance.sourceEvidence.sourceContractObserved, true);
assert.equal(bridged.governance.sourceEvidence.targetingIdentityObserved, true);
assert.equal(bridged.governance.sourceEvidence.bidSourceObserved, true);
assert.equal(bridged.governance.sourceEvidence.bidNullabilityPreserved, true);
assert.equal(bridged.governance.sourceEvidence.adProductObserved, true);

const readiness = bridged.governance.readiness;
for (const key of [
  'targetingIdentityReady',
  'bidSourceColumnReady',
  'bidValueNullabilityTrusted',
  'adProductReady',
  'advertisedProductIdentityReady',
  'attributionMaturityReady',
  'bidGovernanceReady',
  'campaignStudioReady',
]) assert.equal(readiness[key], false, `${key} must remain closed`);
for (const row of bridged.rows) {
  assert.equal(row.bidValueTrusted, false);
  assert.equal(row.governanceReady, false);
  assert.equal(row.advertisedAsin, null);
  assert.equal(row.advertisedSku, null);
  assert.equal(row.attributionWindowDays, null);
}

assert.match(apiSource, /SOURCE_CONTRACT_VERSION = 'store-targeting-source-v1'/);
assert.match(apiSource, /st\.ad_product/);
assert.match(apiSource, /k\.bid_micros AS keyword_bid_micros/);
assert.match(apiSource, /t\.bid_micros AS target_bid_micros/);
assert.doesNotMatch(apiSource, /INSERT\s+INTO|UPDATE\s+[^\s]+\s+SET|DELETE\s+FROM|AMAZON_SYNC_WORKFLOW/);
assert.match(bridgeSource, /sourceEvidence/);
assert.match(bridgeSource, /bidValueTrusted:\s*false/);
assert.match(bridgeSource, /advertisedProductIdentityReady:\s*false/);
assert.match(bridgeSource, /attributionMaturityReady:\s*false/);
assert.match(bridgeSource, /bidGovernanceReady:\s*false/);
assert.match(bridgeSource, /campaignStudioReady:\s*false/);

console.log(JSON.stringify({
  ok: true,
  gate: 12,
  contracts: [
    'store-targeting-source-contract-version',
    'keyword-target-xor-identity',
    'ad-product-source-preserved',
    'identity-specific-bid-source',
    'bid-zero-null-distinction-preserved',
    'bridge-source-evidence-only',
    'governance-readiness-remains-closed',
    'no-advertised-product-join-at-search-term-grain',
    'store-d1-read-only',
  ],
}));
