import assert from 'node:assert/strict';
import {
  entityListContract,
  canonicalizeCampaign,
  canonicalizeAdGroup,
  canonicalizeKeyword,
  canonicalizeTarget,
  canonicalizeEntitySnapshot,
  buildEntityStageRows,
} from '../cloudflare/runtime/amazon-entity-contract.js';

function expectCodeAsync(fn, code) {
  return fn().then(
    () => assert.fail(`expected ${code}`),
    (error) => assert.equal(error.code, code),
  );
}

assert.deepEqual(entityListContract('campaign'), { entityType:'campaign', endpoint:'/sp/campaigns/list', method:'POST' });
assert.equal(entityListContract('ad_group').endpoint, '/sp/adGroups/list');
assert.equal(entityListContract('keyword').endpoint, '/sp/keywords/list');
assert.equal(entityListContract('target').endpoint, '/sp/targets/list');

const syncedAt = '2026-08-15T11:30:00Z';
const campaign = await canonicalizeCampaign({
  profileId:'p1', syncedAt,
  source:{
    campaignId:'c1', portfolioId:'portfolio-without-authority', name:'Campaign', state:'enabled',
    targetingType:'MANUAL', biddingStrategy:'LEGACY_FOR_SALES', dailyBudget:'10.250000',
    startDate:'2026-08-01', extendedData:{ lastUpdateDateTime:'local-or-unqualified-value-must-not-be-used' },
  },
});
assert.equal(campaign.portfolioId, null, 'V1 must not create portfolio FK without portfolio producer authority');
assert.equal(campaign.dailyBudgetMicros, '10250000');
assert.equal(campaign.sourceUpdatedAt, null);
assert.equal(campaign.syncedAt, syncedAt);
assert.match(campaign.payloadHash, /^[0-9a-f]{64}$/);

const adGroup = await canonicalizeAdGroup({
  profileId:'p1', syncedAt,
  source:{
    adGroupId:'a1', campaignId:'c1', name:'Ad Group', state:'PAUSED', defaultBid:null,
    extendedData:{ lastUpdateDate:'2026-08-10', lastUpdateDateTime:'2026-08-10T12:34:56Z' },
  },
});
assert.equal(adGroup.defaultBidMicros, null);
assert.equal(adGroup.sourceUpdatedAt, '2026-08-10T12:34:56Z');

const keywordZero = await canonicalizeKeyword({
  profileId:'p1', syncedAt,
  source:{
    keywordId:'k1', campaignId:'c1', adGroupId:'a1', keywordText:'  Reading   Glasses ',
    matchType:'broad', state:'ARCHIVED', bid:'0', extendedData:{ lastUpdateDate:'2026-08-09' },
  },
});
assert.equal(keywordZero.normalizedKeyword, 'reading glasses');
assert.equal(keywordZero.bidMicros, '0');
assert.equal(keywordZero.state, 'ARCHIVED');
assert.equal(keywordZero.sourceUpdatedAt, '2026-08-09');

const target = await canonicalizeTarget({
  profileId:'p1', syncedAt,
  source:{
    targetId:'t1', campaignId:'c1', adGroupId:'a1', state:'ENABLED', bid:'1.500000',
    expressionType:'MANUAL', expression:[{ value:'B0TEST', type:'asinSameAs' }],
    extendedData:{ lastUpdateDateTime:'must-not-be-used-for-target-v1' },
  },
});
assert.equal(target.bidMicros, '1500000');
assert.equal(target.sourceUpdatedAt, null);
assert.equal(target.targetType, 'MANUAL');
assert.equal(target.expressionJson, '[{"type":"asinSameAs","value":"B0TEST"}]');
assert.equal(target.expressionText, '{"type":"asinSameAs","value":"B0TEST"}');

await expectCodeAsync(() => canonicalizeKeyword({
  profileId:'p1', syncedAt,
  source:{ keywordId:'k2', campaignId:'c1', adGroupId:'a1', keywordText:'x', matchType:'EXACT', state:'ENABLED', bid:1.25 },
}), 'SOURCE_MONEY_LEXICAL_REQUIRED');

const source = {
  profileId:'p1', syncedAt,
  campaigns:[{ campaignId:'c1', name:'Campaign', state:'ENABLED', dailyBudget:'10.25' }],
  adGroups:[{ adGroupId:'a1', campaignId:'c1', name:'Ad Group', state:'ENABLED', defaultBid:'2.00', extendedData:{ lastUpdateDateTime:'2026-08-10T12:34:56Z' } }],
  keywords:[{ keywordId:'k1', campaignId:'c1', adGroupId:'a1', keywordText:'Reading Glasses', matchType:'BROAD', state:'ENABLED', bid:null, extendedData:{} }],
  targets:[{ targetId:'t1', campaignId:'c1', adGroupId:'a1', state:'ARCHIVED', bid:'0', expressionType:'MANUAL', expression:[{ type:'asinSameAs', value:'B0TEST' }] }],
};
const snapshotA = await canonicalizeEntitySnapshot(source);
const snapshotB = await canonicalizeEntitySnapshot(structuredClone(source));
assert.equal(snapshotA.snapshotHash, snapshotB.snapshotHash);
assert.deepEqual(snapshotA.counts, { campaign:1, ad_group:1, keyword:1, target:1 });
for (const entity of [...snapshotA.campaigns, ...snapshotA.adGroups, ...snapshotA.keywords, ...snapshotA.targets]) {
  assert.equal(entity.syncedAt, syncedAt);
}
const stageRows = buildEntityStageRows({ runId:'run1', snapshot:snapshotA });
assert.equal(stageRows.length, 4);
assert.deepEqual(stageRows.map((r) => [r.entityType, r.sourceRowOrdinal]), [
  ['campaign',0], ['ad_group',0], ['keyword',0], ['target',0],
]);

const changed = await canonicalizeEntitySnapshot({
  ...source,
  keywords:[{ ...source.keywords[0], bid:'0' }],
});
assert.notEqual(snapshotA.snapshotHash, changed.snapshotHash, 'null bid and zero bid must remain distinct in snapshot authority');

await expectCodeAsync(() => canonicalizeEntitySnapshot({
  ...source,
  adGroups:[{ ...source.adGroups[0], campaignId:'missing-campaign' }],
}), 'AD_GROUP_CAMPAIGN_HIERARCHY_MISMATCH');
await expectCodeAsync(() => canonicalizeEntitySnapshot({
  ...source,
  keywords:[source.keywords[0], { ...source.keywords[0] }],
}), 'DUPLICATE_KEYWORD_ID');

const emptySnapshot = await canonicalizeEntitySnapshot({ profileId:'p1', syncedAt, campaigns:[], adGroups:[], keywords:[], targets:[] });
assert.deepEqual(emptySnapshot.counts, { campaign:0, ad_group:0, keyword:0, target:0 });
assert.match(emptySnapshot.snapshotHash, /^[0-9a-f]{64}$/);

console.log(JSON.stringify({
  ok:true,
  spV3ListEndpoints:true,
  portfolioAuthorityNotInvented:true,
  sourceTimestampProvenance:true,
  bidNullZeroPreserved:true,
  deterministicTargetExpression:true,
  sharedSnapshotSyncedAt:true,
  snapshotHash:true,
  hierarchyFailClosed:true,
}, null, 2));
