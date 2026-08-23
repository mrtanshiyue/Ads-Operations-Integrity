import {
  SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
  SEARCH_TERM_MODEL_VERSION,
  SEARCH_TERM_RULE_VERSION,
  buildRecommendationAuthority,
  deterministicFingerprint,
} from './decision-intelligence.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const ACTION_STATUSES = new Set(['proposed', 'approved', 'rejected', 'applying', 'applied', 'failed', 'reverted']);
const ACTION_TYPES = new Set(['negative_keyword.create', 'keyword.create']);
const ENTITY_TYPES = new Set(['search_term']);
const SOURCE_TYPES = new Set(['rule', 'model']);
const CONFIDENCE_BANDS = new Set(['high', 'medium', 'low']);
const FRESHNESS_STATES = new Set(['fresh', 'aging', 'stale', 'unknown']);
const AUTHORITY_FILTERS = new Set(['authoritative', 'non-authoritative']);
const SORT_MODES = new Set(['newest', 'actionable', 'risk']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const BODY_LIMIT = 48 * 1024;
const MAX_REASON = 600;

export async function handleOptimizationActionsApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/optimization-actions(?:\/([^/]+))?(?:\/(reject|approve|apply|revert))?$/);
  if (!match) return null;

  const storeId = safeDecode(match[1]);
  const actionId = match[2] ? safeDecode(match[2]) : null;
  const transition = match[3] || null;
  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  if (match[2] && !actionId) return json(request, { error: 'invalid_action_id' }, 400);

  const method = request.method.toUpperCase();
  const permission = method === 'GET' ? 'ads.read' : 'ads.write';
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, permission);
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  if (method === 'GET' && !actionId) return listActions(request, route.storeDb, url, storeId);
  if (method === 'GET' && actionId && !transition) {
    const canWrite = await hasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.write');
    return actionDetail(request, route.storeDb, actionId, storeId, canWrite);
  }
  if (method === 'POST' && !actionId && !transition) {
    return createProposedAction(request, env, route.storeDb, actor, url, storeId);
  }
  if (method === 'POST' && actionId && transition === 'reject') {
    return rejectAction(request, env, route.storeDb, actor, actionId, storeId);
  }
  if (method === 'POST' && actionId && transition === 'approve') {
    return approveAction(request, env, route.storeDb, actor, actionId, storeId);
  }
  if (method === 'POST' && actionId && (transition === 'apply' || transition === 'revert')) {
    return executionDisabled(request, route.storeDb, actionId, transition, storeId);
  }

  return json(request, { error: 'method_not_allowed' }, 405, {
    allow: actionId ? (transition ? 'POST' : 'GET') : 'GET, POST',
  });
}

async function listActions(request, db, url, storeId) {
  const filters = parseListFilters(url);
  if (filters.error) return json(request, { error: filters.error }, 400);

  const result = await db.prepare(`
    SELECT action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
           source_type, rule_key, before_json, proposed_json, rationale_json, status,
           created_by, approved_by, external_request_id, applied_at, created_at, updated_at
    FROM optimization_actions
    WHERE (?1 IS NULL OR status=?1)
      AND (?2 IS NULL OR action_type=?2)
      AND (?3 IS NULL OR entity_type=?3)
      AND (?4 IS NULL OR profile_id=?4)
    ORDER BY created_at DESC, action_id DESC
    LIMIT ?5
  `).bind(filters.status, filters.actionType, filters.entityType, filters.profileId, MAX_LIMIT).all();

  let items = (result.results || []).map(publicAction);
  if (filters.confidence) items = items.filter((item) => item.confidence?.band === filters.confidence);
  if (filters.freshness) items = items.filter((item) => (item.freshness?.state || 'unknown') === filters.freshness);
  if (filters.authority) {
    items = items.filter((item) => {
      const label = item.authority?.authoritative ? 'authoritative' : 'non-authoritative';
      return label === filters.authority;
    });
  }
  items = sortActions(items, filters.sort).slice(0, filters.limit);

  return json(request, {
    schemaVersion: 'optimization-action-control-v1',
    storeId,
    execution: executionState(),
    filters,
    items,
  }, 200);
}

