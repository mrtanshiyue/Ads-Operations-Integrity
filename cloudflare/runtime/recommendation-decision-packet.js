export const RECOMMENDATION_DECISION_PACKET_SCHEMA_VERSION = 'recommendation-decision-packet-v1';

const PACKET_AUTHORITY = Object.freeze({
  sourceKind: 'csv_recommendation_inbox_v1',
  readOnly: true,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
  optimizationActionPersistenceAuthorized: false,
});

export function buildRecommendationDecisionPacket({
  item,
  binding,
  currentReview = null,
  staleReviews = [],
  analysisScope = null,
} = {}) {
  if (item?.itemClass !== 'recommendation_candidate') throw packetError('DECISION_PACKET_RECOMMENDATION_REQUIRED');
  if (!binding?.recommendationFingerprint || !binding?.contextFingerprint || !binding?.sourceEvidenceSha256) {
    throw packetError('DECISION_PACKET_BINDING_REQUIRED');
  }
  if (currentReview?.persisted === true && currentReview?.recommendationFingerprint !== binding.recommendationFingerprint) {
    throw packetError('DECISION_PACKET_CURRENT_REVIEW_FINGERPRINT_MISMATCH');
  }

  const stale = Array.isArray(staleReviews) ? staleReviews.map((review) => normalizeStaleReview(review, binding)) : [];
  const evidence = item?.evidenceSummary && typeof item.evidenceSummary === 'object' ? item.evidenceSummary : {};
  const scope = analysisScope && typeof analysisScope === 'object' ? analysisScope : {};
  const sourceEvidence = parseSourceEvidence(binding.sourceEvidenceJson);

  return Object.freeze({
    schemaVersion: RECOMMENDATION_DECISION_PACKET_SCHEMA_VERSION,
    authority: PACKET_AUTHORITY,
    recommendation: Object.freeze({
      inboxItemId: text(item?.inboxItemId) || null,
      candidateType: text(item?.candidateType) || null,
      actionType: text(item?.actionType) || null,
      matchScope: text(item?.matchScope) || null,
      value: text(item?.value) || null,
    }),
    why: Object.freeze({
      reason: nullableText(item?.reason),
      recommendationGoverned: evidence?.recommendationGoverned === true,
      provenanceGate: nullableText(evidence?.provenanceGate),
    }),
    priorityEvidence: Object.freeze({
      priority: nullableText(item?.priority),
      priorityScore: nullableValue(item?.priorityScore),
      spendMicros: nullableValue(evidence?.spendMicros),
      salesMicros: nullableValue(evidence?.salesMicros),
      orders: nullableValue(evidence?.orders),
      clicks: nullableValue(evidence?.clicks),
      acos: nullableValue(evidence?.acos),
      cvr: nullableValue(evidence?.cvr),
    }),
    root: Object.freeze({
      rootStates: Object.freeze(copyArray(evidence?.rootStates)),
      impactedRoots: Object.freeze(copyObjects(item?.impactedRoots)),
    }),
    lifecycle: Object.freeze({
      items: Object.freeze(copyObjects(item?.lifecycleContext)),
    }),
    financialComparability: Object.freeze({
      financiallyComparable: booleanOrNull(scope?.financiallyComparable),
      analysisScopeComplete: booleanOrNull(scope?.complete),
      candidateEmissionAuthorized: booleanOrNull(scope?.candidateEmissionAuthorized),
      reasons: Object.freeze(copyArray(scope?.reasons)),
    }),
    reviewEvidence: Object.freeze({
      currentFingerprint: binding.recommendationFingerprint,
      contextFingerprint: binding.contextFingerprint,
      sourceEvidenceSha256: binding.sourceEvidenceSha256,
      priorReviewState: currentReview?.persisted === true ? nullableText(currentReview?.state) : 'unreviewed',
      currentRationale: currentReview?.persisted === true ? nullableText(currentReview?.note) : null,
      currentReview: currentReview?.persisted === true ? Object.freeze({ ...currentReview }) : null,
      staleEvidenceCount: stale.length,
      staleEvidence: Object.freeze(stale),
    }),
    sourceEvidence: Object.freeze({
      sourceKind: nullableText(binding?.sourceKind),
      analysisWindow: binding?.analysisWindow ? Object.freeze({ ...binding.analysisWindow }) : null,
      sourceImportIds: Object.freeze(copyArray(binding?.sourceImportIds)),
      provenanceGate: nullableText(evidence?.provenanceGate),
      sourceEvidenceSha256: binding.sourceEvidenceSha256,
      sourceEvidenceJson: nullableText(binding.sourceEvidenceJson),
      snapshot: sourceEvidence,
    }),
  });
}

function normalizeStaleReview(review, binding) {
  if (!review || typeof review !== 'object') throw packetError('DECISION_PACKET_STALE_REVIEW_INVALID');
  if (!review.recommendationFingerprint) throw packetError('DECISION_PACKET_STALE_FINGERPRINT_REQUIRED');
  if (review.recommendationFingerprint === binding.recommendationFingerprint) {
    throw packetError('DECISION_PACKET_STALE_REVIEW_MATCHES_CURRENT');
  }
  return Object.freeze({
    ...review,
    rationale: nullableText(review?.note),
    stale: true,
    inheritedAsCurrent: false,
  });
}

function parseSourceEvidence(value) {
  const raw = nullableText(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? deepFreezeCopy(parsed) : null;
  } catch {
    throw packetError('DECISION_PACKET_SOURCE_EVIDENCE_INVALID');
  }
}

function deepFreezeCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) result[key] = deepFreezeCopy(nested);
  return Object.freeze(result);
}

function copyArray(value) {
  return Array.isArray(value) ? value.map((entry) => typeof entry === 'string' ? entry : entry) : [];
}

function copyObjects(value) {
  return Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === 'object').map((entry) => deepFreezeCopy(entry))
    : [];
}

function nullableValue(value) {
  return value === undefined ? null : value;
}

function booleanOrNull(value) {
  return value === true ? true : value === false ? false : null;
}

function nullableText(value) {
  return text(value) || null;
}

function text(value) {
  return String(value ?? '').trim();
}

function packetError(code) {
  const error = new Error(code);
  error.name = 'RecommendationDecisionPacketError';
  error.code = code;
  return error;
}
