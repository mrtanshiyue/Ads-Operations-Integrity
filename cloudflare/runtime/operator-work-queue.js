export const OPERATOR_WORK_QUEUE_SCHEMA_VERSION = 'daily-operator-work-queue-v1';

export const OPERATOR_WORK_QUEUE_AUTHORITY = Object.freeze({
  readOnly: true,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

const CLASS_ORDER = Object.freeze({
  authoritative_read_failure: 0,
  evidence_gap: 1,
  stale_review_evidence: 2,
  needs_review: 3,
  high_unreviewed: 4,
  other_unreviewed: 5,
  acknowledged_only: 6,
  no_active_queue: 7,
});

export function buildOperatorWorkQueue(decisionQueue) {
  const requestedDateRange = normalizeDateRange(decisionQueue?.dateRange);
  const stores = Array.isArray(decisionQueue?.stores) ? decisionQueue.stores : [];
  const rows = stores.map((store) => buildOperatorWorkQueueRow(store, requestedDateRange));
  rows.sort(compareRows);
  return {
    schemaVersion: OPERATOR_WORK_QUEUE_SCHEMA_VERSION,
    generatedAt: decisionQueue?.generatedAt || null,
    requestedDateRange,
    authority: OPERATOR_WORK_QUEUE_AUTHORITY,
    rows,
  };
}

export function buildOperatorWorkQueueRow(store, requestedDateRange) {
  const identity = {
    storeId: text(store?.storeId),
    storeCode: text(store?.storeCode),
    displayName: text(store?.displayName),
  };
  const range = normalizeDateRange(requestedDateRange || store?.dateRange);

  if (!store || store.unavailable === true || store.evidenceState !== 'available') {
    return row(identity, range, {
      queueClass: 'authoritative_read_failure',
      priority: 1,
      evidenceState: 'unavailable',
      reasonCode: text(store?.error?.code) || 'authoritative_read_failure',
      reasonText: `Authoritative decision evidence is unavailable${store?.error?.code ? ` · ${store.error.code}` : ''}`,
      counts: nullCounts(),
      store,
    });
  }

  const counts = authoritativeCounts(store);
  if (!counts || store.analysisScopeComplete === null || store.analysisScopeComplete === undefined
      || store.financiallyComparable === null || store.financiallyComparable === undefined
      || store.candidateEmissionAuthorized === null || store.candidateEmissionAuthorized === undefined) {
    return row(identity, range, {
      queueClass: 'evidence_gap',
      priority: 1,
      evidenceState: 'unavailable',
      reasonCode: 'operator_queue_evidence_gap',
      reasonText: 'Required authoritative queue evidence is incomplete or internally inconsistent',
      counts: nullCounts(),
      store,
    });
  }

  const otherUnreviewedCount = counts.unreviewedCount - counts.highUnreviewedCount;
  const normalizedCounts = { ...counts, otherUnreviewedCount };

  if (counts.staleReviewEvidenceCount > 0) {
    return row(identity, range, {
      queueClass: 'stale_review_evidence', priority: 2, evidenceState: 'available',
      reasonCode: 'stale_review_evidence',
      reasonText: `${counts.staleReviewEvidenceCount} stale review evidence record${counts.staleReviewEvidenceCount === 1 ? '' : 's'} require operator attention`,
      counts: normalizedCounts, store,
    });
  }
  if (counts.needsReviewCount > 0) {
    return row(identity, range, {
      queueClass: 'needs_review', priority: 2, evidenceState: 'available',
      reasonCode: 'needs_review',
      reasonText: `${counts.needsReviewCount} current recommendation${counts.needsReviewCount === 1 ? '' : 's'} need review`,
      counts: normalizedCounts, store,
    });
  }
  if (counts.highUnreviewedCount > 0) {
    return row(identity, range, {
      queueClass: 'high_unreviewed', priority: 3, evidenceState: 'available',
      reasonCode: 'critical_high_unreviewed',
      reasonText: `${counts.highUnreviewedCount} critical/high recommendation${counts.highUnreviewedCount === 1 ? '' : 's'} remain unreviewed`,
      counts: normalizedCounts, store,
    });
  }
  if (otherUnreviewedCount > 0) {
    return row(identity, range, {
      queueClass: 'other_unreviewed', priority: 4, evidenceState: 'available',
      reasonCode: 'other_unreviewed',
      reasonText: `${otherUnreviewedCount} other recommendation${otherUnreviewedCount === 1 ? '' : 's'} remain unreviewed`,
      counts: normalizedCounts, store,
    });
  }
  if (counts.acknowledgedCount > 0) {
    return row(identity, range, {
      queueClass: 'acknowledged_only', priority: 5, evidenceState: 'available',
      reasonCode: 'acknowledged_only',
      reasonText: 'Only acknowledged recommendations remain; there is no active review queue',
      counts: normalizedCounts, store,
    });
  }
  return row(identity, range, {
    queueClass: 'no_active_queue', priority: 5, evidenceState: 'available',
    reasonCode: store.candidateEmissionAuthorized === false ? 'candidate_emission_not_authorized' : 'no_active_queue',
    reasonText: store.candidateEmissionAuthorized === false
      ? 'The requested analysis scope does not authorize recommendation candidate emission'
      : 'No active recommendation review queue exists for the requested date range',
    counts: normalizedCounts, store,
  });
}

function row(identity, requestedDateRange, { queueClass, priority, evidenceState, reasonCode, reasonText, counts, store }) {
  return {
    ...identity,
    queueClass,
    priority,
    evidenceState,
    needsReviewCount: counts?.needsReviewCount ?? null,
    staleReviewEvidenceCount: counts?.staleReviewEvidenceCount ?? null,
    highUnreviewedCount: counts?.highUnreviewedCount ?? null,
    otherUnreviewedCount: counts?.otherUnreviewedCount ?? null,
    acknowledgedCount: counts?.acknowledgedCount ?? null,
    recommendationCandidateCount: counts?.recommendationCandidateCount ?? null,
    criticalHighCandidateCount: counts?.criticalHighCandidateCount ?? null,
    financiallyComparable: evidenceState === 'available' ? store?.financiallyComparable === true : null,
    candidateEmissionAuthorized: evidenceState === 'available' ? store?.candidateEmissionAuthorized === true : null,
    analysisScopeComplete: evidenceState === 'available' ? store?.analysisScopeComplete === true : null,
    requestedDateRange,
    reasonCode,
    reasonText,
    authority: OPERATOR_WORK_QUEUE_AUTHORITY,
  };
}

function authoritativeCounts(store) {
  const keys = [
    'needsReviewCount', 'staleReviewEvidenceCount', 'highUnreviewedCount', 'unreviewedCount',
    'acknowledgedCount', 'recommendationCandidateCount', 'criticalHighCandidateCount',
  ];
  const values = Object.fromEntries(keys.map((key) => [key, count(store?.[key])]));
  if (Object.values(values).some((value) => value === null)) return null;
  if (values.highUnreviewedCount > values.unreviewedCount) return null;
  if (values.needsReviewCount + values.acknowledgedCount + values.unreviewedCount > values.recommendationCandidateCount) return null;
  if (values.criticalHighCandidateCount > values.recommendationCandidateCount) return null;
  return values;
}

function nullCounts() {
  return {
    needsReviewCount: null,
    staleReviewEvidenceCount: null,
    highUnreviewedCount: null,
    otherUnreviewedCount: null,
    acknowledgedCount: null,
    recommendationCandidateCount: null,
    criticalHighCandidateCount: null,
  };
}

function compareRows(left, right) {
  const priority = left.priority - right.priority;
  if (priority) return priority;
  const classOrder = (CLASS_ORDER[left.queueClass] ?? 99) - (CLASS_ORDER[right.queueClass] ?? 99);
  if (classOrder) return classOrder;
  const salient = salientCount(right) - salientCount(left);
  if (salient) return salient;
  const candidates = safeSortCount(right.recommendationCandidateCount) - safeSortCount(left.recommendationCandidateCount);
  if (candidates) return candidates;
  return String(left.storeCode || left.storeId || '').localeCompare(String(right.storeCode || right.storeId || ''));
}

function salientCount(rowValue) {
  if (rowValue.queueClass === 'stale_review_evidence') return safeSortCount(rowValue.staleReviewEvidenceCount);
  if (rowValue.queueClass === 'needs_review') return safeSortCount(rowValue.needsReviewCount);
  if (rowValue.queueClass === 'high_unreviewed') return safeSortCount(rowValue.highUnreviewedCount);
  if (rowValue.queueClass === 'other_unreviewed') return safeSortCount(rowValue.otherUnreviewedCount);
  if (rowValue.queueClass === 'acknowledged_only') return safeSortCount(rowValue.acknowledgedCount);
  return 0;
}

function safeSortCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}
function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}
function normalizeDateRange(range) {
  const startDate = text(range?.startDate);
  const endDate = text(range?.endDate);
  return startDate && endDate ? { startDate, endDate } : null;
}
