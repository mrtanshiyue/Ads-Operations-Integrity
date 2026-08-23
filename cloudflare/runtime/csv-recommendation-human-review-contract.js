import { canonicalJson } from './canonical-json.js';

export const CSV_RECOMMENDATION_HUMAN_REVIEW_CONTRACT_VERSION = 'csv-recommendation-human-review-v1';
export const RECOMMENDATION_REVIEW_SOURCE_KIND = 'csv_recommendation_inbox_v1';

export const SESSION_REVIEW_STATES = Object.freeze(['unreviewed', 'viewed']);
export const DURABLE_REVIEW_STATES = Object.freeze(['acknowledged', 'needs_review', 'approved', 'rejected']);

const ADVISORY_STATE_MAP = Object.freeze({
  acknowledged: 'acknowledged',
  needs_review: 'open',
  approved: 'approved',
  rejected: 'rejected',
});

const EXECUTION_SEPARATION = Object.freeze({
  optimizationActionMutationAllowed: false,
  optimizationActionApprovalAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
  futurePromotionStatus: 'proposed',
  futurePromotionEnabled: false,
});

/**
 * Pure contract evaluator for Recommendation Inbox human review.
 *
 * This module deliberately does not write D1 and does not mutate optimization_actions.
 * Existing advisory_review_records is the durable review plane. Current schema safely
 * represents acknowledged / needs_review / approved / rejected for search-term candidates.
 * Session states remain presentation-only. Final dispositions are Human Review outcomes only;
 * they must never be coerced into Optimization Action approval or execution state.
 */
export async function evaluateRecommendationReviewRequest({
  inboxItem,
  requestedState,
  analysisScope,
} = {}) {
  const state = clean(requestedState);
  const binding = inboxItem ? await buildRecommendationReviewBinding(inboxItem) : null;
  const sessionOnly = SESSION_REVIEW_STATES.includes(state);
  const durableRequested = DURABLE_REVIEW_STATES.includes(state);
  const mappedAdvisoryState = ADVISORY_STATE_MAP[state] || null;
  const reasons = [];

  if (!state) reasons.push('review_state_required');
  else if (!sessionOnly && !durableRequested) reasons.push('review_state_unsupported');

  if (sessionOnly) reasons.push('session_presentation_state_only');
  if (durableRequested && !inboxItem) reasons.push('emitted_recommendation_required');

  if (durableRequested && inboxItem) {
    if (!mappedAdvisoryState) reasons.push('durable_state_schema_mapping_missing');
    if (binding?.entityType !== 'search_term') reasons.push('review_entity_type_schema_mapping_missing');
    if (analysisScope?.candidateEmissionAuthorized !== true) reasons.push('candidate_emission_not_authorized');
    if (inboxItem?.review?.persistenceAuthorized !== true) reasons.push('review_persistence_not_authorized');
    if (inboxItem?.authority?.governancePersistenceAllowed !== true) reasons.push('governance_persistence_not_authorized');
  }

  const schemaReusable = Boolean(
    durableRequested
    && mappedAdvisoryState
    && binding?.entityType === 'search_term'
  );
  const persistenceAuthorized = schemaReusable && reasons.length === 0;

  return Object.freeze({
    schemaVersion: CSV_RECOMMENDATION_HUMAN_REVIEW_CONTRACT_VERSION,
    requestedState: state || null,
    stateClass: sessionOnly ? 'session' : durableRequested ? 'durable' : 'unsupported',
    schemaReusable,
    persistenceAuthorized,
    advisoryReviewRecord: persistenceAuthorized ? Object.freeze({
      sourceKind: RECOMMENDATION_REVIEW_SOURCE_KIND,
      recommendationFingerprint: binding.recommendationFingerprint,
      entityType: binding.entityType,
      entityId: binding.entityId,
      recommendationFamily: binding.recommendationFamily,
      recommendationActionType: binding.recommendationActionType,
      state: mappedAdvisoryState,
      sourceEvidenceJson: binding.sourceEvidenceJson,
      sourceEvidenceSha256: binding.sourceEvidenceSha256,
    }) : null,
    binding,
    reasons: Object.freeze(reasons),
    execution: EXECUTION_SEPARATION,
  });
}

