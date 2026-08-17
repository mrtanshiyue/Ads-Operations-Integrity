import assert from 'node:assert/strict';
import { handleSyncApiRoute } from '../cloudflare/runtime/sync-api.js';

function statement(firstValue, counters, kind) {
  return {
    bind() { return this; },
    async first() {
      counters.controlReads += 1;
      return typeof firstValue === 'function' ? firstValue() : firstValue;
    },
    async run() {
      counters.controlWrites += 1;
      throw new Error(`unexpected_${kind}_write`);
    },
  };
}

function controlDb(counters) {
  return {
    prepare(sql) {
      const text = String(sql);
      if (text.includes('FROM user_global_roles')) {
        return statement({ ok:1 }, counters, 'permission');
      }
      if (text.includes('FROM stores')) {
        return statement({
          store_id:'store-dev-01',
          store_code:'DEV01',
          display_name:'Development Store',
          marketplace_code:'US',
          amazon_region:'NA',
          d1_binding_key:'STORE_01_DB',
          status:'active',
        }, counters, 'store_route');
      }
      counters.controlWrites += 1;
      throw new Error(`unexpected_control_sql:${text}`);
    },
  };
}

async function rejectWithoutDurableSideEffects(datasets, expectedError) {
  const counters = {
    controlReads:0,
    controlWrites:0,
    storeDbCalls:0,
    workflowCalls:0,
  };

  const storeDb = {
    prepare(sql) {
      counters.storeDbCalls += 1;
      throw new Error(`store_db_must_not_be_touched:${String(sql)}`);
    },
  };
  const workflow = {
    async createBatch() {
      counters.workflowCalls += 1;
      throw new Error('workflow_must_not_be_touched');
    },
    async get() {
      counters.workflowCalls += 1;
      throw new Error('workflow_must_not_be_touched');
    },
  };

  const request = new Request('https://example.test/api/v1/stores/store-dev-01/sync', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'idempotency-key':'phase5-entry-guard-001',
    },
    body:JSON.stringify({
      startDate:'2026-08-15',
      endDate:'2026-08-15',
      datasets,
    }),
  });

  const response = await handleSyncApiRoute({
    request,
    actor:{ user_id:'user-dev-owner' },
    env:{
      CONTROL_DB:controlDb(counters),
      STORE_01_DB:storeDb,
      AMAZON_SYNC_WORKFLOW:workflow,
      SYNC_TRIGGER_ENABLED:'true',
    },
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, expectedError);
  assert.equal(counters.controlReads, 2, 'permission and store route may be read before capability rejection');
  assert.equal(counters.controlWrites, 0, 'capability rejection must not create audit or other Control D1 writes');
  assert.equal(counters.storeDbCalls, 0, 'capability rejection must precede sync_runs registration');
  assert.equal(counters.workflowCalls, 0, 'capability rejection must precede Workflow creation/status calls');
}

await rejectWithoutDurableSideEffects(
  ['campaign_daily'],
  'PRODUCER_DATASET_NOT_IMPLEMENTED:campaign_daily',
);
await rejectWithoutDurableSideEffects(
  ['search_term_daily', 'placement_daily'],
  'PRODUCER_DATASET_NOT_IMPLEMENTED:placement_daily',
);

console.log(JSON.stringify({
  ok:true,
  phase:'5',
  contract:'sync-api-producer-capability-entry-guard-v1',
  implementedEntryDataset:'search_term_daily',
  unsupportedDatasetStatus:400,
  storeD1WritesBeforeRejection:0,
  workflowCallsBeforeRejection:0,
}, null, 2));
