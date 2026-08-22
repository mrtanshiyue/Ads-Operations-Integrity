export const GOVERNED_KEYWORD_NEGATIVE_CANDIDATE_LIBRARY_SCHEMA_VERSION = 'governed-keyword-negative-candidate-library-v1';

const AUTHORITY = Object.freeze({
  readOnly: true,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

const ACTION_MAP = Object.freeze({
  'keyword.review_harvest': Object.freeze({ family: 'keyword', kind: 'harvest' }),
  'keyword.review_scale': Object.freeze({ family: 'keyword', kind: 'scale' }),
  'negative_keyword.review_exact': Object.freeze({ family: 'negative', kind: 'exact_negative' }),
  'negative_keyword.review_phrase': Object.freeze({ family: 'negative', kind: 'phrase_negative_review' }),
});

const PRIORITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

export function buildGovernedKeywordNegativeCandidateLibrary({ storeId, analysisScope, items } = {}) {
  const scope = compactScope(analysisScope);
  const available = scope.candidateEmissionAuthorized === true;
  const source = Array.isArray(items) ? items : [];

  if (!available) {
    return Object.freeze({
      schemaVersion: GOVERNED_KEYWORD_NEGATIVE_CANDIDATE_LIBRARY_SCHEMA_VERSION,
      storeId: text(storeId) || null,
      authority: AUTHORITY,
      status: Object.freeze({
        available: false,
        reasonCode: 'candidate_emission_not_authorized',
        reasonText: 'Current analysis scope does not authorize governed recommendation candidate emission.',
      }),
      analysisScope: scope,
      summary: Object.freeze({
        candidateCount: null,
        keywordCount: null,
        negativeCount: null,
        staleEvidenceCandidateCount: null,
      }),
      items: Object.freeze([]),
    });
  }

  const libraryItems = source.map(toLibraryItem).sort(compareLibraryItem);
  return Object.freeze({
    schemaVersion: GOVERNED_KEYWORD_NEGATIVE_CANDIDATE_LIBRARY_SCHEMA_VERSION,
    storeId: text(storeId) || null,
    authority: AUTHORITY,
    status: Object.freeze({ available: true, reasonCode: null, reasonText: null }),
    analysisScope: scope,
    summary: Object.freeze({
      candidateCount: libraryItems.length,
      keywordCount: libraryItems.filter((item) => item.libraryFamily === 'keyword').length,
      negativeCount: libraryItems.filter((item) => item.libraryFamily === 'negative').length,
      staleEvidenceCandidateCount: libraryItems.filter((item) => item.staleEvidenceCount > 0).length,
    }),
    items: Object.freeze(libraryItems),
  });
}

function toLibraryItem(entry = {}) {
  const packet = entry?.decisionPacket || {};
  if (packet?.schemaVersion !== 'recommendation-decision-packet-v1') {
    throw libraryError('CANDIDATE_LIBRARY_DECISION_PACKET_REQUIRED');
  }
  if (packet?.authority?.readOnly !== true
    || packet?.authority?.executionAuthorized !== false
    || packet?.authority?.amazonMutationAuthorized !== false) {
    throw libraryError('CANDIDATE_LIBRARY_DECISION_PACKET_AUTHORITY_INVALID');
  }

  const recommendation = packet.recommendation || {};
  const reviewEvidence = packet.reviewEvidence || {};
  const priorityEvidence = packet.priorityEvidence || {};
  const financial = packet.financialComparability || {};
  const sourceEvidence = packet.sourceEvidence || {};
  const actionType = text(recommendation.actionType);
  const mapped = ACTION_MAP[actionType];
  if (!mapped) throw libraryError('CANDIDATE_LIBRARY_ACTION_TYPE_UNSUPPORTED');

  const inboxItemId = text(entry?.inboxItemId);
  if (!inboxItemId || inboxItemId !== text(recommendation.inboxItemId)) {
    throw libraryError('CANDIDATE_LIBRARY_INBOX_ID_MISMATCH');
  }

  const currentFingerprint = text(reviewEvidence.currentFingerprint);
  if (!currentFingerprint) throw libraryError('CANDIDATE_LIBRARY_CURRENT_FINGERPRINT_REQUIRED');
  if (text(entry?.recommendationFingerprint) !== currentFingerprint) {
    throw libraryError('CANDIDATE_LIBRARY_CURRENT_FINGERPRINT_MISMATCH');
  }

  const staleEvidence = Array.isArray(reviewEvidence.staleEvidence) ? reviewEvidence.staleEvidence : [];
  if (Number(reviewEvidence.staleEvidenceCount) !== staleEvidence.length) {
    throw libraryError('CANDIDATE_LIBRARY_STALE_COUNT_MISMATCH');
  }
  for (const stale of staleEvidence) {
    if (text(stale?.recommendationFingerprint) === currentFingerprint || stale?.inheritedAsCurrent !== false || stale?.stale !== true) {
      throw libraryError('CANDIDATE_LIBRARY_STALE_INHERITANCE_INVALID');
    }
  }

  const reviewState = text(entry?.review?.state) || 'unreviewed';
  if (reviewState !== text(reviewEvidence.priorReviewState || 'unreviewed')) {
    throw libraryError('CANDIDATE_LIBRARY_REVIEW_STATE_MISMATCH');
  }

  return Object.freeze({
    inboxItemId,
    libraryFamily: mapped.family,
    libraryKind: mapped.kind,
    candidateType: text(recommendation.candidateType),
    actionType,
    matchScope: text(recommendation.matchScope),
    value: text(recommendation.value),
    priority: text(priorityEvidence.priority) || 'low',
    priorityScore: finiteOrNull(priorityEvidence.priorityScore),
    currentFingerprint,
    currentReviewState: reviewState,
    currentReviewPersisted: entry?.review?.persisted === true,
    staleEvidenceCount: staleEvidence.length,
    financiallyComparable: financial.financiallyComparable === true ? true : financial.financiallyComparable === false ? false : null,
    candidateEmissionAuthorized: true,
    analysisWindow: normalizeWindow(sourceEvidence.analysisWindow),
    sourceImportIds: Object.freeze(uniqueTexts(sourceEvidence.sourceImportIds)),
    sourceEvidenceSha256: text(sourceEvidence.sourceEvidenceSha256) || null,
    decisionPacketAvailable: true,
    authority: AUTHORITY,
  });
}

function compareLibraryItem(left, right) {
  return (PRIORITY_RANK[left.priority] ?? 4) - (PRIORITY_RANK[right.priority] ?? 4)
    || String(left.libraryFamily).localeCompare(String(right.libraryFamily))
    || String(left.libraryKind).localeCompare(String(right.libraryKind))
    || String(left.value || '').localeCompare(String(right.value || ''))
    || String(left.inboxItemId || '').localeCompare(String(right.inboxItemId || ''));
}

function compactScope(scope) {
  return Object.freeze({
    complete: scope?.complete === true,
    financiallyComparable: scope?.financiallyComparable === true ? true : scope?.financiallyComparable === false ? false : null,
    candidateEmissionAuthorized: scope?.candidateEmissionAuthorized === true,
    overflowObserved: scope?.overflowObserved === true,
    reasons: Object.freeze(uniqueTexts(scope?.reasons)),
  });
}

function normalizeWindow(value) {
  const startDate = text(value?.startDate);
  const endDate = text(value?.endDate);
  if (!startDate || !endDate) return null;
  return Object.freeze({ startDate, endDate });
}

function uniqueTexts(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(text).filter(Boolean))].sort();
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return String(value ?? '').trim();
}

function libraryError(code) {
  const error = new Error(code);
  error.name = 'GovernedKeywordNegativeCandidateLibraryError';
  error.code = code;
  return error;
}