export async function buildRecommendationReviewBinding(inboxItem = {}) {
  if (inboxItem?.itemClass !== 'recommendation_candidate') throw reviewContractError('RECOMMENDATION_REVIEW_ITEM_REQUIRED');
  const inboxItemId = clean(inboxItem?.inboxItemId);
  const actionType = clean(inboxItem?.actionType);
  const candidateType = clean(inboxItem?.candidateType);
  const matchScope = clean(inboxItem?.matchScope);
  const value = normalizeBusinessText(inboxItem?.value);
  if (!inboxItemId || !actionType || !candidateType || !matchScope || !value) {
    throw reviewContractError('RECOMMENDATION_REVIEW_IDENTITY_INCOMPLETE');
  }

  const entityType = matchScope === 'phrase_review' ? 'root' : 'search_term';
  const analysisWindow = normalizeWindow(inboxItem?.evidenceSummary?.analysisWindow);
  const sourceImportIds = uniqueTexts(inboxItem?.evidenceSummary?.sourceImportIds);
  const contextDescriptor = Object.freeze({
    sourceKind: RECOMMENDATION_REVIEW_SOURCE_KIND,
    inboxItemId,
    candidateType,
    actionType,
    matchScope,
    value,
  });
  const evidenceScopeDescriptor = Object.freeze({
    ...contextDescriptor,
    analysisWindow,
    sourceImportIds,
  });
  const evidenceSnapshot = buildEvidenceSnapshot(inboxItem, evidenceScopeDescriptor);
  const sourceEvidenceJson = canonicalJson(evidenceSnapshot);
  const [contextFingerprint, sourceEvidenceSha256] = await Promise.all([
    sha256Hex(canonicalJson(contextDescriptor)),
    sha256Hex(sourceEvidenceJson),
  ]);
  const recommendationFingerprint = await sha256Hex(canonicalJson({
    ...evidenceScopeDescriptor,
    sourceEvidenceSha256,
  }));

  return Object.freeze({
    sourceKind: RECOMMENDATION_REVIEW_SOURCE_KIND,
    contextFingerprint,
    recommendationFingerprint,
    entityType,
    entityId: value,
    recommendationFamily: candidateType,
    recommendationActionType: actionType,
    analysisWindow,
    sourceImportIds: Object.freeze(sourceImportIds),
    sourceEvidenceJson,
    sourceEvidenceSha256,
  });
}

export function compareRecommendationReviewBindings(previous, current) {
  if (!previous || !current) return Object.freeze({ sameContext: false, stale: false });
  const sameContext = clean(previous.contextFingerprint) === clean(current.contextFingerprint);
  const stale = sameContext && (
    clean(previous.recommendationFingerprint) !== clean(current.recommendationFingerprint)
    || clean(previous.sourceEvidenceSha256) !== clean(current.sourceEvidenceSha256)
  );
  return Object.freeze({ sameContext, stale });
}

function buildEvidenceSnapshot(inboxItem, descriptor) {
  const evidence = inboxItem?.evidenceSummary || {};
  return Object.freeze({
    contract: CSV_RECOMMENDATION_HUMAN_REVIEW_CONTRACT_VERSION,
    descriptor,
    priority: clean(inboxItem?.priority) || null,
    priorityScore: stableNumber(inboxItem?.priorityScore),
    reason: clean(inboxItem?.reason) || null,
    evidence: Object.freeze({
      spendMicros: stableNumber(evidence.spendMicros),
      salesMicros: stableNumber(evidence.salesMicros),
      orders: stableNumber(evidence.orders),
      clicks: stableNumber(evidence.clicks),
      acos: stableNumber(evidence.acos),
      cvr: stableNumber(evidence.cvr),
      recommendationGoverned: evidence.recommendationGoverned === true,
      provenanceGate: clean(evidence.provenanceGate) || null,
      rootStates: Object.freeze(uniqueTexts(evidence.rootStates)),
      identityState: clean(evidence?.identityConfidence?.state) || null,
      canonicalAmazonIdentityResolved: false,
    }),
  });
}

function normalizeWindow(value) {
  const startDate = clean(value?.startDate);
  const endDate = clean(value?.endDate);
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) return null;
  return Object.freeze({ startDate, endDate });
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function stableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : null;
}

function uniqueTexts(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(clean).filter(Boolean))].sort();
}

function normalizeBusinessText(value) {
  return clean(value)?.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ') || '';
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function reviewContractError(code) {
  const error = new Error(code);
  error.name = 'RecommendationHumanReviewContractError';
  error.code = code;
  return error;
}
