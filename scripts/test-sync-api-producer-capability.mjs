import assert from 'node:assert/strict';
import { handleSyncApiRoute } from '../cloudflare/runtime/sync-api.js';

const PERMIT_ID = 'phase5.store01.search-term.2026-08-15.seller.v1';
const REPORT_DATE = '2026-08-15';

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

function harness() {
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
  return { counters, storeDb, workflow };
}

async function rejectWithoutDurableSideEffects({
  datasets = ['search_term_daily'],
  startDate = REPORT_DATE,
  endDate = startDate,
  idempotencyKey = PERMIT_ID,
  envOverrides = {},
  expectedError,
  expectedStatus,
  expectedControlReads = 2,
}) {
  const { counters, storeDb, workflow } = harness();
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/sync', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'idempotency-key':idempotencyKey,
    },
    body:JSON.stringify({ startDate, endDate, datasets }),
  });

  const response = await handleSyncApiRoute({
    request,
    actor:{ user_id:'user-dev-owner' },
    env:{
      APP_ENV:'development',
      CONTROL_DB:controlDb(counters),
      STORE_01_DB:storeDb,
      AMAZON_SYNC_WORKFLOW:workflow,
      SYNC_TRIGGER_ENABLED:'true',
      PHASE5_SINGLE_RUN_PERMIT_ID:PERMIT_ID,
      PHASE5_SINGLE_RUN_REPORT_DATE:REPORT_DATE,
      ...envOverrides,
    },
  });
  const body = await response.json();

  assert.equal(response.status, expectedStatus);
  assert.equal(body.error, expectedError);
  assert.equal(counters.controlReads, expectedControlReads);
  assert.equal(counters.controlWrites, 0, 'rejection must not create audit or other Control D1 writes');
  assert.equal(counters.storeDbCalls, 0, 'rejection must precede sync_runs registration');
  assert.equal(counters.workflowCalls, 0, 'rejection must precede Workflow creation/status calls');
}

await rejectWithoutDurableSideEffects({
  datasets:['campaign_daily'],
  expectedError:'PRODUCER_DATASET_NOT_IMPLEMENTED:campaign_daily',
  expectedStatus:400,
});
await rejectWithoutDurableSideEffects({
  datasets:['search_term_daily', 'placement_daily'],
  expectedError:'PRODUCER_DATASET_NOT_IMPLEMENTED:placement_daily',
  expectedStatus:400,
});
await rejectWithoutDurableSideEffects({
  envOverrides:{
    PHASE5_SINGLE_RUN_PERMIT_ID:'',
    PHASE5_SINGLE_RUN_REPORT_DATE:'',
  },
  expectedError:'phase5_single_run_permit_missing',
  expectedStatus:503,
  expectedControlReads:1,
});
await rejectWithoutDurableSideEffects({
  idempotencyKey:'phase5.store01.search-term.2026-08-15.vendor.v1',
  expectedError:'phase5_single_run_permit_mismatch',
  expectedStatus:409,
});
await rejectWithoutDurableSideEffects({
  startDate:'2026-08-14',
  endDate:'2026-08-14',
  expectedError:'phase5_single_run_intent_mismatch',
  expectedStatus:409,
});

console.log(JSON.stringify({
  ok:true,
  phase:'5',
  contract:'sync-api-producer-capability-entry-guard-v2',
  implementedEntryDataset:'search_term_daily',
  unsupportedDatasetStatus:400,
  exactSingleRunPermit:true,
  missingPermitStatus:503,
  permitMismatchStatus:409,
  intentMismatchStatus:409,
  storeD1WritesBeforeRejection:0,
  workflowCallsBeforeRejection:0,
}, null, 2));
