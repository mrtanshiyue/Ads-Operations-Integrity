import assert from 'node:assert/strict';
import {
  CSV_OBSERVED_TARGETING_IDENTITY_SCHEMA_VERSION,
  buildCsvObservedTargetingIdentity,
} from '../cloudflare/runtime/csv-observed-targeting-identity.js';

const common = {
  advertiserAccountId: 'adv-01',
  profileId: 'profile-observed-01',
  marketplace: 'US',
  currencyCode: 'USD',
  campaignId: 'campaign-01',
  campaignName: 'Campaign A',
  adGroupId: 'adgroup-01',
  adGroupName: 'Group A',
};

const facts = [
  {
    ...common,
    reportDate: '2026-08-01',
    sourceImportId: 'import-a',
    targetingId: 'target-01',
    targeting: 'reading glasses',
    targetingIdentityState: 'resolved_id',
    matchType: 'EXACT',
    searchTerm: 'Reading Glasses Women',
    normalizedSearchTerm: 'reading glasses women',
  },
  {
    ...common,
    reportDate: '2026-08-02',
    sourceImportId: 'import-b',
    targetingId: 'target-01',
    targeting: 'reading glasses',
    targetingIdentityState: 'resolved_id',
    matchType: 'EXACT',
    searchTerm: 'Reading Glasses Lightweight',
    normalizedSearchTerm: 'reading glasses lightweight',
  },
  {
    ...common,
    reportDate: '2026-08-02',
    sourceImportId: 'import-b',
    targetingId: null,
    targeting: 'blue light readers',
    targetingIdentityState: 'name_only',
    matchType: 'PHRASE',
    searchTerm: 'Blue Light Readers Women',
    normalizedSearchTerm: 'blue light readers women',
  },
];

const result = await buildCsvObservedTargetingIdentity(facts);
assert.equal(result.schemaVersion, CSV_OBSERVED_TARGETING_IDENTITY_SCHEMA_VERSION);
assert.equal(result.authority.mode, 'csv_observed_identity_only');
assert.equal(result.authority.authoritative, false);
assert.equal(result.authority.canonicalAmazonIdentityResolved, false);
assert.equal(result.authority.governancePersistenceAllowed, false);
assert.equal(result.authority.executionAuthorized, false);
assert.equal(result.authority.amazonMutationAuthorized, false);
assert.equal(result.context.advertiserAccountId, 'adv-01');
assert.equal(result.context.profileId, 'profile-observed-01');
assert.equal(result.summary.factCount, 3);
assert.equal(result.summary.identityCount, 2);
assert.equal(result.summary.resolvedIdCount, 1);
assert.equal(result.summary.observedOnlyCount, 1);
assert.equal(result.summary.ambiguousIdentityCount, 0);
assert.equal(result.summary.searchTermLinkCount, 3);
assert.equal(result.summary.canonicalAmazonIdentityResolved, false);

const resolved = result.identities.find((item) => item.identityBasis.targetingId === 'target-01');
assert.ok(resolved);
assert.match(resolved.localIdentityFingerprint, /^[a-f0-9]{64}$/);
assert.equal(resolved.observedIdentityState, 'resolved_id');
assert.equal(resolved.identityBasis.campaignId, 'campaign-01');
assert.equal(resolved.identityBasis.adGroupId, 'adgroup-01');
assert.equal(resolved.identityBasis.targeting, 'reading glasses');
assert.equal(resolved.evidence.rowCount, 2);
assert.equal(resolved.evidence.sourceImportCount, 2);
assert.equal(resolved.evidence.reportDateCount, 2);
assert.equal(resolved.evidence.ambiguous, false);
assert.equal(resolved.confidence.band, 'high_observed');
assert.equal(resolved.confidence.score, 1);
assert.deepEqual(resolved.normalizedSearchTerms, ['reading glasses lightweight', 'reading glasses women']);

