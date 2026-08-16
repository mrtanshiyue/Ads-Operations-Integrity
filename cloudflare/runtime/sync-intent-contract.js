const ALLOWED_DATASETS = new Set([
  'campaign_daily',
  'ad_group_daily',
  'keyword_daily',
  'target_daily',
  'search_term_daily',
  'advertised_product_daily',
  'purchased_product_daily',
  'placement_daily',
]);

const ALLOWED_TRIGGER_TYPES = new Set(['scheduled', 'manual', 'recovery', 'backfill']);

export class ContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ContractError';
    this.code = code;
  }
}

export function normalizeClientIdempotencyKey(value) {
  const key = String(value ?? '').trim();
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ContractError('IDEMPOTENCY_KEY_INVALID');
  }
  return key;
}

export function normalizeWorkflowIntent(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (Object.prototype.hasOwnProperty.call(body, 'profileId')) {
    throw new ContractError('CALLER_PROFILE_AUTHORITY_REMOVED');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'reportConfigVersion')) {
    throw new ContractError('CALLER_REPORT_CONFIG_AUTHORITY_REMOVED');
  }

  const storeId = requiredText(body.storeId, 'STORE_ID');
  const startDate = isoDate(body.startDate, 'START_DATE');
  const endDate = isoDate(body.endDate, 'END_DATE');
  if (endDate < startDate) throw new ContractError('SYNC_DATE_RANGE_INVALID');

  const triggerType = String(body.triggerType ?? 'manual').trim().toLowerCase();
  if (!ALLOWED_TRIGGER_TYPES.has(triggerType)) throw new ContractError('SYNC_TRIGGER_TYPE_INVALID');

  const datasets = [...new Set((Array.isArray(body.datasets) ? body.datasets : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))].sort();
  if (!datasets.length) throw new ContractError('SYNC_DATASETS_REQUIRED');
  for (const dataset of datasets) {
    if (!ALLOWED_DATASETS.has(dataset)) throw new ContractError(`SYNC_DATASET_NOT_ALLOWED:${dataset}`);
  }

  return Object.freeze({ storeId, startDate, endDate, datasets: Object.freeze(datasets), triggerType });
}

export async function computeSyncIntentFingerprint(intent) {
  const normalized = normalizeWorkflowIntent(intent);
  return sha256Hex(JSON.stringify([
    'sync-intent-v1',
    normalized.storeId,
    normalized.startDate,
    normalized.endDate,
    normalized.datasets,
    normalized.triggerType,
  ]));
}

export async function computeSyncInstanceId({ storeId, actorUserId, idempotencyKey }) {
  const canonicalStoreId = requiredText(storeId, 'STORE_ID');
  const canonicalActorUserId = requiredText(actorUserId, 'ACTOR_USER_ID');
  const canonicalKey = normalizeClientIdempotencyKey(idempotencyKey);
  const digest = await sha256Hex(JSON.stringify([
    'sync-instance-v1',
    canonicalStoreId,
    canonicalActorUserId,
    canonicalKey,
  ]));
  return `sync-${digest}`;
}

export function assertIntentReceipt(existingFingerprint, requestedFingerprint) {
  const existing = String(existingFingerprint ?? '').trim();
  const requested = String(requestedFingerprint ?? '').trim();
  if (!requested) throw new ContractError('INTENT_FINGERPRINT_REQUIRED');
  if (!existing) throw new ContractError('IDEMPOTENCY_RECEIPT_UNVERIFIABLE');
  if (existing !== requested) throw new ContractError('IDEMPOTENCY_KEY_REUSE_CONFLICT');
  return true;
}

export async function buildManualSyncRegistration({ storeId, actorUserId, idempotencyKey, requestBody }) {
  const intent = normalizeWorkflowIntent({
    ...(requestBody && typeof requestBody === 'object' ? requestBody : {}),
    storeId,
    triggerType: 'manual',
  });
  const instanceId = await computeSyncInstanceId({ storeId: intent.storeId, actorUserId, idempotencyKey });
  const intentFingerprint = await computeSyncIntentFingerprint(intent);
  return Object.freeze({
    instanceId,
    intentFingerprint,
    scopeKey: `ads:${intent.datasets.join(',')}:${intent.startDate}:${intent.endDate}`,
    actorUserId: requiredText(actorUserId, 'ACTOR_USER_ID'),
    intent,
    workflowParams: Object.freeze({
      storeId: intent.storeId,
      startDate: intent.startDate,
      endDate: intent.endDate,
      datasets: intent.datasets,
      triggerType: intent.triggerType,
    }),
  });
}

export function assertSyncRunReceipt(run, registration) {
  if (!run) throw new ContractError('SYNC_RUN_RECEIPT_MISSING');
  if (run.run_id !== registration.instanceId) throw new ContractError('SYNC_RUN_ID_MISMATCH');
  if (run.requested_by !== registration.actorUserId) throw new ContractError('SYNC_RUN_ACTOR_MISMATCH');
  if (run.trigger_type !== registration.intent.triggerType) throw new ContractError('SYNC_RUN_TRIGGER_TYPE_MISMATCH');
  assertIntentReceipt(run.intent_fingerprint, registration.intentFingerprint);
  const status = String(run.status || '');
  if (status === 'queued') {
    if (run.profile_id != null) throw new ContractError('SYNC_QUEUED_PROFILE_RECEIPT_INVALID');
    return 'CREATE_BATCH_IDEMPOTENT';
  }
  if (status === 'running') {
    if (!run.profile_id) throw new ContractError('SYNC_RUNNING_PROFILE_RECEIPT_MISSING');
    return 'REUSE_RUNNING';
  }
  if (['succeeded','partial','failed','cancelled'].includes(status)) return 'REUSE_TERMINAL';
  throw new ContractError('SYNC_RUN_STATUS_INVALID');
}

export function assertWorkflowRunReceipt({ run, eventInstanceId, intent, intentFingerprint }) {
  if (!run) throw new ContractError('SYNC_RUN_RECEIPT_MISSING');
  if (run.run_id !== eventInstanceId) throw new ContractError('SYNC_RUN_ID_MISMATCH');
  if (run.trigger_type !== intent.triggerType) throw new ContractError('SYNC_RUN_TRIGGER_TYPE_MISMATCH');
  assertIntentReceipt(run.intent_fingerprint, intentFingerprint);
  const status = String(run.status || '');
  if (status === 'queued') {
    if (run.profile_id != null) throw new ContractError('SYNC_QUEUED_PROFILE_RECEIPT_INVALID');
    return 'RESOLVE_CANONICAL_PROFILE';
  }
  if (status === 'running') {
    if (!run.profile_id) throw new ContractError('SYNC_RUNNING_PROFILE_RECEIPT_MISSING');
    return 'REUSE_CANONICAL_PROFILE';
  }
  if (['succeeded','partial','failed','cancelled'].includes(status)) return 'REUSE_TERMINAL';
  throw new ContractError('SYNC_RUN_STATUS_INVALID');
}

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new ContractError(`${field}_REQUIRED`);
  if (text.length > 200) throw new ContractError(`${field}_TOO_LONG`);
  return text;
}

function isoDate(value, field) {
  const text = requiredText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ContractError(`${field}_INVALID`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new ContractError(`${field}_INVALID`);
  }
  return text;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
