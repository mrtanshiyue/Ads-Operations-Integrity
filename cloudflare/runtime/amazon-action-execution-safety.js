import { deterministicFingerprint } from './decision-intelligence.js';

export const AMAZON_ACTION_EXECUTION_SAFETY_SCHEMA_VERSION = 'amazon-action-execution-safety-v1';
export const AMAZON_UNIFIED_TARGET_CONTRACT_VERSION = 'amazon-ads-unified-target-v1-2026-08-17';

export const AMAZON_UNIFIED_TARGET_CONTRACT_SOURCE = Object.freeze({
  repository: 'amzn/ads-advanced-tools-docs',
  collectionPath: 'postman/Amazon_Ads_Unified_API.postman_collection.json',
  apiFamily: 'Amazon Ads Unified API',
  apiVersion: 'adsApi/v1',
  verifiedOn: '2026-08-17',
});

const UNIFIED_CREATE_TARGET_HEADERS = Object.freeze([
  'Authorization',
  'Amazon-Ads-AccountId',
  'Amazon-Ads-ClientId',
  'Amazon-Advertising-API-Scope',
  'Content-Type',
  'Accept',
]);

export const LOGICAL_MUTATION_ALLOWLIST = Object.freeze({
  'negative_keyword.create': Object.freeze({
    capability: 'sponsored_products.negative_keyword.create',
    apiContract: AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
    method: 'POST',
    endpointPath: '/adsApi/v1/create/targets',
    endpointMappingVerified: true,
    responseContract: 'http_207_multistatus_error_partialSuccess_success',
    allowedMatchTypes: Object.freeze(['EXACT', 'PHRASE']),
    requiredScope: 'ad_group',
    adProduct: 'SPONSORED_PRODUCTS',
    targetType: 'KEYWORD',
    negative: true,
  }),
  'keyword.create': Object.freeze({
    capability: 'sponsored_products.keyword.create',
    apiContract: AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
    method: 'POST',
    endpointPath: '/adsApi/v1/create/targets',
    endpointMappingVerified: false,
    blockingReason: 'positive_keyword_bid_mapping_unverified',
    allowedMatchTypes: Object.freeze(['BROAD', 'PHRASE', 'EXACT']),
    requiredScope: 'ad_group',
    adProduct: 'SPONSORED_PRODUCTS',
    targetType: 'KEYWORD',
    negative: false,
  }),
});

export const COMPENSATING_ACTION_POLICY = Object.freeze({
  automaticRollbackAuthorized: false,
  directRevertRetryAuthorized: false,
  policy: 'create_separately_governed_compensating_action',
  reason: 'A confirmed external mutation must not be silently rolled back or replayed without a new governance decision.',
});

