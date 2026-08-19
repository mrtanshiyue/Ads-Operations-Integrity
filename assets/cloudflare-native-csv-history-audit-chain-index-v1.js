import { canonicalJson } from './csv-analysis-engine/canonical-json.js';
import {
  CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_VERIFICATION_SCHEMA_VERSION,
  verifyHistoricalRolling12TransitionChronologyReceiptAgainstLedgers,
} from './cloudflare-native-csv-history-rolling-12-transition-chronology-receipt-verification-v1.js';

export const CSV_HISTORY_AUDIT_CHAIN_INDEX_SCHEMA_VERSION = 'csv-history-audit-chain-index-v1';
export const CSV_HISTORY_AUDIT_CHAIN_INDEX_VERIFICATION_SCHEMA_VERSION = 'csv-history-audit-chain-index-verification-v1';

const PACKAGE_INDEX_SCHEMA_VERSION = 'csv-history-audit-package-index-v1';
const PACKAGE_INDEX_VERIFICATION_SCHEMA_VERSION = 'csv-history-audit-package-index-verification-v1';
const PACKAGE_INDEX_VERIFICATION_STATE = 'audit_package_index_verified_against_local_zip_set';
const PROFITABILITY_BASIS = 'sales_minus_ad_spend_only_not_net_profit';
const HEX_64 = /^[a-f0-9]{64}$/;

export async function buildHistoricalAuditChainIndex(input = {}) {
  const comparisonPackageIndex = await projectVerifiedPackageIndex(input.packageIndex, input.packageIndexVerification);
  const chronologyInputs = Array.isArray(input.chronologyInputs) ? input.chronologyInputs : [];
  const chronologies = [];
  for (const chronologyInput of chronologyInputs) {
    if (!chronologyInput || typeof chronologyInput !== 'object' || Array.isArray(chronologyInput)) {
      throw indexError('CSV_HISTORY_AUDIT_CHAIN_CHRONOLOGY_INPUT_INVALID');
    }
    const verification = await verifyHistoricalRolling12TransitionChronologyReceiptAgainstLedgers(
      chronologyInput.receipt,
      chronologyInput.entries,
    );
    chronologies.push(projectChronologyVerification(verification));
  }
  chronologies.sort((left, right) => left.receiptFingerprint.localeCompare(right.receiptFingerprint));
  assertUniqueChronologies(chronologies);

  if (!comparisonPackageIndex && chronologies.length === 0) {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_EVIDENCE_REQUIRED');
  }

  const comparisonPackageCount = comparisonPackageIndex?.packageCount || 0;
  const payload = {
    schemaVersion: CSV_HISTORY_AUDIT_CHAIN_INDEX_SCHEMA_VERSION,
    indexPurpose: 'deterministic_catalog_of_replay_verified_historical_audit_evidence',
    comparisonPackageIndex,
    rolling12Chronologies: chronologies,
    evidenceSummary: {
      comparisonPackageCount,
      rolling12ChronologyCount: chronologies.length,
      totalCatalogEntries: comparisonPackageCount + chronologies.length,
    },
    deterministic: {
      generatedTimestampIncluded: false,
      sourceFileNameIncluded: false,
      selectionOrderAffectsFingerprint: false,
      comparisonPackageOrderInheritedFromVerifiedIndex: true,
      chronologyCatalogOrder: 'receipt_fingerprint_ascending',
      chronologyInternalTransitionOrderPreserved: true,
      indexFingerprintBasis: 'canonical_index_without_index_fingerprint',
    },
    crossArtifactAggregationApplied: false,
    crossArtifactNormalizationApplied: false,
    metricRecomputationApplied: false,
    automaticTrendInferenceApplied: false,
    recommendationGenerated: false,
    actionGenerated: false,
    profitabilityBasis: PROFITABILITY_BASIS,
    authority: noAuthority(),
  };
  const indexFingerprint = await sha256Hex(canonicalJson(payload));
  const index = deepFreeze({ ...payload, indexFingerprint });
  await validateHistoricalAuditChainIndex(index);
  return index;
}

export async function validateHistoricalAuditChainIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw indexError('CSV_HISTORY_AUDIT_CHAIN_INDEX_INVALID');
  if (index.schemaVersion !== CSV_HISTORY_AUDIT_CHAIN_INDEX_SCHEMA_VERSION) throw indexError('CSV_HISTORY_AUDIT_CHAIN_INDEX_SCHEMA_UNSUPPORTED');
  if (index.indexPurpose !== 'deterministic_catalog_of_replay_verified_historical_audit_evidence') throw indexError('CSV_HISTORY_AUDIT_CHAIN_INDEX_PURPOSE_INVALID');
  assertSha(index.indexFingerprint, 'CSV_HISTORY_AUDIT_CHAIN_INDEX_FINGERPRINT_INVALID');
  assertNoAuthority(index.authority, 'CSV_HISTORY_AUDIT_CHAIN_INDEX_AUTHORITY_ESCALATION_BLOCKED');
  if (index.profitabilityBasis !== PROFITABILITY_BASIS) throw indexError('CSV_HISTORY_AUDIT_CHAIN_INDEX_PROFITABILITY_BASIS_INVALID');
  if (index.crossArtifactAggregationApplied !== false
    || index.crossArtifactNormalizationApplied !== false
    || index.metricRecomputationApplied !== false
    || index.automaticTrendInferenceApplied !== false
    || index.recommendationGenerated !== false
    || index.actionGenerated !== false) {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_INDEX_TRANSFORMATION_BOUNDARY_INVALID');
  }
  const deterministic = index.deterministic;
  if (!deterministic
    || deterministic.generatedTimestampIncluded !== false
    || deterministic.sourceFileNameIncluded !== false
    || deterministic.selectionOrderAffectsFingerprint !== false
    || deterministic.comparisonPackageOrderInheritedFromVerifiedIndex !== true
    || deterministic.chronologyCatalogOrder !== 'receipt_fingerprint_ascending'
    || deterministic.chronologyInternalTransitionOrderPreserved !== true
    || deterministic.indexFingerprintBasis !== 'canonical_index_without_index_fingerprint') {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_INDEX_DETERMINISM_BOUNDARY_INVALID');
  }

  const comparisonPackageIndex = index.comparisonPackageIndex;
  if (comparisonPackageIndex !== null) validateProjectedPackageIndex(comparisonPackageIndex);
  const chronologies = Array.isArray(index.rolling12Chronologies) ? index.rolling12Chronologies : [];
  let previous = null;
  const seen = new Set();
  for (const chronology of chronologies) {
    validateProjectedChronology(chronology);
    if (seen.has(chronology.receiptFingerprint)) throw indexError('CSV_HISTORY_AUDIT_CHAIN_DUPLICATE_CHRONOLOGY_RECEIPT');
    seen.add(chronology.receiptFingerprint);
    if (previous && previous.localeCompare(chronology.receiptFingerprint) >= 0) throw indexError('CSV_HISTORY_AUDIT_CHAIN_CHRONOLOGY_ORDER_INVALID');
    previous = chronology.receiptFingerprint;
  }
  if (comparisonPackageIndex === null && chronologies.length === 0) throw indexError('CSV_HISTORY_AUDIT_CHAIN_EVIDENCE_REQUIRED');

  const summary = index.evidenceSummary;
  const expectedPackageCount = comparisonPackageIndex?.packageCount || 0;
  if (!summary
    || summary.comparisonPackageCount !== expectedPackageCount
    || summary.rolling12ChronologyCount !== chronologies.length
    || summary.totalCatalogEntries !== expectedPackageCount + chronologies.length) {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_SUMMARY_MISMATCH');
  }

  const { indexFingerprint: _ignored, ...payload } = index;
  const expectedFingerprint = await sha256Hex(canonicalJson(payload));
  if (expectedFingerprint !== index.indexFingerprint) throw indexError('CSV_HISTORY_AUDIT_CHAIN_INDEX_FINGERPRINT_MISMATCH');
  return deepFreeze(structuredClone(index));
}

export async function verifyHistoricalAuditChainIndexAgainstEvidence(index, input = {}) {
  const validated = await validateHistoricalAuditChainIndex(index);
  const rebuilt = await buildHistoricalAuditChainIndex(input);
  if (rebuilt.indexFingerprint !== validated.indexFingerprint) {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_INDEX_REPLAY_FINGERPRINT_MISMATCH');
  }
  if (serializeHistoricalAuditChainIndex(rebuilt) !== serializeHistoricalAuditChainIndex(validated)) {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_INDEX_REPLAY_SERIALIZATION_MISMATCH');
  }
  return deepFreeze({
    schemaVersion: CSV_HISTORY_AUDIT_CHAIN_INDEX_VERIFICATION_SCHEMA_VERSION,
    verificationState: 'audit_chain_index_verified_against_explicit_local_evidence',
    indexFingerprint: validated.indexFingerprint,
    recomputedIndexFingerprint: rebuilt.indexFingerprint,
    indexFingerprintMatch: true,
    indexSerializationMatch: true,
    comparisonPackageCount: rebuilt.evidenceSummary.comparisonPackageCount,
    rolling12ChronologyCount: rebuilt.evidenceSummary.rolling12ChronologyCount,
    chronologyReceiptFingerprints: rebuilt.rolling12Chronologies.map((item) => item.receiptFingerprint),
    replayedFromExplicitLocalEvidence: true,
    generatedTimestampIncluded: false,
    crossArtifactAggregationApplied: false,
    crossArtifactNormalizationApplied: false,
    recommendationGenerated: false,
    actionGenerated: false,
    profitabilityBasis: PROFITABILITY_BASIS,
    authority: noAuthority(),
  });
}

