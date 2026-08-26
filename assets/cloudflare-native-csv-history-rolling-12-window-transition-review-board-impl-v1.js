import { validateCsvHistoryLedger } from './csv-analysis-engine/csv-history-ledger.js';
import {
  parseHistoricalRolling12WindowTransitionReceipt,
  validateHistoricalRolling12WindowTransitionReceipt,
} from './cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js';
import { verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers } from './cloudflare-native-csv-history-rolling-12-window-transition-receipt-verification-v1.js';

export const CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_BOARD_SCHEMA_VERSION = 'csv-history-rolling-12-window-transition-review-board-v1';
export const CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_BOARD_UI_VERSION = '1.0.0';

const PROFITABILITY_BASIS = 'sales_minus_ad_spend_only_not_net_profit';
const ADDITIVE_ORDER = Object.freeze(['spendMicros', 'salesMicros', 'orders', 'adContributionMicros']);
const RATIO_ORDER = Object.freeze(['acos', 'roas']);
const state = { mounted: false, busy: false, receipt: null, previousLedger: null, currentLedger: null, board: null };

export async function buildHistoricalRolling12WindowTransitionReviewBoard(previousLedger, receipt, options = {}) {
  const validatedReceipt = await validateHistoricalRolling12WindowTransitionReceipt(receipt);
  const verification = await verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(previousLedger, validatedReceipt, options);
  const transition = validatedReceipt.transition;
  const allowed = verification.transitionAllowed === true && transition.transitionAllowed === true;
  const metrics = [
    ...ADDITIVE_ORDER.map((key) => projectAdditiveMetric(key, transition.transitionMetrics?.additive?.[key], allowed)),
    ...RATIO_ORDER.map((key) => projectRatioMetric(key, transition.transitionMetrics?.ratios?.[key], allowed)),
  ];

  return deepFreeze({
    schemaVersion: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_BOARD_SCHEMA_VERSION,
    boardPurpose: 'read_only_projection_of_verified_rolling_12_transition_receipt',
    operatorState: allowed ? 'verified_transition_review_only' : 'verified_blocked_raw_evidence_only',
    receiptFingerprint: validatedReceipt.receiptFingerprint,
    verificationState: verification.verificationState,
    receiptFingerprintMatch: verification.receiptFingerprintMatch,
    receiptSerializationMatch: verification.receiptSerializationMatch,
    previousLedgerFingerprint: verification.previousLedgerFingerprint,
    currentLedgerFingerprint: verification.currentLedgerFingerprint,
    sameLedgerFingerprint: verification.sameLedgerFingerprint,
    transitionAllowed: allowed,
    interpretationAllowed: allowed,
    rawEvidenceOnly: !allowed,
    transitionSemantics: transition.transitionSemantics,
    additiveDeltaBasis: transition.additiveDeltaBasis,
    ratioDeltaBasis: transition.ratioDeltaBasis,
    selectionPolicy: transition.selectionPolicy,
    selection: {
      previousWindowKey: verification.previousWindowKey,
      currentWindowKey: verification.currentWindowKey,
      windowSelectionAutoReordered: false,
    },
    decomposition: {
      outgoingQuarterKey: verification.outgoingQuarterKey,
      sharedQuarterKeys: [...verification.sharedQuarterKeys],
      sharedQuarterCount: verification.sharedQuarterKeys.length,
      overlapMonths: verification.sharedQuarterKeys.length * 3,
      incomingQuarterKey: verification.incomingQuarterKey,
      overlapCollapsed: false,
    },
    gate: {
      verificationRequired: true,
      standaloneReceiptValidatedFirst: verification.standaloneReceiptValidatedFirst,
      exactReplayFingerprintRequired: true,
      exactReplaySerializationRequired: true,
      sharedEvidenceIdentityMustMatch: true,
      sameQuarterKeyDoesNotImplySameEvidence: true,
      blockedTransitionCannotBeUpgraded: true,
      blockers: [...(transition.comparabilityGate?.blockers || [])],
    },
    evidence: {
      previousWindow: transition.rawPreviousWindowEvidence,
      currentWindow: transition.rawCurrentWindowEvidence,
      outgoingQuarter: transition.decomposition?.outgoingQuarter || null,
      incomingQuarter: transition.decomposition?.incomingQuarter || null,
      sharedQuarterEvidence: transition.decomposition?.sharedQuarterEvidence || [],
      sharedQuarterBindings: verification.sharedQuarterBindings,
      rawEvidenceRetained: true,
    },
    metrics,
    movementOnlyNoOutcomeJudgment: true,
    outcomeQualityClassificationApplied: false,
    recommendationGenerated: false,
    actionGenerated: false,
    crossWindowAggregationApplied: false,
    crossWindowNormalizationApplied: false,
    overlapCollapseApplied: false,
    sharedEvidenceAutoReconciled: false,
    gapRepairApplied: false,
    windowSelectionAutoReordered: false,
    profitabilityBasis: PROFITABILITY_BASIS,
    authority: noAuthority(),
  });
}

