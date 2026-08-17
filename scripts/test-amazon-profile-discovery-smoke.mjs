import assert from 'node:assert/strict';
import {
  AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_HEADERS,
  AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_PATH,
  handleAmazonAdsProfileDiscoverySmoke,
} from '../cloudflare/runtime/amazon-ads-profile-discovery-smoke.js';
import { buildAmazonProfileDiscoverySmokeProof } from './smoke-cloudflare-amazon-profile-discovery-dev.mjs';
import { buildAmazonAdsCredentialSmokeProof } from './smoke-cloudflare-amazon-ads-credentials-dev.mjs';

const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TIMESTAMP = 1786935600000;
const REFRESH_TOKEN = 'refresh-token-test-value';

function canonicalProfile(id = '1234567890') {
  return {
    profileId:id,
    countryCode:'US',
    currencyCode:'USD',
    timezone:'America/Los_Angeles',
    accountInfo:{
      marketplaceStringId:'ATVPDKIKX0DER',
      type:'seller',
      name:'Store 01',
    },
  };
}

function controlDb(counter) {
  return {
    prepare(sql) {
      assert.match(String(sql), /FROM stores/);
      return {
        bind(storeId) {
          assert.equal(storeId, 'store-dev-01');
          return this;
        },
        async first() {
          counter.reads += 1;
          return {
            store_id:'store-dev-01',
            store_code:'DEV01',
            marketplace_code:'US',
            amazon_region:'NA',
            status:'active',
          };
        },
        async run() {
          counter.writes += 1;
          throw new Error('control write forbidden');
        },
      };
    },
  };
}

function env(counter, overrides = {}) {
  return {
    APP_ENV:'development',
    AMAZON_ADS_ENABLED:'false',
    AMAZON_ADS_CLIENT_ID:'client-id-test',
    AMAZON_ADS_REFRESH_TOKEN:REFRESH_TOKEN,
    CONTROL_DB:controlDb(counter),
    CF_VERSION_METADATA:{ id:'version-test', tag:COMMIT, timestamp:'2026-08-17T04:00:00Z' },
    ...overrides,
  };
}

function requestWithProof(proof) {
  return new Request(`https://sync.example.test${AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_PATH}`, {
    method:'POST',
    headers:{
      [AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_HEADERS.timestamp]:String(TIMESTAMP),
      [AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_HEADERS.proof]:proof,
    },
  });
}

const proof = buildAmazonProfileDiscoverySmokeProof({
  refreshToken:REFRESH_TOKEN,
  tag:COMMIT,
  timestamp:TIMESTAMP,
});

{
  const counter = { reads:0, writes:0, transportCalls:0, listCalls:0 };
  const response = await handleAmazonAdsProfileDiscoverySmoke(
    requestWithProof(proof),
    env(counter),
    {
      now:() => TIMESTAMP,
      credentialProviderFactory() {
        return { async getAccessToken() { return 'access-token'; } };
      },
      transportFactory(options) {
        counter.transportCalls += 1;
        assert.equal(options.clientId, 'client-id-test');
        assert.equal(options.accessToken, 'access-token');
        assert.equal(options.region, 'NA');
        return {
          async listProfiles() {
            counter.listCalls += 1;
            return [canonicalProfile()];
          },
        };
      },
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.amazonAdsEnabled, false);
  assert.equal(body.runtimeVersion.tag, COMMIT);
  assert.equal(body.profileDiscovery.profileId, '1234567890');
  assert.equal(body.profileDiscovery.accountType, 'seller');
  assert.equal(body.profileDiscovery.timezone, 'America/Los_Angeles');
  assert.equal(counter.reads, 1);
  assert.equal(counter.writes, 0);
  assert.equal(counter.transportCalls, 1);
  assert.equal(counter.listCalls, 1);
  assert.ok(Object.values(body.profileDiscovery.sideEffects).every((value) => value === false));
  assert.equal(JSON.stringify(body).includes('access-token'), false);
  assert.equal(JSON.stringify(body).includes(REFRESH_TOKEN), false);
}

{
  const counter = { reads:0, writes:0 };
  const credentialProof = buildAmazonAdsCredentialSmokeProof({
    refreshToken:REFRESH_TOKEN,
    tag:COMMIT,
    timestamp:TIMESTAMP,
  });
  const response = await handleAmazonAdsProfileDiscoverySmoke(
    requestWithProof(credentialProof),
    env(counter),
    { now:() => TIMESTAMP },
  );
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.errorCode, 'profile_smoke_proof_invalid');
  assert.equal(counter.reads, 0);
  assert.equal(counter.writes, 0);
}

{
  const counter = { reads:0, writes:0 };
  const response = await handleAmazonAdsProfileDiscoverySmoke(
    requestWithProof(proof),
    env(counter, { AMAZON_ADS_ENABLED:'true' }),
    { now:() => TIMESTAMP },
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.errorCode, 'profile_smoke_requires_amazon_ads_disabled');
  assert.equal(counter.reads, 0);
  assert.equal(counter.writes, 0);
}

{
  const counter = { reads:0, writes:0 };
  const response = await handleAmazonAdsProfileDiscoverySmoke(
    requestWithProof(proof),
    env(counter),
    {
      now:() => TIMESTAMP,
      credentialProviderFactory() {
        return { async getAccessToken() { return 'access-token'; } };
      },
      transportFactory() {
        return { async listProfiles() { return [canonicalProfile('1234567890'), canonicalProfile('2234567890')]; } };
      },
    },
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.errorCode, 'profile_smoke_canonical_profile_rejected');
  assert.equal(body.profileCode, 'CANONICAL_PROFILE_AMBIGUOUS');
  assert.equal(counter.reads, 1);
  assert.equal(counter.writes, 0);
}

{
  const counter = { reads:0, writes:0 };
  const response = await handleAmazonAdsProfileDiscoverySmoke(
    requestWithProof(proof),
    env(counter),
    {
      now:() => TIMESTAMP,
      credentialProviderFactory() {
        return { async getAccessToken() { return 'access-token'; } };
      },
      transportFactory() {
        return { async listProfiles() { return []; } };
      },
    },
  );
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.errorCode, 'profile_smoke_canonical_profile_rejected');
  assert.equal(body.profileCode, 'CANONICAL_PROFILE_NOT_FOUND');
  assert.equal(counter.reads, 1);
  assert.equal(counter.writes, 0);
}

console.log(JSON.stringify({
  ok:true,
  contract:'amazon-ads-profile-discovery-smoke-v1',
  safeDisabledOnly:true,
  controlD1ReadOnly:true,
  storeD1Touched:false,
  reportsTouched:false,
  r2Touched:false,
  credentialProofCrossReplayRejected:true,
  canonicalProfileFailClosed:true,
}, null, 2));