export function serializeHistoricalAuditChainIndex(index) {
  return `${JSON.stringify(sortKeysDeep(index), null, 2)}\n`;
}

async function projectVerifiedPackageIndex(index, verification) {
  if (index == null && verification == null) return null;
  if (!index || !verification) throw indexError('CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_VERIFICATION_REQUIRED');
  if (index.schemaVersion !== PACKAGE_INDEX_SCHEMA_VERSION) throw indexError('CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_SCHEMA_UNSUPPORTED');
  assertSha(index.indexFingerprint, 'CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_FINGERPRINT_INVALID');
  const { indexFingerprint: _ignored, ...indexPayload } = index;
  if (await sha256Hex(canonicalJson(indexPayload)) !== index.indexFingerprint) throw indexError('CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_FINGERPRINT_MISMATCH');
  if (verification.schemaVersion !== PACKAGE_INDEX_VERIFICATION_SCHEMA_VERSION
    || verification.verificationState !== PACKAGE_INDEX_VERIFICATION_STATE
    || verification.indexFingerprintMatch !== true
    || verification.indexSerializationMatch !== true
    || verification.archiveSetMatch !== true
    || verification.replayedFromExplicitLocalZipSet !== true
    || verification.generatedTimestampIncluded !== false) {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_NOT_REPLAY_VERIFIED');
  }
  if (verification.indexFingerprint !== index.indexFingerprint || verification.packageCount !== index.packageCount) {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_VERIFICATION_BINDING_MISMATCH');
  }
  const packageFingerprints = Array.isArray(index.packages) ? index.packages.map((item) => item.packageFingerprint) : [];
  if (packageFingerprints.length !== index.packageCount || !sameArray(packageFingerprints, verification.packageFingerprints)) {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_PACKAGE_SET_MISMATCH');
  }
  for (const fingerprint of packageFingerprints) assertSha(fingerprint, 'CSV_HISTORY_AUDIT_CHAIN_PACKAGE_FINGERPRINT_INVALID');
  return deepFreeze({
    schemaVersion: index.schemaVersion,
    indexFingerprint: index.indexFingerprint,
    packageCount: index.packageCount,
    packageFingerprints,
    verificationSchema: verification.schemaVersion,
    verificationState: verification.verificationState,
    replayedFromExplicitLocalZipSet: true,
  });
}

function projectChronologyVerification(verification) {
  if (!verification
    || verification.schemaVersion !== CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_VERIFICATION_SCHEMA_VERSION
    || verification.verificationState !== 'verified_against_explicit_local_ledgers'
    || verification.receiptFingerprintMatch !== true
    || verification.receiptSerializationMatch !== true
    || verification.chronologyRecomputationMatch !== true
    || verification.orderedTransitionBindingsMatch !== true
    || verification.everyTransitionReceiptVerifiedAgainstExplicitLocalLedgers !== true
    || verification.chronologyReplayedFromExplicitLocalEvidence !== true) {
    throw indexError('CSV_HISTORY_AUDIT_CHAIN_CHRONOLOGY_NOT_REPLAY_VERIFIED');
  }
  assertSha(verification.receiptFingerprint, 'CSV_HISTORY_AUDIT_CHAIN_CHRONOLOGY_FINGERPRINT_INVALID');
  for (const fingerprint of verification.transitionReceiptFingerprints || []) assertSha(fingerprint, 'CSV_HISTORY_AUDIT_CHAIN_TRANSITION_FINGERPRINT_INVALID');
  for (const fingerprint of verification.ledgerFingerprintChain || []) assertSha(fingerprint, 'CSV_HISTORY_AUDIT_CHAIN_LEDGER_FINGERPRINT_INVALID');
  return deepFreeze({
    verificationSchema: verification.schemaVersion,
    verificationState: verification.verificationState,
    receiptFingerprint: verification.receiptFingerprint,
    transitionCount: verification.transitionCount,
    transitionReceiptFingerprints: [...verification.transitionReceiptFingerprints],
    ledgerFingerprintChain: [...verification.ledgerFingerprintChain],
    firstWindowKey: verification.firstWindowKey,
    lastWindowKey: verification.lastWindowKey,
    chronologyAllowed: verification.chronologyAllowed,
    rawEvidenceOnly: verification.rawEvidenceOnly,
    ledgerContinuitySatisfied: verification.ledgerContinuitySatisfied,
    windowSequenceContinuitySatisfied: verification.windowSequenceContinuitySatisfied,
    replayedFromExplicitLocalEvidence: true,
  });
}

