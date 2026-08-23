export const HISTORICAL_REVIEW_LEARNING_SCHEMA_VERSION = 'historical-review-learning-v1';

const AUTHORITY = Object.freeze({
  readOnly: true,
  adaptiveLearningAuthorized: false,
  ruleMutationAuthorized: false,
  recommendationMutationAuthorized: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function buildHistoricalReviewLearning({ storeId, historicalEntries, currentEntries } = {}) {
  const history = Array.isArray(historicalEntries) ? historicalEntries : [];
  const current = Array.isArray(currentEntries) ? currentEntries : [];
  const currentByContext = new Map();
  for (const entry of current) {
    const contextKey = text(entry?.contextKey);
    const item = entry?.item || null;
    if (!contextKey || !item) continue;
    if (currentByContext.has(contextKey)) throw learningError('HISTORICAL_LEARNING_CURRENT_CONTEXT_DUPLICATE');
    currentByContext.set(contextKey, item);
  }

  const grouped = new Map();
  let unusableHistoricalRecordCount = 0;
  for (const entry of history) {
    const contextKey = text(entry?.contextKey);
    const review = entry?.review || null;
    const fingerprint = text(review?.recommendationFingerprint);
    if (!contextKey || !review || !fingerprint) {
      unusableHistoricalRecordCount += 1;
      continue;
    }
    const values = grouped.get(contextKey) || [];
    values.push(review);
    grouped.set(contextKey, values);
  }

  const contextKeys = new Set([...grouped.keys(), ...currentByContext.keys()]);
  const contexts = [];
  for (const contextKey of contextKeys) {
    const reviews = [...(grouped.get(contextKey) || [])].sort(compareReviewTime);
    const currentItem = currentByContext.get(contextKey) || null;
    contexts.push(buildContext({ contextKey, reviews, currentItem }));
  }
  contexts.sort(compareContext);

  const usableHistoricalRecordCount = history.length - unusableHistoricalRecordCount;
  const historicalContexts = contexts.filter((context) => context.historicalRecordCount > 0);
  const historicalOnlyContexts = contexts.filter((context) => context.historicalRecordCount > 0 && !context.currentCandidateActive);
  const recurrentContexts = contexts.filter((context) => context.recurrent === true);
  const currentMatchedRecordCount = contexts.reduce((sum, context) => sum + (context.currentMatchedRecordCount || 0), 0);
  const staleEvidenceRecordCount = contexts.reduce((sum, context) => sum + (context.staleEvidenceCount || 0), 0);
  const stateCounts = Object.freeze(historyStateCounts(history));

  return Object.freeze({
    schemaVersion: HISTORICAL_REVIEW_LEARNING_SCHEMA_VERSION,
    storeId: text(storeId) || null,
    authority: AUTHORITY,
    semantics: Object.freeze({
      recurrenceIsEffectiveness: false,
      acknowledgedMeansApproved: false,
      acknowledgedMeansExecuted: false,
      needsReviewMeansRejected: false,
      approvedMeansExecuted: false,
      approvedMeansSuccessful: false,
      rejectedMeansFailed: false,
      finalDispositionIsEffectiveness: false,
      historicalOutcomeAvailable: false,
      automaticFeedbackIntoRecommendations: false,
    }),
    summary: Object.freeze({
      historicalRecordCount: history.length,
      usableHistoricalRecordCount,
      unusableHistoricalRecordCount,
      historicalContextCount: historicalContexts.length,
      currentContextCount: currentByContext.size,
      recurrentContextCount: recurrentContexts.length,
      currentMatchedRecordCount,
      staleEvidenceRecordCount,
      historicalOnlyContextCount: historicalOnlyContexts.length,
      stateCounts,
    }),
    contexts: Object.freeze(contexts),
  });
}

function buildContext({ contextKey, reviews, currentItem }) {
  const currentPacket = currentItem?.decisionPacket || null;
  const currentFingerprint = text(currentItem?.recommendationFingerprint || currentPacket?.reviewEvidence?.currentFingerprint) || null;
  if (currentItem && !currentFingerprint) throw learningError('HISTORICAL_LEARNING_CURRENT_FINGERPRINT_REQUIRED');
  if (currentItem && currentPacket?.schemaVersion !== 'recommendation-decision-packet-v1') {
    throw learningError('HISTORICAL_LEARNING_DECISION_PACKET_REQUIRED');
  }
  if (currentItem && (
    currentPacket?.authority?.readOnly !== true
    || currentPacket?.authority?.executionAuthorized !== false
    || currentPacket?.authority?.amazonMutationAuthorized !== false
  )) throw learningError('HISTORICAL_LEARNING_DECISION_PACKET_AUTHORITY_INVALID');

  const exactCurrent = currentFingerprint
    ? reviews.filter((review) => text(review?.recommendationFingerprint) === currentFingerprint)
    : [];
  const stale = currentFingerprint
    ? reviews.filter((review) => text(review?.recommendationFingerprint) !== currentFingerprint)
    : [];
  const distinctFingerprints = uniqueTexts(reviews.map((review) => review?.recommendationFingerprint));
  const stateCounts = historyStateCounts(reviews.map((review) => ({ review })));
  const latest = reviews[0] || null;
  const earliest = reviews.length ? reviews[reviews.length - 1] : null;
  const identity = currentItem ? identityFromCurrent(currentItem) : identityFromHistorical(latest);
  const historicalRecordCount = reviews.length;
  const recurrent = historicalRecordCount + (currentItem ? 1 : 0) > 1;

  return Object.freeze({
    contextKey,
    ...identity,
    currentCandidateActive: Boolean(currentItem),
    currentFingerprint,
    currentReviewState: currentItem ? text(currentItem?.review?.state) || 'unreviewed' : null,
    currentReviewPersisted: currentItem ? currentItem?.review?.persisted === true : null,
    historicalRecordCount,
    distinctFingerprintCount: distinctFingerprints.length,
    currentMatchedRecordCount: currentItem ? exactCurrent.length : null,
    staleEvidenceCount: currentItem ? stale.length : null,
    acknowledgedCount: stateCounts.acknowledged,
    needsReviewCount: stateCounts.needs_review,
    approvedCount: stateCounts.approved,
    rejectedCount: stateCounts.rejected,
    unsupportedStateCount: stateCounts.unsupported,
    firstObservedAt: timestampOf(earliest),
    latestObservedAt: timestampOf(latest),
    latestHistoricalReview: latest ? Object.freeze({
      reviewId: text(latest.reviewId) || null,
      recommendationFingerprint: text(latest.recommendationFingerprint) || null,
      state: normalizedState(latest.state),
      reviewedAt: text(latest.reviewedAt) || null,
      updatedAt: text(latest.updatedAt) || null,
      sourceEvidenceSha256: text(latest.sourceEvidenceSha256) || null,
    }) : null,
    recurrent,
    currentEvidenceDrift: currentItem ? stale.length > 0 : null,
    authority: AUTHORITY,
  });
}

function identityFromCurrent(item) {
  const recommendation = item?.decisionPacket?.recommendation || {};
  return {
    inboxItemId: text(item?.inboxItemId || recommendation.inboxItemId) || null,
    actionType: text(recommendation.actionType) || null,
    candidateType: text(recommendation.candidateType) || null,
    matchScope: text(recommendation.matchScope) || null,
    value: text(recommendation.value) || null,
  };
}

function identityFromHistorical(review) {
  const descriptor = review?.sourceEvidence?.descriptor || {};
  return {
    inboxItemId: text(descriptor.inboxItemId) || null,
    actionType: text(descriptor.actionType) || null,
    candidateType: text(descriptor.candidateType) || null,
    matchScope: text(descriptor.matchScope) || null,
    value: text(descriptor.value) || null,
  };
}

function historyStateCounts(entries) {
  const counts = { acknowledged: 0, needs_review: 0, approved: 0, rejected: 0, unsupported: 0 };
  for (const entry of entries) {
    const review = entry?.review || entry;
    const state = normalizedState(review?.state);
    if (state === 'acknowledged') counts.acknowledged += 1;
    else if (state === 'needs_review') counts.needs_review += 1;
    else if (state === 'approved') counts.approved += 1;
    else if (state === 'rejected') counts.rejected += 1;
    else counts.unsupported += 1;
  }
  return counts;
}

function normalizedState(value) {
  const state = text(value);
  if (state === 'acknowledged') return 'acknowledged';
  if (state === 'needs_review' || state === 'open') return 'needs_review';
  if (state === 'approved') return 'approved';
  if (state === 'rejected' || state === 'dismissed') return 'rejected';
  return 'unsupported';
}

function timestampOf(review) {
  return text(review?.updatedAt || review?.reviewedAt || review?.createdAt) || null;
}

function compareReviewTime(left, right) {
  return String(timestampOf(right) || '').localeCompare(String(timestampOf(left) || ''))
    || String(right?.reviewId || '').localeCompare(String(left?.reviewId || ''));
}

function compareContext(left, right) {
  return Number(right.currentCandidateActive) - Number(left.currentCandidateActive)
    || Number(right.recurrent) - Number(left.recurrent)
    || nullableCount(right.staleEvidenceCount) - nullableCount(left.staleEvidenceCount)
    || right.historicalRecordCount - left.historicalRecordCount
    || String(right.latestObservedAt || '').localeCompare(String(left.latestObservedAt || ''))
    || String(left.actionType || '').localeCompare(String(right.actionType || ''))
    || String(left.value || '').localeCompare(String(right.value || ''))
    || String(left.contextKey).localeCompare(String(right.contextKey));
}

function nullableCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

function uniqueTexts(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))].sort();
}

function text(value) {
  return String(value ?? '').trim();
}

function learningError(code) {
  const error = new Error(code);
  error.name = 'HistoricalReviewLearningError';
  error.code = code;
  return error;
}
