import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-query-bridge-v1.js'), 'utf8');

const sourceContract = {
  schemaVersion: 'store-targeting-source-v1',
  identityRule: 'keyword_xor_target',
  bidUnit: 'micros',
  bidNullability: 'preserved',
};
const items = [
  {
    reportDate: '2026-08-12',
    profileId: 'profile-1',
    adProduct: 'SPONSORED_PRODUCTS',
    campaignId: 'campaign-1',
    campaignName: 'Campaign 1',
    adGroupId: 'adgroup-1',
    adGroupName: 'Ad group 1',
    keywordId: 'keyword-1',
    keywordText: 'reading glasses',
    targetId: null,
    targetType: null,
    targetExpressionText: null,
    targetingKind: 'keyword',
    targetingIdentityValid: true,
    targetingState: 'ENABLED',
    currentBidMicros: 0,
    currentBidSyncedAt: '2026-08-14 09:35:29',
    bidSource: 'keyword',
    searchTerm: 'reading glasses',
    normalizedSearchTerm: 'reading glasses',
    matchType: 'EXACT',
    impressions: 100,
    clicks: 10,
    costMicros: 1000000,
    purchases: 2,
    unitsSold: 2,
    salesMicros: 5000000,
  },
  {
    reportDate: '2026-08-12',
    profileId: 'profile-1',
    adProduct: 'SPONSORED_PRODUCTS',
    campaignId: 'campaign-1',
    campaignName: 'Campaign 1',
    adGroupId: 'adgroup-1',
    adGroupName: 'Ad group 1',
    keywordId: null,
    keywordText: null,
    targetId: 'target-1',
    targetType: 'PRODUCT_TARGETING',
    targetExpressionText: 'asin="B000000001"',
    targetingKind: 'target',
    targetingIdentityValid: true,
    targetingState: 'ENABLED',
    currentBidMicros: null,
    currentBidSyncedAt: '2026-08-14 09:36:00',
    bidSource: 'target',
    searchTerm: 'reader glasses',
    normalizedSearchTerm: 'reader glasses',
    matchType: null,
    impressions: 50,
    clicks: 5,
    costMicros: 500000,
    purchases: 1,
    unitsSold: 1,
    salesMicros: 2000000,
  },
];
let payload = { sourceContract, items, nextCursor: null };

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

let bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
const keywordRow = bridged.rows.find((row) => row.targetingId === 'keyword-1');
const targetRow = bridged.rows.find((row) => row.targetingId === 'target-1');
assert.equal(keywordRow.currentBid, 0);
assert.equal(keywordRow.currentBidSyncedAt, '2026-08-14 09:35:29');
assert.equal(keywordRow.sourceProvenance.currentBidSyncedAt, '2026-08-14 09:35:29');
assert.equal(keywordRow.sourceProvenance.currentBidSyncedAtObserved, true);
assert.equal(keywordRow.sourceProvenance.bidSnapshotSemantic, 'current_entity_mirror');
assert.equal(targetRow.currentBid, null);
assert.equal(targetRow.currentBidSyncedAt, '2026-08-14 09:36:00');
assert.equal(targetRow.sourceProvenance.currentBidSyncedAt, '2026-08-14 09:36:00');
assert.equal(bridged.governance.sourceEvidence.currentBidSnapshotSemantic, 'current_entity_mirror');
assert.equal(bridged.governance.sourceEvidence.currentBidSyncedAtObserved, true);
assert.equal(bridged.governance.legacyCompatibility.bidSnapshot, 'current-entity-mirror-untrusted');

for (const key of [
  'targetingIdentityReady',
  'bidSourceColumnReady',
  'bidValueNullabilityTrusted',
  'adProductReady',
  'advertisedProductIdentityReady',
  'attributionMaturityReady',
  'bidGovernanceReady',
  'campaignStudioReady',
]) assert.equal(bridged.governance.readiness[key], false, `${key} must remain closed`);
for (const row of bridged.rows) {
  assert.equal(row.bidValueTrusted, false);
  assert.equal(row.governanceReady, false);
}

payload = {
  sourceContract,
  items: items.map((item, index) => index === 1 ? { ...item, currentBidSyncedAt: null } : item),
  nextCursor: null,
};
window.CloudflareNativeQueryBridge.clearCache();
bridged = await window.CloudflareNativeQueryBridge.ads({
  scope: 'DEV01', from: '2026-08-12', to: '2026-08-12', limit: 20, offset: 0,
});
assert.equal(bridged.governance.sourceEvidence.currentBidSyncedAtObserved, false);
assert.equal(bridged.rows.find((row) => row.targetingId === 'target-1').currentBidSyncedAt, null);
assert.equal(bridged.rows.find((row) => row.targetingId === 'target-1').bidValueTrusted, false);
assert.equal(bridged.governance.readiness.bidValueNullabilityTrusted, false);
assert.equal(bridged.governance.readiness.bidGovernanceReady, false);

assert.match(bridgeSource, /CURRENT_BID_SNAPSHOT_SEMANTIC = 'current_entity_mirror'/);
assert.match(bridgeSource, /currentBidSyncedAt:\s*provenance\.currentBidSyncedAt/);
assert.match(bridgeSource, /currentBidSyncedAtObserved/);
assert.match(bridgeSource, /bidValueTrusted:\s*false/);
assert.match(bridgeSource, /bidGovernanceReady:\s*false/);
assert.match(bridgeSource, /campaignStudioReady:\s*false/);

console.log(JSON.stringify({
  ok: true,
  gate: 13,
  contracts: [
    'current-bid-snapshot-timestamp-lossless-bridge-pass-through',
    'current-bid-current-entity-mirror-semantic-explicit',
    'snapshot-timestamp-evidence-observed-without-freshness-threshold',
    'missing-snapshot-timestamp-does-not-promote-trust',
    'bid-zero-null-distinction-preserved',
    'governance-readiness-remains-closed',
  ],
}));
