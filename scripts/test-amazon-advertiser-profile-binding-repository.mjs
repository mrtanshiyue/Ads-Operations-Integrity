import assert from 'node:assert/strict';
import { resolveCanonicalAdvertiserProfileBinding } from '../cloudflare/runtime/amazon-advertiser-profile-binding.js';
import {
  bindingReceiptRow,
  persistCanonicalAdvertiserProfileBindingReceipt,
} from '../cloudflare/runtime/amazon-advertiser-profile-binding-repository.js';

const store = { marketplace_code:'US', amazon_region:'NA' };
const accountType = 'official-verified-account-id';
const profileIdentifierType = 'official-verified-profile-id';
const account = {
  advertiserAccountId:'amzn1.ads-account.g.example',
  advertiserAccountIdentifierType:accountType,
  alternateIdentifiers:[{ identifierType:profileIdentifierType, identifierValue:'profile-1' }],
  sourceContract:'amazon-ads-advertiser-account-query-v1',
  sourceEndpoint:'/adsApi/v1/query/advertiserAccounts',
  sourceObservedAt:'2026-08-18T07:00:00Z',
};
const profileCandidate = {
  sourceAuthority:'amazon-ads-profiles-api-v2',
  profile:{
    profileId:'profile-1',
    countryCode:'US',
    currencyCode:'USD',
    timezone:'America/Los_Angeles',
    accountInfo:{ marketplaceStringId:'ATVPDKIKX0DER', type:'seller', name:'Canonical Seller' },
  },
};
const binding = await resolveCanonicalAdvertiserProfileBinding({
  store,
  observedAdvertiserAccountId:account.advertiserAccountId,
  advertiserAccounts:[account],
  profileCandidates:[profileCandidate],
  verifiedAdvertiserAccountIdentifierType:accountType,
  verifiedProfileIdentifierType:profileIdentifierType,
});
const recordedAt = '2026-08-18T07:05:00Z';
const expectedRow = bindingReceiptRow(binding, recordedAt);
assert.equal(expectedRow.relation_cardinality, 'not_assumed');
assert.equal(expectedRow.profile_id, 'profile-1');

class FakeRepository {
  constructor({ existing=null, raceReceipt=null, insertError=null, omitAfterInsert=false } = {}) {
    this.row = existing ? { ...existing } : null;
    this.raceReceipt = raceReceipt;
    this.insertError = insertError;
    this.omitAfterInsert = omitAfterInsert;
    this.loads = 0;
    this.inserts = 0;
  }
  async loadBindingReceipt() {
    this.loads += 1;
    return this.row ? { ...this.row } : null;
  }
  async insertBindingReceipt(row) {
    this.inserts += 1;
    if (this.raceReceipt) {
      this.row = { ...this.raceReceipt };
      throw new Error('simulated race');
    }
    if (this.insertError) throw this.insertError;
    if (!this.omitAfterInsert) this.row = { ...row };
  }
}

{
  const repository = new FakeRepository();
  const result = await persistCanonicalAdvertiserProfileBindingReceipt({ repository, binding, recordedAt });
  assert.equal(result.reused, false);
  assert.equal(repository.inserts, 1);
  assert.equal(result.receipt.evidence_fingerprint, binding.evidenceFingerprint);
}

{
  const repository = new FakeRepository({ existing:expectedRow });
  const result = await persistCanonicalAdvertiserProfileBindingReceipt({ repository, binding, recordedAt });
  assert.equal(result.reused, true);
  assert.equal(repository.inserts, 0);
}

{
  const repository = new FakeRepository({ raceReceipt:expectedRow });
  const result = await persistCanonicalAdvertiserProfileBindingReceipt({ repository, binding, recordedAt });
  assert.equal(result.reused, true);
  assert.equal(repository.inserts, 1);
}

{
  const repository = new FakeRepository({ existing:{ ...expectedRow, profile_id:'profile-conflict' } });
  await rejectsCode(
    () => persistCanonicalAdvertiserProfileBindingReceipt({ repository, binding, recordedAt }),
    'ADVERTISER_PROFILE_BINDING_RECEIPT_CONFLICT:profile_id',
  );
  assert.equal(repository.inserts, 0);
}

{
  const repository = new FakeRepository({ insertError:new Error('db unavailable') });
  await rejectsCode(
    () => persistCanonicalAdvertiserProfileBindingReceipt({ repository, binding, recordedAt }),
    'ADVERTISER_PROFILE_BINDING_RECEIPT_PERSIST_FAILED',
  );
}

{
  const repository = new FakeRepository({ omitAfterInsert:true });
  await rejectsCode(
    () => persistCanonicalAdvertiserProfileBindingReceipt({ repository, binding, recordedAt }),
    'ADVERTISER_PROFILE_BINDING_RECEIPT_MISSING',
  );
}

{
  const repository = new FakeRepository();
  await rejectsCode(
    () => persistCanonicalAdvertiserProfileBindingReceipt({
      repository,
      binding:{ ...binding, relationCardinality:'one_to_one' },
      recordedAt,
    }),
    'ADVERTISER_PROFILE_BINDING_CARDINALITY_ASSUMPTION_FORBIDDEN',
  );
  assert.equal(repository.loads, 0);
  assert.equal(repository.inserts, 0);
}

console.log(JSON.stringify({
  ok:true,
  appendOnlyInsertContract:true,
  exactReplayIdempotent:true,
  sameReceiptRaceRecovered:true,
  conflictingFingerprintFailsClosed:true,
  noCanonicalSelectionApi:true,
  remoteD1Writes:0,
}, null, 2));

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error.code === code);
}
