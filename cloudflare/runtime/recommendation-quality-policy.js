export const RECOMMENDATION_QUALITY_POLICY_SCHEMA_VERSION = 'recommendation-quality-governance-v1';

export const RECOMMENDATION_SUPPRESSION_PRECEDENCE = Object.freeze([
  'profile_store_integrity',
  'source_data_quality',
  'existing_entity_collision',
  'semantic_recommendation_collision',
  'exact_fingerprint_duplicate',
  'open_governance_collision',
  'semantic_governance_collision',
  'analysis_window_cooldown',
  'recommendation_candidate',
]);

const OPEN_STATUSES = new Set(['proposed', 'approved', 'applying', 'applied']);
const REPEAT_TERMINAL_STATUSES = new Set(['rejected', 'failed', 'reverted']);

export function applyRecommendationQualityPolicy({ payload, history = [], storeId } = {}) {
  const profileId = text(payload?.profile?.profileId);
  const responseStoreId = text(payload?.storeId);
  const routeStoreId = text(storeId);
  const range = normalizeRange(payload?.range);
  const records = history
    .filter((record) => !profileId || !text(record?.profileId) || text(record.profileId) === profileId)
    .map(normalizeHistoryRecord);

  const semanticActionSets = new Map();
  for (const item of payload?.items || []) {
    if (!item?.recommendation) continue;
    const semanticKey = semanticKeyFromItem(item);
    if (!semanticKey) continue;
    if (!semanticActionSets.has(semanticKey)) semanticActionSets.set(semanticKey, new Set());
    semanticActionSets.get(semanticKey).add(text(item.recommendation.actionType));
  }

  const counts = {
    duplicateSuppressionCount: 0,
    alreadyGovernedSuppressionCount: 0,
    proposedActionConflictCount: 0,
    approvedNotExecutedCount: 0,
    semanticConflictCount: 0,
    recentRejectionCooldownCount: 0,
    repeatedSuggestionCooldownCount: 0,
    profileStoreIntegrityMismatchCount: 0,
  };

  const integrityMismatch = !profileId || !routeStoreId || !responseStoreId || responseStoreId !== routeStoreId;
  const items = (payload?.items || []).map((item) => {
    if (!item?.recommendation) return item;

    if (integrityMismatch) {
      counts.profileStoreIntegrityMismatchCount += 1;
      return suppress(item, 'profile_store_integrity_mismatch',
        'Recommendation suppressed because response store/profile integrity does not match the authenticated store route.');
    }

    const actionType = text(item.recommendation.actionType);
    const entityId = text(item.recommendation.entityId || item?.entity?.entityId);
    const fingerprint = text(item.fingerprint);
    const semanticKey = semanticKeyFromItem(item);

    if (semanticKey && (semanticActionSets.get(semanticKey)?.size || 0) > 1) {
      counts.semanticConflictCount += 1;
      return suppress(item, 'semantic_recommendation_conflict',
        'Recommendation suppressed because the same normalized semantic candidate produced conflicting action types in this analysis window.');
    }

    const exactOpen = records.find((record) => fingerprint
      && record.recommendationFingerprint === fingerprint
      && OPEN_STATUSES.has(record.status));
    if (exactOpen) {
      counts.duplicateSuppressionCount += 1;
      return suppress(item, 'duplicate_recommendation',
        'The same deterministic recommendation is already present in the governance queue.', exactOpen);
    }

    const sameEntityOpen = records.find((record) => record.entityId === entityId
      && record.actionType === actionType
      && OPEN_STATUSES.has(record.status));
    if (sameEntityOpen?.status === 'proposed') {
      counts.proposedActionConflictCount += 1;
      return suppress(item, 'proposed_action_conflict',
        'Recommendation suppressed because an open proposed action already exists for this entity and action type.', sameEntityOpen);
    }
    if (sameEntityOpen?.status === 'approved' && !sameEntityOpen.appliedAt) {
      counts.approvedNotExecutedCount += 1;
      return suppress(item, 'approved_not_executed',
        'Recommendation suppressed because governance already approved this candidate but Amazon execution has not occurred.', sameEntityOpen);
    }
    if (sameEntityOpen) {
      counts.alreadyGovernedSuppressionCount += 1;
      return suppress(item, 'already_governed_action',
        'An open governance action already exists for this entity and action type.', sameEntityOpen);
    }

    const semanticOpen = semanticKey
      ? records.find((record) => record.semanticKey === semanticKey
          && record.actionType && record.actionType !== actionType
          && OPEN_STATUSES.has(record.status))
      : null;
    if (semanticOpen) {
      counts.semanticConflictCount += 1;
      return suppress(item, 'semantic_governance_conflict',
        'Recommendation suppressed because an open governance action with a conflicting action type already exists for the same normalized semantic candidate.', semanticOpen);
    }

    const recentRejected = records.find((record) => record.status === 'rejected'
      && sameCandidate(record, { entityId, actionType, semanticKey, fingerprint })
      && withinAnalysisWindow(record.updatedAt || record.createdAt, range));
    if (recentRejected) {
      counts.recentRejectionCooldownCount += 1;
      return suppress(item, 'recent_rejection_cooldown',
        'Recommendation suppressed because the same candidate was rejected inside the current recommendation analysis window.', recentRejected, range);
    }

    const repeatedTerminal = records.find((record) => REPEAT_TERMINAL_STATUSES.has(record.status)
      && sameCandidate(record, { entityId, actionType, semanticKey, fingerprint })
      && withinAnalysisWindow(record.updatedAt || record.createdAt, range));
    if (repeatedTerminal) {
      counts.repeatedSuggestionCooldownCount += 1;
      return suppress(item, 'repeated_suggestion_cooldown',
        'Recommendation suppressed because the same candidate already reached a terminal governance state inside the current recommendation analysis window.', repeatedTerminal, range);
    }

    return item;
  });

  return {
    items,
    counts,
    contract: {
      schemaVersion: RECOMMENDATION_QUALITY_POLICY_SCHEMA_VERSION,
      suppressionPrecedence: [...RECOMMENDATION_SUPPRESSION_PRECEDENCE],
      semanticIdentity: 'profile + normalized_search_term',
      cooldown: {
        basis: 'current_recommendation_analysis_window',
        startDate: range.startDate,
        endDate: range.endDate,
        arbitraryDayCount: false,
      },
      approvedMeansExecuted: false,
      amazonMutationAuthorized: false,
    },
  };
}

