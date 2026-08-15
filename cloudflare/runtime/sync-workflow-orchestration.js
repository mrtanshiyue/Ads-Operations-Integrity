import {
  normalizeWorkflowIntent,
  computeSyncIntentFingerprint,
  assertWorkflowRunReceipt,
} from './sync-intent-contract.js';

export async function prepareWorkflowExecution({ eventInstanceId, payload, repository }) {
  const instanceId = String(eventInstanceId ?? '').trim();
  if (!instanceId) throw Object.assign(new Error('WORKFLOW_INSTANCE_ID_REQUIRED'), { code: 'WORKFLOW_INSTANCE_ID_REQUIRED' });
  const intent = normalizeWorkflowIntent(payload);
  const intentFingerprint = await computeSyncIntentFingerprint(intent);
  const run = await repository.loadRun(instanceId);
  const profileStage = assertWorkflowRunReceipt({ run, eventInstanceId: instanceId, intent, intentFingerprint });
  return Object.freeze({ instanceId, intent, intentFingerprint, run, profileStage });
}
