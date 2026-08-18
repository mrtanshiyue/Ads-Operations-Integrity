import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(`
CREATE TABLE amazon_profiles (
  profile_id TEXT PRIMARY KEY,
  marketplace_id TEXT,
  country_code TEXT,
  currency_code TEXT,
  timezone TEXT,
  account_name TEXT,
  account_type TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
db.exec(readFileSync('cloudflare/foundation/migrations/store/0020_store_advertiser_profile_binding_receipts.sql', 'utf8'));

const insertProfile = db.prepare(`INSERT INTO amazon_profiles(
  profile_id,marketplace_id,country_code,currency_code,account_name,account_type,status
) VALUES(?,?,?,?,?,?,?)`);
insertProfile.run('p1','ATVPDKIKX0DER','US','USD','Seller 1','seller','active');
insertProfile.run('p2','ATVPDKIKX0DER','US','USD','Seller 2','seller','active');
insertProfile.run('p-disabled','ATVPDKIKX0DER','US','USD','Disabled','seller','disabled');

const insertReceipt = db.prepare(`INSERT INTO amazon_advertiser_profile_binding_receipts(
  evidence_fingerprint,contract_version,advertiser_account_identifier_type,advertiser_account_id,
  profile_identifier_type,profile_id,marketplace_id,country_code,currency_code,account_type,account_name,
  source_contract,source_endpoint,source_observed_at,relation_cardinality,profile_authority
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const row = (fingerprint, advertiserAccountId='acct-1', profileId='p1', patch={}) => ({
  evidence_fingerprint:fingerprint,
  contract_version:'CanonicalAdvertiserProfileBindingV1',
  advertiser_account_identifier_type:'verified-account-type',
  advertiser_account_id:advertiserAccountId,
  profile_identifier_type:'verified-profile-type',
  profile_id:profileId,
  marketplace_id:'ATVPDKIKX0DER',
  country_code:'US',
  currency_code:'USD',
  account_type:'seller',
  account_name:'Seller',
  source_contract:'amazon-ads-advertiser-account-query-v1',
  source_endpoint:'/adsApi/v1/query/advertiserAccounts',
  source_observed_at:'2026-08-18T07:00:00Z',
  relation_cardinality:'not_assumed',
  profile_authority:'amazon-ads-profiles-api-v2',
  ...patch,
});
const values = (r) => [
  r.evidence_fingerprint,r.contract_version,r.advertiser_account_identifier_type,r.advertiser_account_id,
  r.profile_identifier_type,r.profile_id,r.marketplace_id,r.country_code,r.currency_code,r.account_type,r.account_name,
  r.source_contract,r.source_endpoint,r.source_observed_at,r.relation_cardinality,r.profile_authority,
];
const insert = (r) => insertReceipt.run(...values(r));
const expectFail = (r, code) => assert.throws(() => insert(r), (error) => String(error.message).includes(code));

insert(row('a'.repeat(64)));
// Storage deliberately does not encode 1:1 cardinality. Selection remains a fail-closed resolver concern.
insert(row('b'.repeat(64), 'acct-1', 'p2'));
insert(row('c'.repeat(64), 'acct-2', 'p1'));
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM amazon_advertiser_profile_binding_receipts').get().n, 3);

expectFail(row('BAD'), 'ADVERTISER_PROFILE_BINDING_FINGERPRINT_INVALID');
expectFail(row('d'.repeat(64), 'acct-3', 'p-disabled'), 'ADVERTISER_PROFILE_BINDING_PROFILE_RECEIPT_MISMATCH');
expectFail(row('e'.repeat(64), 'acct-4', 'p1', { marketplace_id:'wrong' }), 'ADVERTISER_PROFILE_BINDING_PROFILE_RECEIPT_MISMATCH');
expectFail(row('f'.repeat(64), 'acct-5', 'missing'), 'ADVERTISER_PROFILE_BINDING_PROFILE_RECEIPT_MISMATCH');
assert.throws(
  () => db.prepare("UPDATE amazon_advertiser_profile_binding_receipts SET account_name='x' WHERE evidence_fingerprint=?").run('a'.repeat(64)),
  (error) => String(error.message).includes('ADVERTISER_PROFILE_BINDING_RECEIPT_IMMUTABLE'),
);
assert.throws(
  () => db.prepare('DELETE FROM amazon_advertiser_profile_binding_receipts WHERE evidence_fingerprint=?').run('a'.repeat(64)),
  (error) => String(error.message).includes('ADVERTISER_PROFILE_BINDING_RECEIPT_IMMUTABLE'),
);
assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

console.log(JSON.stringify({
  ok:true,
  appendOnly:true,
  cardinalityNotAssumed:true,
  profileReceiptGuard:true,
  remoteWrites:0,
}, null, 2));