export async function buildExecutionPlan({ storeId, action } = {}) {
  const errors = [];
  const normalized = normalizeAction(action);
  const mapping = LOGICAL_MUTATION_ALLOWLIST[normalized.actionType] || null;

  if (!text(storeId)) errors.push('store_id_required');
  if (!normalized.actionId) errors.push('action_id_required');
  if (normalized.status !== 'approved') errors.push('approved_action_required');
  if (!mapping) errors.push('action_type_not_allowlisted');
  if (normalized.externalRequestId || normalized.appliedAt) errors.push('action_already_has_execution_marker');
  if (!hex64(normalized.requestFingerprint)) errors.push('request_fingerprint_required');

  const target = normalizeTarget(normalized.actionType, normalized.proposed, mapping, errors);
  const targetFingerprint = errors.length === 0
    ? await deterministicFingerprint({
        storeId: text(storeId),
        profileId: normalized.profileId,
        entityType: normalized.entityType,
        entityId: normalized.entityId,
        actionType: normalized.actionType,
        target,
      })
    : null;
  const executionFingerprint = targetFingerprint && normalized.requestFingerprint
    ? await deterministicFingerprint({
        schemaVersion: AMAZON_ACTION_EXECUTION_SAFETY_SCHEMA_VERSION,
        transition: 'apply',
        actionId: normalized.actionId,
        requestFingerprint: normalized.requestFingerprint,
        targetFingerprint,
      })
    : null;

  const valid = errors.length === 0;
  const endpointMappingVerified = Boolean(mapping?.endpointMappingVerified && mapping?.endpointPath && mapping?.method);
  return freeze({
    schemaVersion: AMAZON_ACTION_EXECUTION_SAFETY_SCHEMA_VERSION,
    transition: 'apply',
    valid,
    errors,
    storeId: text(storeId) || null,
    action: {
      actionId: normalized.actionId || null,
      profileId: normalized.profileId || null,
      entityType: normalized.entityType || null,
      entityId: normalized.entityId || null,
      actionType: normalized.actionType || null,
      status: normalized.status || null,
    },
    mutation: mapping ? {
      capability: mapping.capability,
      apiContract: mapping.apiContract || null,
      method: mapping.method || null,
      endpointPath: mapping.endpointPath,
      endpointMappingVerified,
      blockingReason: endpointMappingVerified ? null : (mapping.blockingReason || 'amazon_endpoint_mapping_unverified'),
      responseContract: mapping.responseContract || null,
      target,
    } : null,
    requestFingerprint: normalized.requestFingerprint || null,
    targetFingerprint,
    executionFingerprint,
    dryRunReady: valid,
    permitIssuanceReady: valid && endpointMappingVerified,
    networkDispatchAuthorized: false,
    retryPolicy: 'no_blind_retry_after_dispatch',
    finalizationPolicy: 'amazon_readback_confirmation_required',
    compensatingActionPolicy: COMPENSATING_ACTION_POLICY,
  });
}

export function buildAmazonMutationRequest(plan) {
  const errors = [];
  if (!plan?.valid) errors.push('valid_execution_plan_required');
  if (!plan?.mutation?.endpointMappingVerified) errors.push(plan?.mutation?.blockingReason || 'amazon_endpoint_mapping_unverified');
  if (plan?.action?.actionType !== 'negative_keyword.create') errors.push('mutation_request_builder_not_verified_for_action_type');
  if (!plan?.mutation?.target) errors.push('execution_target_required');

  const target = plan?.mutation?.target || {};
  if (target.scope !== 'ad_group' || !text(target.adGroupId)) errors.push('destination_scope_not_frozen');
  if (!text(target.keywordText)) errors.push('keyword_text_required');
  if (!['EXACT', 'PHRASE'].includes(text(target.matchType).toUpperCase())) errors.push('invalid_execution_match_type');

  if (errors.length) {
    return freeze({
      ready: false,
      errors: unique(errors),
      networkDispatchAuthorized: false,
    });
  }

  return freeze({
    ready: true,
    errors: [],
    contractVersion: AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
    source: AMAZON_UNIFIED_TARGET_CONTRACT_SOURCE,
    method: 'POST',
    endpointPath: '/adsApi/v1/create/targets',
    requiredHeaderNames: UNIFIED_CREATE_TARGET_HEADERS,
    contentType: 'application/json',
    body: {
      targets: [{
        adGroupId: target.adGroupId,
        adProduct: 'SPONSORED_PRODUCTS',
        negative: true,
        state: 'ENABLED',
        targetDetails: {
          keywordTarget: {
            keyword: target.keywordText,
            matchType: text(target.matchType).toUpperCase(),
          },
        },
        targetType: 'KEYWORD',
      }],
    },
    expectedResponse: {
      httpStatus: 207,
      shape: 'error_partialSuccess_success_arrays',
      singleEntityIndex: 0,
    },
    networkDispatchAuthorized: false,
  });
}

