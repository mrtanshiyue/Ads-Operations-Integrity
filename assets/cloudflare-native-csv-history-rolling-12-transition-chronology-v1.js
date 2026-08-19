import { buildHistoricalRolling12WindowTransitionReviewBoard } from './cloudflare-native-csv-history-rolling-12-window-transition-review-board-v1.js';

export const CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_SCHEMA_VERSION = 'csv-history-rolling-12-transition-chronology-v1';

const REVIEW_BOARD_SCHEMA_VERSION = 'csv-history-rolling-12-window-transition-review-board-v1';
const REVIEW_BOARD_PURPOSE = 'read_only_projection_of_verified_rolling_12_transition_receipt';
const VERIFIED_STATE = 'verified_against_explicit_local_ledgers';
const PROFITABILITY_BASIS = 'sales_minus_ad_spend_only_not_net_profit';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertChronologyItem(item, index) {
  assertObject(item, `items[${index}]`);
  assertObject(item.board, `items[${index}].board`);
  const board = item.board;

  if (board.schemaVersion !== REVIEW_BOARD_SCHEMA_VERSION || board.boardPurpose !== REVIEW_BOARD_PURPOSE) {
    throw new Error(`items[${index}] is not a Rolling-12 transition review board`);
  }

  const previousWindowKey = normalizeText(board.selection?.previousWindowKey);
  const currentWindowKey = normalizeText(board.selection?.currentWindowKey);
  if (!previousWindowKey || !currentWindowKey) {
    throw new Error(`items[${index}] is missing explicit Rolling-12 window keys`);
  }
  if (previousWindowKey === currentWindowKey) {
    throw new Error(`items[${index}] must move between distinct Rolling-12 windows`);
  }

  const receiptFingerprint = normalizeText(board.receiptFingerprint);
  if (!receiptFingerprint) {
    throw new Error(`items[${index}] is missing receiptFingerprint`);
  }

  return {
    board,
    previousWindowKey,
    currentWindowKey,
    receiptFingerprint,
    previousLedgerFingerprint: normalizeText(board.previousLedgerFingerprint),
    currentLedgerFingerprint: normalizeText(board.currentLedgerFingerprint),
  };
}

function isVerifiedAllowedBoard(board) {
  return board.verificationState === VERIFIED_STATE
    && board.receiptFingerprintMatch === true
    && board.receiptSerializationMatch === true
    && board.transitionAllowed === true
    && board.interpretationAllowed === true
    && board.rawEvidenceOnly === false;
}

function projectMetric(metric, chronologyAllowed) {
  const allowed = chronologyAllowed && metric?.interpretationAllowed === true;
  return {
    key: normalizeText(metric?.key),
    metricKind: normalizeText(metric?.metricKind),
    previousRolling12Value: allowed ? (metric?.previousRolling12Value ?? null) : null,
    currentRolling12Value: allowed ? (metric?.currentRolling12Value ?? null) : null,
    rolling12Delta: allowed ? (metric?.rolling12Delta ?? null) : null,
    movementDirection: allowed ? normalizeText(metric?.movementDirection) : 'withheld_not_comparable',
    interpretationAllowed: allowed,
    outcomeQualityClassification: 'not_assigned',
    recommendationGenerated: false,
    actionGenerated: false,
  };
}

