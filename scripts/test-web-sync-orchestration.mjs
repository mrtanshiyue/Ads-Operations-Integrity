import assert from 'node:assert/strict';
import { buildManualSyncRegistration } from '../cloudflare/runtime/sync-intent-contract.js';
import { registerAndTriggerSync } from '../cloudflare/runtime/web-sync-orchestration.js';

class FakeRepository {
  constructor() { this.runs = new Map(); }
  async insertQueuedRun(input) {
    if (!this.runs.has(input.runId)) {
      this.runs.set(input.runId, {
        run_id: input.runId,
        profile_id: null,
        trigger_type: input.triggerType,
        scope_key: input.scopeKey,
        status: 'queued',
        requested_by: input.requestedBy,
        intent_fingerprint: input.intentFingerprint,
      });
    }
  }
  async loadRun(id) { return this.runs.get(id) || null; }
}

function instance(status = 'queued') {
  return { id: 'unused', async status() { return { status }; } };
}

async function registration(key = 'client-key-1000', endDate = '2026-08-12') {
  return buildManualSyncRegistration({
    storeId: 'store-dev-01', actorUserId: 'user-dev-owner', idempotencyKey: key,
    requestBody: { startDate: '2026-08-01', endDate, datasets: ['search_term_daily'] },
  });
}

{
  const repo = new FakeRepository();
  let createCalls = 0;
  const wf = {
    async createBatch() { createCalls++; return [instance('queued')]; },
    async get() { throw new Error('not found'); },
  };
  const out = await registerAndTriggerSync({ registration: await registration(), repository: repo, workflow: wf });
  assert.equal(out.reused, false);
  assert.equal(createCalls, 1);
  assert.equal(repo.runs.get(out.instanceId).status, 'queued');
}

{
  const repo = new FakeRepository();
  const reg = await registration('client-key-1001');
  await repo.insertQueuedRun({
    runId: reg.instanceId, triggerType: reg.intent.triggerType, scopeKey: reg.scopeKey,
    requestedBy: reg.actorUserId, intentFingerprint: reg.intentFingerprint,
  });
  let createCalls = 0;
  const wf = {
    async createBatch() { createCalls++; return [instance('queued')]; },
    async get() { throw new Error('not found'); },
  };
  await registerAndTriggerSync({ registration: reg, repository: repo, workflow: wf });
  assert.equal(createCalls, 1);
}

{
  const repo = new FakeRepository();
  const reg = await registration('client-key-1002');
  const wf = {
    async createBatch() { return []; },
    async get() { return instance('running'); },
  };
  const out = await registerAndTriggerSync({ registration: reg, repository: repo, workflow: wf });
  assert.equal(out.reused, true);
  assert.equal(out.triggerDecision, 'SKIPPED_EXISTING');
  assert.equal(out.workflow.status, 'running');
}

{
  const repo = new FakeRepository();
  const reg = await registration('client-key-1003');
  const wf = {
    async createBatch() { throw new Error('network response lost'); },
    async get() { return instance('running'); },
  };
  const out = await registerAndTriggerSync({ registration: reg, repository: repo, workflow: wf });
  assert.equal(out.triggerDecision, 'AMBIGUOUS_CREATE_RECOVERED_BY_GET');
  assert.equal(repo.runs.get(reg.instanceId).status, 'queued');
}

{
  const repo = new FakeRepository();
  const reg = await registration('client-key-1004');
  const wf = {
    async createBatch() { throw new Error('network response lost'); },
    async get() { throw new Error('unknown'); },
  };
  try {
    await registerAndTriggerSync({ registration: reg, repository: repo, workflow: wf });
    assert.fail('expected receipt-unavailable failure');
  } catch (error) {
    assert.equal(error.code, 'WORKFLOW_TRIGGER_RECEIPT_UNAVAILABLE');
  }
  assert.equal(repo.runs.get(reg.instanceId).status, 'queued');
}

{
  const repo = new FakeRepository();
  const regA = await registration('client-key-1005', '2026-08-12');
  const regB = await registration('client-key-1005', '2026-08-13');
  await repo.insertQueuedRun({
    runId: regA.instanceId, triggerType: regA.intent.triggerType, scopeKey: regA.scopeKey,
    requestedBy: regA.actorUserId, intentFingerprint: regA.intentFingerprint,
  });
  let createCalls = 0;
  const wf = { async createBatch() { createCalls++; return []; }, async get() { throw new Error('none'); } };
  try {
    await registerAndTriggerSync({ registration: regB, repository: repo, workflow: wf });
    assert.fail('expected idempotency conflict');
  } catch (error) {
    assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSE_CONFLICT');
  }
  assert.equal(createCalls, 0);
}

{
  const repo = new FakeRepository();
  const reg = await registration('client-key-1006');
  await repo.insertQueuedRun({
    runId: reg.instanceId, triggerType: reg.intent.triggerType, scopeKey: reg.scopeKey,
    requestedBy: reg.actorUserId, intentFingerprint: reg.intentFingerprint,
  });
  repo.runs.get(reg.instanceId).status = 'running';
  repo.runs.get(reg.instanceId).profile_id = 'p1';
  let createCalls = 0;
  const wf = { async createBatch() { createCalls++; return []; }, async get() { return instance('running'); } };
  const out = await registerAndTriggerSync({ registration: reg, repository: repo, workflow: wf });
  assert.equal(out.triggerDecision, 'REUSE_RUNNING');
  assert.equal(createCalls, 0);
}

console.log(JSON.stringify({ ok: true, crashRetryMatrix: true, createBatchIdempotency: true, noSyntheticFailureReceipt: true }, null, 2));