function suppress(item, code, reason, governanceAction = null, range = null) {
  return {
    ...item,
    recommendation: null,
    fingerprint: null,
    suppression: {
      code,
      reason,
      governanceAction: governanceAction ? publicRecord(governanceAction) : undefined,
      cooldownWindow: range?.valid ? { startDate: range.startDate, endDate: range.endDate } : undefined,
      governancePersistenceAllowed: false,
      amazonMutationAuthorized: false,
    },
  };
}

function normalizeHistoryRecord(record = {}) {
  const proposed = plainObject(record.proposed) ? record.proposed : parseJson(record.proposedJson);
  return {
    actionId: text(record.actionId || record.action_id),
    profileId: text(record.profileId || record.profile_id),
    entityId: text(record.entityId || record.entity_id),
    actionType: text(record.actionType || record.action_type),
    status: text(record.status),
    createdAt: nullableText(record.createdAt || record.created_at),
    updatedAt: nullableText(record.updatedAt || record.updated_at),
    appliedAt: nullableText(record.appliedAt || record.applied_at),
    externalRequestId: nullableText(record.externalRequestId || record.external_request_id),
    recommendationFingerprint: text(record.recommendationFingerprint || record.recommendation_fingerprint),
    proposed,
    semanticKey: normalizeSemantic(record.semanticKey || proposed?.keywordText),
  };
}

function sameCandidate(record, candidate) {
  if (candidate.fingerprint && record.recommendationFingerprint === candidate.fingerprint) return true;
  if (candidate.entityId && record.entityId === candidate.entityId && record.actionType === candidate.actionType) return true;
  return Boolean(candidate.semanticKey && record.semanticKey === candidate.semanticKey && record.actionType === candidate.actionType);
}

function semanticKeyFromItem(item) {
  return normalizeSemantic(item?.entity?.normalizedSearchTerm || item?.recommendation?.proposed?.keywordText || item?.entity?.searchTerm);
}

function normalizeSemantic(value) {
  return text(value).toLowerCase().replace(/\s+/g, ' ');
}

function normalizeRange(value = {}) {
  const startDate = text(value?.startDate);
  const endDate = text(value?.endDate);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    && /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    && endDate >= startDate;
  return { startDate: valid ? startDate : null, endDate: valid ? endDate : null, valid };
}

function withinAnalysisWindow(value, range) {
  if (!range.valid) return false;
  const date = isoDate(value);
  return Boolean(date && date >= range.startDate && date <= range.endDate);
}

function isoDate(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function publicRecord(record) {
  return {
    actionId: record.actionId || null,
    status: record.status || null,
    entityId: record.entityId || null,
    actionType: record.actionType || null,
    recommendationFingerprint: record.recommendationFingerprint || null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    appliedAt: record.appliedAt || null,
    externalRequestId: record.externalRequestId || null,
  };
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return String(value ?? '').trim(); }
function nullableText(value) { const out = text(value); return out || null; }
