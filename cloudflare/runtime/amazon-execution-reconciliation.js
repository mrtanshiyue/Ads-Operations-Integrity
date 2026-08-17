import { deterministicFingerprint } from './decision-intelligence.js';

export const AMAZON_UNIFIED_TARGET_READBACK_CONTRACT_VERSION = 'amazon-ads-unified-target-readback-v1-2026-08-17';
export const AMAZON_UNIFIED_TARGET_READBACK_SOURCE = Object.freeze({
  repository: 'amzn/ads-advanced-tools-docs',
  collectionPath: 'postman/Amazon_Ads_Unified_API.postman_collection.json',
  apiFamily: 'Amazon Ads Unified API',
  apiVersion: 'adsApi/v1',
  verifiedOn: '2026-08-17',
  operation: 'List target',
});

const READBACK_HEADERS = Object.freeze([
  'Authorization',
  'Amazon-Ads-AccountId',
  'Amazon-Ads-ClientId',
  'Amazon-Advertising-API-Scope',
  'Content-Type',
  'Accept',
]);
const MAX_READBACK_RESULTS = 1000;

export function buildNegativeKeywordTargetReadbackRequest(plan) {
  const errors = [];
  if (!plan?.valid) errors.push('valid_execution_plan_required');
  if (plan?.action?.actionType !== 'negative_keyword.create') errors.push('readback_not_enabled_for_action_type');
  if (!plan?.mutation?.endpointMappingVerified) errors.push('amazon_mutation_contract_unverified');
  if (!plan?.mutation?.target?.adGroupId) errors.push('frozen_ad_group_required');
  if (!plan?.mutation?.target?.keywordText) errors.push('keyword_text_required');
  if (!['EXACT', 'PHRASE'].includes(text(plan?.mutation?.target?.matchType).toUpperCase())) errors.push('invalid_execution_match_type');
  if (errors.length) return freeze({ ready: false, errors: unique(errors), networkDispatchAuthorized: false });

  return freeze({
    schemaVersion: AMAZON_UNIFIED_TARGET_READBACK_CONTRACT_VERSION,
    source: AMAZON_UNIFIED_TARGET_READBACK_SOURCE,
    ready: true,
    errors: [],
    method: 'POST',
    endpointPath: '/adsApi/v1/query/targets',
    requiredHeaderNames: READBACK_HEADERS,
    contentType: 'application/json',
    body: {
      stateFilter: { include: ['ENABLED', 'PAUSED'] },
      adProductFilter: { include: ['SPONSORED_PRODUCTS'] },
      maxResults: MAX_READBACK_RESULTS,
      negativeFilter: { include: [true] },
      targetTypeFilter: { include: ['KEYWORD'] },
    },
    correlationPolicy: {
      strategy: 'unique_exact_entity_match',
      requiredFields: ['targetId', 'adGroupId', 'negative', 'targetDetails.keywordTarget.keyword', 'targetDetails.keywordTarget.matchType', 'state'],
      expectedAdGroupId: plan.mutation.target.adGroupId,
      expectedKeyword: plan.mutation.target.keywordText,
      expectedMatchType: text(plan.mutation.target.matchType).toUpperCase(),
      expectedNegative: true,
      expectedState: 'ENABLED',
      maxResults: MAX_READBACK_RESULTS,
      failClosedOnAmbiguousMatch: true,
      failClosedOnTruncationSignal: true,
      failClosedAtResultCap: true,
    },
    networkDispatchAuthorized: false,
  });
}

