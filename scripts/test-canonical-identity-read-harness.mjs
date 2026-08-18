import assert from 'node:assert/strict';
import {
  CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT,
  CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS,
  AMAZON_ADS_SCOPE_HEADER,
  verifyCanonicalCsvIdentityReadOnly,
} from '../cloudflare/runtime/canonical-identity-read-harness.js';
import {
  ADVERTISER_ACCOUNT_QUERY_CONTRACT,
  SPONSORED_ADS_PROFILE_AUTHORITY,
} from '../cloudflare/runtime/amazon-advertiser-profile-binding.js';

const store = { marketplace_code: 'US', amazon_region: 'NA' };
const accountType = 'official-verified-advertiser-account-id';
const profileIdentifierType = 'official-verified-sponsored-ads-profile-id';
const baseCapability = () => ({
  contractVersion: CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT,
  semanticReadOnly: true,
  sideEffects: { ...CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS },
});

function makeReaders(overrides = {}) {
  const calls = { account:0, profile:0, entity:0 };
  const advertiserAccountReader = {
    capability: {
      ...baseCapability(),
      schemaAuthorityVerified: true,
      verifiedAdvertiserAccountIdentifierType: accountType,
      verifiedProfileIdentifierType: profileIdentifierType,
      ...overrides.accountCapability,
    },
    async queryAdvertiserAccounts() {
      calls.account += 1;
      return overrides.accountResult ?? {
        advertiserAccounts: [{
          advertiserAccountId: 'amzn1.ads-account.g.example',
          advertiserAccountIdentifierType: accountType,
          alternateIdentifiers: [{ identifierType: profileIdentifierType, identifierValue: 'profile-1' }],
          sourceContract: ADVERTISER_ACCOUNT_QUERY_CONTRACT.sourceContract,
          sourceEndpoint: ADVERTISER_ACCOUNT_QUERY_CONTRACT.endpoint,
          sourceObservedAt: '2026-08-18T07:00:00Z',
        }],
      };
    },
  };
  const profileReader = {
    capability: {
      ...baseCapability(),
      sourceAuthority: SPONSORED_ADS_PROFILE_AUTHORITY,
      ...overrides.profileCapability,
    },
    async listProfiles() {
      calls.profile += 1;
      return overrides.profileResult ?? {
        profiles: [{
          profileId: 'profile-1',
          countryCode: 'US',
          currencyCode: 'USD',
          timezone: 'America/Los_Angeles',
          accountInfo: {
            marketplaceStringId: 'ATVPDKIKX0DER',
            type: 'seller',
            name: 'Canonical Seller',
          },
        }],
      };
    },
  };
  const entityReader = {
    capability: {
      ...baseCapability(),
      scopeHeader: AMAZON_ADS_SCOPE_HEADER,
      ...overrides.entityCapability,
    },
    async listSponsoredProductsEntities({ profileId, scopeHeader }) {
      calls.entity += 1;
      assert.equal(scopeHeader, AMAZON_ADS_SCOPE_HEADER);
      return overrides.entityResult ?? {
        profileId,
        syncedAt: '2026-08-18T07:01:00Z',
        campaigns: [{ campaignId:'c1', name:'Campaign', state:'ENABLED', targetingType:'MANUAL', dailyBudget:'10.00' }],
        adGroups: [{ adGroupId:'a1', campaignId:'c1', name:'Ad Group', state:'ENABLED', defaultBid:'1.00' }],
        keywords: [{ keywordId:'k1', campaignId:'c1', adGroupId:'a1', keywordText:'reading glasses', matchType:'EXACT', state:'ENABLED', bid:'1.25' }],
        targets: [],
      };
    },
  };
  return { calls, advertiserAccountReader, profileReader, entityReader };
}

