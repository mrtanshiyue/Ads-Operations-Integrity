import assert from 'node:assert/strict';
import {
  createCanonicalIdentityBootstrapReadAdapters,
} from '../cloudflare/runtime/canonical-identity-bootstrap-read-adapters.js';
import {
  CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT,
  CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS,
  verifyCanonicalCsvIdentityReadOnly,
} from '../cloudflare/runtime/canonical-identity-read-harness.js';
import { ADVERTISER_ACCOUNT_QUERY_CONTRACT } from '../cloudflare/runtime/amazon-advertiser-profile-binding.js';

const calls = { profiles:0, entities:0 };
const bootstrapTransport = {
  async listProfiles() {
    calls.profiles += 1;
    return [{
      profileId:'profile-1',
      countryCode:'US',
      currencyCode:'USD',
      timezone:'America/Los_Angeles',
      accountInfo:{ marketplaceStringId:'ATVPDKIKX0DER', type:'seller', name:'Canonical Seller' },
    }];
  },
  async fetchEntitySnapshot({ profileId }) {
    calls.entities += 1;
    assert.equal(profileId, 'profile-1');
    return {
      campaigns:[{ campaignId:'c1', name:'Campaign', state:'ENABLED', targetingType:'MANUAL', dailyBudget:'10.00' }],
      adGroups:[{ adGroupId:'a1', campaignId:'c1', name:'Ad Group', state:'ENABLED', defaultBid:'1.00' }],
      keywords:[{ keywordId:'k1', campaignId:'c1', adGroupId:'a1', keywordText:'reading glasses', matchType:'EXACT', state:'ENABLED', bid:'1.25' }],
      targets:[],
    };
  },
};
const { profileReader, entityReader } = createCanonicalIdentityBootstrapReadAdapters(bootstrapTransport, {
  now:() => '2026-08-18T07:10:00Z',
});
assert.equal(profileReader.capability.semanticReadOnly, true);
assert.equal(entityReader.capability.semanticReadOnly, true);
assert.deepEqual(profileReader.capability.sideEffects, CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS);
assert.deepEqual(entityReader.capability.sideEffects, CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS);

const accountIdentifierType = 'official-verified-account-id';
const profileIdentifierType = 'official-verified-profile-id';
let accountReads = 0;
const advertiserAccountReader = {
  capability:{
    contractVersion:CANONICAL_IDENTITY_READ_ADAPTER_CONTRACT,
    semanticReadOnly:true,
    sideEffects:{ ...CANONICAL_IDENTITY_ZERO_SIDE_EFFECTS },
    schemaAuthorityVerified:true,
    verifiedAdvertiserAccountIdentifierType:accountIdentifierType,
    verifiedProfileIdentifierType:profileIdentifierType,
  },
  async queryAdvertiserAccounts() {
    accountReads += 1;
    return {
      advertiserAccounts:[{
        advertiserAccountId:'amzn1.ads-account.g.example',
        advertiserAccountIdentifierType:accountIdentifierType,
        alternateIdentifiers:[{ identifierType:profileIdentifierType, identifierValue:'profile-1' }],
        sourceContract:ADVERTISER_ACCOUNT_QUERY_CONTRACT.sourceContract,
        sourceEndpoint:ADVERTISER_ACCOUNT_QUERY_CONTRACT.endpoint,
        sourceObservedAt:'2026-08-18T07:09:00Z',
      }],
    };
  },
};

const evidence = await verifyCanonicalCsvIdentityReadOnly({
  store:{ marketplace_code:'US', amazon_region:'NA' },
  observedAdvertiserAccountId:'amzn1.ads-account.g.example',
  csvRows:[{ campaign_id:'c1', ad_group_id:'a1', targeting_id:'k1' }],
  advertiserAccountReader,
  profileReader,
  entityReader,
});
assert.equal(accountReads, 1);
assert.deepEqual(calls, { profiles:1, entities:1 });
assert.equal(evidence.canonicalProfileId, 'profile-1');
assert.equal(evidence.membershipCounts.verified, 1);
assert.equal(evidence.verificationTimestamp, '2026-08-18T07:09:00Z');

assert.throws(
  () => createCanonicalIdentityBootstrapReadAdapters({ listProfiles() {} }),
  (error) => error.code === 'CANONICAL_IDENTITY_ENTITY_TRANSPORT_INVALID',
);

{
  const adapters = createCanonicalIdentityBootstrapReadAdapters({
    async listProfiles() { return []; },
    async fetchEntitySnapshot() { return { campaigns:[], adGroups:[], keywords:[], targets:[] }; },
  }, { now:() => 'not-a-timestamp' });
  await assert.rejects(
    () => adapters.entityReader.listSponsoredProductsEntities({
      profileId:'profile-1',
      scopeHeader:'amazon-advertising-api-scope',
    }),
    (error) => error.code === 'CANONICAL_IDENTITY_ENTITY_SYNCED_AT_INVALID',
  );
}

console.log(JSON.stringify({
  ok:true,
  existingProfileTransportAdapted:true,
  existingEntityTransportAdapted:true,
  profileScopedEntityRead:true,
  advertiserAccountRawHttpAdapterImplemented:false,
  amazonMutation:0,
  d1Write:0,
  r2Write:0,
}, null, 2));