export async function verifyNegativeKeywordTargetReadback({ plan, responseBody, observedAt = new Date() } = {}) {
  if (!plan?.valid || plan?.action?.actionType !== 'negative_keyword.create') {
    return verification('unknown', plan, null, ['valid_negative_keyword_execution_plan_required'], observedAt);
  }
  const payload = parseJson(responseBody);
  if (!payload || !Array.isArray(payload.targets)) {
    return verification('unknown', plan, null, ['invalid_target_query_response'], observedAt);
  }
  if (hasTruncationSignal(payload)) {
    return verification('unknown', plan, null, ['target_query_result_may_be_truncated'], observedAt, { returnedCount: payload.targets.length });
  }

  const expected = plan.mutation?.target || {};
  const candidates = payload.targets.filter((target) => exactLogicalMatch(target, expected));
  if (candidates.length === 0) return verification('not_found', plan, null, ['exact_target_not_found'], observedAt);
  if (candidates.length !== 1) {
    return verification('unknown', plan, null, ['ambiguous_exact_target_match'], observedAt, { candidateCount: candidates.length });
  }

  const target = candidates[0];
  const targetId = text(target.targetId);
  if (!targetId) return verification('mismatch', plan, target, ['target_id_missing'], observedAt);

  const mismatches = [];
  if (text(target.adGroupId) !== text(expected.adGroupId)) mismatches.push('ad_group_id_mismatch');
  if (target.negative !== true) mismatches.push('negative_flag_mismatch');
  if (text(target.targetDetails?.keywordTarget?.keyword) !== text(expected.keywordText)) mismatches.push('keyword_text_mismatch');
  if (text(target.targetDetails?.keywordTarget?.matchType).toUpperCase() !== text(expected.matchType).toUpperCase()) mismatches.push('match_type_mismatch');
  if (text(target.state).toUpperCase() !== 'ENABLED') mismatches.push('state_mismatch');
  if (mismatches.length) return verification('mismatch', plan, target, mismatches, observedAt);

  const observedTarget = {
    scope: 'ad_group',
    campaignId: text(target.campaignId) || text(expected.campaignId),
    adGroupId: text(target.adGroupId),
    keywordText: text(target.targetDetails?.keywordTarget?.keyword),
    matchType: text(target.targetDetails?.keywordTarget?.matchType).toUpperCase(),
  };
  const observedFingerprint = await deterministicFingerprint({
    storeId: text(plan.storeId),
    profileId: text(plan.action?.profileId),
    entityType: text(plan.action?.entityType),
    entityId: text(plan.action?.entityId),
    actionType: text(plan.action?.actionType),
    target: observedTarget,
  });
  const fingerprintMatches = observedFingerprint === text(plan.targetFingerprint);
  return freeze({
    schemaVersion: 'amazon-target-readback-verification-v1',
    result: fingerprintMatches ? 'confirmed' : 'mismatch',
    expectedFingerprint: text(plan.targetFingerprint) || null,
    observedFingerprint,
    observedAt: normalizeTime(observedAt),
    targetId,
    observedTarget,
    errors: fingerprintMatches ? [] : ['target_fingerprint_mismatch'],
    details: {
      targetId,
      adGroupId: text(target.adGroupId),
      campaignId: text(target.campaignId) || null,
      negative: target.negative,
      keyword: text(target.targetDetails?.keywordTarget?.keyword),
      matchType: text(target.targetDetails?.keywordTarget?.matchType).toUpperCase(),
      state: text(target.state).toUpperCase(),
      adProduct: text(target.adProduct),
      targetType: text(target.targetType),
    },
    networkDispatchAuthorized: false,
  });
}

