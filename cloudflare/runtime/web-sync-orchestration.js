import { assertSyncRunReceipt } from './sync-intent-contract.js';

export class WebSyncOrchestrationError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'WebSyncOrchestrationError';
    this.code = code;
    this.cause = cause;
  }
}

export async function registerAndTriggerSync({ registration, repository, workflow }) {
  await repository.insertQueuedRun({
    runId: registration.instanceId,
    triggerType: registration.intent.triggerType,
    scopeKey: registration.scopeKey,
    requestedBy: registration.actorUserId,
    intentFingerprint: registration.intentFingerprint,
  });

  const run = await repository.loadRun(registration.instanceId);
  const decision = assertSyncRunReceipt(run, registration);

  if (decision === 'REUSE_TERMINAL') {
    return {
      instanceId: registration.instanceId,
      reused: true,
      durableRun: run,
      workflow: await getWorkflowStatusSafe(workflow, registration.instanceId),
      triggerDecision: decision,
    };
  }

  if (decision === 'REUSE_RUNNING') {
    return {
      instanceId: registration.instanceId,
      reused: true,
      durableRun: run,
      workflow: await getWorkflowStatusSafe(workflow, registration.instanceId),
      triggerDecision: decision,
    };
  }

  if (decision !== 'CREATE_BATCH_IDEMPOTENT') {
    throw new WebSyncOrchestrationError('SYNC_TRIGGER_DECISION_INVALID');
  }

  try {
    const created = await workflow.createBatch([{
      id: registration.instanceId,
      params: registration.workflowParams,
    }]);
    if (!Array.isArray(created) || created.length > 1) {
      throw new WebSyncOrchestrationError('WORKFLOW_CREATE_BATCH_RESULT_INVALID');
    }

    if (created.length === 1) {
      const instance = created[0];
      const status = await instance.status();
      return {
        instanceId: registration.instanceId,
        reused: false,
        durableRun: run,
        workflow: publicWorkflowStatus(status),
        triggerDecision: 'CREATED',
      };
    }

    return {
      instanceId: registration.instanceId,
      reused: true,
      durableRun: run,
      workflow: await getWorkflowStatusSafe(workflow, registration.instanceId),
      triggerDecision: 'SKIPPED_EXISTING',
    };
  } catch (error) {
    if (error?.code === 'WORKFLOW_CREATE_BATCH_RESULT_INVALID') throw error;
    const existing = await getWorkflowStatusSafe(workflow, registration.instanceId);
    if (existing.status !== 'unknown') {
      return {
        instanceId: registration.instanceId,
        reused: true,
        durableRun: run,
        workflow: existing,
        triggerDecision: 'AMBIGUOUS_CREATE_RECOVERED_BY_GET',
      };
    }
    throw new WebSyncOrchestrationError('WORKFLOW_TRIGGER_RECEIPT_UNAVAILABLE', error);
  }
}

async function getWorkflowStatusSafe(workflow, instanceId) {
  try {
    const instance = await workflow.get(instanceId);
    return publicWorkflowStatus(await instance.status());
  } catch {
    return { status: 'unknown', hasError: false, rollbackOutcome: null };
  }
}

function publicWorkflowStatus(status) {
  return {
    status: String(status?.status || 'unknown'),
    hasError: Boolean(status?.error),
    rollbackOutcome: status?.rollback?.outcome || null,
  };
}