async function actionDetail(request, db, actionId, storeId, canWrite) {
  const action = await findAction(db, actionId);
  if (!action) return json(request, { error: 'action_not_found' }, 404);
  const events = await db.prepare(`
    SELECT event_id, action_id, event_type, actor_id, details_json, occurred_at
    FROM optimization_action_events
    WHERE action_id=?1
    ORDER BY occurred_at, event_id
  `).bind(actionId).all();
  const publicEvents = (events.results || []).map(publicEvent);
  const item = publicAction(action);
  const rejection = [...publicEvents].reverse().find((event) => event.eventType === 'action.rejected');

  return json(request, {
    schemaVersion: 'optimization-action-detail-v2',
    storeId,
    action: {
      ...item,
      rejectionReason: rejection?.details?.reason || null,
    },
    events: publicEvents,
    transitionEligibility: {
      approve: Boolean(canWrite && action.status === 'proposed'),
      reject: Boolean(canWrite && action.status === 'proposed'),
      apply: false,
      revert: false,
      governanceOnly: true,
      executionReason: 'action_execution_disabled',
    },
    execution: executionState(),
  }, 200);
}

async function createProposedAction(request, env, db, actor, url, storeId) {
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const normalized = await normalizeCreateRequest(body.value, env, db, storeId);
  if (normalized.error) return json(request, normalized.payload || { error: normalized.error }, normalized.status || 400);

  const dryRun = normalized.dryRun || parseBooleanFlag(url.searchParams.get('dryRun')) === true;
  const existing = await findActionByIdempotency(db, normalized.idempotencyKey);
  if (existing) {
    const existingGovernance = governanceFromRationale(existing.rationale_json);
    const samePayload = existingGovernance?.requestFingerprint === normalized.requestFingerprint;
    if (!samePayload) {
      return json(request, {
        error: 'idempotency_conflict',
        storeId,
        idempotencyKey: normalized.idempotencyKey,
        existingActionId: existing.action_id,
        existingStatus: existing.status,
        requestFingerprint: normalized.requestFingerprint,
        existingRequestFingerprint: existingGovernance?.requestFingerprint || null,
        amazonMutationAttempted: false,
      }, 409);
    }
    return json(request, {
      schemaVersion: 'optimization-action-control-v1',
      storeId,
      dryRun,
      valid: true,
      idempotentReuse: true,
      wouldCreate: false,
      action: publicAction(existing),
      execution: executionState(),
    }, 200);
  }

  if (dryRun) {
    return json(request, {
      schemaVersion: 'optimization-action-dry-run-v1',
      storeId,
      dryRun: true,
      valid: true,
      idempotentReuse: false,
      wouldCreate: true,
      normalized: publicNormalizedRequest(normalized),
      execution: executionState(),
    }, 200);
  }

  const actionId = `act_${crypto.randomUUID()}`;
  const eventId = crypto.randomUUID();
  const rationaleEnvelope = {
    recommendation: normalized.rationale,
    governance: {
      schemaVersion: 'optimization-action-governance-v1',
      recommendationFingerprint: normalized.recommendationFingerprint,
      requestFingerprint: normalized.requestFingerprint,
      recommendationContract: {
        schemaVersion: SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
        modelVersion: SEARCH_TERM_MODEL_VERSION,
        ruleVersion: SEARCH_TERM_RULE_VERSION,
      },
      analysisWindow: normalized.analysisWindow,
      evidence: normalized.evidence,
      authority: normalized.authority,
      confidence: normalized.confidence,
      scores: normalized.scores,
      trend: normalized.trend,
      freshness: normalized.freshness,
      executionAuthorized: false,
    },
  };

  try {
    await executeStoreBatch(db, [
      db.prepare(`
        INSERT INTO optimization_actions(
          action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
          source_type, rule_key, before_json, proposed_json, rationale_json, status,
          created_by, approved_by, external_request_id, applied_at, created_at, updated_at
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'proposed',?12,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      `).bind(
        actionId,
        normalized.idempotencyKey,
        normalized.profileId,
        normalized.entityType,
        normalized.entityId,
        normalized.actionType,
        normalized.sourceType,
        normalized.ruleKey,
        JSON.stringify(normalized.before),
        JSON.stringify(normalized.proposed),
        JSON.stringify(rationaleEnvelope),
        actor.user_id,
      ),
      db.prepare(`
        INSERT INTO optimization_action_events(event_id, action_id, event_type, actor_id, details_json, occurred_at)
        VALUES(?1,?2,'action.proposed',?3,?4,CURRENT_TIMESTAMP)
      `).bind(eventId, actionId, actor.user_id, JSON.stringify({
        recommendationFingerprint: normalized.recommendationFingerprint,
        requestFingerprint: normalized.requestFingerprint,
        authorityMode: normalized.authority.mode,
        nonAuthoritative: !normalized.authority.authoritative,
        amazonMutationAttempted: false,
      })),
    ]);
  } catch (error) {
    const raced = await findActionByIdempotency(db, normalized.idempotencyKey);
    if (raced) {
      const governance = governanceFromRationale(raced.rationale_json);
      if (governance?.requestFingerprint === normalized.requestFingerprint) {
        return json(request, {
          schemaVersion: 'optimization-action-control-v1',
          storeId,
          dryRun: false,
          valid: true,
          idempotentReuse: true,
          wouldCreate: false,
          action: publicAction(raced),
          execution: executionState(),
        }, 200);
      }
      return json(request, {
        error: 'idempotency_conflict',
        storeId,
        idempotencyKey: normalized.idempotencyKey,
        existingActionId: raced.action_id,
        amazonMutationAttempted: false,
      }, 409);
    }
    throw error;
  }

  await auditControl(env.CONTROL_DB, request, actor.user_id, storeId, 'optimization_action.proposed', actionId, {
    profileId: normalized.profileId,
    actionType: normalized.actionType,
    entityType: normalized.entityType,
    entityId: normalized.entityId,
    recommendationFingerprint: normalized.recommendationFingerprint,
    requestFingerprint: normalized.requestFingerprint,
    authorityMode: normalized.authority.mode,
    amazonMutationAttempted: false,
  });

  const action = await findAction(db, actionId);
  return json(request, {
    schemaVersion: 'optimization-action-control-v1',
    storeId,
    dryRun: false,
    valid: true,
    idempotentReuse: false,
    wouldCreate: true,
    action: publicAction(action),
    execution: executionState(),
  }, 201);
}