export function validatePermitBinding({ permit, plan, now = new Date() } = {}) {
  const errors = [];
  if (!permit || typeof permit !== 'object') return freeze({ valid: false, errors: ['permit_required'] });
  if (!plan?.valid) errors.push('valid_execution_plan_required');
  if (permit.state !== 'issued') errors.push('permit_not_issued');
  if (permit.transition !== 'apply') errors.push('permit_transition_mismatch');
  if (text(permit.actionId || permit.action_id) !== text(plan?.action?.actionId)) errors.push('permit_action_mismatch');
  if (text(permit.profileId || permit.profile_id) !== text(plan?.action?.profileId)) errors.push('permit_profile_mismatch');
  if (text(permit.entityId || permit.entity_id) !== text(plan?.action?.entityId)) errors.push('permit_entity_mismatch');
  if (text(permit.actionType || permit.action_type) !== text(plan?.action?.actionType)) errors.push('permit_action_type_mismatch');
  if (text(permit.requestFingerprint || permit.request_fingerprint) !== text(plan?.requestFingerprint)) errors.push('permit_request_fingerprint_mismatch');
  if (text(permit.targetFingerprint || permit.target_fingerprint) !== text(plan?.targetFingerprint)) errors.push('permit_target_fingerprint_mismatch');
  if (text(permit.executionFingerprint || permit.execution_fingerprint) !== text(plan?.executionFingerprint)) errors.push('permit_execution_fingerprint_mismatch');

  const expiry = Date.parse(text(permit.expiresAt || permit.expires_at));
  const current = now instanceof Date ? now.getTime() : Date.parse(text(now));
  if (!Number.isFinite(expiry)) errors.push('permit_expiry_required');
  else if (!Number.isFinite(current) || current >= expiry) errors.push('permit_expired');

  if (!plan?.mutation?.endpointMappingVerified) errors.push(plan?.mutation?.blockingReason || 'amazon_endpoint_mapping_unverified');
  if (plan?.networkDispatchAuthorized !== false) errors.push('invalid_execution_authority_contract');

  return freeze({
    valid: errors.length === 0,
    errors: unique(errors),
    singleUse: true,
    networkDispatchAuthorized: false,
  });
}

export function classifyMutationTransportOutcome({ dispatched, httpStatus = null, amazonRequestId = null, networkError = null, responseBody = null } = {}) {
  if (!dispatched) {
    return freeze({
      transportOutcome: 'unknown',
      retryDisposition: 'retry_before_dispatch',
      readbackRequired: false,
      reason: 'request_not_dispatched',
    });
  }

  const status = Number(httpStatus);
  if (status === 207) return classifyUnifiedTargetMultiStatus({ responseBody, amazonRequestId });
  if (Number.isInteger(status) && status >= 200 && status < 300) {
    return freeze({
      transportOutcome: 'accepted',
      retryDisposition: 'readback_required',
      readbackRequired: true,
      reason: 'transport_accepted_business_state_unconfirmed',
      amazonRequestId: text(amazonRequestId) || null,
    });
  }
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return freeze({
      transportOutcome: 'rejected',
      retryDisposition: 'not_retryable',
      readbackRequired: false,
      reason: 'deterministic_client_rejection',
      amazonRequestId: text(amazonRequestId) || null,
    });
  }
  return freeze({
    transportOutcome: 'unknown',
    retryDisposition: 'readback_required',
    readbackRequired: true,
    reason: networkError ? 'dispatched_outcome_unknown' : 'server_or_transport_outcome_unknown',
    amazonRequestId: text(amazonRequestId) || null,
  });
}

export function canMarkActionApplied({ receipt, verification, plan } = {}) {
  const receiptFingerprint = text(receipt?.executionFingerprint || receipt?.execution_fingerprint);
  const verificationExpected = text(verification?.expectedFingerprint || verification?.expected_fingerprint);
  const verificationObserved = text(verification?.observedFingerprint || verification?.observed_fingerprint);
  const planFingerprint = text(plan?.executionFingerprint);
  const confirmed = verification?.result === 'confirmed';
  const transportAccepted = receipt?.transportOutcome === 'accepted' || receipt?.transport_outcome === 'accepted';
  const fingerprintsMatch = Boolean(planFingerprint)
    && receiptFingerprint === planFingerprint
    && verificationExpected === planFingerprint
    && verificationObserved === planFingerprint;

  return freeze({
    allowed: Boolean(plan?.valid && transportAccepted && confirmed && fingerprintsMatch),
    transportAccepted,
    readbackConfirmed: confirmed,
    fingerprintsMatch,
    networkDispatchAuthorized: false,
  });
}

