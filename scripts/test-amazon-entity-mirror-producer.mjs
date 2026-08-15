import assert from 'node:assert/strict';
import { canonicalizeEntitySnapshot } from '../cloudflare/runtime/amazon-entity-contract.js';
import {
  stageEntityMirrorSnapshot,
  publishEntityMirrorSnapshot,
  assertStageReceipt,
  assertSnapshotReceipt,
} from '../cloudflare/runtime/amazon-entity-mirror-producer.js';

const syncedAt = '2026-08-15T11:40:00Z';
const source = {
  profileId:'p1', syncedAt,
  campaigns:[{ campaignId:'c1', name:'Campaign', state:'ENABLED', dailyBudget:'10.25' }],
  adGroups:[{ adGroupId:'a1', campaignId:'c1', name:'Ad Group', state:'ENABLED', defaultBid:'2.00', extendedData:{ lastUpdateDateTime:'2026-08-10T12:34:56Z' } }],
  keywords:[{ keywordId:'k1', campaignId:'c1', adGroupId:'a1', keywordText:'Reading Glasses', matchType:'BROAD', state:'ENABLED', bid:null, extendedData:{} }],
  targets:[{ targetId:'t1', campaignId:'c1', adGroupId:'a1', state:'ARCHIVED', bid:'0', expressionType:'MANUAL', expression:[{ type:'asinSameAs', value:'B0TEST' }] }],
};
const snapshot = await canonicalizeEntitySnapshot(source);
const changedSnapshot = await canonicalizeEntitySnapshot({
  ...source,
  keywords:[{ ...source.keywords[0], bid:'0' }],
});
const emptySnapshot = await canonicalizeEntitySnapshot({ profileId:'p1', syncedAt, campaigns:[], adGroups:[], keywords:[], targets:[] });

function receiptFromSnapshot(runId, s, kind) {
  return {
    run_id:runId,
    profile_id:s.profileId,
    snapshot_synced_at:s.syncedAt,
    snapshot_sha256:s.snapshotHash,
    campaign_count:s.counts.campaign,
    ad_group_count:s.counts.ad_group,
    keyword_count:s.counts.keyword,
    target_count:s.counts.target,
    ...(kind === 'stage' ? { staged_at:'2026-08-15T11:41:00Z' } : { published_at:'2026-08-15T11:42:00Z' }),
  };
}

class FakeRepository {
  constructor({ runId='run1', profileId='p1', publishRace=false } = {}) {
    this.run = { run_id:runId, profile_id:profileId, status:'running' };
    this.stageReceipt = null;
    this.finalReceipt = null;
    this.summary = null;
    this.replaceCalls = 0;
    this.publishCalls = 0;
    this.publishRace = publishRace;
  }
  async loadRun() { return { ...this.run }; }
  async loadReceipt() { return this.finalReceipt ? { ...this.finalReceipt } : null; }
  async loadStageReceipt() { return this.stageReceipt ? { ...this.stageReceipt } : null; }
  async replaceStageAndPersistReceipt({ runId, rows, profileId, syncedAt, snapshotHash, counts, stagedAt }) {
    this.replaceCalls += 1;
    this.stageRows = rows;
    this.stageReceipt = {
      run_id:runId, profile_id:profileId, snapshot_synced_at:syncedAt, snapshot_sha256:snapshotHash,
      campaign_count:counts.campaign, ad_group_count:counts.ad_group, keyword_count:counts.keyword, target_count:counts.target,
      staged_at:stagedAt,
    };
    this.summary = {
      profile_id:profileId,
      snapshot_synced_at:rows.length ? syncedAt : null,
      campaign_count:counts.campaign,
      ad_group_count:counts.ad_group,
      keyword_count:counts.keyword,
      target_count:counts.target,
      invalid_rows:0,
    };
  }
  async loadStageSummary() { return this.summary ? { ...this.summary } : null; }
  async publishStage({ runId, profileId, syncedAt, snapshotHash, counts, publishedAt }) {
    this.publishCalls += 1;
    this.finalReceipt = {
      run_id:runId, profile_id:profileId, snapshot_synced_at:syncedAt, snapshot_sha256:snapshotHash,
      campaign_count:counts.campaign, ad_group_count:counts.ad_group, keyword_count:counts.keyword, target_count:counts.target,
      published_at:publishedAt,
    };
    if (this.publishRace) throw new Error('simulated response loss after transaction');
    this.stageRows = [];
  }
}

