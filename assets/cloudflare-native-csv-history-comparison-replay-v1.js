import { parseCsvHistoryLedger, validateCsvHistoryLedger } from './csv-analysis-engine/csv-history-ledger.js';
import {
  buildHistoricalComparisonReceipt,
  parseHistoricalComparisonReceipt,
  validateHistoricalComparisonReceipt,
} from './cloudflare-native-csv-history-comparison-receipt-v1.js';

export const CSV_HISTORY_COMPARISON_REPLAY_SCHEMA_VERSION = 'csv-history-comparison-replay-v1';
export const CSV_HISTORY_COMPARISON_REPLAY_UI_VERSION = '1.0.0';

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
  if (validatedReceipt.source?.ledgerFingerprint !== validatedLedger.ledgerFingerprint) {
    throw replayError('CSV_HISTORY_COMPARISON_REPLAY_LEDGER_FINGERPRINT_MISMATCH');
  }
  const replayedReceipt = await buildHistoricalComparisonReceipt(
    validatedLedger,
    validatedReceipt.source.periodAEvidenceKey,
    validatedReceipt.source.periodBEvidenceKey,
  );
  if (replayedReceipt.receiptFingerprint !== validatedReceipt.receiptFingerprint) {
    throw replayError('CSV_HISTORY_COMPARISON_REPLAY_RESULT_MISMATCH');
  }
  return deepFreeze({
    schemaVersion: CSV_HISTORY_COMPARISON_REPLAY_SCHEMA_VERSION,
    verificationPurpose: 'local_receipt_vs_immutable_ledger_replay_only',
    verified: true,
    ledgerFingerprint: validatedLedger.ledgerFingerprint,
    receiptFingerprint: validatedReceipt.receiptFingerprint,
    periodAEvidenceKey: validatedReceipt.source.periodAEvidenceKey,
    periodBEvidenceKey: validatedReceipt.source.periodBEvidenceKey,
    comparisonAllowed: validatedReceipt.comparison.comparisonAllowed,
    rawEvidenceOnly: validatedReceipt.comparison.rawEvidenceOnly,
    replay: {
      comparisonRecomputedFromLedger: true,
      receiptFingerprintReproduced: true,
      generatedTimestampIncluded: false,
      cryptographicSignatureVerified: false,
    },
    authority: noAuthority(),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryComparisonReplay', {
    value: Object.freeze({
      version: CSV_HISTORY_COMPARISON_REPLAY_UI_VERSION,
      schemaVersion: CSV_HISTORY_COMPARISON_REPLAY_SCHEMA_VERSION,
      authority: 'local_receipt_vs_immutable_ledger_replay_only',
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
  if (joint.querySelector('[data-csv-history-comparison-replay]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhrep';
  root.dataset.csvHistoryComparisonReplay = CSV_HISTORY_COMPARISON_REPLAY_UI_VERSION;
  root.innerHTML = `
    <div class="cfhrep-head">
      <div><b>Historical Comparison Receipt Replay</b><small>Verify a downloaded comparison receipt by re-importing its original immutable history ledger and recomputing the comparison locally.</small></div>
      <span>ledger replay · local only</span>
    </div>
    <div class="cfhrep-guard">A receipt fingerprint is not a digital signature. Verification succeeds only when the original ledger reproduces the exact receipt fingerprint. This creates no analytical, governance, execution, or Amazon authority.</div>
    <div class="cfhrep-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhrep-ledger></label>
      <label>Comparison receipt <input type="file" accept="application/json,.json" data-cfhrep-receipt></label>
      <button type="button" data-cfhrep-verify disabled>Replay & verify</button>
    </div>
    <div class="cfhrep-status" data-cfhrep-status>Import the original local ledger and a comparison receipt. Nothing is stored after this page session.</div>
    <div class="cfhrep-result" data-cfhrep-result hidden></div>`;

  const receiptPanel = joint.querySelector('[data-csv-history-comparison-receipt]');
  const provenance = joint.querySelector('[data-csv-provenance-audit]');
  if (receiptPanel) receiptPanel.insertAdjacentElement('afterend', root);
  else if (provenance) provenance.insertAdjacentElement('beforebegin', root);
  else joint.appendChild(root);

  root.querySelector('[data-cfhrep-ledger]').addEventListener('change', (event) => void importLedger(root, event.currentTarget));
  root.querySelector('[data-cfhrep-receipt]').addEventListener('change', (event) => void importReceipt(root, event.currentTarget));
  root.querySelector('[data-cfhrep-verify]').addEventListener('click', () => void verifyFromUi(root));
  state.mounted = true;
}

async function importLedger(root, input) {
  const file = input.files?.[0];
  if (!file || state.busy) return;
  state.busy = true;
  state.ledger = null;
  state.ledgerFileName = null;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Validating local history ledger…', 'loading');
  try {
    state.ledger = await parseCsvHistoryLedger(await file.text());
    state.ledgerFileName = file.name;
    setStatus(root, `Ledger ${state.ledger.ledgerFingerprint.slice(0, 12)} validated from ${file.name}.`, 'ok');
  } catch (error) {
    setStatus(root, `Ledger import blocked: ${errorCode(error)}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function importReceipt(root, input) {
  const file = input.files?.[0];
  if (!file || state.busy) return;
  state.busy = true;
  state.receipt = null;
  state.receiptFileName = null;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Validating comparison receipt fingerprint and bindings…', 'loading');
  try {
    state.receipt = await parseHistoricalComparisonReceipt(await file.text());
    state.receiptFileName = file.name;
    setStatus(root, `Receipt ${state.receipt.receiptFingerprint.slice(0, 12)} validated from ${file.name}. Import the matching ledger if not already selected.`, 'ok');
  } catch (error) {
    setStatus(root, `Receipt import blocked: ${errorCode(error)}`, 'bad');
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
  setStatus(root, 'Replaying Period A/B from immutable ledger evidence…', 'loading');
  try {
    const verification = await verifyHistoricalComparisonReceiptAgainstLedger(state.ledger, state.receipt);
    renderVerification(root, verification);
    setStatus(root, `Verified receipt ${verification.receiptFingerprint.slice(0, 12)} against ledger ${verification.ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    setStatus(root, `Replay verification failed closed: ${errorCode(error)}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function syncControls(root) {
  root.querySelector('[data-cfhrep-ledger]').disabled = state.busy;
  root.querySelector('[data-cfhrep-receipt]').disabled = state.busy;
  root.querySelector('[data-cfhrep-verify]').disabled = state.busy || !state.ledger || !state.receipt;
}

function renderVerification(root, verification) {
  const result = root.querySelector('[data-cfhrep-result]');
  result.innerHTML = `
    <div class="cfhrep-grid">
      ${card('Replay', '<b>verified</b>')}
      ${card('Ledger fingerprint', `<code>${esc(verification.ledgerFingerprint)}</code>`)}
      ${card('Receipt fingerprint', `<code>${esc(verification.receiptFingerprint)}</code>`)}
      ${card('Comparison state', verification.comparisonAllowed ? '<b>comparable</b>' : '<b>blocked · raw evidence only</b>')}
    </div>
    <div class="cfhrep-note">Fingerprint reproduced by recomputing the comparison from the imported ledger. No digital-signature claim is made.</div>
    <details><summary>Verification authority boundary</summary><pre>${esc(JSON.stringify(verification.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function clearResult(root) {
  const result = root.querySelector('[data-cfhrep-result]');
  result.hidden = true;
  result.innerHTML = '';
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

function replayError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryComparisonReplayError';
  error.code = code;
  return error;
}

function errorCode(error) {
  return String(error?.code || error?.message || 'unknown_error');
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhrep-status]');
  node.textContent = text;
  node.dataset.kind = kind;
}

function card(label, value) {
  return `<div class="cfhrep-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhrep-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhrep-style-v1';
  style.textContent = '.cfhrep{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhrep-head{display:flex;justify-content:space-between;gap:12px}.cfhrep-head small{display:block;color:#64748b;max-width:780px}.cfhrep-head>span{font-size:11px;font-weight:800}.cfhrep-guard,.cfhrep-status,.cfhrep-note{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhrep-status[data-kind="bad"]{color:#b91c1c}.cfhrep-status[data-kind="ok"]{color:#047857}.cfhrep-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhrep-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhrep-controls input,.cfhrep-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhrep-controls button{font-weight:700;cursor:pointer}.cfhrep-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhrep-result{margin-top:10px}.cfhrep-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhrep-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhrep-card small{display:block;color:#64748b}.cfhrep code{font-size:11px;word-break:break-all}.cfhrep details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhrep summary{cursor:pointer;font-weight:700}.cfhrep pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