function classifyUnifiedTargetMultiStatus({ responseBody, amazonRequestId }) {
  const payload = parseJson(responseBody);
  if (!payload || !Array.isArray(payload.error) || !Array.isArray(payload.partialSuccess) || !Array.isArray(payload.success)) {
    return freeze({
      transportOutcome: 'unknown',
      retryDisposition: 'readback_required',
      readbackRequired: true,
      reason: 'unified_target_207_unparseable',
      amazonRequestId: text(amazonRequestId) || null,
    });
  }

  const error = indexedResult(payload.error, 0);
  const partial = indexedResult(payload.partialSuccess, 0);
  const success = indexedResult(payload.success, 0);
  if (error) {
    return freeze({
      transportOutcome: 'rejected',
      retryDisposition: 'not_retryable',
      readbackRequired: false,
      reason: 'unified_target_207_entity_error',
      amazonRequestId: text(amazonRequestId) || null,
      entityIndex: 0,
    });
  }
  if (partial) {
    return freeze({
      transportOutcome: 'unknown',
      retryDisposition: 'readback_required',
      readbackRequired: true,
      reason: 'unified_target_207_partial_success',
      amazonRequestId: text(amazonRequestId) || null,
      entityIndex: 0,
    });
  }
  if (success) {
    return freeze({
      transportOutcome: 'accepted',
      retryDisposition: 'readback_required',
      readbackRequired: true,
      reason: 'unified_target_207_entity_success_readback_required',
      amazonRequestId: text(amazonRequestId) || null,
      entityIndex: 0,
    });
  }
  return freeze({
    transportOutcome: 'unknown',
    retryDisposition: 'readback_required',
    readbackRequired: true,
    reason: 'unified_target_207_missing_entity_result',
    amazonRequestId: text(amazonRequestId) || null,
    entityIndex: 0,
  });
}

function indexedResult(items, index) {
  return items.find((item) => Number(item?.index) === index) || null;
}

function normalizeAction(action) {
  const rationale = parseJson(action?.rationale ?? action?.rationale_json) || {};
  const governance = rationale?.governance && typeof rationale.governance === 'object' ? rationale.governance : {};
  return {
    actionId: text(action?.actionId ?? action?.action_id),
    profileId: text(action?.profileId ?? action?.profile_id),
    entityType: text(action?.entityType ?? action?.entity_type),
    entityId: text(action?.entityId ?? action?.entity_id),
    actionType: text(action?.actionType ?? action?.action_type),
    status: text(action?.status),
    proposed: parseJson(action?.proposed ?? action?.proposed_json) || {},
    requestFingerprint: text(action?.requestFingerprint ?? governance.requestFingerprint),
    externalRequestId: text(action?.externalRequestId ?? action?.external_request_id),
    appliedAt: text(action?.appliedAt ?? action?.applied_at),
  };
}

function normalizeTarget(actionType, proposed, mapping, errors) {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) {
    errors.push('proposed_payload_required');
    return null;
  }
  const campaignId = text(proposed.campaignId);
  const adGroupId = text(proposed.adGroupId);
  const scope = text(proposed.scope).toLowerCase();
  const keywordText = text(proposed.keywordText);
  const matchType = text(proposed.matchType).toUpperCase();

  if (!campaignId || !adGroupId || scope !== mapping?.requiredScope) errors.push('destination_scope_not_frozen');
  if (!keywordText) errors.push('keyword_text_required');
  if (!mapping?.allowedMatchTypes?.includes(matchType)) errors.push('invalid_execution_match_type');

  const target = {
    scope: scope || null,
    campaignId: campaignId || null,
    adGroupId: adGroupId || null,
    keywordText: keywordText || null,
    matchType: matchType || null,
  };
  if (actionType === 'keyword.create') {
    const bid = proposed.bidMicros;
    if (bid !== null && bid !== undefined && (!Number.isSafeInteger(Number(bid)) || Number(bid) < 0)) {
      errors.push('invalid_bid_micros');
    }
    target.bidMicros = bid === null || bid === undefined ? null : Number(bid);
  }
  return freeze(target);
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return null; }
}
function unique(values) { return [...new Set(values)]; }
function hex64(value) { return /^[a-f0-9]{64}$/i.test(text(value)); }
function text(value) { return String(value ?? '').trim(); }
function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freeze(item)));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
  }
  return value;
}