async function rejectAction(request, env, db, actor, actionId, storeId) {
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  if (!plainObject(body.value)) return json(request, { error: 'invalid_json_object' }, 400);
  if (Object.keys(body.value).some((key) => !['reason'].includes(key))) {
    return json(request, { error: 'unsupported_reject_field' }, 400);
  }
  const reason = requiredText(body.value.reason, MAX_REASON);
  if (!reason) return json(request, { error: 'rejection_reason_required' }, 400);
  if (String(body.value.reason).trim().length > MAX_REASON) return json(request, { error: 'rejection_reason_too_long' }, 400);

  const existing = await findAction(db, actionId);
  if (!existing) return json(request, { error: 'action_not_found' }, 404);
  const [transitionResult, eventResult] = await executeStoreBatch(db, [
    db.prepare(`
      UPDATE optimization_actions
      SET status='rejected', updated_at=CURRENT_TIMESTAMP
      WHERE action_id=?1 AND status='proposed'
    `).bind(actionId),
    db.prepare(`
      INSERT INTO optimization_action_events(event_id, action_id, event_type, actor_id, details_json, occurred_at)
      SELECT ?1,?2,'action.rejected',?3,?4,CURRENT_TIMESTAMP
      WHERE changes()=1
    `).bind(crypto.randomUUID(), actionId, actor.user_id, JSON.stringify({
      reason,
      fromStatus: 'proposed',
      toStatus: 'rejected',
      amazonMutationAttempted: false,
    })),
  ]);
  if (changedRows(transitionResult) !== 1) return transitionConflict(request, db, actionId, 'reject', storeId);
  if (changedRows(eventResult) !== 1) throw new Error('optimization_action_reject_event_atomicity_violation');

  await auditControl(env.CONTROL_DB, request, actor.user_id, storeId, 'optimization_action.rejected', actionId, {
    profileId: existing.profile_id,
    actionType: existing.action_type,
    reason,
    fromStatus: 'proposed',
    toStatus: 'rejected',
    amazonMutationAttempted: false,
  });

  const action = await findAction(db, actionId);
  return json(request, {
    schemaVersion: 'optimization-action-transition-v1',
    storeId,
    transition: 'reject',
    action: publicAction(action),
    execution: executionState(),
  }, 200);
}

