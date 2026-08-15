import assert from 'node:assert/strict';
import { canonicalizeEntitySnapshot } from '../cloudflare/runtime/amazon-entity-contract.js';
import { prepareProducerBootstrap } from '../cloudflare/runtime/sync-producer-bootstrap.js';

const now = '2026-08-15T11:45:00Z';
const store = { store_id:'store-1', store_code:'DEV01', marketplace_code:'US', amazon_region:'NA' };
const rawProfiles = [{
  profileId:'profile-1', countryCode:'US', currencyCode:'USD', timezone:'America/Los_Angeles',
  accountInfo:{ marketplaceStringId:'ATVPDKIKX0DER', type:'seller', name:'Seller Account' },
}];
const entitySource = {
  campaigns:[{ campaignId:'c1', name:'Campaign', state:'ENABLED', dailyBudget:'10.00' }],
  adGroups:[{ adGroupId:'a1', campaignId:'c1', name:'Ad Group', state:'ENABLED', defaultBid:'1.50', extendedData:{} }],
  keywords:[{ keywordId:'k1', campaignId:'c1', adGroupId:'a1', keywordText:'Reading Glasses', matchType:'BROAD', state:'ENABLED', bid:null, extendedData:{} }],
  targets:[{ targetId:'t1', campaignId:'c1', adGroupId:'a1', expressionType:'MANUAL', expression:[{type:'asinSameAs',value:'B0TEST'}], state:'ENABLED', bid:'0' }],
};

function execution(run, datasets=['search_term_daily']) {
  return {
    instanceId:'run-1',
    intent:{ storeId:'store-1', startDate:'2026-08-12', endDate:'2026-08-12', datasets, triggerType:'manual' },
    run:{ ...run },
    profileStage:run.status === 'queued' ? 'RESOLVE_CANONICAL_PROFILE' : 'REUSE_CANONICAL_PROFILE',
  };
}

class SharedState {
  constructor(run) {
    this.run = { ...run };
    this.profileRow = null;
    this.entityStageReceipt = null;
    this.entityFinalReceipt = null;
    this.entitySummary = null;
    this.entityPublishCalls = 0;
    this.reportRows = new Map();
  }
}

function profileRepository(state) {
  return {
    async loadRun() { return { ...state.run }; },
    async loadCanonicalProfile(profileId) {
      return state.profileRow?.profile_id === profileId ? { ...state.profileRow } : null;
    },
    async upsertCanonicalProfile(profile, syncedAt) {
      state.profileRow = {
        profile_id:profile.profileId, marketplace_id:profile.marketplaceId, country_code:profile.countryCode,
        currency_code:profile.currencyCode, timezone:profile.timezone, account_name:profile.accountName,
        account_type:profile.accountType, status:'active', source_updated_at:null, synced_at:syncedAt,
      };
    },
    async assignProfileToQueuedRun(runId, profileId, startedAt) {
      if (state.run.run_id !== runId || state.run.status !== 'queued' || state.run.profile_id != null) return false;
      state.run.profile_id = profileId;
      state.run.status = 'running';
      state.run.started_at = startedAt;
      return true;
    },
  };
}

function entityRepository(state) {
  return {
    async loadRun() { return { ...state.run }; },
    async loadReceipt() { return state.entityFinalReceipt ? { ...state.entityFinalReceipt } : null; },
    async loadStageReceipt() { return state.entityStageReceipt ? { ...state.entityStageReceipt } : null; },
    async loadStageSummary() { return state.entitySummary ? { ...state.entitySummary } : null; },
    async replaceStageAndPersistReceipt({ runId, rows, profileId, syncedAt, snapshotHash, counts, stagedAt }) {
      state.entityStageReceipt = {
        run_id:runId, profile_id:profileId, snapshot_synced_at:syncedAt, snapshot_sha256:snapshotHash,
        campaign_count:counts.campaign, ad_group_count:counts.ad_group, keyword_count:counts.keyword,
        target_count:counts.target, staged_at:stagedAt,
      };
      state.entitySummary = {
        profile_id:profileId, snapshot_synced_at:rows.length ? syncedAt : null,
        campaign_count:counts.campaign, ad_group_count:counts.ad_group, keyword_count:counts.keyword,
        target_count:counts.target, invalid_rows:0,
      };
    },
    async publishStage({ runId, profileId, syncedAt, snapshotHash, counts, publishedAt }) {
      state.entityPublishCalls += 1;
      state.entityFinalReceipt = {
        run_id:runId, profile_id:profileId, snapshot_synced_at:syncedAt, snapshot_sha256:snapshotHash,
        campaign_count:counts.campaign, ad_group_count:counts.ad_group, keyword_count:counts.keyword,
        target_count:counts.target, published_at:publishedAt,
      };
    },
  };
}

