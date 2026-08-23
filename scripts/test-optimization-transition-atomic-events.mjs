import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleOptimizationActionsApiRoute } from '../cloudflare/runtime/optimization-actions-api-core.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/optimization-actions-api-core.js'), 'utf8');
assert.match(coreSource, /store_d1_atomic_batch_required/);
assert.ok((coreSource.match(/WHERE changes\(\)=1/g) || []).length >= 2,
  'approve/reject transition events must be gated by the preceding status mutation');
assert.match(coreSource, /executeStoreBatch\(db, \[/);

const actor = { user_id: 'operator-01' };
const storeId = 'store-01';
const actionId = 'act-transition-01';
const now = '2026-08-23 10:00:00';

function actionRow(status = 'proposed') {
  return {
    action_id: actionId,
    idempotency_key: 'idem-transition-01',
    profile_id: 'profile-01',
    entity_type: 'search_term',
    entity_id: 'row-01',
    action_type: 'negative_keyword.create',
    source_type: 'rule',
    rule_key: 'rule-01',
    before_json: '{}',
    proposed_json: '{"keywordText":"free","matchType":"EXACT"}',
    rationale_json: '{}',
    status,
    created_by: 'creator-01',
    approved_by: null,
    external_request_id: null,
    applied_at: null,
    created_at: now,
    updated_at: now,
  };
}

function createControlDb() {
  const state = { audits: [] };
  return {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM user_global_roles ugr')) return { ok: 1 };
              if (sql.includes('FROM stores')) {
                return { store_id: storeId, d1_binding_key: 'STORE_01_DB', status: 'active' };
              }
              if (sql.includes('FROM store_members sm')) return null;
              throw new Error(`unexpected control first query: ${sql}`);
            },
            async run() {
              if (!sql.includes('INSERT INTO audit_log')) throw new Error(`unexpected control run query: ${sql}`);
              state.audits.push({ action: params[3], entityId: params[4] });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

function createStoreDb({ status = 'proposed', failEvent = false, withBatch = true } = {}) {
  const state = {
    action: actionRow(status),
    events: [],
    failEvent,
    lastChanges: 0,
    batchCalls: 0,
  };

  const db = {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM optimization_actions') && sql.includes('WHERE action_id=?1')) {
                return params[0] === actionId ? { ...state.action } : null;
              }
              throw new Error(`unexpected store first query: ${sql}`);
            },
            async run() {
              if (sql.includes('UPDATE optimization_actions')) {
                if (params[0] !== actionId || state.action.status !== 'proposed') {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                const approved = sql.includes("status='approved'");
                state.action = {
                  ...state.action,
                  status: approved ? 'approved' : 'rejected',
                  approved_by: approved ? params[1] : state.action.approved_by,
                  updated_at: now,
                };
                state.lastChanges = 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO optimization_action_events')) {
                if (sql.includes('WHERE changes()=1') && state.lastChanges !== 1) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                if (state.failEvent) throw new Error('synthetic_transition_event_failure');
                state.events.push({
                  eventId: params[0],
                  actionId: params[1],
                  eventType: sql.includes("'action.approved'") ? 'action.approved' : 'action.rejected',
                  actorId: params[2],
                  details: JSON.parse(params[3]),
                });
                state.lastChanges = 1;
                return { success: true, meta: { changes: 1 } };
              }
              throw new Error(`unexpected store run query: ${sql}`);
            },
          };
        },
      };
    },
  };

  if (withBatch) {
    db.batch = async (statements) => {
      state.batchCalls += 1;
      const snapshot = {
        action: { ...state.action },
        events: state.events.map((entry) => ({ ...entry, details: { ...entry.details } })),
        lastChanges: state.lastChanges,
      };
      state.lastChanges = 0;
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      } catch (error) {
        state.action = snapshot.action;
        state.events = snapshot.events;
        state.lastChanges = snapshot.lastChanges;
        throw error;
      }
    };
  }

  return db;
}

function transitionRequest(kind, body = {}) {
  const url = `https://example.test/api/v1/stores/${storeId}/optimization-actions/${actionId}/${kind}`;
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-ray': `ray-${kind}` },
    body: JSON.stringify(body),
  });
}

async function route({ kind, body, storeDb, controlDb = createControlDb() }) {
  const request = transitionRequest(kind, body);
  const response = await handleOptimizationActionsApiRoute({
    request,
    env: { CONTROL_DB: controlDb, STORE_01_DB: storeDb },
    actor,
    url: new URL(request.url),
  });
  return { response, controlDb };
}

for (const testCase of [
  { kind: 'reject', body: { reason: 'not relevant' }, expectedStatus: 'rejected', expectedEvent: 'action.rejected' },
  { kind: 'approve', body: { note: 'governance reviewed' }, expectedStatus: 'approved', expectedEvent: 'action.approved' },
]) {
  const storeDb = createStoreDb();
  const { response, controlDb } = await route({ ...testCase, storeDb });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.action.status, testCase.expectedStatus);
  assert.equal(payload.execution.amazonMutationAuthorized, false);
  assert.equal(storeDb.state.action.status, testCase.expectedStatus);
  assert.equal(storeDb.state.events.length, 1);
  assert.equal(storeDb.state.events[0].eventType, testCase.expectedEvent);
  assert.equal(storeDb.state.batchCalls, 1);
  assert.equal(controlDb.state.audits.length, 1);
}

for (const testCase of [
  { kind: 'reject', body: { reason: 'event must persist atomically' } },
  { kind: 'approve', body: { note: 'event must persist atomically' } },
]) {
  const storeDb = createStoreDb({ failEvent: true });
  const controlDb = createControlDb();
  await assert.rejects(route({ ...testCase, storeDb, controlDb }), /synthetic_transition_event_failure/);
  assert.equal(storeDb.state.action.status, 'proposed');
  assert.equal(storeDb.state.events.length, 0);
  assert.equal(storeDb.state.batchCalls, 1);
  assert.equal(controlDb.state.audits.length, 0);
}

const conflictDb = createStoreDb({ status: 'approved' });
const conflict = await route({ kind: 'reject', body: { reason: 'too late' }, storeDb: conflictDb });
assert.equal(conflict.response.status, 409);
const conflictPayload = await conflict.response.json();
assert.equal(conflictPayload.error, 'action_transition_conflict');
assert.equal(conflictPayload.currentStatus, 'approved');
assert.equal(conflictDb.state.events.length, 0);
assert.equal(conflictDb.state.batchCalls, 1);
assert.equal(conflict.controlDb.state.audits.length, 0);

const noBatchDb = createStoreDb({ withBatch: false });
const noBatchControl = createControlDb();
await assert.rejects(
  route({ kind: 'reject', body: { reason: 'atomic storage required' }, storeDb: noBatchDb, controlDb: noBatchControl }),
  /store_d1_atomic_batch_required/,
);
assert.equal(noBatchDb.state.action.status, 'proposed');
assert.equal(noBatchDb.state.events.length, 0);
assert.equal(noBatchControl.state.audits.length, 0);

console.log(JSON.stringify({
  ok: true,
  contract: 'optimization-transition-atomic-events-v1',
  storeD1Atomic: ['reject-status+event', 'approve-status+event'],
  eventFailureRollback: true,
  zeroRowEventSuppressed: true,
  atomicBatchRequired: true,
  controlAuditTransactionDomain: 'separate-control-d1',
  amazonMutationAttempted: false,
  amazonMutationAuthorized: false,
}, null, 2));
