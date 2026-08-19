import {
  CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION,
  fingerprintDeterministicReceiptPayload,
  serializeDeterministicReceiptJson,
} from './csv-analysis-engine/csv-history-deterministic-receipt.js';
import {
  CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_SCHEMA_VERSION,
  projectHistoricalRolling12VerifiedTransitionChronology,
} from './cloudflare-native-csv-history-rolling-12-transition-chronology-v1.js';

export const CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_SCHEMA_VERSION = 'csv-history-rolling-12-transition-chronology-receipt-v1';
export const CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_UI_VERSION = '1.0.0';

const PURPOSE = 'local_historical_rolling_12_transition_chronology_audit_only';
const PROFITABILITY_BASIS = 'sales_minus_ad_spend_only_not_net_profit';
const HEX_64 = /^[a-f0-9]{64}$/;

export async function buildHistoricalRolling12TransitionChronologyReceipt(items) {
  const chronology = projectHistoricalRolling12VerifiedTransitionChronology(items);
  const payload = {
    schemaVersion: CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_SCHEMA_VERSION,
    receiptPurpose: PURPOSE,
    source: projectSourceBinding(chronology),
    chronology,
    deterministic: {
      generatedTimestampIncluded: false,
      canonicalProjectionVersion: CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION,
      chronologyProjectionReused: true,
      orderedTransitionEvidenceBound: true,
      ledgerContinuityEvidenceBound: true,
      blockedChronologyExportable: true,
    },
    authority: noAuthority(),
  };
  assertReceiptBoundary(payload);
  const receiptFingerprint = await fingerprintDeterministicReceiptPayload(payload);
  return deepFreeze({ ...payload, receiptFingerprint });
}

export async function validateHistoricalRolling12TransitionChronologyReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_INVALID');
  if (receipt.schemaVersion !== CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_SCHEMA_VERSION) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_SCHEMA_UNSUPPORTED');
  assertReceiptBoundary(receipt);
  const fingerprint = String(receipt.receiptFingerprint || '').toLowerCase();
  if (!HEX_64.test(fingerprint)) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_FINGERPRINT_INVALID');
  const { receiptFingerprint: _ignored, ...payload } = receipt;
  const expected = await fingerprintDeterministicReceiptPayload(payload);
  if (expected !== fingerprint) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_FINGERPRINT_MISMATCH');
  assertSourceBinding(receipt);
  return deepFreeze(structuredClone(receipt));
}

export async function parseHistoricalRolling12TransitionChronologyReceipt(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_JSON_INVALID');
  }
  return validateHistoricalRolling12TransitionChronologyReceipt(parsed);
}

export function serializeHistoricalRolling12TransitionChronologyReceipt(receipt) {
  assertReceiptBoundary(receipt);
  if (!HEX_64.test(String(receipt?.receiptFingerprint || '').toLowerCase())) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_FINGERPRINT_INVALID');
  return serializeDeterministicReceiptJson(receipt);
}

function projectSourceBinding(chronology) {
  return {
    transitionCount: chronology.transitionCount,
    firstWindowKey: chronology.firstWindowKey,
    lastWindowKey: chronology.lastWindowKey,
    transitionBindings: chronology.transitions.map((transition) => ({
      index: transition.index,
      receiptFingerprint: transition.receiptFingerprint,
      previousWindowKey: transition.previousWindowKey,
      currentWindowKey: transition.currentWindowKey,
      previousLedgerFingerprint: transition.previousLedgerFingerprint,
      currentLedgerFingerprint: transition.currentLedgerFingerprint,
    })),
  };
}

function assertReceiptBoundary(receipt) {
  if (receipt?.receiptPurpose !== PURPOSE) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_PURPOSE_INVALID');
  assertAuthorityFalse(receipt?.authority);
  const deterministic = receipt?.deterministic;
  if (!deterministic
    || deterministic.generatedTimestampIncluded !== false
    || deterministic.canonicalProjectionVersion !== CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION
    || deterministic.chronologyProjectionReused !== true
    || deterministic.orderedTransitionEvidenceBound !== true
    || deterministic.ledgerContinuityEvidenceBound !== true
    || deterministic.blockedChronologyExportable !== true) {
    throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_DETERMINISM_BOUNDARY_INVALID');
  }
  assertChronologyBoundary(receipt?.chronology);
  assertSourceBinding(receipt);
}

