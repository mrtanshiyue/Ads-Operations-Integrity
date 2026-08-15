import assert from 'node:assert/strict';
import { computeSyncIntentFingerprint, normalizeWorkflowIntent } from '../cloudflare/runtime/sync-intent-contract.js';
import { prepareWorkflowExecution } from '../cloudflare/runtime/sync-workflow-orchestration.js';

const payload = { storeId:'store-dev-01', startDate:'2026-08-01', endDate:'2026-08-12', datasets:['search_term_daily'], triggerType:'manual' };
const intent = normalizeWorkflowIntent(payload);
const fp = await computeSyncIntentFingerprint(intent);
const id = 'sync-test';

async function runWith(row) {
  return prepareWorkflowExecution({ eventInstanceId:id, payload, repository:{ async loadRun(){ return row; } } });
}

assert.equal((await runWith({ run_id:id, profile_id:null, trigger_type:'manual', status:'queued', intent_fingerprint:fp })).profileStage, 'RESOLVE_CANONICAL_PROFILE');
assert.equal((await runWith({ run_id:id, profile_id:'p1', trigger_type:'manual', status:'running', intent_fingerprint:fp })).profileStage, 'REUSE_CANONICAL_PROFILE');
assert.equal((await runWith({ run_id:id, profile_id:'p1', trigger_type:'manual', status:'succeeded', intent_fingerprint:fp })).profileStage, 'REUSE_TERMINAL');

for (const [row, code] of [
  [{ run_id:id, profile_id:'p1', trigger_type:'manual', status:'queued', intent_fingerprint:fp }, 'SYNC_QUEUED_PROFILE_RECEIPT_INVALID'],
  [{ run_id:id, profile_id:null, trigger_type:'manual', status:'running', intent_fingerprint:fp }, 'SYNC_RUNNING_PROFILE_RECEIPT_MISSING'],
  [{ run_id:id, profile_id:null, trigger_type:'manual', status:'queued', intent_fingerprint:'wrong' }, 'IDEMPOTENCY_KEY_REUSE_CONFLICT'],
]) {
  try { await runWith(row); assert.fail(`expected ${code}`); } catch (e) { assert.equal(e.code, code); }
}

console.log(JSON.stringify({ ok:true, durableReceiptFirst:true, canonicalProfileRecovery:true }, null, 2));
