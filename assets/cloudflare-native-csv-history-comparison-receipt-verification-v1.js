import { validateCsvHistoryLedger } from './csv-analysis-engine/csv-history-ledger.js';
import {
  buildHistoricalComparisonReceipt,
  parseHistoricalComparisonReceipt,
  serializeHistoricalComparisonReceipt,
  validateHistoricalComparisonReceipt,
} from './cloudflare-native-csv-history-comparison-receipt-v1.js';

export const CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION = 'csv-history-comparison-receipt-verification-v1';
export const CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION = '1.0.0';

const state = {
  mounted: false,
  busy: false,
  ledger: null,
  receipt: null,
  ledgerFileName: null,
  receiptFileName: null,
};

export async function verifyHistoricalComparisonReceiptAgainstLedger(ledger, receipt) {
  const validatedLedger = await validateCsvHistoryLedger(ledger);
  const validatedReceipt = await validateHistoricalComparisonReceipt(receipt);
  if (validatedLedger.ledgerFingerprint !== validatedReceipt.source.ledgerFingerprint) {
    throw verificationError('CSV_HISTORY_COMPARISON_RECEIPT_LEDGER_FINGERPRINT_MISMATCH');
  }

  const recomputed = await buildHistoricalComparisonReceipt(
    validatedLedger,
    validatedReceipt.source.periodAEvidenceKey,
    validatedReceipt.source.periodBEvidenceKey,
  );
  if (recomputed.receiptFingerprint !== validatedReceipt.receiptFingerprint) {
    throw verificationError('CSV_HISTORY_COMPARISON_RECEIPT_REPLAY_FINGERPRINT_MISMATCH');
  }
  const originalSerialized = serializeHistoricalComparisonReceipt(validatedReceipt);
  const recomputedSerialized = serializeHistoricalComparisonReceipt(recomputed);
  if (originalSerialized !== recomputedSerialized) {
    throw verificationError('CSV_HISTORY_COMPARISON_RECEIPT_REPLAY_SERIALIZATION_MISMATCH');
  }

  return deepFreeze({
    schemaVersion: CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION,
    verificationState: 'verified_against_local_ledger',
    receiptFingerprint: validatedReceipt.receiptFingerprint,
    recomputedReceiptFingerprint: recomputed.receiptFingerprint,
    ledgerFingerprint: validatedLedger.ledgerFingerprint,
    periodAEvidenceKey: validatedReceipt.source.periodAEvidenceKey,
    periodBEvidenceKey: validatedReceipt.source.periodBEvidenceKey,
    comparisonAllowed: validatedReceipt.comparison.comparisonAllowed,
    rawEvidenceOnly: validatedReceipt.comparison.rawEvidenceOnly,
    receiptSerializationMatch: true,
    receiptFingerprintMatch: true,
    generatedTimestampIncluded: false,
    replayedFromExplicitLocalLedger: true,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    crossSnapshotAggregationApplied: false,
    normalizationApplied: false,
    authority: noAuthority(),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryComparisonReceiptVerification', {
    value: Object.freeze({
      version: CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION,
      schemaVersion: CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_SCHEMA_VERSION,
      authority: 'local_historical_comparison_receipt_verification_only',
      verifyHistoricalComparisonReceiptAgainstLedger,
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
  const joint = document.querySelector('[data-csv-joint-analysis]');
  if (!joint) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-joint-analysis]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (joint.querySelector('[data-csv-history-comparison-receipt-verification]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhcv';
  root.dataset.csvHistoryComparisonReceiptVerification = CSV_HISTORY_COMPARISON_RECEIPT_VERIFICATION_UI_VERSION;
  root.innerHTML = `
    <div class="cfhcv-head">
      <div><b>Comparison Receipt Verification</b><small>Supply the original local history ledger and a downloaded comparison receipt. Verification replays Period A/B through the current comparability engine and requires an exact fingerprint and serialization match.</small></div>
      <span>ledger-bound replay</span>
    </div>
    <div class="cfhcv-guard">Standalone receipt integrity is checked first, then the receipt is rebuilt from the explicit local ledger. Any receipt drift, ledger drift, evidence-key drift, or authority escalation fails closed.</div>
    <div class="cfhcv-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhcv-ledger></label>
      <label>Comparison receipt <input type="file" accept="application/json,.json" data-cfhcv-receipt></label>
      <button type="button" data-cfhcv-verify disabled>Verify against ledger</button>
    </div>
    <div class="cfhcv-status" data-cfhcv-status>Select both local files. No file contents are persisted remotely or in hidden browser storage.</div>
    <div class="cfhcv-result" data-cfhcv-result hidden></div>`;

  const receiptWorkspace = joint.querySelector('[data-csv-history-comparison-receipt]');
  const provenance = joint.querySelector('[data-csv-provenance-audit]');
  if (receiptWorkspace) receiptWorkspace.insertAdjacentElement('afterend', root);
  else if (provenance) provenance.insertAdjacentElement('beforebegin', root);
  else joint.appendChild(root);

  root.querySelector('[data-cfhcv-ledger]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget));
  root.querySelector('[data-cfhcv-receipt]').addEventListener('change', (event) => void loadReceipt(root, event.currentTarget));
  root.querySelector('[data-cfhcv-verify]').addEventListener('click', () => void verifyFromUi(root));
  state.mounted = true;
}

async function loadLedger(root, input) {
  const file = input.files?.[0];
  state.ledger = null;
  state.ledgerFileName = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating local history ledger…', 'loading');
  try {
    const parsed = JSON.parse(await file.text());
    state.ledger = await validateCsvHistoryLedger(parsed);
    state.ledgerFileName = file.name;
    setStatus(root, `Ledger validated: ${state.ledger.ledgerFingerprint.slice(0, 12)}. Select or retain a receipt, then verify.`, 'ok');
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
  state.receiptFileName = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating standalone comparison receipt integrity…', 'loading');
  try {
    state.receipt = await parseHistoricalComparisonReceipt(await file.text());
    state.receiptFileName = file.name;
    setStatus(root, `Receipt integrity validated: ${state.receipt.receiptFingerprint.slice(0, 12)}. Select or retain its source ledger, then verify.`, 'ok');
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
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Replaying receipt against explicit local ledger…', 'loading');
  try {
    const verification = await verifyHistoricalComparisonReceiptAgainstLedger(state.ledger, state.receipt);
    renderVerification(root, verification);
    setStatus(root, `Verified against local ledger. Receipt ${verification.receiptFingerprint.slice(0, 12)} exactly matches recomputation.`, 'ok');
  } catch (error) {
    setStatus(root, `Verification blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function renderVerification(root, verification) {
  const result = root.querySelector('[data-cfhcv-result]');
  result.innerHTML = `
    <div class="cfhcv-grid">
      ${card('Verification', '<b>verified against local ledger</b>')}
      ${card('Receipt fingerprint', `<code>${esc(verification.receiptFingerprint)}</code>`)}
      ${card('Ledger fingerprint', `<code>${esc(verification.ledgerFingerprint)}</code>`)}
      ${card('Comparison state', verification.comparisonAllowed ? '<b>allowed</b><br>interpretable review receipt' : '<b>blocked</b><br>raw evidence only')}
    </div>
    <div class="cfhcv-guard">Fingerprint match: true · serialization match: true · generated timestamp: none · normalization: none · cross-snapshot aggregation: none.</div>
    <details><summary>Period A evidence key</summary><pre>${esc(JSON.stringify(verification.periodAEvidenceKey, null, 2))}</pre></details>
    <details><summary>Period B evidence key</summary><pre>${esc(JSON.stringify(verification.periodBEvidenceKey, null, 2))}</pre></details>
    <details><summary>Verification authority boundary</summary><pre>${esc(JSON.stringify(verification.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function syncControls(root) {
  root.querySelector('[data-cfhcv-ledger]').disabled = state.busy;
  root.querySelector('[data-cfhcv-receipt]').disabled = state.busy;
  root.querySelector('[data-cfhcv-verify]').disabled = state.busy || !state.ledger || !state.receipt;
}

function clearResult(root) {
  const result = root.querySelector('[data-cfhcv-result]');
  result.hidden = true;
  result.innerHTML = '';
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhcv-status]');
  node.textContent = text;
  node.dataset.kind = kind;
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
  error.name = 'CsvHistoryComparisonReceiptVerificationError';
  error.code = code;
  return error;
}

function card(label, value) {
  return `<div class="cfhcv-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhcv-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhcv-style-v1';
  style.textContent = '.cfhcv{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhcv-head{display:flex;justify-content:space-between;gap:12px}.cfhcv-head small{display:block;color:#64748b;max-width:780px}.cfhcv-head>span{font-size:11px;font-weight:800}.cfhcv-guard,.cfhcv-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhcv-status[data-kind="bad"]{color:#b91c1c}.cfhcv-status[data-kind="ok"]{color:#047857}.cfhcv-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhcv-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhcv-controls input,.cfhcv-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhcv-controls button{font-weight:700;cursor:pointer}.cfhcv-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhcv-result{margin-top:10px}.cfhcv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhcv-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhcv-card small{display:block;color:#64748b}.cfhcv code{font-size:11px;word-break:break-all}.cfhcv details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhcv summary{cursor:pointer;font-weight:700}.cfhcv pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
