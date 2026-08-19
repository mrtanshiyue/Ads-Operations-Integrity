import {
  buildHistoricalRolling12WindowTransitionReviewBoard,
} from './cloudflare-native-csv-history-rolling-12-window-transition-review-board-v1.js';
import {
  projectHistoricalRolling12VerifiedTransitionChronology,
} from './cloudflare-native-csv-history-rolling-12-transition-chronology-v1.js';
import {
  buildHistoricalRolling12TransitionChronologyReceipt,
  serializeHistoricalRolling12TransitionChronologyReceipt,
  validateHistoricalRolling12TransitionChronologyReceipt,
} from './cloudflare-native-csv-history-rolling-12-transition-chronology-receipt-v1.js';

export const CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_VERIFICATION_SCHEMA_VERSION = 'csv-history-rolling-12-transition-chronology-receipt-verification-v1';
export const CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_VERIFICATION_UI_VERSION = '1.0.0';

const VERIFIED_STATE = 'verified_against_explicit_local_ledgers';
const PROFITABILITY_BASIS = 'sales_minus_ad_spend_only_not_net_profit';

export async function verifyHistoricalRolling12TransitionChronologyReceiptAgainstLedgers(receipt, entries) {
  const validatedReceipt = await validateHistoricalRolling12TransitionChronologyReceipt(receipt);
  if (!Array.isArray(entries) || entries.length !== validatedReceipt.source.transitionCount || entries.length < 2) {
    throw verificationError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_VERIFICATION_ENTRY_COUNT_MISMATCH');
  }

  const items = [];
  const transitionVerifications = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw verificationError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_VERIFICATION_ENTRY_INVALID');
    }
    if (!entry.receipt || !entry.previousLedger) {
      throw verificationError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_VERIFICATION_EXPLICIT_EVIDENCE_REQUIRED');
    }

    const board = await buildHistoricalRolling12WindowTransitionReviewBoard(
      entry.previousLedger,
      entry.receipt,
      entry.currentLedger ? { currentLedger: entry.currentLedger } : {},
    );
    const binding = validatedReceipt.source.transitionBindings[index];
    assertBoardBinding(board, binding, index);
    items.push({ board });
    transitionVerifications.push(projectTransitionVerification(board, index));
  }

  const recomputedChronology = projectHistoricalRolling12VerifiedTransitionChronology(items);
  const recomputedReceipt = await buildHistoricalRolling12TransitionChronologyReceipt(items);
  if (recomputedReceipt.receiptFingerprint !== validatedReceipt.receiptFingerprint) {
    throw verificationError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_VERIFICATION_REPLAY_FINGERPRINT_MISMATCH');
  }

  const originalSerialized = serializeHistoricalRolling12TransitionChronologyReceipt(validatedReceipt);
  const recomputedSerialized = serializeHistoricalRolling12TransitionChronologyReceipt(recomputedReceipt);
  if (originalSerialized !== recomputedSerialized) {
    throw verificationError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_VERIFICATION_REPLAY_SERIALIZATION_MISMATCH');
  }

  const continuityBlocker = recomputedChronology.blockers.find((item) => item.code === 'non_contiguous_ledger_evidence') || null;
  const sequenceBlocker = recomputedChronology.blockers.find((item) => item.code === 'non_adjacent_transition_sequence') || null;
  const transitionReceiptFingerprints = transitionVerifications.map((item) => item.receiptFingerprint);
  const ledgerFingerprintChain = buildLedgerFingerprintChain(transitionVerifications);

  return deepFreeze({
    schemaVersion: CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_VERIFICATION_SCHEMA_VERSION,
    verificationPurpose: 'prove_rolling_12_transition_chronology_receipt_against_ordered_transition_receipts_and_explicit_local_ledgers',
    verificationState: VERIFIED_STATE,
    receiptFingerprint: validatedReceipt.receiptFingerprint,
    recomputedReceiptFingerprint: recomputedReceipt.receiptFingerprint,
    receiptFingerprintMatch: true,
    receiptSerializationMatch: true,
    chronologyRecomputationMatch: true,
    orderedTransitionBindingsMatch: true,
    transitionCount: validatedReceipt.source.transitionCount,
    transitionReceiptFingerprints,
    ledgerFingerprintChain,
    transitionVerifications,
    firstWindowKey: recomputedChronology.firstWindowKey,
    lastWindowKey: recomputedChronology.lastWindowKey,
    chronologyAllowed: recomputedChronology.chronologyAllowed,
    interpretationAllowed: recomputedChronology.chronologyAllowed,
    rawEvidenceOnly: recomputedChronology.rawEvidenceOnly,
    blockers: structuredClone(recomputedChronology.blockers),
    ledgerContinuitySatisfied: continuityBlocker === null,
    windowSequenceContinuitySatisfied: sequenceBlocker === null,
    generatedTimestampIncluded: false,
    standaloneChronologyReceiptValidatedFirst: true,
    everyTransitionReceiptVerifiedAgainstExplicitLocalLedgers: true,
    chronologyReplayedFromExplicitLocalEvidence: true,
    blockedChronologyCannotBeUpgraded: true,
    transitionOrderPreserved: true,
    windowSelectionAutoReordered: false,
    invalidTransitionAutoSkipped: false,
    sharedEvidenceAutoReconciled: false,
    overlapCollapseApplied: false,
    crossWindowAggregationApplied: false,
    crossWindowNormalizationApplied: false,
    automaticTrendInferenceApplied: false,
    outcomeQualityJudgmentApplied: false,
    recommendationGenerated: false,
    actionGenerated: false,
    profitabilityBasis: PROFITABILITY_BASIS,
    authority: noAuthority(),
  });
}

function assertBoardBinding(board, binding, index) {
  if (!binding || binding.index !== index) {
    throw verificationError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_VERIFICATION_BINDING_INDEX_MISMATCH');
  }
  const checks = [
    ['receiptFingerprint', board.receiptFingerprint],
    ['previousWindowKey', board.selection?.previousWindowKey],
    ['currentWindowKey', board.selection?.currentWindowKey],
    ['previousLedgerFingerprint', board.previousLedgerFingerprint],
    ['currentLedgerFingerprint', board.currentLedgerFingerprint],
  ];
  for (const [key, actual] of checks) {
    if (binding[key] !== actual) {
      throw verificationError(`CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_VERIFICATION_${bindingCode(key)}_MISMATCH`);
    }
  }
}

function bindingCode(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function projectTransitionVerification(board, index) {
  if (board.verificationState !== VERIFIED_STATE || board.receiptFingerprintMatch !== true || board.receiptSerializationMatch !== true) {
    throw verificationError('CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_VERIFICATION_TRANSITION_NOT_REPLAY_VERIFIED');
  }
  return deepFreeze({
    index,
    receiptFingerprint: board.receiptFingerprint,
    previousWindowKey: board.selection.previousWindowKey,
    currentWindowKey: board.selection.currentWindowKey,
    previousLedgerFingerprint: board.previousLedgerFingerprint,
    currentLedgerFingerprint: board.currentLedgerFingerprint,
    transitionAllowed: board.transitionAllowed,
    interpretationAllowed: board.interpretationAllowed,
    rawEvidenceOnly: board.rawEvidenceOnly,
    receiptFingerprintMatch: true,
    receiptSerializationMatch: true,
    verificationState: board.verificationState,
  });
}

function buildLedgerFingerprintChain(transitions) {
  const chain = [transitions[0].previousLedgerFingerprint];
  for (const transition of transitions) chain.push(transition.currentLedgerFingerprint);
  return chain;
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

function verificationError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryRolling12TransitionChronologyReceiptVerificationError';
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