{
  const repository = new FakeRepository();
  const staged = await stageEntityMirrorSnapshot({ repository, runId:'run1', snapshot, stagedAt:'2026-08-15T11:41:00Z' });
  assert.equal(staged.reused, false);
  assert.equal(staged.published, false);
  assert.equal(repository.replaceCalls, 1);
  assert.equal(repository.stageRows.length, 4);
  assert.equal(assertStageReceipt(repository.stageReceipt, 'run1', snapshot), true);

  const stagedReplay = await stageEntityMirrorSnapshot({ repository, runId:'run1', snapshot, stagedAt:'ignored' });
  assert.equal(stagedReplay.reused, true);
  assert.equal(repository.replaceCalls, 1);

  const published = await publishEntityMirrorSnapshot({ repository, runId:'run1', snapshot, publishedAt:'2026-08-15T11:42:00Z' });
  assert.equal(published.reused, false);
  assert.equal(repository.publishCalls, 1);
  assert.equal(assertSnapshotReceipt(repository.finalReceipt, 'run1', snapshot), true);

  const publishedReplay = await publishEntityMirrorSnapshot({ repository, runId:'run1', snapshot, publishedAt:'ignored' });
  assert.equal(publishedReplay.reused, true);
  assert.equal(repository.publishCalls, 1);
}

{
  const repository = new FakeRepository();
  await stageEntityMirrorSnapshot({ repository, runId:'run1', snapshot, stagedAt:'t1' });
  try {
    await stageEntityMirrorSnapshot({ repository, runId:'run1', snapshot:changedSnapshot, stagedAt:'t2' });
    assert.fail('different snapshot reused same stage receipt');
  } catch (error) {
    assert.equal(error.code, 'ENTITY_STAGE_RECEIPT_CONFLICT:snapshot_sha256');
  }
  assert.equal(repository.replaceCalls, 1);
}

{
  const repository = new FakeRepository();
  repository.summary = {
    profile_id:'p1', snapshot_synced_at:syncedAt,
    campaign_count:1, ad_group_count:1, keyword_count:1, target_count:1, invalid_rows:0,
  };
  try {
    await publishEntityMirrorSnapshot({ repository, runId:'run1', snapshot, publishedAt:'t' });
    assert.fail('publish without stage receipt accepted');
  } catch (error) {
    assert.equal(error.code, 'ENTITY_STAGE_RECEIPT_REQUIRED');
  }
}

{
  const repository = new FakeRepository({ publishRace:true });
  await stageEntityMirrorSnapshot({ repository, runId:'run1', snapshot, stagedAt:'t1' });
  const result = await publishEntityMirrorSnapshot({ repository, runId:'run1', snapshot, publishedAt:'t2' });
  assert.equal(result.reused, true, 'lost publish response should recover from durable final receipt');
  assert.equal(repository.publishCalls, 1);
}

{
  const repository = new FakeRepository();
  const staged = await stageEntityMirrorSnapshot({ repository, runId:'run1', snapshot:emptySnapshot, stagedAt:'t1' });
  assert.equal(staged.reused, false);
  assert.equal(repository.stageRows.length, 0);
  const published = await publishEntityMirrorSnapshot({ repository, runId:'run1', snapshot:emptySnapshot, publishedAt:'t2' });
  assert.equal(published.reused, false);
  assert.equal(repository.finalReceipt.campaign_count, 0);
}

{
  const repository = new FakeRepository({ profileId:'p2' });
  try {
    await stageEntityMirrorSnapshot({ repository, runId:'run1', snapshot, stagedAt:'t' });
    assert.fail('profile mismatch accepted');
  } catch (error) {
    assert.equal(error.code, 'ENTITY_MIRROR_PROFILE_RECEIPT_MISMATCH');
  }
}

{
  const bad = receiptFromSnapshot('run1', snapshot, 'stage');
  bad.keyword_count = null;
  try {
    assertStageReceipt(bad, 'run1', snapshot);
    assert.fail('NULL count accepted as zero');
  } catch (error) {
    assert.equal(error.code, 'ENTITY_STAGE_RECEIPT_INVALID:keyword_count');
  }
}

console.log(JSON.stringify({
  ok:true,
  stageDurableReceipt:true,
  stageFrozenBySnapshotHash:true,
  publishDurableReceipt:true,
  lostPublishResponseRecovered:true,
  zeroEntitySnapshot:true,
  nullCountRejected:true,
}, null, 2));
