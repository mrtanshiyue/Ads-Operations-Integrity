import { validateCsvHistoryLedger } from './csv-analysis-engine/csv-history-ledger.js';
import {
  buildHistoricalRolling12WindowTransitionReceipt,
  parseHistoricalRolling12WindowTransitionReceipt,
  serializeHistoricalRolling12WindowTransitionReceipt,
  validateHistoricalRolling12WindowTransitionReceipt,
} from './cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js';

export const CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_VERIFICATION_SCHEMA_VERSION = 'csv-history-rolling-12-window-transition-receipt-verification-v1';
export const CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_VERIFICATION_UI_VERSION = '1.0.0';

const PROFITABILITY_BASIS = 'sales_minus_ad_spend_only_not_net_profit';
const state = {
  mounted: false,
  busy: false,
  previousLedger: null,
  currentLedger: null,
  receipt: null,
  verification: null,
};

export async function verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(previousLedger, receipt, options = {}) {
  const validatedReceipt = await validateHistoricalRolling12WindowTransitionReceipt(receipt);
  const validatedPreviousLedger = await validateCsvHistoryLedger(previousLedger);
  const currentLedgerProvided = Object.prototype.hasOwnProperty.call(options || {}, 'currentLedger');
  const receiptRequiresDistinctCurrentLedger = validatedReceipt.source.previousLedgerFingerprint !== validatedReceipt.source.currentLedgerFingerprint;

  if (validatedPreviousLedger.ledgerFingerprint !== validatedReceipt.source.previousLedgerFingerprint) {
    throw verificationError('CSV_HISTORY_R12_TRANSITION_RECEIPT_VERIFICATION_PREVIOUS_LEDGER_FINGERPRINT_MISMATCH');
  }
  if (receiptRequiresDistinctCurrentLedger && !currentLedgerProvided) {
    throw verificationError('CSV_HISTORY_R12_TRANSITION_RECEIPT_VERIFICATION_CURRENT_LEDGER_REQUIRED');
  }

  const candidateCurrentLedger = currentLedgerProvided ? options.currentLedger : previousLedger;
  const validatedCurrentLedger = candidateCurrentLedger === previousLedger
    ? validatedPreviousLedger
    : await validateCsvHistoryLedger(candidateCurrentLedger);
  if (validatedCurrentLedger.ledgerFingerprint !== validatedReceipt.source.currentLedgerFingerprint) {
    throw verificationError('CSV_HISTORY_R12_TRANSITION_RECEIPT_VERIFICATION_CURRENT_LEDGER_FINGERPRINT_MISMATCH');
  }

  const recomputed = await buildHistoricalRolling12WindowTransitionReceipt(
    validatedPreviousLedger,
    validatedReceipt.source.previousWindowKey,
    validatedReceipt.source.currentWindowKey,
    { currentLedger: validatedCurrentLedger },
  );
  if (recomputed.receiptFingerprint !== validatedReceipt.receiptFingerprint) {
    throw verificationError('CSV_HISTORY_R12_TRANSITION_RECEIPT_VERIFICATION_REPLAY_FINGERPRINT_MISMATCH');
  }

  const originalSerialized = serializeHistoricalRolling12WindowTransitionReceipt(validatedReceipt);
  const recomputedSerialized = serializeHistoricalRolling12WindowTransitionReceipt(recomputed);
  if (originalSerialized !== recomputedSerialized) {
    throw verificationError('CSV_HISTORY_R12_TRANSITION_RECEIPT_VERIFICATION_REPLAY_SERIALIZATION_MISMATCH');
  }

  return deepFreeze({
    schemaVersion: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_VERIFICATION_SCHEMA_VERSION,
    verificationState: 'verified_against_explicit_local_ledgers',
    receiptFingerprint: validatedReceipt.receiptFingerprint,
    recomputedReceiptFingerprint: recomputed.receiptFingerprint,
    previousLedgerFingerprint: validatedPreviousLedger.ledgerFingerprint,
    currentLedgerFingerprint: validatedCurrentLedger.ledgerFingerprint,
    sameLedgerFingerprint: validatedPreviousLedger.ledgerFingerprint === validatedCurrentLedger.ledgerFingerprint,
    distinctCurrentLedgerRequired: receiptRequiresDistinctCurrentLedger,
    distinctCurrentLedgerProvided: currentLedgerProvided && validatedPreviousLedger.ledgerFingerprint !== validatedCurrentLedger.ledgerFingerprint,
    previousWindowKey: validatedReceipt.source.previousWindowKey,
    currentWindowKey: validatedReceipt.source.currentWindowKey,
    outgoingQuarterKey: validatedReceipt.source.outgoingQuarterKey,
    incomingQuarterKey: validatedReceipt.source.incomingQuarterKey,
    sharedQuarterKeys: [...validatedReceipt.source.sharedQuarterKeys],
    sharedQuarterBindings: validatedReceipt.source.sharedQuarterBindings.map((item) => ({
      quarter: item.quarter,
      previousCanonicalQuarterFingerprint: item.previousCanonicalQuarterFingerprint,
      currentCanonicalQuarterFingerprint: item.currentCanonicalQuarterFingerprint,
      previousSourceInputSetFingerprints: [...item.previousSourceInputSetFingerprints],
      currentSourceInputSetFingerprints: [...item.currentSourceInputSetFingerprints],
      previousSourceContentSha256s: [...item.previousSourceContentSha256s],
      currentSourceContentSha256s: [...item.currentSourceContentSha256s],
    })),
    transitionAllowed: validatedReceipt.transition.transitionAllowed,
    interpretationAllowed: validatedReceipt.transition.interpretationAllowed,
    rawEvidenceOnly: validatedReceipt.transition.rawEvidenceOnly,
    receiptFingerprintMatch: true,
    receiptSerializationMatch: true,
    generatedTimestampIncluded: false,
    standaloneReceiptValidatedFirst: true,
    replayedFromExplicitLocalLedgers: true,
    transitionSemantics: 'overlap_aware_one_quarter_out_one_quarter_in_three_quarters_shared',
    additiveDeltaBasis: 'incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12',
    ratioDeltaBasis: 'current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals',
    selectionPolicy: 'operator_selected_forward_adjacent_quarter_aligned_rolling_12_windows_no_auto_reorder_or_repair',
    overlapCollapseApplied: false,
    sharedEvidenceAutoReconciled: false,
    crossWindowAggregationApplied: false,
    crossWindowNormalizationApplied: false,
    windowSelectionAutoReordered: false,
    recommendationGenerated: false,
    actionGenerated: false,
    profitabilityBasis: PROFITABILITY_BASIS,
    authority: noAuthority(),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryRolling12WindowTransitionReceiptVerification', {
    value: Object.freeze({
      version: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_VERIFICATION_UI_VERSION,
      schemaVersion: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_VERIFICATION_SCHEMA_VERSION,
      authority: 'local_historical_rolling_12_window_transition_receipt_verification_only',
      verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers,
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
  const receiptHost = document.querySelector('[data-csv-history-rolling-12-window-transition-receipt]');
  if (!receiptHost) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-rolling-12-window-transition-receipt]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-rolling-12-window-transition-receipt-verification]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhr12trv';
  root.dataset.csvHistoryRolling12WindowTransitionReceiptVerification = CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_VERIFICATION_UI_VERSION;
  root.innerHTML = `
    <div class="cfhr12trv-head"><div><b>Rolling-12 Transition Receipt Verification</b><small>Validate a downloaded transition receipt first, bind it to explicit local ledger evidence, replay the original Rolling-12 window transition, and require exact receipt fingerprint plus deterministic serialization equality.</small></div><span>ledger-bound replay · fail closed</span></div>
    <div class="cfhr12trv-guard">If the receipt binds different previous/current ledger fingerprints, a second explicit current ledger is required. Verification never chooses a newer ledger, reconciles shared-quarter conflicts, upgrades a blocked transition, or grants execution authority.</div>
    <div class="cfhr12trv-controls">
      <label>Transition receipt <input type="file" accept="application/json,.json" data-cfhr12trv-receipt></label>
      <label>Previous ledger <input type="file" accept="application/json,.json" data-cfhr12trv-previous></label>
      <label>Current ledger <small>optional only when same fingerprint</small><input type="file" accept="application/json,.json" data-cfhr12trv-current></label>
      <button type="button" data-cfhr12trv-verify disabled>Verify receipt</button>
    </div>
    <div class="cfhr12trv-status" data-cfhr12trv-status>Explicit local-file ownership only. No ledger, receipt, or verification result is silently persisted.</div>
    <div class="cfhr12trv-result" data-cfhr12trv-result hidden></div>`;
  receiptHost.insertAdjacentElement('afterend', root);

  root.querySelector('[data-cfhr12trv-receipt]').addEventListener('change', (event) => void loadReceipt(root, event.currentTarget));
  root.querySelector('[data-cfhr12trv-previous]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget, 'previous'));
  root.querySelector('[data-cfhr12trv-current]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget, 'current'));
  root.querySelector('[data-cfhr12trv-verify]').addEventListener('click', () => void verifyFromUi(root));
  state.mounted = true;
}

async function loadReceipt(root, input) {
  const file = input.files?.[0];
  state.receipt = null;
  state.verification = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating standalone Rolling-12 transition receipt…', 'loading');
  try {
    state.receipt = await parseHistoricalRolling12WindowTransitionReceipt(await file.text());
    const distinct = state.receipt.source.previousLedgerFingerprint !== state.receipt.source.currentLedgerFingerprint;
    setStatus(root, distinct
      ? `Receipt ${state.receipt.receiptFingerprint.slice(0, 12)} validated. It binds two distinct ledgers; both are required.`
      : `Receipt ${state.receipt.receiptFingerprint.slice(0, 12)} validated. Previous/current ledger fingerprints are identical.`, 'ok');
  } catch (error) {
    setStatus(root, `Receipt blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function loadLedger(root, input, role) {
  const file = input.files?.[0];
  state[`${role}Ledger`] = null;
  state.verification = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, `Validating explicit local ${role} ledger…`, 'loading');
  try {
    state[`${role}Ledger`] = await validateCsvHistoryLedger(JSON.parse(await file.text()));
    setStatus(root, `${role === 'previous' ? 'Previous' : 'Current'} ledger validated: ${state[`${role}Ledger`].ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    setStatus(root, `${role === 'previous' ? 'Previous' : 'Current'} ledger blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function verifyFromUi(root) {
  if (!state.receipt || !state.previousLedger || state.busy) return;
  const distinctRequired = state.receipt.source.previousLedgerFingerprint !== state.receipt.source.currentLedgerFingerprint;
  if (distinctRequired && !state.currentLedger) return setStatus(root, 'Verification blocked: receipt requires an explicit current ledger with the bound fingerprint.', 'bad');
  state.busy = true;
  state.verification = null;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Replaying receipt against bound local ledger evidence…', 'loading');
  try {
    const options = state.currentLedger ? { currentLedger: state.currentLedger } : {};
    state.verification = await verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers(state.previousLedger, state.receipt, options);
    renderVerification(root, state.verification);
    setStatus(root, `Verified ${state.verification.receiptFingerprint.slice(0, 12)} with exact replay fingerprint and deterministic serialization equality.`, 'ok');
  } catch (error) {
    setStatus(root, `Verification blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function renderVerification(root, verification) {
  const result = root.querySelector('[data-cfhr12trv-result]');
  result.innerHTML = `
    <div class="cfhr12trv-grid">
      ${card('Verification', '<b>verified_against_explicit_local_ledgers</b>')}
      ${card('Receipt', `<code>${esc(verification.receiptFingerprint)}</code>`)}
      ${card('Previous R12', `<b>${esc(verification.previousWindowKey)}</b>`)}
      ${card('Current R12', `<b>${esc(verification.currentWindowKey)}</b>`)}
      ${card('Transition', verification.transitionAllowed ? '<b>allowed</b>' : '<b>blocked · raw evidence only</b>')}
      ${card('Ledger binding', verification.sameLedgerFingerprint ? '<b>same ledger</b>' : '<b>two explicit ledgers</b>')}
    </div>
    <div class="cfhr12trv-evidence">Outgoing: <b>${esc(verification.outgoingQuarterKey || '—')}</b> · shared quarters: <b>${verification.sharedQuarterKeys.length}</b> · incoming: <b>${esc(verification.incomingQuarterKey || '—')}</b> · fingerprint match: <b>true</b> · serialization match: <b>true</b></div>
    <details><summary>Verification authority boundary</summary><pre>${esc(JSON.stringify(verification.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function syncControls(root) {
  const distinctRequired = Boolean(state.receipt && state.receipt.source.previousLedgerFingerprint !== state.receipt.source.currentLedgerFingerprint);
  root.querySelector('[data-cfhr12trv-receipt]').disabled = state.busy;
  root.querySelector('[data-cfhr12trv-previous]').disabled = state.busy;
  root.querySelector('[data-cfhr12trv-current]').disabled = state.busy;
  root.querySelector('[data-cfhr12trv-verify]').disabled = state.busy || !state.receipt || !state.previousLedger || (distinctRequired && !state.currentLedger);
}
function clearResult(root) { const node = root.querySelector('[data-cfhr12trv-result]'); node.hidden = true; node.innerHTML = ''; }
function setStatus(root, text, tone = '') { const node = root.querySelector('[data-cfhr12trv-status]'); node.textContent = text; node.dataset.tone = tone; }
function card(label, value) { return `<div class="cfhr12trv-card"><small>${esc(label)}</small><div>${value}</div></div>`; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function noAuthority() {
  return { authoritative: false, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
function verificationError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryRolling12WindowTransitionReceiptVerificationError';
  error.code = code;
  return error;
}
function installStyles() {
  if (document.getElementById('cfhr12trv-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhr12trv-style-v1';
  style.textContent = '.cfhr12trv{margin:24px 0;padding:20px;border:1px solid rgba(127,127,127,.24);border-radius:18px;background:rgba(255,255,255,.72)}.cfhr12trv-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.cfhr12trv-head b{font-size:18px}.cfhr12trv-head small{display:block;max-width:820px;margin-top:5px;line-height:1.45}.cfhr12trv-head>span,.cfhr12trv-guard,.cfhr12trv-status,.cfhr12trv-evidence{font-size:12px}.cfhr12trv-guard,.cfhr12trv-status,.cfhr12trv-evidence{margin-top:12px;padding:10px 12px;border-radius:12px;background:rgba(127,127,127,.08)}.cfhr12trv-status[data-tone="bad"]{color:#b91c1c}.cfhr12trv-status[data-tone="ok"]{color:#047857}.cfhr12trv-controls{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-top:14px}.cfhr12trv-controls label{display:grid;gap:5px;font-size:12px}.cfhr12trv-controls label small{font-weight:400}.cfhr12trv-controls input,.cfhr12trv-controls button{min-height:34px}.cfhr12trv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:14px}.cfhr12trv-card{padding:12px;border:1px solid rgba(127,127,127,.2);border-radius:12px;overflow-wrap:anywhere}.cfhr12trv-card small{display:block;margin-bottom:5px}.cfhr12trv code{font-size:11px;word-break:break-all}.cfhr12trv details{margin-top:12px}.cfhr12trv pre{white-space:pre-wrap;word-break:break-word}';
  document.head.append(style);
}