function projectAdditiveMetric(key, metric, allowed) {
  if (!metric) throw boardError('CSV_HISTORY_R12_TRANSITION_REVIEW_BOARD_ADDITIVE_METRIC_MISSING');
  return {
    key,
    label: metric.label,
    unit: metric.unit,
    metricKind: 'additive',
    previousRolling12Value: metric.previousRolling12Value,
    currentRolling12Value: metric.currentRolling12Value,
    outgoingQuarterValue: metric.outgoingQuarterValue,
    incomingQuarterValue: metric.incomingQuarterValue,
    rolling12Delta: allowed ? metric.rolling12Delta : null,
    movementDirection: allowed ? movement(metric.rolling12Delta) : 'withheld_not_comparable',
    transitionIdentity: metric.identity,
    interpretationAllowed: allowed,
    outcomeQualityClassification: 'not_assigned',
    recommendationGenerated: false,
  };
}

function projectRatioMetric(key, metric, allowed) {
  if (!metric) throw boardError('CSV_HISTORY_R12_TRANSITION_REVIEW_BOARD_RATIO_METRIC_MISSING');
  return {
    key,
    label: metric.label,
    unit: metric.unit,
    metricKind: 'ratio',
    previousRolling12Value: metric.previousRolling12Value,
    currentRolling12Value: metric.currentRolling12Value,
    outgoingQuarterValue: null,
    incomingQuarterValue: null,
    rolling12Delta: allowed ? metric.rolling12Delta : null,
    movementDirection: allowed ? movement(metric.rolling12Delta) : 'withheld_not_comparable',
    deltaBasis: metric.deltaBasis,
    ratioDerivedFromFullRolling12Totals: true,
    incomingOutgoingQuarterRatioDeltaUsed: false,
    interpretationAllowed: allowed,
    outcomeQualityClassification: 'not_assigned',
    recommendationGenerated: false,
  };
}

function movement(value) {
  if (!Number.isFinite(value)) return 'withheld_not_comparable';
  if (value > 0) return 'increase';
  if (value < 0) return 'decrease';
  return 'no_change';
}