function assertChronologyBoundary(chronology) {
  if (!chronology || chronology.schemaVersion !== CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_SCHEMA_VERSION) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_CHRONOLOGY_INVALID');
  if (chronology.chronologyPurpose !== 'ordered_read_only_projection_of_independently_verified_rolling_12_transitions') throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_CHRONOLOGY_PURPOSE_INVALID');
  if (!Number.isInteger(chronology.transitionCount) || chronology.transitionCount < 2 || chronology.transitionCount !== chronology.transitions?.length) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_TRANSITION_COUNT_INVALID');
  if (!chronology.firstWindowKey || !chronology.lastWindowKey) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_WINDOW_BOUNDARY_INVALID');
  if (chronology.profitabilityBasis !== PROFITABILITY_BASIS) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_PROFITABILITY_BASIS_INVALID');
  assertAuthorityFalse(chronology.authority);
  for (const [key, expected] of Object.entries({
    chronologyProjectionApplied: true,
    crossWindowAggregationApplied: false,
    crossWindowNormalizationApplied: false,
    overlapCollapseApplied: false,
    automaticTrendInferenceApplied: false,
    outcomeQualityJudgmentApplied: false,
    recommendationGenerated: false,
    actionGenerated: false,
    windowSelectionAutoReordered: false,
    invalidTransitionAutoSkipped: false,
    sharedEvidenceAutoReconciled: false,
  })) {
    if (chronology[key] !== expected) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_INTEGRITY_BOUNDARY_INVALID');
  }

  if (chronology.chronologyAllowed === true) {
    if (chronology.rawEvidenceOnly !== false || chronology.blockers?.length !== 0) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_ALLOWED_STATE_INVALID');
  } else {
    if (chronology.rawEvidenceOnly !== true || !Array.isArray(chronology.blockers) || chronology.blockers.length === 0) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_BLOCKED_STATE_INVALID');
  }

  for (const [index, transition] of chronology.transitions.entries()) {
    if (transition.index !== index) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_INDEX_INVALID');
    if (!HEX_64.test(String(transition.receiptFingerprint || '').toLowerCase())) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_TRANSITION_FINGERPRINT_INVALID');
    if (!HEX_64.test(String(transition.previousLedgerFingerprint || '').toLowerCase()) || !HEX_64.test(String(transition.currentLedgerFingerprint || '').toLowerCase())) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_LEDGER_FINGERPRINT_INVALID');
    if (!transition.previousWindowKey || !transition.currentWindowKey) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_TRANSITION_WINDOW_INVALID');
    if (transition.outcomeQualityClassificationApplied !== false || transition.recommendationGenerated !== false || transition.actionGenerated !== false) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_TRANSITION_AUTHORITY_INVALID');
    if (chronology.chronologyAllowed === true) {
      if (transition.interpretationAllowed !== true || transition.rawEvidenceOnly !== false) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_TRANSITION_ALLOWED_STATE_INVALID');
    } else if (transition.interpretationAllowed !== false || transition.rawEvidenceOnly !== true) {
      throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_TRANSITION_BLOCKED_STATE_INVALID');
    }
    for (const metric of transition.metrics || []) {
      if (metric.outcomeQualityClassification !== 'not_assigned' || metric.recommendationGenerated !== false || metric.actionGenerated !== false) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_METRIC_AUTHORITY_INVALID');
      if (chronology.chronologyAllowed !== true && (metric.rolling12Delta !== null || metric.movementDirection !== 'withheld_not_comparable' || metric.interpretationAllowed !== false)) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_BLOCKED_METRIC_INVALID');
    }
  }
}

function assertSourceBinding(receipt) {
  const source = receipt?.source;
  const chronology = receipt?.chronology;
  if (!source || !chronology) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_SOURCE_INVALID');
  if (source.transitionCount !== chronology.transitionCount || source.firstWindowKey !== chronology.firstWindowKey || source.lastWindowKey !== chronology.lastWindowKey) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_SOURCE_SUMMARY_MISMATCH');
  const expected = projectSourceBinding(chronology).transitionBindings;
  if (!Array.isArray(source.transitionBindings) || source.transitionBindings.length !== expected.length) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_SOURCE_BINDING_MISMATCH');
  for (let index = 0; index < expected.length; index += 1) {
    const actual = source.transitionBindings[index];
    const target = expected[index];
    for (const key of ['index', 'receiptFingerprint', 'previousWindowKey', 'currentWindowKey', 'previousLedgerFingerprint', 'currentLedgerFingerprint']) {
      if (actual?.[key] !== target[key]) throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_SOURCE_BINDING_MISMATCH');
    }
  }
}

function noAuthority() {
  return {
    authoritative: false,
    canonicalAmazonIdentityResolved: false,
    governancePersistenceAllowed: false,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
  };
}

function assertAuthorityFalse(authority) {
  if (!authority
    || authority.authoritative !== false
    || authority.canonicalAmazonIdentityResolved !== false
    || authority.governancePersistenceAllowed !== false
    || authority.executionAuthorized !== false
    || authority.amazonMutationAuthorized !== false) {
    throw receiptError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_AUTHORITY_INVALID');
  }
}

function receiptError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