async function approveAction(request, env, db, actor, actionId, storeId) {
  const body = await readJson(request, { emptyObject: true });
  if (body.error) return json(request, { error: body.error }, 400);
  if (!plainObject(body.value)) return json(request, { error: 'invalid_json_object' }, 400);
  if (Object.keys(body.value).some((key) => !['note'].includes(key))) {
    return json(request, { error: 'unsupported_approve_field' }, 400);
  }
  const note = optionalText(body.value.note, MAX_REASON);
  if (body.value.note !== undefined && String(body.value.note || '').trim().length > MAX_REASON) {
    return json(request, { error: 'approval_note_too_long' }, 400);
  }

  const existing = await findAction(db, actionId);
  if (!existing) return json(request, { error: 'action_not_found' }, 404);
  const [transitionResult, eventResult] = await executeStoreBatch(db, [
    db.prepare(`
      UPDATE optimization_actions
      SET status='approved', approved_by=?2, updated_at=CURRENT_TIMESTAMP
      WHERE action_id=?1 AND status='proposed'
    `).bind(actionId, actor.user_id),
    db.prepare(`
      INSERT INTO optimization_action_events(event_id, action_id, event_type, actor_id, details_json, occurred_at)
      SELECT ?1,?2,'action.approved',?3,?4,CURRENT_TIMESTAMP
      WHERE changes()=1
    `).bind(crypto.randomUUID(), actionId, actor.user_id, JSON.stringify({
      note,
      fromStatus: 'proposed',
      toStatus: 'approved',
      governanceOnly: true,
      executionAuthorized: false,
      amazonMutationAttempted: false,
    })),
  ]);
  if (changedRows(transitionResult) !== 1) return transitionConflict(request, db, actionId, 'approve', storeId);
  if (changedRows(eventResult) !== 1) throw new Error('optimization_action_approve_event_atomicity_violation');

  await auditControl(env.CONTROL_DB, request, actor.user_id, storeId, 'optimization_action.approved', actionId, {
    profileId: existing.profile_id,
    actionType: existing.action_type,
    fromStatus: 'proposed',
    toStatus: 'approved',
    governanceOnly: true,
    amazonMutationAttempted: false,
  });

  const action = await findAction(db, actionId);
  return json(request, {
    schemaVersion: 'optimization-action-transition-v1',
    storeId,
    transition: 'approve',
    action: publicAction(action),
    execution: executionState(),
  }, 200);
}

async function transitionConflict(request, db, actionId, requestedTransition, storeId) {
  const current = await findAction(db, actionId);
  return json(request, {
    error: 'action_transition_conflict',
    storeId,
    actionId,
    requestedTransition,
    currentStatus: current?.status || null,
    requiredStatus: 'proposed',
    amazonMutationAttempted: false,
  }, 409);
}

async function executionDisabled(request, db, actionId, transition, storeId) {
  const action = await findAction(db, actionId);
  if (!action) return json(request, { error: 'action_not_found' }, 404);
  return json(request, {
    error: 'action_execution_disabled',
    storeId,
    actionId,
    requestedTransition: transition,
    currentStatus: action.status,
    requiredPhase: 11,
    amazonMutationAttempted: false,
    amazonMutationAuthorized: false,
  }, 409);
}

