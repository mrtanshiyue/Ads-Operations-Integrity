export function canFinalizeConfirmedAmazonMutation({ receipt, verification, plan } = {}) {
  const receiptExecutionFingerprint = text(receipt?.executionFingerprint || receipt?.execution_fingerprint);
  const verificationExpected = text(verification?.expectedFingerprint || verification?.expected_fingerprint);
  const verificationObserved = text(verification?.observedFingerprint || verification?.observed_fingerprint);
  const executionFingerprint = text(plan?.executionFingerprint);
  const targetFingerprint = text(plan?.targetFingerprint);
  const transportOutcome = text(receipt?.transportOutcome || receipt?.transport_outcome);
  const verificationResult = text(verification?.result);

  const checks = Object.freeze({
    planValid: plan?.valid === true,
    transportAccepted: transportOutcome === 'accepted',
    executionFingerprintMatches: Boolean(executionFingerprint) && receiptExecutionFingerprint === executionFingerprint,
    readbackConfirmed: verificationResult === 'confirmed',
    expectedTargetFingerprintMatches: Boolean(targetFingerprint) && verificationExpected === targetFingerprint,
    observedTargetFingerprintMatches: Boolean(targetFingerprint) && verificationObserved === targetFingerprint,
  });
  return Object.freeze({
    allowed: Object.values(checks).every(Boolean),
    checks,
    blindRetryAuthorized: false,
    networkDispatchAuthorized: false,
  });
}

export function determineAmazonExecutionReconciliation({ receipt, verification, plan } = {}) {
  const transportOutcome = text(receipt?.transportOutcome || receipt?.transport_outcome);
  const retryDisposition = text(receipt?.retryDisposition || receipt?.retry_disposition);
  const verificationResult = text(verification?.result);

  if (transportOutcome === 'rejected') {
    return decision('failed_terminal', 'failed', 'amazon_mutation_rejected');
  }
  if (retryDisposition === 'readback_required' && !verificationResult) {
    return decision('awaiting_readback', 'applying', 'readback_required');
  }
  if (verificationResult === 'not_found' || verificationResult === 'unknown') {
    return decision('readback_unresolved', 'applying', `readback_${verificationResult}`);
  }
  if (verificationResult === 'mismatch') {
    return decision('failed_terminal', 'failed', 'readback_mismatch');
  }
  const finalization = canFinalizeConfirmedAmazonMutation({ receipt, verification, plan });
  if (verificationResult === 'confirmed' && finalization.allowed) {
    return Object.freeze({
      ...decision('confirmed_applied', 'applied', 'amazon_readback_confirmed'),
      finalization,
    });
  }
  return Object.freeze({
    ...decision('readback_unresolved', 'applying', 'finalization_gate_not_satisfied'),
    finalization,
  });
}

export async function finalizeAmazonExecutionAction({ db, actorId, actionId, receipt, verification, plan, now = new Date() } = {}) {
  if (!db || !text(actorId) || !text(actionId)) {
    return Object.freeze({ updated: false, error: 'finalization_context_required', networkDispatchAuthorized: false });
  }
  const reconciliation = determineAmazonExecutionReconciliation({ receipt, verification, plan });
  if (!['applied', 'failed'].includes(reconciliation.actionStatus)) {
    return Object.freeze({ updated: false, reconciliation, networkDispatchAuthorized: false });
  }
  const timestamp = normalizeTime(now);
  if (!timestamp) return Object.freeze({ updated: false, error: 'invalid_finalization_clock', reconciliation, networkDispatchAuthorized: false });
  const externalRequestId = text(receipt?.amazonRequestId || receipt?.amazon_request_id) || null;
  const update = reconciliation.actionStatus === 'applied'
    ? db.prepare(`UPDATE optimization_actions SET status='applied', external_request_id=?2, applied_at=?3, updated_at=?3 WHERE action_id=?1 AND status='applying'`).bind(actionId, externalRequestId, timestamp)
    : db.prepare(`UPDATE optimization_actions SET status='failed', external_request_id=COALESCE(external_request_id,?2), updated_at=?3 WHERE action_id=?1 AND status='applying'`).bind(actionId, externalRequestId, timestamp);
  const event = db.prepare(`INSERT INTO optimization_action_events(event_id,action_id,event_type,actor_id,details_json,occurred_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(
    `evt_${crypto.randomUUID()}`,
    actionId,
    reconciliation.actionStatus === 'applied' ? 'action.applied' : 'action.execution_failed',
    actorId,
    JSON.stringify({
      schemaVersion: 'optimization-action-execution-reconciliation-v1',
      receiptId: text(receipt?.receiptId || receipt?.receipt_id) || null,
      verificationId: text(verification?.verificationId || verification?.verification_id) || null,
      disposition: reconciliation.disposition,
      reason: reconciliation.reason,
      blindRetryAuthorized: false,
    }),
    timestamp,
  );
  const results = await db.batch([update, event]);
  if (changedRows(results?.[0]) !== 1) {
    return Object.freeze({ updated: false, error: 'action_finalization_transition_conflict', reconciliation, networkDispatchAuthorized: false });
  }
  return Object.freeze({ updated: true, actionStatus: reconciliation.actionStatus, reconciliation, networkDispatchAuthorized: false });
}

function decision(disposition, actionStatus, reason) {
  return Object.freeze({
    disposition,
    actionStatus,
    reason,
    blindRetryAuthorized: false,
    networkDispatchAuthorized: false,
  });
}
function text(value) { return String(value ?? '').trim(); }
function changedRows(result) { return Number(result?.meta?.changes ?? result?.changes ?? 0); }
function normalizeTime(value) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }
