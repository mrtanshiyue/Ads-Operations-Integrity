import { canonicalJson } from './csv-analysis-engine/canonical-json.js';
import { parseCsvHistoryLedger } from './csv-analysis-engine/csv-history-ledger.js';
import {
  buildHistoricalMonthlyWorkspace,
  buildHistoricalPeriodComparison,
} from './cloudflare-native-csv-history-ledger-v1.js';

export const CSV_HISTORY_COMPARISON_RECEIPT_SCHEMA_VERSION = 'csv-history-comparison-receipt-v1';
export const CSV_HISTORY_COMPARISON_RECEIPT_UI_VERSION = '1.0.0';

const state = {
  mounted: false,
  busy: false,
  ledger: null,
  rows: [],
  receipt: null,
  importedFileName: null,
};

export async function buildHistoricalComparisonReceipt(ledger, periodASelection, periodBSelection) {
  const comparison = await buildHistoricalPeriodComparison(ledger, periodASelection, periodBSelection);
  const payload = {
    schemaVersion: CSV_HISTORY_COMPARISON_RECEIPT_SCHEMA_VERSION,
    receiptPurpose: 'local_historical_comparison_audit_only',
    source: {
      ledgerFingerprint: comparison.periodA.evidenceKey.ledgerFingerprint,
      periodAEvidenceKey: comparison.periodA.evidenceKey,
      periodBEvidenceKey: comparison.periodB.evidenceKey,
    },
    comparison,
    deterministic: {
      generatedTimestampIncluded: false,
      canonicalProjectionVersion: 'csv-history-number-projection-v1',
      comparisonRecomputedFromLedger: true,
    },
    authority: noAuthority(),
  };
  assertReceiptBoundary(payload);
  const receiptFingerprint = await fingerprintReceiptPayload(payload);
  return deepFreeze({ ...payload, receiptFingerprint });
}

export async function validateHistoricalComparisonReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_INVALID');
  if (receipt.schemaVersion !== CSV_HISTORY_COMPARISON_RECEIPT_SCHEMA_VERSION) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_SCHEMA_UNSUPPORTED');
  assertReceiptBoundary(receipt);
  const fingerprint = String(receipt.receiptFingerprint || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_FINGERPRINT_INVALID');
  const { receiptFingerprint: _ignored, ...payload } = receipt;
  const expected = await fingerprintReceiptPayload(payload);
  if (expected !== fingerprint) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_FINGERPRINT_MISMATCH');
  if (receipt.source?.ledgerFingerprint !== receipt.comparison?.periodA?.evidenceKey?.ledgerFingerprint) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_LEDGER_BINDING_MISMATCH');
  if (receipt.source?.ledgerFingerprint !== receipt.comparison?.periodB?.evidenceKey?.ledgerFingerprint) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_LEDGER_BINDING_MISMATCH');
  if (!sameEvidenceKey(receipt.source?.periodAEvidenceKey, receipt.comparison?.periodA?.evidenceKey)) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_PERIOD_A_BINDING_MISMATCH');
  if (!sameEvidenceKey(receipt.source?.periodBEvidenceKey, receipt.comparison?.periodB?.evidenceKey)) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_PERIOD_B_BINDING_MISMATCH');
  return deepFreeze(structuredClone(receipt));
}

export async function parseHistoricalComparisonReceipt(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_JSON_INVALID');
  }
  return validateHistoricalComparisonReceipt(parsed);
}