async function normalizeCreateRequest(input, env, db, storeId) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  const allowed = new Set([
    'dryRun', 'idempotencyKey', 'fingerprint', 'profileId', 'entityType', 'entityId', 'actionType',
    'sourceType', 'ruleKey', 'before', 'proposed', 'rationale', 'analysisWindow', 'evidence',
    'confidence', 'scores', 'trend', 'freshness', 'schemaVersion', 'modelVersion', 'ruleVersion',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { error: 'unsupported_action_field' };

  const dryRun = input.dryRun === undefined ? false : input.dryRun;
  if (typeof dryRun !== 'boolean') return { error: 'invalid_dry_run' };
  const profileId = requiredText(input.profileId, 200);
  if (!profileId) return { error: 'profile_id_required' };
  const entityType = requiredText(input.entityType, 80);
  if (!ENTITY_TYPES.has(entityType)) return { error: 'invalid_entity_type' };
  const entityId = requiredText(input.entityId, 240);
  if (!entityId) return { error: 'entity_id_required' };
  const actionType = requiredText(input.actionType, 120);
  if (!ACTION_TYPES.has(actionType)) return { error: 'invalid_action_type' };
  const sourceType = optionalText(input.sourceType, 40) || 'rule';
  if (!SOURCE_TYPES.has(sourceType)) return { error: 'invalid_source_type' };
  const ruleKey = optionalText(input.ruleKey, 160) || SEARCH_TERM_RULE_VERSION;
  if (!plainObject(input.before)) return { error: 'invalid_before_payload' };
  if (!plainObject(input.proposed) || Object.keys(input.proposed).length === 0) return { error: 'invalid_proposed_payload' };
  const rationale = input.rationale === undefined || input.rationale === null ? null : input.rationale;
  const analysisWindow = normalizeAnalysisWindow(input.analysisWindow);
  if (analysisWindow.error) return { error: analysisWindow.error };

  if (input.schemaVersion && input.schemaVersion !== SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION) {
    return { error: 'stale_recommendation_contract', status: 409, payload: { error: 'stale_recommendation_contract', field: 'schemaVersion' } };
  }
  if (input.modelVersion && input.modelVersion !== SEARCH_TERM_MODEL_VERSION) {
    return { error: 'stale_recommendation_contract', status: 409, payload: { error: 'stale_recommendation_contract', field: 'modelVersion' } };
  }
  if (input.ruleVersion && input.ruleVersion !== SEARCH_TERM_RULE_VERSION) {
    return { error: 'stale_recommendation_contract', status: 409, payload: { error: 'stale_recommendation_contract', field: 'ruleVersion' } };
  }

  const profile = await db.prepare(`
    SELECT profile_id FROM amazon_profiles
    WHERE profile_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(profileId).first();
  if (!profile) return { error: 'profile_not_found', status: 404 };

  const entity = await db.prepare(`
    SELECT row_key, profile_id FROM search_term_daily
    WHERE row_key=?1 AND profile_id=?2
    LIMIT 1
  `).bind(entityId, profileId).first();
  if (!entity) return { error: 'action_entity_not_found', status: 404 };

  const evidence = normalizeEvidenceEnvelope(input.evidence);
  const sourceFactIdentity = sourceFactIdentityFromEvidence(evidence);
  const authority = buildRecommendationAuthority({
    env,
    profileId,
    lineageValid: Boolean(evidence.lineageValid),
  });
  const confidence = normalizeConfidence(input.confidence);
  const scores = normalizeOptionalObject(input.scores);
  const trend = normalizeOptionalObject(input.trend);
  const freshness = normalizeFreshness(input.freshness);

  const recommendationFingerprint = await deterministicFingerprint({
    schemaVersion: SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
    modelVersion: SEARCH_TERM_MODEL_VERSION,
    ruleVersion: SEARCH_TERM_RULE_VERSION,
    storeId,
    profileId,
    entityType,
    entityId,
    actionType,
    before: input.before,
    proposed: input.proposed,
    analysisWindow: analysisWindow.value,
    sourceFactIdentity,
  });
  const suppliedFingerprint = optionalText(input.fingerprint, 80);
  if (suppliedFingerprint && suppliedFingerprint !== recommendationFingerprint) {
    return {
      error: 'recommendation_fingerprint_mismatch',
      status: 409,
      payload: {
        error: 'recommendation_fingerprint_mismatch',
        suppliedFingerprint,
        computedFingerprint: recommendationFingerprint,
        amazonMutationAttempted: false,
      },
    };
  }

  const requestFingerprint = await deterministicFingerprint({
    recommendationFingerprint,
    storeId,
    profileId,
    entityType,
    entityId,
    actionType,
    sourceType,
    ruleKey,
    before: input.before,
    proposed: input.proposed,
    rationale,
    analysisWindow: analysisWindow.value,
    evidence,
    authority,
    confidence,
    scores,
    trend,
    freshness,
  });
  const idempotencyKey = optionalText(input.idempotencyKey, 240) || recommendationFingerprint;
  if (!idempotencyKey) return { error: 'idempotency_key_required' };

  return {
    dryRun,
    idempotencyKey,
    recommendationFingerprint,
    requestFingerprint,
    profileId,
    entityType,
    entityId,
    actionType,
    sourceType,
    ruleKey,
    before: input.before,
    proposed: input.proposed,
    rationale,
    analysisWindow: analysisWindow.value,
    evidence,
    authority,
    confidence,
    scores,
    trend,
    freshness,
  };
}

function publicNormalizedRequest(value) {
  return {
    idempotencyKey: value.idempotencyKey,
    recommendationFingerprint: value.recommendationFingerprint,
    requestFingerprint: value.requestFingerprint,
    profileId: value.profileId,
    entityType: value.entityType,
    entityId: value.entityId,
    actionType: value.actionType,
    sourceType: value.sourceType,
    ruleKey: value.ruleKey,
    before: value.before,
    proposed: value.proposed,
    analysisWindow: value.analysisWindow,
    evidence: value.evidence,
    authority: value.authority,
    confidence: value.confidence,
    scores: value.scores,
    trend: value.trend,
    freshness: value.freshness,
    status: 'proposed',
    executionAuthorized: false,
  };
}

async function findAction(db, actionId) {
  if (!actionId || actionId.length > 240) return null;
  return db.prepare(actionSelect('WHERE action_id=?1 LIMIT 1')).bind(actionId).first();
}

async function findActionByIdempotency(db, idempotencyKey) {
  if (!idempotencyKey || idempotencyKey.length > 240) return null;
  return db.prepare(actionSelect('WHERE idempotency_key=?1 LIMIT 1')).bind(idempotencyKey).first();
}

function actionSelect(whereClause) {
  return `
    SELECT action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
           source_type, rule_key, before_json, proposed_json, rationale_json, status,
           created_by, approved_by, external_request_id, applied_at, created_at, updated_at
    FROM optimization_actions ${whereClause}
  `;
}

function publicAction(row) {
  if (!row) return null;
  const rawRationale = parseJson(row.rationale_json);
  const governance = plainObject(rawRationale?.governance) ? rawRationale.governance : null;
  const rationale = governance && Object.prototype.hasOwnProperty.call(rawRationale, 'recommendation')
    ? rawRationale.recommendation
    : rawRationale;
  return {
    actionId: row.action_id,
    idempotencyKey: row.idempotency_key,
    profileId: row.profile_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actionType: row.action_type,
    sourceType: row.source_type,
    ruleKey: row.rule_key || null,
    before: parseJson(row.before_json),
    proposed: parseJson(row.proposed_json),
    rationale,
    status: row.status,
    createdBy: row.created_by || null,
    approvedBy: row.approved_by || null,
    externalRequestId: row.external_request_id || null,
    appliedAt: row.applied_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fingerprint: governance?.recommendationFingerprint || null,
    requestFingerprint: governance?.requestFingerprint || null,
    analysisWindow: governance?.analysisWindow || null,
    evidence: governance?.evidence || null,
    authority: governance?.authority || null,
    confidence: governance?.confidence || null,
    scores: governance?.scores || null,
    trend: governance?.trend || null,
    freshness: governance?.freshness || null,
    governanceOnly: Boolean(governance),
    executionAuthorized: false,
  };
}

function publicEvent(event) {
  return {
    eventId: event.event_id,
    actionId: event.action_id,
    eventType: event.event_type,
    actorId: event.actor_id || null,
    details: parseJson(event.details_json),
    occurredAt: event.occurred_at,
  };
}

function parseListFilters(url) {
  const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: 'invalid_limit' };
  const status = optionalText(url.searchParams.get('status'), 40);
  if (status && !ACTION_STATUSES.has(status)) return { error: 'invalid_status' };
  const actionType = optionalText(url.searchParams.get('actionType'), 120);
  if (actionType && !ACTION_TYPES.has(actionType)) return { error: 'invalid_action_type' };
  const entityType = optionalText(url.searchParams.get('entityType'), 80);
  if (entityType && !ENTITY_TYPES.has(entityType)) return { error: 'invalid_entity_type' };
  const profileId = optionalText(url.searchParams.get('profileId'), 200);
  const confidence = optionalText(url.searchParams.get('confidence'), 20)?.toLowerCase() || null;
  if (confidence && !CONFIDENCE_BANDS.has(confidence)) return { error: 'invalid_confidence' };
  const freshness = optionalText(url.searchParams.get('freshness'), 20)?.toLowerCase() || null;
  if (freshness && !FRESHNESS_STATES.has(freshness)) return { error: 'invalid_freshness' };
  const authority = optionalText(url.searchParams.get('authority'), 30)?.toLowerCase() || null;
  if (authority && !AUTHORITY_FILTERS.has(authority)) return { error: 'invalid_authority' };
  const sort = optionalText(url.searchParams.get('sort'), 30)?.toLowerCase() || 'actionable';
  if (!SORT_MODES.has(sort)) return { error: 'invalid_sort' };
  return { status, actionType, entityType, profileId, confidence, freshness, authority, sort, limit };
}

function sortActions(items, sort) {
  const copy = [...items];
  const time = (item) => Date.parse(item.createdAt || '') || 0;
  const risk = (item) => Math.max(Number(item.scores?.waste?.score || 0), Number(item.scores?.harvest?.score || 0));
  if (sort === 'newest') return copy.sort((a, b) => time(b) - time(a));
  if (sort === 'risk') return copy.sort((a, b) => risk(b) - risk(a) || time(b) - time(a));
  return copy.sort((a, b) => {
    const actionableA = a.status === 'proposed' ? 1 : 0;
    const actionableB = b.status === 'proposed' ? 1 : 0;
    return actionableB - actionableA || risk(b) - risk(a) || time(b) - time(a);
  });
}

function normalizeAnalysisWindow(value) {
  if (!plainObject(value)) return { error: 'analysis_window_required' };
  const startDate = isoDate(value.startDate);
  const endDate = isoDate(value.endDate);
  if (!startDate || !endDate) return { error: 'analysis_window_invalid' };
  if (endDate < startDate) return { error: 'analysis_window_invalid' };
  const days = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  if (days < 1 || days > 93) return { error: 'analysis_window_invalid' };
  return { value: { startDate, endDate, days };
}

function normalizeEvidenceEnvelope(value) {
  if (!plainObject(value)) {
    return {
      lineageValid: false,
      factRowCount: 0,
      invalidLineageCount: 0,
      sourceReportJobIds: [],
      amazonReportIds: [],
      r2ObjectKeys: [],
      contentSha256s: [],
      sourceFactIdentity: { sourceReportJobIds: [], amazonReportIds: [], r2ObjectKeys: [], contentSha256s: [] },
    };
  }
  const source = plainObject(value.sourceFactIdentity) ? value.sourceFactIdentity : value;
  const sourceFactIdentity = {
    sourceReportJobIds: uniqueTexts(source.sourceReportJobIds),
    amazonReportIds: uniqueTexts(source.amazonReportIds),
    r2ObjectKeys: uniqueTexts(source.r2ObjectKeys),
    contentSha256s: uniqueTexts(source.contentSha256s).map((item) => item.toLowerCase()),
  };
  return {
    lineageValid: Boolean(value.lineageValid),
    factRowCount: nonNegativeInt(value.factRowCount),
    invalidLineageCount: nonNegativeInt(value.invalidLineageCount),
    sourceReportJobIds: sourceFactIdentity.sourceReportJobIds,
    amazonReportIds: sourceFactIdentity.amazonReportIds,
    r2ObjectKeys: sourceFactIdentity.r2ObjectKeys,
    contentSha256s: sourceFactIdentity.contentSha256s,
    sourceFactIdentity,
    latestReportDate: isoDate(value.latestReportDate) || null,
    factUpdatedAt: optionalText(value.factUpdatedAt, 80),
  };
}

function sourceFactIdentityFromEvidence(evidence) {
  return evidence.sourceFactIdentity || {
    sourceReportJobIds: [],
    amazonReportIds: [],
    r2ObjectKeys: [],
    contentSha256s: [],
  };
}

function normalizeConfidence(value) {
  if (!plainObject(value)) return null;
  const score = Number(value.score);
  const band = optionalText(value.band, 20)?.toLowerCase() || null;
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null,
    band: band && CONFIDENCE_BANDS.has(band) ? band : null,
    sampleScore: finiteOrNull(value.sampleScore),
    lineageFactor: finiteOrNull(value.lineageFactor),
    freshnessFactor: finiteOrNull(value.freshnessFactor),
  };
}

function normalizeFreshness(value) {
  if (!plainObject(value)) return { state: 'unknown' };
  const state = optionalText(value.state, 20)?.toLowerCase() || 'unknown';
  return {
    state: FRESHNESS_STATES.has(state) ? state : 'unknown',
    latestReportDate: isoDate(value.latestReportDate) || null,
    factUpdatedAt: optionalText(value.factUpdatedAt, 80),
    profileSyncedAt: optionalText(value.profileSyncedAt, 80),
    ageDays: nonNegativeNumberOrNull(value.ageDays),
    confidenceFactor: finiteOrNull(value.confidenceFactor),
  };
}

function normalizeOptionalObject(value) {
  return plainObject(value) ? value : null;
}

function governanceFromRationale(value) {
  const parsed = parseJson(value);
  return plainObject(parsed?.governance) ? parsed.governance : null;
}

async function executeStoreBatch(db, statements) {
  if (!db || typeof db.batch !== 'function') throw new Error('store_d1_atomic_batch_required');
  return db.batch(statements);
}

async function auditControl(db, request, actorUserId, storeId, action, entityId, details) {
  await db.prepare(`
    INSERT INTO audit_log(event_id, actor_user_id, store_id, action, entity_type, entity_id, request_id, cf_ray, details_json)
    VALUES(?1,?2,?3,?4,'optimization_action',?5,?6,?7,?8)
  `).bind(
    crypto.randomUUID(),
    actorUserId,
    storeId,
    action,
    entityId,
    request.headers.get('cf-ray') || crypto.randomUUID(),
    request.headers.get('cf-ray'),
    JSON.stringify(details || {}),
  ).run();
}

async function authorizedStoreRoute(env, userId, storeId, permission) {
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error: 'forbidden', permission, status: 403 };
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, d1_binding_key, status
    FROM stores WHERE store_id=?1 AND status <> 'disabled' LIMIT 1
  `).bind(storeId).first();
  if (!store) return { error: 'store_not_found', status: 404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error: 'store_db_unavailable', status: 503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { store, storeDb };
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`
    SELECT 1 AS ok FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key=ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2 LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM store_members sm
    JOIN role_permissions rp ON rp.role_key=sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3 LIMIT 1
  `).bind(userId, storeId, permission).first());
}

