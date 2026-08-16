import assert from 'node:assert/strict';
import {
  AmazonAdsBootstrapTransportError,
  createAmazonAdsBootstrapTransport,
  parseJsonPreservingNumberLexemes,
} from '../cloudflare/runtime/amazon-ads-bootstrap-transport.js';
import { canonicalizeEntitySnapshot } from '../cloudflare/runtime/amazon-entity-contract.js';

function responseRaw(raw, init = {}) {
  return new Response(raw, {
    status:init.status ?? 200,
    headers:{ 'content-type':'application/json', ...(init.headers || {}) },
  });
}

function baseOptions(overrides = {}) {
  return {
    clientId:'client-id',
    accessToken:'access-token',
    region:'NA',
    sleep:async () => {},
    pageSize:100,
    ...overrides,
  };
}

function testLosslessJsonNumbers() {
  const value = parseJsonPreservingNumberLexemes('{"id":12345678901234567890,"money":10.250000,"tiny":1e-7,"label":"123.45","ok":true}');
  assert.equal(value.id, '12345678901234567890');
  assert.equal(value.money, '10.250000');
  assert.equal(value.tiny, '1e-7');
  assert.equal(value.label, '123.45');
  assert.equal(value.ok, true);
}

async function testProfilesUseRegionHostWithoutScope() {
  const calls = [];
  const transport = createAmazonAdsBootstrapTransport(baseOptions({
    fetchImpl:async (url, init) => {
      calls.push({ url, init });
      return responseRaw('[{"profileId":12345678901234567,"countryCode":"US","currencyCode":"USD","timezone":"America/Los_Angeles","accountInfo":{"type":"seller","marketplaceStringId":"ATVPDKIKX0DER"}}]');
    },
  }));
  const profiles = await transport.listProfiles({ storeId:'store-dev-01' });
  assert.equal(profiles[0].profileId, '12345678901234567');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://advertising-api.amazon.com/v2/profiles');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['amazon-advertising-api-clientid'], 'client-id');
  assert.equal(calls[0].init.headers.authorization, 'Bearer access-token');
  assert.equal(calls[0].init.headers['amazon-advertising-api-scope'], undefined);
}