function noAuthority() {
  return { authoritative: false, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
function boardError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryRolling12WindowTransitionReviewBoardError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryRolling12WindowTransitionReviewBoard', {
    value: Object.freeze({
      version: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_BOARD_UI_VERSION,
      schemaVersion: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_BOARD_SCHEMA_VERSION,
      authority: 'local_historical_rolling_12_transition_verified_read_only_review_board',
      buildHistoricalRolling12WindowTransitionReviewBoard,
    }),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

function mount() {
  if (state.mounted) return;
  const host = document.querySelector('[data-csv-history-rolling-12-window-transition-receipt-verification]');
  if (!host) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-rolling-12-window-transition-receipt-verification]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-rolling-12-window-transition-review-board]')) return void (state.mounted = true);
  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhr12trb';
  root.dataset.csvHistoryRolling12WindowTransitionReviewBoard = CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_BOARD_UI_VERSION;
  root.innerHTML = `
    <div class="cfhr12trb-head"><div><b>Rolling-12 Transition Review Board</b><small>Read-only projection of a deterministic transition receipt only after exact local-ledger replay verification. It shows movement and evidence state without judging business outcomes, recommending actions, or authorizing execution.</small></div><span>verified evidence · movement only</span></div>
    <div class="cfhr12trb-guard">One quarter moves out, three quarters remain shared, and one quarter moves in. Additive movement uses incoming minus outgoing. ACoS and ROAS movement uses the two full Rolling-12 totals only. Ad Contribution = Sales - Ad Spend only; it is not Net Profit.</div>
    <div class="cfhr12trb-controls">
      <label>Transition receipt <input type="file" accept="application/json,.json" data-cfhr12trb-receipt></label>
      <label>Previous ledger <input type="file" accept="application/json,.json" data-cfhr12trb-previous></label>
      <label>Current ledger <small>required only for distinct fingerprint</small><input type="file" accept="application/json,.json" data-cfhr12trb-current></label>
      <button type="button" data-cfhr12trb-build disabled>Build verified board</button>
    </div>
    <div class="cfhr12trb-status" data-cfhr12trb-status>Explicit local-file ownership only. Nothing is silently persisted.</div>
    <div class="cfhr12trb-result" data-cfhr12trb-result hidden></div>`;
  host.insertAdjacentElement('afterend', root);
  root.querySelector('[data-cfhr12trb-receipt]').addEventListener('change', (event) => void loadReceipt(root, event.currentTarget));
  root.querySelector('[data-cfhr12trb-previous]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget, 'previous'));
  root.querySelector('[data-cfhr12trb-current]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget, 'current'));
  root.querySelector('[data-cfhr12trb-build]').addEventListener('click', () => void buildFromUi(root));
  state.mounted = true;
}

async function loadReceipt(root, input) {
  const file = input.files?.[0];
  state.receipt = null; state.board = null; clearResult(root);
  if (!file || state.busy) return syncControls(root);
  state.busy = true; syncControls(root); setStatus(root, 'Validating standalone transition receipt…', 'loading');
  try {
    state.receipt = await parseHistoricalRolling12WindowTransitionReceipt(await file.text());
    setStatus(root, `Receipt validated: ${state.receipt.receiptFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) { setStatus(root, `Receipt blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad'); }
  finally { state.busy = false; syncControls(root); }
}

async function loadLedger(root, input, role) {
  const file = input.files?.[0];
  state[`${role}Ledger`] = null; state.board = null; clearResult(root);
  if (!file || state.busy) return syncControls(root);
  state.busy = true; syncControls(root); setStatus(root, `Validating explicit local ${role} ledger…`, 'loading');
  try {
    state[`${role}Ledger`] = await validateCsvHistoryLedger(JSON.parse(await file.text()));
    setStatus(root, `${role === 'previous' ? 'Previous' : 'Current'} ledger validated: ${state[`${role}Ledger`].ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) { setStatus(root, `${role === 'previous' ? 'Previous' : 'Current'} ledger blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad'); }
  finally { state.busy = false; syncControls(root); }
}

async function buildFromUi(root) {
  if (!state.receipt || !state.previousLedger || state.busy) return;
  const distinct = state.receipt.source.previousLedgerFingerprint !== state.receipt.source.currentLedgerFingerprint;
  if (distinct && !state.currentLedger) return setStatus(root, 'Board blocked: the receipt binds a distinct current ledger and requires that explicit local file.', 'bad');
  state.busy = true; state.board = null; clearResult(root); syncControls(root);
  setStatus(root, 'Verifying exact receipt replay before projecting review board…', 'loading');
  try {
    state.board = await buildHistoricalRolling12WindowTransitionReviewBoard(state.previousLedger, state.receipt, state.currentLedger ? { currentLedger: state.currentLedger } : {});
    renderBoard(root, state.board);
    setStatus(root, state.board.transitionAllowed ? 'Verified transition review only. Movement shown without outcome judgment.' : `Verified blocked receipt; raw evidence only. ${state.board.gate.blockers.join(', ')}`, state.board.transitionAllowed ? 'ok' : 'bad');
  } catch (error) { setStatus(root, `Board blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad'); }
  finally { state.busy = false; syncControls(root); }
}

function renderBoard(root, board) {
  const rows = board.metrics.map((item) => `<tr><td>${esc(item.label)}</td><td>${format(item.previousRolling12Value)}</td><td>${format(item.currentRolling12Value)}</td><td>${item.metricKind === 'additive' ? format(item.outgoingQuarterValue) : 'not used'}</td><td>${item.metricKind === 'additive' ? format(item.incomingQuarterValue) : 'not used'}</td><td>${format(item.rolling12Delta)}</td><td>${esc(item.movementDirection)}</td><td>not assigned</td></tr>`).join('');
  const result = root.querySelector('[data-cfhr12trb-result]');
  result.innerHTML = `<div class="cfhr12trb-grid">${card('Operator state', `<b>${esc(board.operatorState)}</b>`)}${card('Previous R12', `<b>${esc(board.selection.previousWindowKey)}</b>`)}${card('Outgoing', `<b>${esc(board.decomposition.outgoingQuarterKey || '—')}</b>`)}${card('Shared', `<b>${board.decomposition.sharedQuarterCount}</b> quarters / ${board.decomposition.overlapMonths} months`)}${card('Incoming', `<b>${esc(board.decomposition.incomingQuarterKey || '—')}</b>`)}${card('Current R12', `<b>${esc(board.selection.currentWindowKey)}</b>`)}</div><div class="cfhr12trb-table"><table><thead><tr><th>Metric</th><th>Previous R12</th><th>Current R12</th><th>Outgoing Q</th><th>Incoming Q</th><th>Δ R12</th><th>Movement</th><th>Outcome quality</th></tr></thead><tbody>${rows}</tbody></table></div><div class="cfhr12trb-evidence">Receipt <code>${esc(board.receiptFingerprint)}</code> · exact fingerprint replay: <b>true</b> · exact serialization replay: <b>true</b> · recommendation: <b>none</b> · authority: <b>none</b></div>`;
  result.hidden = false;
}

function syncControls(root) {
  const distinct = Boolean(state.receipt && state.receipt.source.previousLedgerFingerprint !== state.receipt.source.currentLedgerFingerprint);
  root.querySelector('[data-cfhr12trb-receipt]').disabled = state.busy;
  root.querySelector('[data-cfhr12trb-previous]').disabled = state.busy;
  root.querySelector('[data-cfhr12trb-current]').disabled = state.busy;
  root.querySelector('[data-cfhr12trb-build]').disabled = state.busy || !state.receipt || !state.previousLedger || (distinct && !state.currentLedger);
}
function clearResult(root) { const node = root.querySelector('[data-cfhr12trb-result]'); node.hidden = true; node.innerHTML = ''; }
function setStatus(root, text, tone = '') { const node = root.querySelector('[data-cfhr12trb-status]'); node.textContent = text; node.dataset.tone = tone; }
function card(label, value) { return `<div class="cfhr12trb-card"><small>${esc(label)}</small><div>${value}</div></div>`; }
function format(value) { return value == null || !Number.isFinite(Number(value)) ? 'withheld' : Number.isInteger(value) ? String(value) : Number(value).toPrecision(8).replace(/0+$/, '').replace(/\.$/, ''); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function installStyles() {
  if (document.getElementById('cfhr12trb-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhr12trb-style-v1';
  style.textContent = '.cfhr12trb{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhr12trb-head{display:flex;justify-content:space-between;gap:12px}.cfhr12trb-head small{display:block;color:#64748b;max-width:840px}.cfhr12trb-head>span{font-size:11px;font-weight:800}.cfhr12trb-guard,.cfhr12trb-status,.cfhr12trb-evidence{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhr12trb-status[data-tone="bad"]{color:#b91c1c}.cfhr12trb-status[data-tone="ok"]{color:#047857}.cfhr12trb-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhr12trb-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhr12trb-controls input,.cfhr12trb-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhr12trb-controls button{font-weight:700}.cfhr12trb-result{margin-top:10px}.cfhr12trb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.cfhr12trb-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px}.cfhr12trb-card small{display:block;color:#64748b}.cfhr12trb-table{overflow:auto;margin-top:9px}.cfhr12trb table{width:100%;border-collapse:collapse;font-size:12px}.cfhr12trb th,.cfhr12trb td{text-align:left;padding:7px;border-bottom:1px solid #e2e8f0}.cfhr12trb code{font-size:11px;word-break:break-all}';
  document.head.appendChild(style);
}