function validateProjectedPackageIndex(value) {
  if (!value || value.schemaVersion !== PACKAGE_INDEX_SCHEMA_VERSION) throw indexError('CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_PROJECTION_INVALID');
  assertSha(value.indexFingerprint, 'CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_FINGERPRINT_INVALID');
  if (!Number.isInteger(value.packageCount) || value.packageCount < 1 || value.packageFingerprints?.length !== value.packageCount) throw indexError('CSV_HISTORY_AUDIT_CHAIN_PACKAGE_COUNT_INVALID');
  if (value.verificationSchema !== PACKAGE_INDEX_VERIFICATION_SCHEMA_VERSION || value.verificationState !== PACKAGE_INDEX_VERIFICATION_STATE || value.replayedFromExplicitLocalZipSet !== true) throw indexError('CSV_HISTORY_AUDIT_CHAIN_PACKAGE_INDEX_NOT_REPLAY_VERIFIED');
  for (const fingerprint of value.packageFingerprints) assertSha(fingerprint, 'CSV_HISTORY_AUDIT_CHAIN_PACKAGE_FINGERPRINT_INVALID');
}

function validateProjectedChronology(value) {
  if (!value || value.verificationSchema !== CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_VERIFICATION_SCHEMA_VERSION || value.verificationState !== 'verified_against_explicit_local_ledgers') throw indexError('CSV_HISTORY_AUDIT_CHAIN_CHRONOLOGY_PROJECTION_INVALID');
  assertSha(value.receiptFingerprint, 'CSV_HISTORY_AUDIT_CHAIN_CHRONOLOGY_FINGERPRINT_INVALID');
  if (!Number.isInteger(value.transitionCount) || value.transitionCount < 2 || value.transitionReceiptFingerprints?.length !== value.transitionCount || value.ledgerFingerprintChain?.length !== value.transitionCount + 1) throw indexError('CSV_HISTORY_AUDIT_CHAIN_CHRONOLOGY_COUNT_INVALID');
  for (const fingerprint of value.transitionReceiptFingerprints) assertSha(fingerprint, 'CSV_HISTORY_AUDIT_CHAIN_TRANSITION_FINGERPRINT_INVALID');
  for (const fingerprint of value.ledgerFingerprintChain) assertSha(fingerprint, 'CSV_HISTORY_AUDIT_CHAIN_LEDGER_FINGERPRINT_INVALID');
  if (!value.firstWindowKey || !value.lastWindowKey || typeof value.chronologyAllowed !== 'boolean' || value.rawEvidenceOnly === value.chronologyAllowed || typeof value.ledgerContinuitySatisfied !== 'boolean' || typeof value.windowSequenceContinuitySatisfied !== 'boolean' || value.replayedFromExplicitLocalEvidence !== true) throw indexError('CSV_HISTORY_AUDIT_CHAIN_CHRONOLOGY_STATE_INVALID');
}

function assertUniqueChronologies(chronologies) {
  for (let index = 1; index < chronologies.length; index += 1) {
    if (chronologies[index - 1].receiptFingerprint === chronologies[index].receiptFingerprint) throw indexError('CSV_HISTORY_AUDIT_CHAIN_DUPLICATE_CHRONOLOGY_RECEIPT');
  }
}

function assertNoAuthority(authority, code) {
  if (!authority
    || authority.authoritative !== false
    || authority.canonicalAmazonIdentityResolved !== false
    || authority.governancePersistenceAllowed !== false
    || authority.executionAuthorized !== false
    || authority.amazonMutationAuthorized !== false) throw indexError(code);
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

function assertSha(value, code) {
  if (!HEX_64.test(String(value || '').toLowerCase())) throw indexError(code);
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) throw indexError('CSV_HISTORY_AUDIT_CHAIN_CRYPTO_UNAVAILABLE');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = sortKeysDeep(value[key]);
  return output;
}

function indexError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryAuditChainIndexError';
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