const nameOnly = result.identities.find((item) => item.observedIdentityState === 'name_only');
assert.ok(nameOnly);
assert.equal(nameOnly.identityBasis.targetingId, null);
assert.equal(nameOnly.identityBasis.targeting, 'blue light readers');
assert.equal(nameOnly.identityBasis.matchType, 'PHRASE');
assert.equal(nameOnly.confidence.band, 'medium_observed');
assert.equal(nameOnly.authority.canonicalAmazonIdentityResolved, false);

for (const link of result.searchTermLinks) {
  assert.match(link.localIdentityFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(link.canonicalAmazonIdentityResolved, false);
}
assert.deepEqual(
  result.searchTermLinks.map((link) => link.normalizedSearchTerm),
  ['blue light readers women', 'reading glasses lightweight', 'reading glasses women'],
);

const textConflict = await buildCsvObservedTargetingIdentity([
  {
    ...common,
    targetingId: 'target-conflict',
    targeting: 'reading glasses',
    targetingIdentityState: 'resolved_id',
    matchType: 'EXACT',
    searchTerm: 'term one',
  },
  {
    ...common,
    targetingId: 'target-conflict',
    targeting: 'different targeting text',
    targetingIdentityState: 'resolved_id',
    matchType: 'EXACT',
    searchTerm: 'term two',
  },
]);
assert.equal(textConflict.summary.identityCount, 1);
assert.equal(textConflict.summary.ambiguousIdentityCount, 1);
assert.equal(textConflict.identities[0].evidence.ambiguous, true);
assert.deepEqual(textConflict.identities[0].evidence.conflictCodes, ['targeting_text_conflict']);
assert.equal(textConflict.identities[0].confidence.band, 'blocked');
assert.equal(textConflict.identities[0].confidence.score, 0);

const parentConflict = await buildCsvObservedTargetingIdentity([
  {
    ...common,
    targetingId: 'target-parent-conflict',
    targeting: 'reading glasses',
    targetingIdentityState: 'resolved_id',
    searchTerm: 'term one',
  },
  {
    ...common,
    campaignId: 'campaign-02',
    campaignName: 'Campaign B',
    adGroupId: 'adgroup-02',
    adGroupName: 'Group B',
    targetingId: 'target-parent-conflict',
    targeting: 'reading glasses',
    targetingIdentityState: 'resolved_id',
    searchTerm: 'term two',
  },
]);
assert.equal(parentConflict.summary.identityCount, 2);
assert.equal(parentConflict.summary.ambiguousIdentityCount, 2);
for (const identity of parentConflict.identities) {
  assert.equal(identity.evidence.ambiguous, true);
  assert.ok(identity.evidence.conflictCodes.includes('targeting_id_parent_conflict'));
  assert.equal(identity.confidence.band, 'blocked');
}

const reordered = await buildCsvObservedTargetingIdentity([...facts].reverse());
assert.deepEqual(reordered.summary, result.summary, 'summary must be input-order independent');
assert.deepEqual(reordered.identities, result.identities, 'identity fingerprints/evidence must be input-order independent');
assert.deepEqual(reordered.searchTermLinks, result.searchTermLinks, 'search-term links must be deterministic');

await assert.rejects(
  () => buildCsvObservedTargetingIdentity([
    { ...common, advertiserAccountId: 'adv-01', searchTerm: 'one' },
    { ...common, advertiserAccountId: 'adv-02', searchTerm: 'two' },
  ]),
  (error) => error?.code === 'CSV_OBSERVED_IDENTITY_MIXED_ADVERTISER_SCOPE',
);
await assert.rejects(
  () => buildCsvObservedTargetingIdentity([
    { ...common, currencyCode: 'USD', searchTerm: 'one' },
    { ...common, currencyCode: 'EUR', searchTerm: 'two' },
  ]),
  (error) => error?.code === 'CSV_OBSERVED_IDENTITY_MIXED_CURRENCY_SCOPE',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-observed-targeting-identity-v1',
  identityCount: result.summary.identityCount,
  resolvedIdCount: result.summary.resolvedIdCount,
  ambiguousIdentityBlocking: true,
  deterministicLocalFingerprint: true,
  canonicalAmazonIdentityResolved: false,
  amazonMutationAuthorized: false,
}, null, 2));