{
  const readers = makeReaders();
  const evidence = await verifyCanonicalCsvIdentityReadOnly({
    store,
    observedAdvertiserAccountId:'amzn1.ads-account.g.example',
    csvRows:[{ campaign_id:'c1', ad_group_id:'a1', targeting_id:'k1' }],
    ...readers,
  });
  assert.deepEqual(readers.calls, { account:1, profile:1, entity:1 });
  assert.equal(evidence.canonicalProfileId, 'profile-1');
  assert.equal(evidence.membershipCounts.verified, 1);
  assert.equal(evidence.entitySnapshotCounts.campaign, 1);
  assert.equal(evidence.entitySnapshotCounts.ad_group, 1);
  assert.equal(evidence.entitySnapshotCounts.keyword, 1);
  assert.equal(evidence.entitySnapshotCounts.target, 0);
  assert.match(evidence.entitySnapshotHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(evidence.sideEffects, CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS);
}

{
  const readers = makeReaders({ accountCapability:{ schemaAuthorityVerified:false } });
  await rejectsCode(() => verifyCanonicalCsvIdentityReadOnly({
    store, observedAdvertiserAccountId:'amzn1.ads-account.g.example', csvRows:[], ...readers,
  }), 'ADVERTISER_ACCOUNT_SCHEMA_AUTHORITY_UNVERIFIED');
  assert.deepEqual(readers.calls, { account:0, profile:0, entity:0 });
}

{
  const readers = makeReaders({
    accountCapability:{ sideEffects:{ ...CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS, amazonMutation:true } },
  });
  await rejectsCode(() => verifyCanonicalCsvIdentityReadOnly({
    store, observedAdvertiserAccountId:'amzn1.ads-account.g.example', csvRows:[], ...readers,
  }), 'CANONICAL_IDENTITY_READ_SIDE_EFFECT_FORBIDDEN');
  assert.deepEqual(readers.calls, { account:0, profile:0, entity:0 });
}

{
  const readers = makeReaders({ profileCapability:{ sourceAuthority:'synthetic-dev-mirror' } });
  await rejectsCode(() => verifyCanonicalCsvIdentityReadOnly({
    store, observedAdvertiserAccountId:'amzn1.ads-account.g.example', csvRows:[], ...readers,
  }), 'CANONICAL_PROFILE_SOURCE_AUTHORITY_UNVERIFIED');
  assert.deepEqual(readers.calls, { account:0, profile:0, entity:0 });
}

{
  const readers = makeReaders({ entityCapability:{ scopeHeader:'x-unverified-scope' } });
  await rejectsCode(() => verifyCanonicalCsvIdentityReadOnly({
    store, observedAdvertiserAccountId:'amzn1.ads-account.g.example', csvRows:[], ...readers,
  }), 'CANONICAL_ENTITY_SCOPE_AUTHORITY_UNVERIFIED');
  assert.deepEqual(readers.calls, { account:0, profile:0, entity:0 });
}

{
  const readers = makeReaders({ entityResult:{
    profileId:'profile-other', syncedAt:'2026-08-18T07:01:00Z', campaigns:[], adGroups:[], keywords:[], targets:[],
  } });
  await rejectsCode(() => verifyCanonicalCsvIdentityReadOnly({
    store, observedAdvertiserAccountId:'amzn1.ads-account.g.example', csvRows:[], ...readers,
  }), 'CANONICAL_ENTITY_PROFILE_SCOPE_MISMATCH');
  assert.deepEqual(readers.calls, { account:1, profile:1, entity:1 });
}

{
  const readers = makeReaders({ entityResult:{
    profileId:'profile-1',
    syncedAt:'2026-08-18T07:01:00Z',
    campaigns:[],
    adGroups:[{ adGroupId:'a1', campaignId:'missing', name:'Ad Group', state:'ENABLED', defaultBid:'1.00' }],
    keywords:[],
    targets:[],
  } });
  await assert.rejects(
    () => verifyCanonicalCsvIdentityReadOnly({
      store, observedAdvertiserAccountId:'amzn1.ads-account.g.example', csvRows:[], ...readers,
    }),
    (error) => error.code === 'AD_GROUP_CAMPAIGN_HIERARCHY_MISMATCH',
  );
}

console.log(JSON.stringify({
  ok:true,
  preInvocationCapabilityGate:true,
  schemaAuthorityGate:true,
  profileAuthorityGate:true,
  profileScopeGate:true,
  canonicalEntityHierarchyValidation:true,
  liveAdvertiserAccountHttpAdapterImplemented:false,
  sideEffects:CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS,
}, null, 2));

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error.code === code);
}