export async function persistImmutableExecutionReceipt({ db, permit, plan, envelope, transportEvidence, responseMetadata = null, dispatchedAt, completedAt = null } = {}) {
  const errors = [];
  if (!db) errors.push('store_db_required');
  if (permit?.state !== 'consumed') errors.push('consumed_permit_required');
  if (!plan?.valid) errors.push('valid_execution_plan_required');
  if (text(permit?.actionId || permit?.action_id) !== text(plan?.action?.actionId)) errors.push('permit_action_mismatch');
  if (text(permit?.executionFingerprint || permit?.execution_fingerprint) !== text(plan?.executionFingerprint)) errors.push('permit_execution_fingerprint_mismatch');
  if (!hex64(envelope?.requestBodySha256)) errors.push('request_body_sha256_required');
  if (!['accepted', 'rejected', 'unknown'].includes(text(transportEvidence?.transportOutcome))) errors.push('transport_outcome_required');
  if (!['not_retryable', 'retry_before_dispatch', 'readback_required'].includes(text(transportEvidence?.retryDisposition))) errors.push('retry_disposition_required');
  if (text(transportEvidence?.retryDisposition) === 'retry_before_dispatch' || transportEvidence?.dispatched !== true) errors.push('receipt_requires_dispatched_request');
  const dispatchedIso = normalizeTime(dispatchedAt);
  if (!dispatchedIso) errors.push('dispatched_at_required');
  if (errors.length) return freeze({ persisted: false, errors: unique(errors), networkDispatchAuthorized: false });

  const permitId = text(permit?.permitId || permit?.permit_id);
  const receiptId = `execr_${crypto.randomUUID()}`;
  const metadata = {
    schemaVersion: 'amazon-mutation-receipt-metadata-v1',
    reason: transportEvidence.reason || null,
    entityIndex: Number.isInteger(transportEvidence.entityIndex) ? transportEvidence.entityIndex : null,
    readbackRequired: Boolean(transportEvidence.readbackRequired),
    responseMetadata: responseMetadata || null,
  };
  try {
    await db.prepare(`
      INSERT INTO optimization_execution_receipts(
        receipt_id, permit_id, action_id, transition, execution_fingerprint,
        request_body_sha256, amazon_request_id, http_status, transport_outcome,
        retry_disposition, response_body_sha256, response_metadata_json,
        dispatched_at, completed_at, created_at
      ) VALUES(?1,?2,?3,'apply',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?12)
    `).bind(
      receiptId, permitId, plan.action.actionId, plan.executionFingerprint,
      envelope.requestBodySha256, text(transportEvidence.amazonRequestId) || null,
      integerOrNull(transportEvidence.httpStatus), transportEvidence.transportOutcome,
      transportEvidence.retryDisposition, hex64(transportEvidence.responseBodySha256) ? transportEvidence.responseBodySha256 : null,
      JSON.stringify(metadata), dispatchedIso, normalizeTime(completedAt),
    ).run();
  } catch (error) {
    const existing = await findReceiptByPermit(db, permitId);
    return freeze({
      persisted: false,
      errors: [existing ? 'receipt_already_exists_for_permit' : 'receipt_persistence_failed'],
      existingReceiptId: existing?.receipt_id || null,
      networkDispatchAuthorized: false,
    });
  }
  return freeze({ persisted: true, errors: [], receipt: publicReceipt(await findReceipt(db, receiptId)), networkDispatchAuthorized: false });
}

export async function persistImmutableExecutionVerification({ db, receipt, plan, readbackVerification } = {}) {
  const errors = [];
  if (!db) errors.push('store_db_required');
  if (!receipt) errors.push('receipt_required');
  if (!plan?.valid) errors.push('valid_execution_plan_required');
  if (!['confirmed', 'mismatch', 'not_found', 'unknown'].includes(text(readbackVerification?.result))) errors.push('verification_result_required');
  if (text(receipt?.actionId || receipt?.action_id) !== text(plan?.action?.actionId)) errors.push('receipt_action_mismatch');
  if (text(receipt?.executionFingerprint || receipt?.execution_fingerprint) !== text(plan?.executionFingerprint)) errors.push('receipt_execution_fingerprint_mismatch');
  if (text(readbackVerification?.expectedFingerprint) !== text(plan?.targetFingerprint)) errors.push('verification_expected_fingerprint_mismatch');
  const observedFingerprint = text(readbackVerification?.observedFingerprint) || null;
  if (observedFingerprint && !hex64(observedFingerprint)) errors.push('invalid_observed_fingerprint');
  const observedAt = normalizeTime(readbackVerification?.observedAt);
  if (!observedAt) errors.push('verification_observed_at_required');
  if (errors.length) return freeze({ persisted: false, errors: unique(errors), networkDispatchAuthorized: false });

  const verificationId = `execv_${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO optimization_execution_verifications(
      verification_id, receipt_id, action_id, verification_type,
      expected_fingerprint, observed_fingerprint, result, details_json,
      observed_at, created_at
    ) VALUES(?1,?2,?3,'amazon_readback',?4,?5,?6,?7,?8,?8)
  `).bind(
    verificationId,
    text(receipt?.receiptId || receipt?.receipt_id),
    plan.action.actionId,
    plan.targetFingerprint,
    observedFingerprint,
    readbackVerification.result,
    JSON.stringify({
      schemaVersion: 'amazon-readback-verification-details-v1',
      targetId: readbackVerification.targetId || null,
      errors: readbackVerification.errors || [],
      details: readbackVerification.details || null,
    }),
    observedAt,
  ).run();
  return freeze({ persisted: true, errors: [], verification: publicVerification(await findVerification(db, verificationId)), networkDispatchAuthorized: false });
}

