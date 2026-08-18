import assert from 'node:assert/strict';
import {
  ADVERTISER_ACCOUNT_QUERY_CONTRACT,
  SPONSORED_ADS_PROFILE_AUTHORITY,
  resolveCanonicalAdvertiserProfileBinding,
} from '../cloudflare/runtime/amazon-advertiser-profile-binding.js';
import { validateCsvCanonicalMembership } from '../cloudflare/runtime/csv-canonical-membership-validator.js';
import { buildCanonicalCsvIdentityEvidence } from '../cloudflare/runtime/canonical-csv-identity-evidence.js';

const store = { marketplace_code: 'US', amazon_region: 'NA' };
const accountType = 'verified-advertiser-account-id';
const profileIdentifierType = 'verified-sponsored-ads-profile-id';
const account = {
  advertiserAccountId: 'amzn1.ads-account.g.example',
  advertiserAccountIdentifierType: accountType,
  alternateIdentifiers: [{ identifierType: profileIdentifierType, identifierValue: '1234567890' }],
  sourceContract: ADVERTISER_ACCOUNT_QUERY_CONTRACT.sourceContract,
  sourceEndpoint: ADVERTISER_ACCOUNT_QUERY_CONTRACT.endpoint,
  sourceObservedAt: '2026-08-18T07:00:00Z',
};
const rawProfile = {
  profileId: '1234567890', countryCode: 'US', currencyCode: 'USD', timezone: 'America/Los_Angeles',
  accountInfo: { marketplaceStringId: 'ATVPDKIKX0DER', type: 'seller', name: 'Canonical Seller' },
};
const candidate = { sourceAuthority: SPONSORED_ADS_PROFILE_AUTHORITY, profile: rawProfile };
const bindingInput = {
  store,
  observedAdvertiserAccountId: account.advertiserAccountId,
  advertiserAccounts: [account],
  profileCandidates: [candidate],
  verifiedAdvertiserAccountIdentifierType: accountType,
  verifiedProfileIdentifierType: profileIdentifierType,
};

const binding = await resolveCanonicalAdvertiserProfileBinding(bindingInput);
assert.equal(binding.profileId, '1234567890');
assert.equal(binding.relationCardinality, 'not_assumed');
assert.match(binding.evidenceFingerprint, /^[a-f0-9]{64}$/);
assert.equal(ADVERTISER_ACCOUNT_QUERY_CONTRACT.method, 'POST');
assert.equal(ADVERTISER_ACCOUNT_QUERY_CONTRACT.semanticReadOnly, true);

await rejectsCode({ ...bindingInput, advertiserAccounts: [] }, 'ADVERTISER_ACCOUNT_NOT_FOUND');
await rejectsCode({ ...bindingInput, advertiserAccounts: [account, { ...account }] }, 'ADVERTISER_ACCOUNT_AMBIGUOUS');
await rejectsCode({ ...bindingInput, advertiserAccounts: [{ ...account, alternateIdentifiers: [] }] }, 'PROFILE_IDENTIFIER_NOT_FOUND');
await rejectsCode({
  ...bindingInput,
  advertiserAccounts: [{ ...account, alternateIdentifiers: [
    { identifierType: profileIdentifierType, identifierValue: '1234567890' },
    { identifierType: profileIdentifierType, identifierValue: '2222222222' },
  ] }],
}, 'PROFILE_IDENTIFIER_AMBIGUOUS');
await rejectsCode({ ...bindingInput, profileCandidates: [] }, 'PROFILE_IDENTIFIER_NOT_FOUND');
await rejectsCode({ ...bindingInput, profileCandidates: [candidate, { ...candidate, profile: { ...rawProfile } }] }, 'PROFILE_IDENTIFIER_AMBIGUOUS');
await rejectsCode({ ...bindingInput, profileCandidates: [{ ...candidate, profile: { ...rawProfile, countryCode: 'CA' } }] }, 'PROFILE_MARKETPLACE_MISMATCH');
await rejectsCode({
  ...bindingInput,
  profileCandidates: [{ ...candidate, profile: { ...rawProfile, accountInfo: { ...rawProfile.accountInfo, type: 'agency' } } }],
}, 'PROFILE_ACCOUNT_TYPE_UNSUPPORTED');
await rejectsCode({ ...bindingInput, profileCandidates: [{ sourceAuthority: 'synthetic-dev-mirror', profile: rawProfile }] }, 'ADVERTISER_PROFILE_BINDING_UNVERIFIED');
await rejectsCode({ ...bindingInput, verifiedProfileIdentifierType: '' }, 'ADVERTISER_PROFILE_BINDING_UNVERIFIED');
await rejectsCode({ ...bindingInput, advertiserAccounts: [{ ...account, sourceEndpoint: '/unverified' }] }, 'ADVERTISER_PROFILE_BINDING_UNVERIFIED');

