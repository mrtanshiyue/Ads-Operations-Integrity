import { canonicalJson } from './canonical-json.js';

export const CSV_LIBRARY_REVIEW_BRIDGE_SCHEMA_VERSION = 'csv-library-review-bridge-v1';

const NON_AUTHORITY = Object.freeze({
  mode: 'csv_library_review_local_only',
  authoritative: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export async function buildCsvLibraryReviewBridge(jointResult) {
  validateJointResult(jointResult);
  const inputSetFingerprint = String(jointResult.source.inputSetFingerprint).toLowerCase();
  const identityIndex = buildIdentityIndex(jointResult.observedIdentity || {});
  const candidates = collectCandidates(jointResult.analysis || {});
  const items = [];

  for (const candidate of candidates) {
    const sourceSearchTerms = sourceSearchTermsForCandidate(candidate, jointResult.analysis || {});
    const observedIdentity = identityAssessment(sourceSearchTerms, identityIndex);
    const reviewId = `csv-library-review:${await sha256Hex(canonicalJson({
      schemaVersion: CSV_LIBRARY_REVIEW_BRIDGE_SCHEMA_VERSION,
      inputSetFingerprint,
      destination: candidate.destination,
      candidateKind: candidate.candidateKind,
      value: candidate.normalizedValue,
      suggestedMatchType: candidate.suggestedMatchType,
      rationaleCode: candidate.rationaleCode,
    }))}`;

    items.push(Object.freeze({
      reviewId,
      destination: candidate.destination,
      candidateKind: candidate.candidateKind,
      value: candidate.value,
      normalizedValue: candidate.normalizedValue,
      suggestedMatchType: candidate.suggestedMatchType,
      rationaleCode: candidate.rationaleCode,
      priorityScore: candidate.priorityScore,
      metrics: candidate.metrics,
      sourceTermCount: candidate.sourceTermCount,
      sourceSearchTerms: Object.freeze(sourceSearchTerms),
      observedIdentity,
      initialReviewState: 'open',
      requiresHumanReview: true,
      persistenceAuthorized: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
      authority: NON_AUTHORITY,
      source: Object.freeze({
        kind: 'csv_import_set',
        inputSetFingerprint,
        contentSha256s: Object.freeze([...(jointResult.source.contentSha256s || [])]),
        reportStartDate: jointResult.range?.startDate || null,
        reportEndDate: jointResult.range?.endDate || null,
        canonicalAmazonIdentityResolved: false,
      }),
    }));
  }

  items.sort(compareReviewItem);
  const keywordItems = items.filter((item) => item.destination === 'keyword_library');
  const negativeItems = items.filter((item) => item.destination === 'negative_keyword_library');
  const blockedObservedIdentityCount = items.filter((item) => item.observedIdentity.confidenceBlocked).length;

  return Object.freeze({
    schemaVersion: CSV_LIBRARY_REVIEW_BRIDGE_SCHEMA_VERSION,
    authority: NON_AUTHORITY,
    source: Object.freeze({
      inputSetFingerprint,
      contentSha256s: Object.freeze([...(jointResult.source.contentSha256s || [])]),
      reportStartDate: jointResult.range?.startDate || null,
      reportEndDate: jointResult.range?.endDate || null,
      canonicalAmazonIdentityResolved: false,
    }),
    summary: Object.freeze({
      reviewItemCount: items.length,
      keywordLibraryCandidateCount: keywordItems.length,
      negativeLibraryCandidateCount: negativeItems.length,
      exactNegativeCandidateCount: negativeItems.filter((item) => item.candidateKind === 'negative_exact').length,
      phraseNegativeReviewCount: negativeItems.filter((item) => item.candidateKind === 'negative_phrase_root').length,
      blockedObservedIdentityCount,
      persistenceAuthorized: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    items: Object.freeze(items),
  });
}

function validateJointResult(result) {
  if (!result || typeof result !== 'object') throw bridgeError('CSV_LIBRARY_REVIEW_JOINT_RESULT_REQUIRED');
  if (result.source?.kind !== 'csv_import_set') throw bridgeError('CSV_LIBRARY_REVIEW_SOURCE_UNSUPPORTED');
  if (!/^[a-f0-9]{64}$/i.test(String(result.source?.inputSetFingerprint || ''))) {
    throw bridgeError('CSV_LIBRARY_REVIEW_INPUT_FINGERPRINT_INVALID');
  }
  const authorityFlags = [
    result.source?.canonicalAmazonIdentityResolved,
    result.source?.governancePersistenceAllowed,
    result.source?.executionAuthorized,
    result.source?.amazonMutationAuthorized,
    result.analysis?.authority?.authoritative,
    result.analysis?.authority?.governancePersistenceAllowed,
    result.analysis?.authority?.executionAuthorized,
    result.analysis?.authority?.amazonMutationAuthorized,
  ];
  if (authorityFlags.some((value) => value === true)) throw bridgeError('CSV_LIBRARY_REVIEW_AUTHORITY_ESCALATION_BLOCKED');
  if (!Array.isArray(result.analysis?.negativeSuggestions) || !Array.isArray(result.analysis?.harvestSuggestions)) {
    throw bridgeError('CSV_LIBRARY_REVIEW_SUGGESTIONS_REQUIRED');
  }
}

function collectCandidates(analysis) {
  const output = [];
  const seen = new Set();
  for (const suggestion of analysis.harvestSuggestions || []) {
    addCandidate(output, seen, normalizeSuggestion(suggestion, 'keyword_library'));
  }
  for (const suggestion of analysis.negativeSuggestions || []) {
    addCandidate(output, seen, normalizeSuggestion(suggestion, 'negative_keyword_library'));
  }
  return output;
}

function normalizeSuggestion(suggestion, destination) {
  const value = clean(suggestion?.value);
  if (!value) throw bridgeError('CSV_LIBRARY_REVIEW_CANDIDATE_VALUE_REQUIRED');
  if (suggestion?.requiresHumanReview !== true) throw bridgeError('CSV_LIBRARY_REVIEW_HUMAN_REVIEW_REQUIRED');
  if ([suggestion?.persistenceAuthorized, suggestion?.executionAuthorized, suggestion?.amazonMutationAuthorized].some((flag) => flag === true)) {
    throw bridgeError('CSV_LIBRARY_REVIEW_CANDIDATE_AUTHORITY_ESCALATION_BLOCKED');
  }
  const matchScope = clean(suggestion?.matchScope)?.toLowerCase() || '';
  let candidateKind;
  let suggestedMatchType;
  if (destination === 'keyword_library') {
    if (suggestion?.suggestionType !== 'keyword_harvest') throw bridgeError('CSV_LIBRARY_REVIEW_KEYWORD_SUGGESTION_UNSUPPORTED');
    candidateKind = 'keyword_harvest';
    suggestedMatchType = matchScope === 'exact_review' ? 'EXACT' : 'REVIEW';
  } else {
    if (suggestion?.suggestionType !== 'negative_keyword') throw bridgeError('CSV_LIBRARY_REVIEW_NEGATIVE_SUGGESTION_UNSUPPORTED');
    if (matchScope === 'exact') {
      candidateKind = 'negative_exact';
      suggestedMatchType = 'EXACT';
    } else if (matchScope === 'phrase_review') {
      candidateKind = 'negative_phrase_root';
      suggestedMatchType = 'PHRASE';
    } else {
      throw bridgeError('CSV_LIBRARY_REVIEW_NEGATIVE_MATCH_SCOPE_UNSUPPORTED');
    }
  }
  return Object.freeze({
    destination,
    candidateKind,
    value,
    normalizedValue: normalizeBusinessText(value),
    suggestedMatchType,
    rationaleCode: clean(suggestion?.rationaleCode) || 'unspecified',
    priorityScore: finiteNumber(suggestion?.priorityScore),
    metrics: suggestion?.metrics || null,
    sourceTermCount: Math.max(0, Number(suggestion?.sourceTermCount || 0)),
  });
}

function addCandidate(output, seen, candidate) {
  const key = [candidate.destination, candidate.candidateKind, candidate.normalizedValue, candidate.suggestedMatchType].join('|');
  if (seen.has(key)) return;
  seen.add(key);
  output.push(candidate);
}

function sourceSearchTermsForCandidate(candidate, analysis) {
  if (candidate.candidateKind !== 'negative_phrase_root') return [candidate.normalizedValue];
  const root = (analysis.toxicRoots || []).find((item) => normalizeBusinessText(item?.root) === candidate.normalizedValue);
  const terms = Array.isArray(root?.searchTerms) ? root.searchTerms.map(normalizeBusinessText).filter(Boolean) : [];
  return [...new Set(terms)].sort();
}

function buildIdentityIndex(observedIdentity) {
  const identityByFingerprint = new Map();
  for (const identity of observedIdentity.identities || []) {
    const fingerprint = clean(identity?.localIdentityFingerprint);
    if (fingerprint) identityByFingerprint.set(fingerprint, identity);
  }
  const linksByTerm = new Map();
  for (const link of observedIdentity.searchTermLinks || []) {
    const term = normalizeBusinessText(link?.normalizedSearchTerm);
    if (!term) continue;
    if (!linksByTerm.has(term)) linksByTerm.set(term, []);
    linksByTerm.get(term).push(link);
  }
  return { identityByFingerprint, linksByTerm };
}

function identityAssessment(sourceSearchTerms, index) {
  const links = [];
  for (const term of sourceSearchTerms) {
    for (const link of index.linksByTerm.get(term) || []) links.push(link);
  }
  const uniqueLinks = new Map();
  for (const link of links) {
    const fingerprint = clean(link?.localIdentityFingerprint);
    if (fingerprint) uniqueLinks.set(fingerprint, link);
  }
  const fingerprints = [...uniqueLinks.keys()].sort();
  let ambiguousLinkCount = 0;
  const observedStates = new Set();
  for (const fingerprint of fingerprints) {
    const link = uniqueLinks.get(fingerprint);
    const identity = index.identityByFingerprint.get(fingerprint);
    if (link?.identityAmbiguous === true || identity?.evidence?.ambiguous === true) ambiguousLinkCount += 1;
    if (clean(link?.observedIdentityState)) observedStates.add(clean(link.observedIdentityState));
  }
  const confidenceBlocked = ambiguousLinkCount > 0;
  return Object.freeze({
    quality: confidenceBlocked ? 'blocked_observed_identity' : (fingerprints.length ? 'observed_only' : 'unresolved'),
    confidenceBlocked,
    linkCount: fingerprints.length,
    ambiguousLinkCount,
    localIdentityFingerprints: Object.freeze(fingerprints),
    observedIdentityStates: Object.freeze([...observedStates].sort()),
    canonicalAmazonIdentityResolved: false,
  });
}

function compareReviewItem(left, right) {
  return left.destination.localeCompare(right.destination)
    || right.priorityScore - left.priorityScore
    || left.normalizedValue.localeCompare(right.normalizedValue)
    || left.reviewId.localeCompare(right.reviewId);
}

function normalizeBusinessText(value) {
  return clean(value)?.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ') || '';
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bridgeError(code) {
  const error = new Error(code);
  error.name = 'CsvLibraryReviewBridgeError';
  error.code = code;
  return error;
}