function projectItem(asserted, index, chronologyAllowed) {
  const {
    board,
    previousWindowKey,
    currentWindowKey,
    receiptFingerprint,
    previousLedgerFingerprint,
    currentLedgerFingerprint,
  } = asserted;
  const itemAllowed = chronologyAllowed && isVerifiedAllowedBoard(board);
  const metrics = Array.isArray(board.metrics) ? board.metrics.map((metric) => projectMetric(metric, itemAllowed)) : [];

  return {
    index,
    previousWindowKey,
    currentWindowKey,
    receiptFingerprint,
    verificationState: normalizeText(board.verificationState),
    receiptFingerprintMatch: board.receiptFingerprintMatch === true,
    receiptSerializationMatch: board.receiptSerializationMatch === true,
    transitionAllowed: board.transitionAllowed === true,
    interpretationAllowed: itemAllowed,
    rawEvidenceOnly: !itemAllowed,
    previousLedgerFingerprint,
    currentLedgerFingerprint,
    decomposition: {
      outgoingQuarterKey: normalizeText(board.decomposition?.outgoingQuarterKey),
      incomingQuarterKey: normalizeText(board.decomposition?.incomingQuarterKey),
      sharedQuarterKeys: Array.isArray(board.decomposition?.sharedQuarterKeys) ? [...board.decomposition.sharedQuarterKeys] : [],
      sharedQuarterCount: Number.isInteger(board.decomposition?.sharedQuarterCount) ? board.decomposition.sharedQuarterCount : null,
    },
    metrics,
    movementOnlyNoOutcomeJudgment: true,
    outcomeQualityClassificationApplied: false,
    recommendationGenerated: false,
    actionGenerated: false,
  };
}

export function projectHistoricalRolling12VerifiedTransitionChronology(items) {
  if (!Array.isArray(items) || items.length < 2) {
    throw new Error('At least two ordered Rolling-12 transition review boards are required');
  }

  const asserted = items.map(assertChronologyItem);
  const blockers = [];

  for (let index = 0; index < asserted.length; index += 1) {
    const current = asserted[index];
    if (!isVerifiedAllowedBoard(current.board)) {
      blockers.push({ index, code: 'transition_not_verified_allowed' });
    }
    if (!current.previousLedgerFingerprint || !current.currentLedgerFingerprint) {
      blockers.push({ index, code: 'missing_ledger_fingerprint' });
    }
    if (index > 0) {
      const previous = asserted[index - 1];
      if (previous.currentWindowKey !== current.previousWindowKey) {
        blockers.push({
          index,
          code: 'non_adjacent_transition_sequence',
          expectedPreviousWindowKey: previous.currentWindowKey,
          actualPreviousWindowKey: current.previousWindowKey,
        });
      }
      if (
        previous.currentLedgerFingerprint
        && current.previousLedgerFingerprint
        && previous.currentLedgerFingerprint !== current.previousLedgerFingerprint
      ) {
        blockers.push({
          index,
          code: 'non_contiguous_ledger_evidence',
          expectedPreviousLedgerFingerprint: previous.currentLedgerFingerprint,
          actualPreviousLedgerFingerprint: current.previousLedgerFingerprint,
        });
      }
    }
  }

  const chronologyAllowed = blockers.length === 0;
  const transitions = asserted.map((item, index) => projectItem(item, index, chronologyAllowed));

  return deepFreeze({
    schemaVersion: CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_SCHEMA_VERSION,
    chronologyPurpose: 'ordered_read_only_projection_of_independently_verified_rolling_12_transitions',
    operatorState: chronologyAllowed ? 'verified_transition_chronology_review_only' : 'chronology_blocked_raw_evidence_only',
    transitionCount: transitions.length,
    firstWindowKey: asserted[0].previousWindowKey,
    lastWindowKey: asserted[asserted.length - 1].currentWindowKey,
    chronologyAllowed,
    rawEvidenceOnly: !chronologyAllowed,
    blockers,
    transitions,
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
    profitabilityBasis: PROFITABILITY_BASIS,
    authority: {
      authoritative: false,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
  });
}

export async function buildHistoricalRolling12VerifiedTransitionChronology(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new Error('At least two ordered Rolling-12 transition entries are required');
  }

  const items = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    assertObject(entry, `entries[${index}]`);
    const board = await buildHistoricalRolling12WindowTransitionReviewBoard(
      entry.previousLedger,
      entry.receipt,
      entry.currentLedger ? { currentLedger: entry.currentLedger } : {},
    );
    items.push({ board });
  }

  return projectHistoricalRolling12VerifiedTransitionChronology(items);
}
