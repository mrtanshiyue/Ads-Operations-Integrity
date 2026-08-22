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

export function buildGovernedKeywordNegativeCandidateLibrary({ storeId, analysisScope, entries } = {}) {
  const scope = compactScope(analysisScope);
  const available = scope.candidateEmissionAuthorized === true;
  const source = Array.isArray(entries) ? entries : [];

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

  const items = source.map(toLibraryItem).sort(compareLibraryItem);
  return Object.freeze({
    schemaVersion: GOVERNED_KEYWORD_NEGATIVE_CANDIDATE_LIBRARY_SCHEMA_VERSION,
    storeId: text(storeId) || null,
    authority: AUTHORITY,
    status: Object.freeze({
      available: true,
      reasonCode: null,
      reasonText: null,
    }),
    analysisScope: scope,
    summary: Object.freeze({
      candidateCount: items.length,
      keywordCount: items.filter((item) => item.libraryFamily === 'keyword').length,
      negativeCount: items.filter((item) => item.libraryFamily === 'negative').length,
      staleEvidenceCandidateCount: items.filter((item) => item.staleEvidenceCount > 0).length,
    }),
    items: Object.freeze(items),
  });
}

function toLibraryItem(entry = {}) {
  const item = entry.item || {};
  const binding = entry.binding || {};
  const currentReview = entry.currentReview || null;
  const staleReviews = Array.isArray(entry.staleReviews) ? entry.staleReviews : [];
  const decisionPacket = entry.decisionPacket || null;
  const mapped = ACTION_MAP[text(item.actionType)];
  if (!mapped) throw libraryError('CANDIDATE_LIBRARY_ACTION_TYPE_UNSUPPORTED');
  if (item.itemClass !== 'recommendation_candidate') throw libraryError('CANDIDATE_LIBRARY_ITEM_CLASS_INVALID');
  const currentFingerprint = text(binding.recommendationFingerprint);
  if (!currentFingerprint) throw libraryError('CANDIDATE_LIBRARY_CURRENT_FINGERPRINT_REQUIRED');
  if (currentReview?.recommendationFingerprint && text(currentReview.recommendationFingerprint) !== currentFingerprint) {
    throw libraryError('CANDIDATE_LIBRARY_CURRENT_REVIEW_FINGERPRINT_MISMATCH');
  }
  for (const stale of staleReviews) {
    if (text(stale?.recommendationFingerprint) === currentFingerprint) {
      throw libraryError('CANDIDATE_LIBRARY_STALE_FINGERPRINT_MATCHES_CURRENT');
    }
  }

  return Object.freeze({
    inboxItemId: text(item.inboxItemId),
    libraryFamily: mapped.family,
    libraryKind: mapped.kind,
    candidateType: text(item.candidateType),
    actionType: text(item.actionType),
    matchScope: text(item.matchScope),
    value: text(item.value),
    priority: text(item.priority) || 'low',
    priorityScore: finiteOrNull(item.priorityScore),
    currentFingerprint,
    currentReviewState: text(currentReview?.state) || 'unreviewed',
    currentReviewPersisted: currentReview?.persisted === true,
    staleEvidenceCount: staleReviews.length,
    financiallyComparable: entry.financiallyComparable === true ? true : entry.financiallyComparable === false ? false : null,
    candidateEmissionAuthorized: true,
    analysisWindow: normalizeWindow(binding.analysisWindow),
    sourceImportIds: Object.freeze(uniqueTexts(binding.sourceImportIds)),
    sourceEvidenceSha256: text(binding.sourceEvidenceSha256),
    decisionPacketAvailable: decisionPacket?.schemaVersion === 'recommendation-decision-packet-v1',
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