async function readJson(request, options = {}) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > BODY_LIMIT) return { error: 'request_body_too_large' };
  const text = await request.text();
  if (text.length > BODY_LIMIT) return { error: 'request_body_too_large' };
  if (!text.trim() && options.emptyObject) return { value: {} };
  try {
    return { value: JSON.parse(text || '{}') };
  } catch {
    return { error: 'invalid_json' };
  }
}

function executionState() {
  return {
    enabled: false,
    phase: 11,
    amazonMutationAuthorized: false,
    apply: 'disabled',
    revert: 'disabled',
  };
}

function changedRows(result) {
  const value = result?.meta?.changes ?? result?.changes ?? result?.meta?.changed_db;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return { parseError: true }; }
}
function parseBooleanFlag(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return null;
}
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function safeDecode(value) { try { return decodeURIComponent(value); } catch { return null; } }
function requiredText(value, max) { const out = String(value ?? '').trim(); return out ? out.slice(0, max) : null; }
function optionalText(value, max) { const out = String(value ?? '').trim(); return out ? out.slice(0, max) : null; }
function uniqueTexts(values) {
  const source = Array.isArray(values) ? values : String(values || '').split(',');
  return [...new Set(source.map((value) => String(value ?? '').trim()).filter(Boolean))].sort();
}
function nonNegativeInt(value) { const number = Number(value || 0); return Number.isInteger(number) && number > 0 ? number : 0; }
function nonNegativeNumberOrNull(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function finiteOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function isoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}
function json(request, payload, status, extraHeaders = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  const ray = request.headers.get('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status, headers });
}