async function testEntityPaginationAndCanonicalMoney() {
  const calls = [];
  const queues = new Map([
    ['/sp/campaigns/list', [
      '{"campaigns":[{"campaignId":"c1","name":"Campaign","state":"ENABLED","targetingType":"MANUAL","budget":{"budget":10.250000,"budgetType":"DAILY"},"dynamicBidding":{"strategy":"LEGACY_FOR_SALES"}}],"nextToken":"campaign-page-2","totalResults":2}',
      '{"campaigns":[{"campaignId":"c2","name":"Campaign 2","state":"PAUSED","targetingType":"AUTO","budget":{"budget":20.000001,"budgetType":"DAILY"}}],"totalResults":2}',
    ]],
    ['/sp/adGroups/list', [
      '{"adGroups":[{"adGroupId":"a1","campaignId":"c1","name":"Ad Group","state":"ENABLED","defaultBid":1.230000,"extendedData":{"lastUpdateDateTime":"2026-08-16T00:01:02Z"}}],"totalResults":1}',
    ]],
    ['/sp/keywords/list', [
      '{"keywords":[{"keywordId":"k1","campaignId":"c1","adGroupId":"a1","keywordText":"reading glasses","matchType":"BROAD","state":"ENABLED","bid":0.000001}],"totalResults":1}',
    ]],
    ['/sp/targets/list', [
      '{"targetingClauses":[{"targetId":"t1","campaignId":"c1","adGroupId":"a1","state":"ENABLED","bid":2.500000,"expressionType":"MANUAL","expression":[{"type":"asinSameAs","value":"B0TEST"}]}],"totalResults":1}',
    ]],
  ]);
  const transport = createAmazonAdsBootstrapTransport(baseOptions({
    fetchImpl:async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, init, body:init.body ? JSON.parse(init.body) : null });
      const queue = queues.get(path);
      assert.ok(queue, `unexpected path ${path}`);
      const raw = queue.shift();
      assert.ok(raw, `unexpected extra call ${path}`);
      return responseRaw(raw);
    },
  }));

  const source = await transport.fetchEntitySnapshot({ profile:{ profileId:'profile-1' } });
  assert.equal(source.campaigns.length, 2);
  assert.equal(source.campaigns[0].dailyBudget, '10.250000');
  assert.equal(source.campaigns[0].biddingStrategy, 'LEGACY_FOR_SALES');
  assert.equal(source.adGroups[0].defaultBid, '1.230000');
  assert.equal(source.keywords[0].bid, '0.000001');
  assert.equal(source.targets[0].bid, '2.500000');
  assert.equal(calls.length, 5);
  assert.equal(calls[0].path, '/sp/campaigns/list');
  assert.equal(calls[0].init.headers.accept, 'application/vnd.spCampaign.v3+json');
  assert.equal(calls[0].init.headers['amazon-advertising-api-scope'], 'profile-1');
  assert.equal(calls[0].body.includeExtendedDataFields, true);
  assert.equal(calls[0].body.maxResults, 100);
  assert.equal(calls[1].body.nextToken, 'campaign-page-2');
  const targetCall = calls.find((call) => call.path === '/sp/targets/list');
  assert.equal(targetCall.init.headers.accept, 'application/vnd.spTargetingClause.v3+json');
  assert.equal(targetCall.body.includeExtendedDataFields, undefined);

  const snapshot = await canonicalizeEntitySnapshot({
    profileId:'profile-1',
    syncedAt:'2026-08-16T00:10:00Z',
    ...source,
  });
  assert.equal(snapshot.campaigns[0].dailyBudgetMicros, '10250000');
  assert.equal(snapshot.campaigns[1].dailyBudgetMicros, '20000001');
  assert.equal(snapshot.adGroups[0].defaultBidMicros, '1230000');
  assert.equal(snapshot.keywords[0].bidMicros, '1');
  assert.equal(snapshot.targets[0].bidMicros, '2500000');
  assert.equal(snapshot.adGroups[0].sourceUpdatedAt, '2026-08-16T00:01:02Z');
}

async function testSafeListRetryAndPaginationLoopGuard() {
  let calls = 0;
  const sleeps = [];
  const transport = createAmazonAdsBootstrapTransport(baseOptions({
    maxRetries:2,
    sleep:async (ms) => { sleeps.push(ms); },
    fetchImpl:async (url) => {
      calls += 1;
      if (url.endsWith('/v2/profiles')) {
        if (calls === 1) return new Response('', { status:429, headers:{ 'retry-after':'1' } });
        return responseRaw('[]');
      }
      throw new Error('unexpected');
    },
  }));
  assert.deepEqual(await transport.listProfiles(), []);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);

  const loopQueues = new Map([
    ['/sp/campaigns/list', [
      '{"campaigns":[],"nextToken":"same"}',
      '{"campaigns":[],"nextToken":"same"}',
    ]],
  ]);
  const looping = createAmazonAdsBootstrapTransport(baseOptions({
    fetchImpl:async (url) => {
      const path = new URL(url).pathname;
      if (path !== '/sp/campaigns/list') return responseRaw('{"adGroups":[]}');
      return responseRaw(loopQueues.get(path).shift());
    },
  }));
  await assert.rejects(looping.fetchEntitySnapshot({ profileId:'p1' }), (error) => {
    assert.ok(error instanceof AmazonAdsBootstrapTransportError);
    assert.equal(error.code, 'AMAZON_ADS_ENTITY_PAGINATION_LOOP:campaigns');
    return true;
  });
}

testLosslessJsonNumbers();
await testProfilesUseRegionHostWithoutScope();
await testEntityPaginationAndCanonicalMoney();
await testSafeListRetryAndPaginationLoopGuard();
console.log('Amazon Ads bootstrap transport tests: PASS');