const manyToOne = await resolveCanonicalAdvertiserProfileBinding({
  ...bindingInput,
  advertiserAccounts: [account, { ...account, advertiserAccountId: 'amzn1.ads-account.g.other' }],
});
assert.equal(manyToOne.profileId, binding.profileId);
assert.equal(manyToOne.relationCardinality, 'not_assumed');

const snapshot = {
  campaigns: [
    { campaignId: 'c1', profileId: binding.profileId },
    { campaignId: 'c-other', profileId: 'other-profile' },
  ],
  adGroups: [
    { adGroupId: 'a1', campaignId: 'c1', profileId: binding.profileId },
    { adGroupId: 'a-wrong-parent', campaignId: 'c2', profileId: binding.profileId },
    { adGroupId: 'a-other-profile', campaignId: 'c1', profileId: 'other-profile' },
  ],
  keywords: [
    { keywordId: 'k1', campaignId: 'c1', adGroupId: 'a1', profileId: binding.profileId },
    { keywordId: 'k-wrong-parent', campaignId: 'c1', adGroupId: 'a-wrong-parent', profileId: binding.profileId },
    { keywordId: 'k-other-profile', campaignId: 'c1', adGroupId: 'a1', profileId: 'other-profile' },
    { keywordId: 'shared', campaignId: 'c1', adGroupId: 'a1', profileId: binding.profileId },
  ],
  targets: [
    { targetId: 't1', campaignId: 'c1', adGroupId: 'a1', profileId: binding.profileId },
    { targetId: 'shared', campaignId: 'c1', adGroupId: 'a1', profileId: binding.profileId },
  ],
};
const rows = [
  { campaign_id: 'c1', ad_group_id: 'a1', targeting_id: 'k1' },
  { campaign_id: 'c1', ad_group_id: 'a1', targeting_id: 't1' },
  { campaign_id: 'missing', ad_group_id: 'a1', targeting_id: 'k1' },
  { campaign_id: 'c-other', ad_group_id: 'a1', targeting_id: 'k1' },
  { campaign_id: 'c1', ad_group_id: 'a-other-profile', targeting_id: 'k1' },
  { campaign_id: 'c1', ad_group_id: 'a1', targeting_id: 'k-other-profile' },
  { campaign_id: 'c1', ad_group_id: 'a1', targeting_id: 'k-wrong-parent' },
  { campaign_id: 'c1', ad_group_id: 'a1', targeting_id: 'shared' },
  { campaign_id: 'c1', ad_group_id: 'a1', targeting_id: 'missing-target' },
  { campaign_id: 'c1', ad_group_id: 'a1', targeting_id: null },
];
const memberships = validateCsvCanonicalMembership({ profileId: binding.profileId, rows, snapshot });
assert.deepEqual(memberships.map((row) => row.status), [
  'verified', 'verified', 'not_found', 'profile_mismatch', 'profile_mismatch',
  'profile_mismatch', 'hierarchy_mismatch', 'ambiguous', 'not_found', 'csv_unresolved',
]);
assert.equal(memberships[0].entityType, 'keyword');
assert.equal(memberships[1].entityType, 'target');

const evidence = await buildCanonicalCsvIdentityEvidence({
  ...bindingInput,
  csvRows: [
    { campaign_id: 'c1', ad_group_id: 'a1', targeting_id: 'k1' },
    { campaign_id: 'c1', ad_group_id: 'a1', targeting_id: null },
  ],
  entitySnapshot: snapshot,
});
assert.equal(evidence.membershipCounts.verified, 1);
assert.equal(evidence.membershipCounts.csv_unresolved, 1);
assert.deepEqual(evidence.sideEffects, {
  amazonMutation: false, d1Write: false, r2Write: false, reportCreate: false,
  reportPoll: false, reportDownload: false, optimizationAction: false, executionPermit: false,
});

console.log(JSON.stringify({
  ok: true,
  contract: 'CanonicalAdvertiserProfileBindingV1',
  schemaAuthorityGate: true,
  exactBinding: true,
  noCardinalityAssumption: true,
  syntheticAuthorityRejected: true,
  membershipStatuses: [...new Set(memberships.map((row) => row.status))],
  sideEffects: evidence.sideEffects,
}, null, 2));

async function rejectsCode(input, code) {
  try {
    await resolveCanonicalAdvertiserProfileBinding(input);
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code);
  }
}