export function serializeHistoricalComparisonReceipt(receipt) {
  assertReceiptBoundary(receipt);
  if (!/^[a-f0-9]{64}$/i.test(String(receipt?.receiptFingerprint || ''))) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_FINGERPRINT_INVALID');
  return `${JSON.stringify(sortKeysDeep(receipt), null, 2)}\n`;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryComparisonReceipt', {
    value: Object.freeze({
      version: CSV_HISTORY_COMPARISON_RECEIPT_UI_VERSION,
      schemaVersion: CSV_HISTORY_COMPARISON_RECEIPT_SCHEMA_VERSION,
      authority: 'local_historical_comparison_audit_only',
      buildHistoricalComparisonReceipt,
      validateHistoricalComparisonReceipt,
      parseHistoricalComparisonReceipt,
      serializeHistoricalComparisonReceipt,
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
  if (joint.querySelector('[data-csv-history-comparison-receipt]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhcr';
  root.dataset.csvHistoryComparisonReceipt = CSV_HISTORY_COMPARISON_RECEIPT_UI_VERSION;
  root.innerHTML = `
    <div class="cfhcr-head">
      <div><b>Historical Comparison Receipt</b><small>Re-import a local history-ledger.json to independently replay Period A/B through the comparability gate and create a deterministic audit receipt.</small></div>
      <span>local replay · deterministic</span>
    </div>
    <div class="cfhcr-guard">Receipt generation creates no new analytical authority. Blocked comparisons remain exportable as raw-evidence-only receipts with deltas withheld. Ad Contribution = Sales - Ad Spend only; it is not Net Profit.</div>
    <div class="cfhcr-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhcr-ledger></label>
      <label>Period A <select data-cfhcr-a disabled><option value="">Import ledger first</option></select></label>
      <label>Period B <select data-cfhcr-b disabled><option value="">Import ledger first</option></select></label>
      <button type="button" data-cfhcr-build disabled>Build receipt</button>
      <button type="button" data-cfhcr-download disabled>Download receipt</button>
    </div>
    <div class="cfhcr-status" data-cfhcr-status>Explicit local file ownership: no ledger is retained after this page session.</div>
    <div class="cfhcr-result" data-cfhcr-result hidden></div>`;

  const historyComparison = joint.querySelector('[data-cfhl-history-comparison]');
  const provenance = joint.querySelector('[data-csv-provenance-audit]');
  if (historyComparison) historyComparison.insertAdjacentElement('afterend', root);
  else if (provenance) provenance.insertAdjacentElement('beforebegin', root);
  else joint.appendChild(root);

  root.querySelector('[data-cfhcr-ledger]').addEventListener('change', (event) => void importLedger(root, event.currentTarget));
  root.querySelector('[data-cfhcr-a]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhcr-b]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhcr-build]').addEventListener('click', () => void buildReceiptFromUi(root));
  root.querySelector('[data-cfhcr-download]').addEventListener('click', () => downloadReceipt(root));
  state.mounted = true;
}

async function importLedger(root, input) {
  const file = input.files?.[0];
  if (!file || state.busy) return;
  state.busy = true;
  state.ledger = null;
  state.rows = [];
  state.receipt = null;
  root.querySelector('[data-cfhcr-result]').hidden = true;
  setStatus(root, 'Validating local history ledger…', 'loading');
  syncControls(root);
  try {
    const ledger = await parseCsvHistoryLedger(await file.text());
    const workspace = buildHistoricalMonthlyWorkspace(ledger);
    state.ledger = ledger;
    state.rows = [...workspace.rows];
    state.importedFileName = file.name;
    populateSelectors(root, state.rows);
    setStatus(root, `Validated ${workspace.rowCount} monthly evidence row(s) from ${file.name}. Ledger ${ledger.ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    state.importedFileName = null;
    populateSelectors(root, []);
    setStatus(root, `Ledger import blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function buildReceiptFromUi(root) {
  if (!state.ledger || state.busy) return;
  const indexA = Number(root.querySelector('[data-cfhcr-a]').value);
  const indexB = Number(root.querySelector('[data-cfhcr-b]').value);
  if (!Number.isSafeInteger(indexA) || !Number.isSafeInteger(indexB) || !state.rows[indexA] || !state.rows[indexB]) return setStatus(root, 'Select valid Period A and Period B evidence rows.', 'bad');
  state.busy = true;
  state.receipt = null;
  syncControls(root);
  setStatus(root, 'Recomputing historical comparison and fingerprinting receipt…', 'loading');
  try {
    const receipt = await buildHistoricalComparisonReceipt(state.ledger, selectionFor(state.rows[indexA]), selectionFor(state.rows[indexB]));
    state.receipt = receipt;
    renderReceipt(root, receipt);
    setStatus(root, `Receipt ${receipt.receiptFingerprint.slice(0, 12)} built locally. ${receipt.comparison.comparisonAllowed ? 'Comparability gate passed.' : 'Comparison blocked; raw evidence preserved with deltas withheld.'}`, 'ok');
  } catch (error) {
    root.querySelector('[data-cfhcr-result]').hidden = true;
    setStatus(root, `Receipt generation blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function downloadReceipt(root) {
  if (!state.receipt || state.busy) return;
  const text = serializeHistoricalComparisonReceipt(state.receipt);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `csv-history-comparison-receipt-v1-${state.receipt.receiptFingerprint.slice(0, 12)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(root, `Downloaded deterministic comparison receipt ${state.receipt.receiptFingerprint.slice(0, 12)}. No remote persistence occurred.`, 'ok');
}

function populateSelectors(root, rows) {
  const optionHtml = rows.length
    ? rows.map((row, index) => `<option value="${index}">${esc(row.month)} · ${esc(row.sourceInputSetFingerprint.slice(0, 12))} · ${esc(row.decisionState)}</option>`).join('')
    : '<option value="">No monthly evidence</option>';
  const selectA = root.querySelector('[data-cfhcr-a]');
  const selectB = root.querySelector('[data-cfhcr-b]');
  selectA.innerHTML = optionHtml;
  selectB.innerHTML = optionHtml;
  if (rows.length > 1) selectB.value = '1';
}

function syncControls(root) {
  const ready = Boolean(state.ledger && state.rows.length);
  const selectA = root.querySelector('[data-cfhcr-a]');
  const selectB = root.querySelector('[data-cfhcr-b]');
  selectA.disabled = state.busy || !ready;
  selectB.disabled = state.busy || !ready;
  const validSelection = ready && state.rows[Number(selectA.value)] && state.rows[Number(selectB.value)];
  root.querySelector('[data-cfhcr-build]').disabled = state.busy || !validSelection;
  root.querySelector('[data-cfhcr-download]').disabled = state.busy || !state.receipt;
  root.querySelector('[data-cfhcr-ledger]').disabled = state.busy;
}

function renderReceipt(root, receipt) {
  const result = root.querySelector('[data-cfhcr-result]');
  const comparison = receipt.comparison;
  const reasons = comparison.comparabilityGate.reasons.length ? comparison.comparabilityGate.reasons.join(', ') : 'all comparability checks passed';
  const metricRows = Object.entries(comparison.metrics).map(([key, metric]) => `<tr><td>${esc(metric.label || key)}</td><td>${formatValue(metric.periodAValue)}</td><td>${formatValue(metric.periodBValue)}</td><td>${metric.delta == null ? 'withheld' : formatValue(metric.delta)}</td><td>${esc(metric.direction)}</td></tr>`).join('');
  result.innerHTML = `
    <div class="cfhcr-grid">
      ${card('Receipt fingerprint', `<code>${esc(receipt.receiptFingerprint)}</code>`)}
      ${card('Period A', `<b>${esc(comparison.periodA.selectedMonth)}</b><br><code>${esc(comparison.periodA.evidenceKey.sourceInputSetFingerprint.slice(0, 12))}</code>`)}
      ${card('Period B', `<b>${esc(comparison.periodB.selectedMonth)}</b><br><code>${esc(comparison.periodB.evidenceKey.sourceInputSetFingerprint.slice(0, 12))}</code>`)}
      ${card('Comparability', comparison.comparisonAllowed ? '<b>allowed</b><br>deltas available' : '<b>blocked</b><br>raw evidence only')}
    </div>
    <div class="cfhcr-reasons"><b>Gate:</b> ${esc(reasons)}</div>
    <div class="cfhcr-table"><table><thead><tr><th>Metric</th><th>Period A</th><th>Period B</th><th>Δ B-A</th><th>Direction</th></tr></thead><tbody>${metricRows}</tbody></table></div>
    <details><summary>Receipt authority boundary</summary><pre>${esc(JSON.stringify(receipt.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

async function fingerprintReceiptPayload(payload) {
  return sha256Hex(canonicalJson(projectNumbers(payload)));
}

function projectNumbers(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_NUMBER_INVALID');
    return { $csvHistoryNumber: Object.is(value, -0) ? '0' : String(value) };
  }
  if (Array.isArray(value)) return value.map(projectNumbers);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === 'receiptFingerprint') continue;
      const nested = value[key];
      if (nested === undefined) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_UNDEFINED');
      out[key] = projectNumbers(nested);
    }
    return out;
  }
  throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_TYPE_UNSUPPORTED');
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_CRYPTO_UNAVAILABLE');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertReceiptBoundary(receipt) {
  const authority = receipt?.authority;
  const flags = [authority?.authoritative, authority?.canonicalAmazonIdentityResolved, authority?.governancePersistenceAllowed, authority?.executionAuthorized, authority?.amazonMutationAuthorized];
  if (flags.some((value) => value === true)) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_AUTHORITY_ESCALATION_BLOCKED');
  const comparison = receipt?.comparison;
  if (!comparison || comparison.profitabilityBasis !== 'sales_minus_ad_spend_only_not_net_profit') throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_PROFITABILITY_BASIS_INVALID');
  if (comparison.crossSnapshotAggregationApplied !== false || comparison.normalizationApplied !== false) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_NORMALIZATION_BLOCKED');
  if (comparison.authority?.authoritative === true || comparison.authority?.canonicalAmazonIdentityResolved === true || comparison.authority?.governancePersistenceAllowed === true || comparison.authority?.executionAuthorized === true || comparison.authority?.amazonMutationAuthorized === true) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_AUTHORITY_ESCALATION_BLOCKED');
  if (comparison.comparisonAllowed !== true) {
    if (comparison.rawEvidenceOnly !== true || comparison.interpretationAllowed !== false) throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_BLOCKED_STATE_INVALID');
    for (const metric of Object.values(comparison.metrics || {})) {
      if (metric.delta !== null || metric.interpretationAllowed !== false || metric.direction !== 'withheld_not_comparable') throw receiptError('CSV_HISTORY_COMPARISON_RECEIPT_BLOCKED_DELTA_INVALID');
    }
  }
}

function sameEvidenceKey(left, right) {
  return Boolean(left && right)
    && left.ledgerFingerprint === right.ledgerFingerprint
    && left.sourceInputSetFingerprint === right.sourceInputSetFingerprint
    && left.month === right.month;
}

function selectionFor(row) {
  return {
    ledgerFingerprint: row.ledgerFingerprint,
    sourceInputSetFingerprint: row.sourceInputSetFingerprint,
    month: row.month,
  };
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

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function receiptError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryComparisonReceiptError';
  error.code = code;
  return error;
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhcr-status]');
  node.textContent = text;
  node.dataset.kind = kind;
}

function card(label, value) {
  return `<div class="cfhcr-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function formatValue(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'missing';
  return Number.isInteger(value) ? String(value) : Number(value).toPrecision(8).replace(/0+$/, '').replace(/\.$/, '');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhcr-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhcr-style-v1';
  style.textContent = '.cfhcr{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhcr-head{display:flex;justify-content:space-between;gap:12px}.cfhcr-head small{display:block;color:#64748b;max-width:780px}.cfhcr-head>span{font-size:11px;font-weight:800}.cfhcr-guard,.cfhcr-status,.cfhcr-reasons{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhcr-status[data-kind="bad"]{color:#b91c1c}.cfhcr-status[data-kind="ok"]{color:#047857}.cfhcr-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhcr-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhcr-controls input,.cfhcr-controls select,.cfhcr-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhcr-controls button{font-weight:700;cursor:pointer}.cfhcr-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhcr-result{margin-top:10px}.cfhcr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhcr-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhcr-card small{display:block;color:#64748b}.cfhcr code{font-size:11px;word-break:break-all}.cfhcr-table{overflow:auto;margin-top:9px}.cfhcr table{width:100%;border-collapse:collapse;font-size:12px}.cfhcr th,.cfhcr td{text-align:left;padding:7px;border-bottom:1px solid #e2e8f0}.cfhcr details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhcr summary{cursor:pointer;font-weight:700}.cfhcr pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