function exactLogicalMatch(target, expected) {
  return text(target?.adGroupId) === text(expected?.adGroupId)
    && target?.negative === true
    && text(target?.targetDetails?.keywordTarget?.keyword) === text(expected?.keywordText)
    && text(target?.targetDetails?.keywordTarget?.matchType).toUpperCase() === text(expected?.matchType).toUpperCase()
    && text(target?.adProduct) === 'SPONSORED_PRODUCTS'
    && text(target?.targetType) === 'KEYWORD';
}
function verification(result, plan, target, errors, observedAt, extra = {}) {
  return freeze({
    schemaVersion: 'amazon-target-readback-verification-v1',
    result,
    expectedFingerprint: text(plan?.targetFingerprint) || null,
    observedFingerprint: null,
    observedAt: normalizeTime(observedAt),
    targetId: text(target?.targetId) || null,
    observedTarget: null,
    errors,
    details: extra,
    networkDispatchAuthorized: false,
  });
}
function hasTruncationSignal(payload) {
  return Boolean(text(payload?.nextToken) || payload?._truncated === true || payload?.truncated === true || payload?.targets?.length >= MAX_READBACK_RESULTS);
}
async function findReceipt(db, receiptId) { return db.prepare('SELECT * FROM optimization_execution_receipts WHERE receipt_id=?1 LIMIT 1').bind(receiptId).first(); }
async function findReceiptByPermit(db, permitId) { return db.prepare('SELECT * FROM optimization_execution_receipts WHERE permit_id=?1 LIMIT 1').bind(permitId).first(); }
async function findVerification(db, verificationId) { return db.prepare('SELECT * FROM optimization_execution_verifications WHERE verification_id=?1 LIMIT 1').bind(verificationId).first(); }
function publicReceipt(row) { if (!row) return null; return freeze({ receiptId: row.receipt_id, permitId: row.permit_id, actionId: row.action_id, transition: row.transition, executionFingerprint: row.execution_fingerprint, requestBodySha256: row.request_body_sha256, amazonRequestId: row.amazon_request_id || null, httpStatus: row.http_status, transportOutcome: row.transport_outcome, retryDisposition: row.retry_disposition, responseBodySha256: row.response_body_sha256 || null, dispatchedAt: row.dispatched_at, completedAt: row.completed_at || null }); }
function publicVerification(row) { if (!row) return null; return freeze({ verificationId: row.verification_id, receiptId: row.receipt_id, actionId: row.action_id, expectedFingerprint: row.expected_fingerprint, observedFingerprint: row.observed_fingerprint || null, result: row.result, observedAt: row.observed_at }); }
function integerOrNull(value) { const number = Number(value); return Number.isInteger(number) ? number : null; }
function normalizeTime(value) { if (value === null || value === undefined || value === '') return null; const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }
function parseJson(value) { if (!value) return null; if (typeof value === 'object') return value; try { return JSON.parse(String(value)); } catch { return null; } }
function hex64(value) { return /^[a-f0-9]{64}$/i.test(text(value)); }
function text(value) { return String(value ?? '').trim(); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function freeze(value) { if (Array.isArray(value)) return Object.freeze(value.map((item) => freeze(item))); if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key,item]) => [key, freeze(item)]))); return value; }
