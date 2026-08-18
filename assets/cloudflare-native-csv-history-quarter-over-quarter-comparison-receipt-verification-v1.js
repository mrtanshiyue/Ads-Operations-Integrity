import { validateCsvHistoryLedger } from './csv-analysis-engine/csv-history-ledger.js';
import {
  buildHistoricalQuarterOverQuarterComparisonReceipt,
  parseHistoricalQuarterOverQuarterComparisonReceipt,
  serializeHistoricalQuarterOverQuarterComparisonReceipt,
  validateHistoricalQuarterOverQuarterComparisonReceipt,
} from './cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-v1.js';

export const CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION = 'csv-history-quarter-over-quarter-comparison-receipt-verification-v1';
export const CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION = '1.0.0';

const state = {
  mounted: false,
  busy: false,
  ledger: null,
  receipt: null,
  verification: null,
};

export async function verifyHistoricalQuarterOverQuarterComparisonReceiptAgainstLedger(ledger, receipt) {
  const validatedLedger = await validateCsvHistoryLedger(ledger);
  const validatedReceipt = await validateHistoricalQuarterOverQuarterComparisonReceipt(receipt);
  if (validatedLedger.ledgerFingerprint !== validatedReceipt.source.ledgerFingerprint) {
    throw verificationError('CSV_HISTORY_QOQ_RECEIPT_LEDGER_FINGERPRINT_MISMATCH');
  }

  const recomputed = await buildHistoricalQuarterOverQuarterComparisonReceipt(
    validatedLedger,
    validatedReceipt.source.periodAQuarter,
    validatedReceipt.source.periodBQuarter,
  );
  if (recomputed.receiptFingerprint !== validatedReceipt.receiptFingerprint) {
    throw verificationError('CSV_HISTORY_QOQ_RECEIPT_REPLAY_FINGERPRINT_MISMATCH');
  }

  const originalSerialized = serializeHistoricalQuarterOverQuarterComparisonReceipt(validatedReceipt);
  const recomputedSerialized = serializeHistoricalQuarterOverQuarterComparisonReceipt(recomputed);
  if (originalSerialized !== recomputedSerialized) {
    throw verificationError('CSV_HISTORY_QOQ_RECEIPT_REPLAY_SERIALIZATION_MISMATCH');
  }

  return deepFreeze({
    schemaVersion: CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION,
    verificationState: 'verified_against_local_ledger',
    receiptFingerprint: validatedReceipt.receiptFingerprint,
    recomputedReceiptFingerprint: recomputed.receiptFingerprint,
    ledgerFingerprint: validatedLedger.ledgerFingerprint,
    periodAQuarter: validatedReceipt.source.periodAQuarter,
    periodBQuarter: validatedReceipt.source.periodBQuarter,
    periodASourceInputSetFingerprints: [...validatedReceipt.source.periodASourceInputSetFingerprints],
    periodBSourceInputSetFingerprints: [...validatedReceipt.source.periodBSourceInputSetFingerprints],
    comparisonAllowed: validatedReceipt.comparison.comparisonAllowed,
    interpretationAllowed: validatedReceipt.comparison.interpretationAllowed,
    rawEvidenceOnly: validatedReceipt.comparison.rawEvidenceOnly,
    receiptFingerprintMatch: true,
    receiptSerializationMatch: true,
    generatedTimestampIncluded: false,
    replayedFromExplicitLocalLedger: true,
    deltaBasis: 'quarter_b_minus_quarter_a',
    selectionPolicy: 'operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder',
    crossQuarterAggregationApplied: false,
    crossQuarterNormalizationApplied: false,
    quarterSelectionAutoReordered: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryQuarterOverQuarterComparisonReceiptVerification', {
    value: Object.freeze({
      version: CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION,
      schemaVersion: CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION,
      authority: 'local_historical_quarter_over_quarter_receipt_verification_only',
      verifyHistoricalQuarterOverQuarterComparisonReceiptAgainstLedger,
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
  const receiptHost = document.querySelector('[data-csv-history-quarter-over-quarter-comparison-receipt]');
  if (!receiptHost) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-quarter-over-quarter-comparison-receipt]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-quarter-over-quarter-comparison-receipt-verification]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhqoqv';
  root.dataset.csvHistoryQuarterOverQuarterComparisonReceiptVerification = CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION;
  root.innerHTML = `
    <div class="cfhqoqv-head">
      <div><b>QoQ Receipt Verification</b><small>Supply the explicit local history ledger and a downloaded QoQ receipt. Verification independently validates the receipt, replays its operator-selected quarters, and requires exact fingerprint and deterministic serialization equality.</small></div>
      <span>ledger-bound replay</span>
    </div>
    <div class="cfhqoqv-guard">Any ledger drift, receipt tampering, quarter/source binding drift, replay drift, or authority escalation fails closed. A verified blocked receipt remains raw-evidence-only; verification never upgrades comparability or execution authority.</div>
    <div class="cfhqoqv-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhqoqv-ledger></label>
      <label>QoQ receipt <input type="file" accept="application/json,.json" data-cfhqoqv-receipt></label>
      <button type="button" data-cfhqoqv-verify disabled>Verify against ledger</button>
    </div>
    <div class="cfhqoqv-status" data-cfhqoqv-status>Explicit local-file ownership: no ledger, receipt, or verification result is silently persisted.</div>
    <div class="cfhqoqv-result" data-cfhqoqv-result hidden></div>`;
  receiptHost.insertAdjacentElement('afterend', root);

  root.querySelector('[data-cfhqoqv-ledger]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget));
  root.querySelector('[data-cfhqoqv-receipt]').addEventListener('change', (event) => void loadReceipt(root, event.currentTarget));
  root.querySelector('[data-cfhqoqv-verify]').addEventListener('click', () => void verifyFromUi(root));
  state.mounted = true;
}

async function loadLedger(root, input) {
  const file = input.files?.[0];
  state.ledger = null;
  state.verification = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating explicit local history ledger…', 'loading');
  try {
    state.ledger = await validateCsvHistoryLedger(JSON.parse(await file.text()));
    setStatus(root, `Ledger validated: ${state.ledger.ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    setStatus(root, `Ledger blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function loadReceipt(root, input) {
  const file = input.files?.[0];
  state.receipt = null;
  state.verification = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating standalone QoQ receipt integrity…', 'loading');
  try {
    state.receipt = await parseHistoricalQuarterOverQuarterComparisonReceipt(await file.text());
    setStatus(root, `Receipt integrity validated: ${state.receipt.receiptFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    setStatus(root, `Receipt blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function verifyFromUi(root) {
  if (!state.ledger || !state.receipt || state.busy) return;
  state.busy = true;
  state.verification = null;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Replaying QoQ receipt against explicit local ledger…', 'loading');
  try {
    state.verification = await verifyHistoricalQuarterOverQuarterComparisonReceiptAgainstLedger(state.ledger, state.receipt);
    renderVerification(root, state.verification);
    setStatus(root, `Verified ${state.verification.receiptFingerprint.slice(0, 12)} against local ledger with exact replay equality.`, 'ok');
  } catch (error) {
    setStatus(root, `Verification blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function renderVerification(root, verification) {
  const result = root.querySelector('[data-cfhqoqv-result]');
  result.innerHTML = `
    <div class="cfhqoqv-grid">
      ${card('Verification', '<b>verified_against_local_ledger</b>')}
      ${card('Receipt', `<code>${esc(verification.receiptFingerprint)}</code>`)}
      ${card('Period A', `<b>${esc(verification.periodAQuarter)}</b>`)}
      ${card('Period B', `<b>${esc(verification.periodBQuarter)}</b>`)}
      ${card('Comparability', verification.comparisonAllowed ? '<b>allowed</b>' : '<b>blocked · raw evidence only</b>')}
    </div>
    <div class="cfhqoqv-evidence">Fingerprint match: <b>true</b> · deterministic serialization match: <b>true</b> · quarter selection auto-reordered: <b>false</b></div>
    <details><summary>Verification authority boundary</summary><pre>${esc(JSON.stringify(verification.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function syncControls(root) {
  root.querySelector('[data-cfhqoqv-ledger]').disabled = state.busy;
  root.querySelector('[data-cfhqoqv-receipt]').disabled = state.busy;
  root.querySelector('[data-cfhqoqv-verify]').disabled = state.busy || !state.ledger || !state.receipt;
}

function clearResult(root) {
  root.querySelector('[data-cfhqoqv-result]').hidden = true;
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function verificationError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryQuarterOverQuarterComparisonReceiptVerificationError';
  error.code = code;
  return error;
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhqoqv-status]');
  node.textContent = text;
  node.dataset.kind = kind;
}

function card(label, value) {
  return `<div class="cfhqoqv-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhqoqv-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhqoqv-style-v1';
  style.textContent = '.cfhqoqv{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhqoqv-head{display:flex;justify-content:space-between;gap:12px}.cfhqoqv-head small{display:block;color:#64748b;max-width:800px}.cfhqoqv-head>span{font-size:11px;font-weight:800}.cfhqoqv-guard,.cfhqoqv-status,.cfhqoqv-evidence{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhqoqv-status[data-kind="bad"]{color:#b91c1c}.cfhqoqv-status[data-kind="ok"]{color:#047857}.cfhqoqv-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhqoqv-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhqoqv-controls input,.cfhqoqv-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhqoqv-controls button{font-weight:700;cursor:pointer}.cfhqoqv-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhqoqv-result{margin-top:10px}.cfhqoqv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhqoqv-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhqoqv-card small{display:block;color:#64748b}.cfhqoqv code{font-size:11px;word-break:break-all}.cfhqoqv details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhqoqv summary{cursor:pointer;font-weight:700}.cfhqoqv pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