function reportRepository(state) {
  return {
    async insertQueued(plan) {
      if (!state.reportRows.has(plan.idempotencyKey)) {
        state.reportRows.set(plan.idempotencyKey, {
          job_id:plan.jobId, run_id:plan.runId, profile_id:plan.profileId, ad_product:plan.adProduct,
          report_type:plan.reportType, start_date:plan.startDate, end_date:plan.endDate, status:'queued',
          idempotency_key:plan.idempotencyKey, request_fingerprint:plan.requestFingerprint, request_json:plan.requestJson,
        });
      }
    },
    async loadByIdempotencyKey(key) {
      const row = state.reportRows.get(key);
      return row ? { ...row } : null;
    },
  };
}

function repositories(state) {
  return { profile:profileRepository(state), entity:entityRepository(state), report:reportRepository(state) };
}

// First execution: adapters are called only for missing durable authorities.
{
  const state = new SharedState({ run_id:'run-1', status:'queued', profile_id:null });
  let profileCalls = 0;
  let entityCalls = 0;
  const result = await prepareProducerBootstrap({
    execution:execution(state.run), store, repositories:repositories(state), now,
    adapters:{
      async listProfiles() { profileCalls += 1; return rawProfiles; },
      async fetchEntitySnapshot() { entityCalls += 1; return entitySource; },
    },
  });
  assert.equal(profileCalls, 1);
  assert.equal(entityCalls, 1);
  assert.equal(state.run.status, 'running');
  assert.equal(state.run.profile_id, 'profile-1');
  assert.equal(state.entityPublishCalls, 1);
  assert.equal(result.profile.accountType, 'seller');
  assert.equal(result.reportJobs.length, 1);
  assert.equal(state.reportRows.size, 1);

  // Restart: running profile + final entity receipt eliminate both Amazon adapter reads.
  const retry = await prepareProducerBootstrap({
    execution:execution(state.run), store, repositories:repositories(state), now:'2026-08-15T11:46:00Z',
    adapters:{
      async listProfiles() { throw new Error('profile adapter must not run on durable retry'); },
      async fetchEntitySnapshot() { throw new Error('entity adapter must not run on durable retry'); },
    },
  });
  assert.equal(retry.profile.profileId, 'profile-1');
  assert.equal(retry.reportJobs.length, 1);
  assert.equal(state.entityPublishCalls, 1);
  assert.equal(state.reportRows.size, 1);
}

// Crash after entity stage receipt: bootstrap publishes durable stage without fetching Amazon again.
{
  const state = new SharedState({ run_id:'run-1', status:'running', profile_id:'profile-1' });
  state.profileRow = {
    profile_id:'profile-1', marketplace_id:'ATVPDKIKX0DER', country_code:'US', currency_code:'USD',
    timezone:'America/Los_Angeles', account_name:'Seller Account', account_type:'seller', status:'active', synced_at:'t0',
  };
  const snapshot = await canonicalizeEntitySnapshot({ profileId:'profile-1', syncedAt:'t-stage', ...entitySource });
  state.entityStageReceipt = {
    run_id:'run-1', profile_id:'profile-1', snapshot_synced_at:snapshot.syncedAt, snapshot_sha256:snapshot.snapshotHash,
    campaign_count:1, ad_group_count:1, keyword_count:1, target_count:1, staged_at:'t-stage',
  };
  state.entitySummary = {
    profile_id:'profile-1', snapshot_synced_at:snapshot.syncedAt,
    campaign_count:1, ad_group_count:1, keyword_count:1, target_count:1, invalid_rows:0,
  };
  const result = await prepareProducerBootstrap({
    execution:execution(state.run), store, repositories:repositories(state), now:'t-publish',
    adapters:{
      async listProfiles() { throw new Error('profile adapter must not run'); },
      async fetchEntitySnapshot() { throw new Error('entity adapter must not run after stage receipt'); },
    },
  });
  assert.equal(state.entityPublishCalls, 1);
  assert.equal(result.entityReceipt.snapshot_sha256, snapshot.snapshotHash);
  assert.equal(result.reportJobs.length, 1);
}

// Unsupported durable intent fails before profile/entity adapters or producer writes.
{
  const state = new SharedState({ run_id:'run-1', status:'queued', profile_id:null });
  let calls = 0;
  await assert.rejects(
    () => prepareProducerBootstrap({
      execution:execution(state.run, ['campaign_daily']), store, repositories:repositories(state), now,
      adapters:{
        async listProfiles() { calls += 1; return rawProfiles; },
        async fetchEntitySnapshot() { calls += 1; return entitySource; },
      },
    }),
    (error) => error.code === 'PRODUCER_DATASET_NOT_IMPLEMENTED:campaign_daily',
  );
  assert.equal(calls, 0);
  assert.equal(state.run.status, 'queued');
  assert.equal(state.profileRow, null);
  assert.equal(state.entityFinalReceipt, null);
  assert.equal(state.reportRows.size, 0);
}

console.log(JSON.stringify({
  ok:true,
  durableProfileRetryAvoidsAmazonProfiles:true,
  durableEntityFinalRetryAvoidsAmazonEntityFetch:true,
  durableEntityStageCrashRecoveryAvoidsAmazonEntityFetch:true,
  reportsReservedOnlyAfterEntityReceipt:true,
  unsupportedCapabilityHasZeroProducerSideEffects:true,
}, null, 2));
