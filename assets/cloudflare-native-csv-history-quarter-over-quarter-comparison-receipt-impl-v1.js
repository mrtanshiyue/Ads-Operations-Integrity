import { parseCsvHistoryLedger } from './csv-analysis-engine/csv-history-ledger.js';
import {
  CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION,
  fingerprintDeterministicReceiptPayload,
  serializeDeterministicReceiptJson,
} from './csv-analysis-engine/csv-history-deterministic-receipt.js';
import { buildHistoricalQuarterlyOperatingReview } from './cloudflare-native-csv-history-quarterly-operating-review-v1.js';
import { buildHistoricalQuarterOverQuarterComparison } from './cloudflare-native-csv-history-quarter-over-quarter-comparison-v1.js';

export const CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_SCHEMA_VERSION = 'csv-history-quarter-over-quarter-comparison-receipt-v1';
export const CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_UI_VERSION = '1.0.0';

const state = {
  mounted: false,
  busy: false,
  ledger: null,
  quarters: [],
  receipt: null,
};

export async function buildHistoricalQuarterOverQuarterComparisonReceipt(ledger, quarterAKey, quarterBKey) {
  const comparison = await buildHistoricalQuarterOverQuarterComparison(ledger, quarterAKey, quarterBKey);
  const payload = {
    schemaVersion: CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_SCHEMA_VERSION,
    receiptPurpose: 'local_historical_quarter_over_quarter_comparison_audit_only',
    source: {
      ledgerFingerprint: comparison.ledgerFingerprint,
      periodAQuarter: comparison.periodA.quarter,
      periodBQuarter: comparison.periodB.quarter,
      periodASourceInputSetFingerprints: [...comparison.periodA.sourceInputSetFingerprints],
      periodBSourceInputSetFingerprints: [...comparison.periodB.sourceInputSetFingerprints],
    },
    comparison,
    deterministic: {
      generatedTimestampIncluded: false,
      canonicalProjectionVersion: CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION,
      comparisonRecomputedFromLedger: true,
    },
    authority: noAuthority(),
  };
  assertReceiptBoundary(payload);
  const receiptFingerprint = await fingerprintDeterministicReceiptPayload(payload);
  return deepFreeze({ ...payload, receiptFingerprint });
}

export async function validateHistoricalQuarterOverQuarterComparisonReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_INVALID');
  if (receipt.schemaVersion !== CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_SCHEMA_VERSION) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_SCHEMA_UNSUPPORTED');
  assertReceiptBoundary(receipt);
  const fingerprint = String(receipt.receiptFingerprint || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_FINGERPRINT_INVALID');
  const { receiptFingerprint: _ignored, ...payload } = receipt;
  const expected = await fingerprintDeterministicReceiptPayload(payload);
  if (expected !== fingerprint) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_FINGERPRINT_MISMATCH');
  assertSourceBinding(receipt);
  return deepFreeze(structuredClone(receipt));
}

export async function parseHistoricalQuarterOverQuarterComparisonReceipt(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw receiptError('CSV_HISTORY_QOQ_RECEIPT_JSON_INVALID');
  }
  return validateHistoricalQuarterOverQuarterComparisonReceipt(parsed);
}

export function serializeHistoricalQuarterOverQuarterComparisonReceipt(receipt) {
  assertReceiptBoundary(receipt);
  if (!/^[a-f0-9]{64}$/i.test(String(receipt?.receiptFingerprint || ''))) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_FINGERPRINT_INVALID');
  return serializeDeterministicReceiptJson(receipt);
}

function assertReceiptBoundary(receipt) {
  assertAuthorityFalse(receipt?.authority);
  const comparison = receipt?.comparison;
  if (!comparison || comparison.schemaVersion !== 'csv-history-quarter-over-quarter-comparison-v1') throw receiptError('CSV_HISTORY_QOQ_RECEIPT_COMPARISON_INVALID');
  assertAuthorityFalse(comparison.authority);
  assertAuthorityFalse(comparison.periodA?.authority);
  assertAuthorityFalse(comparison.periodB?.authority);
  if (comparison.profitabilityBasis !== 'sales_minus_ad_spend_only_not_net_profit') throw receiptError('CSV_HISTORY_QOQ_RECEIPT_PROFITABILITY_BASIS_INVALID');
  if (comparison.deltaBasis !== 'quarter_b_minus_quarter_a') throw receiptError('CSV_HISTORY_QOQ_RECEIPT_DELTA_BASIS_INVALID');
  if (comparison.selectionPolicy !== 'operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder') throw receiptError('CSV_HISTORY_QOQ_RECEIPT_SELECTION_POLICY_INVALID');
  for (const [key, expected] of Object.entries({
    crossQuarterAggregationApplied: false,
    crossQuarterNormalizationApplied: false,
    quarterSelectionAutoReordered: false,
    sameMonthAggregationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
  })) {
    if (comparison[key] !== expected) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_INTEGRITY_BOUNDARY_INVALID');
  }
  if (comparison.comparisonAllowed !== true) {
    if (comparison.rawEvidenceOnly !== true || comparison.interpretationAllowed !== false) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_BLOCKED_STATE_INVALID');
    for (const metric of Object.values(comparison.metrics || {})) {
      if (metric.delta !== null || metric.interpretationAllowed !== false || metric.direction !== 'withheld_not_comparable') throw receiptError('CSV_HISTORY_QOQ_RECEIPT_BLOCKED_DELTA_INVALID');
    }
  }
}

function assertSourceBinding(receipt) {
  const source = receipt?.source;
  const comparison = receipt?.comparison;
  if (!source || source.ledgerFingerprint !== comparison?.ledgerFingerprint) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_LEDGER_BINDING_MISMATCH');
  if (source.periodAQuarter !== comparison?.periodA?.quarter) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_PERIOD_A_BINDING_MISMATCH');
  if (source.periodBQuarter !== comparison?.periodB?.quarter) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_PERIOD_B_BINDING_MISMATCH');
  if (!sameStringArray(source.periodASourceInputSetFingerprints, comparison?.periodA?.sourceInputSetFingerprints)) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_PERIOD_A_SOURCE_BINDING_MISMATCH');
  if (!sameStringArray(source.periodBSourceInputSetFingerprints, comparison?.periodB?.sourceInputSetFingerprints)) throw receiptError('CSV_HISTORY_QOQ_RECEIPT_PERIOD_B_SOURCE_BINDING_MISMATCH');
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertAuthorityFalse(authority) {
  if (!authority || authority.authoritative !== false || authority.canonicalAmazonIdentityResolved !== false || authority.governancePersistenceAllowed !== false || authority.executionAuthorized !== false || authority.amazonMutationAuthorized !== false) {
    throw receiptError('CSV_HISTORY_QOQ_RECEIPT_AUTHORITY_ESCALATION_BLOCKED');
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function receiptError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryQuarterOverQuarterComparisonReceiptError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryQuarterOverQuarterComparisonReceipt', {
    value: Object.freeze({
      version: CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_UI_VERSION,
      schemaVersion: CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_SCHEMA_VERSION,
      authority: 'local_historical_quarter_over_quarter_comparison_audit_only',
      buildHistoricalQuarterOverQuarterComparisonReceipt,
      validateHistoricalQuarterOverQuarterComparisonReceipt,
      parseHistoricalQuarterOverQuarterComparisonReceipt,
      serializeHistoricalQuarterOverQuarterComparisonReceipt,
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
  const qoqHost = document.querySelector('[data-csv-history-quarter-over-quarter-comparison]');
  if (!qoqHost) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-quarter-over-quarter-comparison]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-quarter-over-quarter-comparison-receipt]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhqoqr';
  root.dataset.csvHistoryQuarterOverQuarterComparisonReceipt = CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_RECEIPT_UI_VERSION;
  root.innerHTML = `
    <div class="cfhqoqr-head">
      <div><b>QoQ Comparison Receipt</b><small>Replay two operator-selected quarters from an explicit local history ledger and produce a deterministic audit receipt bound to the ledger, quarter keys, source fingerprints, and the full fail-closed QoQ comparison.</small></div>
      <span>local replay · deterministic</span>
    </div>
    <div class="cfhqoqr-guard">Receipt generation creates no analytical or execution authority. Blocked QoQ selections remain exportable as raw-evidence-only receipts with every delta withheld. Ad Contribution = Sales - Ad Spend only; it is not Net Profit.</div>
    <div class="cfhqoqr-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhqoqr-ledger></label>
      <label>Period A <select data-cfhqoqr-a disabled><option value="">Import ledger first</option></select></label>
      <label>Period B <select data-cfhqoqr-b disabled><option value="">Import ledger first</option></select></label>
      <button type="button" data-cfhqoqr-build disabled>Build receipt</button>
      <button type="button" data-cfhqoqr-download disabled>Download receipt</button>
    </div>
    <div class="cfhqoqr-status" data-cfhqoqr-status>Explicit local file ownership: no ledger or receipt is silently persisted.</div>
    <div class="cfhqoqr-result" data-cfhqoqr-result hidden></div>`;
  qoqHost.insertAdjacentElement('afterend', root);

  root.querySelector('[data-cfhqoqr-ledger]').addEventListener('change', (event) => void importLedger(root, event.currentTarget));
  root.querySelector('[data-cfhqoqr-a]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhqoqr-b]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhqoqr-build]').addEventListener('click', () => void buildReceiptFromUi(root));
  root.querySelector('[data-cfhqoqr-download]').addEventListener('click', () => downloadReceipt(root));
  state.mounted = true;
}

async function importLedger(root, input) {
  const file = input.files?.[0];
  if (!file || state.busy) return;
  state.busy = true;
  state.ledger = null;
  state.quarters = [];
  state.receipt = null;
  root.querySelector('[data-cfhqoqr-result]').hidden = true;
  setStatus(root, 'Validating local history ledger and rebuilding quarterly review…', 'loading');
  syncControls(root);
  try {
    const ledger = await parseCsvHistoryLedger(await file.text());
    const review = await buildHistoricalQuarterlyOperatingReview(ledger);
    state.ledger = ledger;
    state.quarters = review.quarters.map((item) => item.quarter);
    populateSelectors(root, state.quarters);
    setStatus(root, `Validated ${review.quarterCount} quarter(s). Ledger ${ledger.ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    populateSelectors(root, []);
    setStatus(root, `Ledger import blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function buildReceiptFromUi(root) {
  if (!state.ledger || state.busy) return;
  const quarterA = root.querySelector('[data-cfhqoqr-a]').value;
  const quarterB = root.querySelector('[data-cfhqoqr-b]').value;
  if (!state.quarters.includes(quarterA) || !state.quarters.includes(quarterB)) return setStatus(root, 'Select valid Period A and Period B quarter evidence.', 'bad');
  state.busy = true;
  state.receipt = null;
  syncControls(root);
  setStatus(root, 'Recomputing QoQ comparison and fingerprinting deterministic receipt…', 'loading');
  try {
    state.receipt = await buildHistoricalQuarterOverQuarterComparisonReceipt(state.ledger, quarterA, quarterB);
    renderReceipt(root, state.receipt);
    setStatus(root, `Receipt ${state.receipt.receiptFingerprint.slice(0, 12)} built locally. ${state.receipt.comparison.comparisonAllowed ? 'QoQ comparability gate passed.' : 'QoQ blocked; raw quarter evidence preserved with deltas withheld.'}`, 'ok');
  } catch (error) {
    root.querySelector('[data-cfhqoqr-result]').hidden = true;
    setStatus(root, `Receipt generation blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function downloadReceipt(root) {
  if (!state.receipt || state.busy) return;
  const blob = new Blob([serializeHistoricalQuarterOverQuarterComparisonReceipt(state.receipt)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `csv-history-quarter-over-quarter-comparison-receipt-v1-${state.receipt.receiptFingerprint.slice(0, 12)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(root, `Downloaded deterministic QoQ receipt ${state.receipt.receiptFingerprint.slice(0, 12)}. No remote persistence occurred.`, 'ok');
}

function populateSelectors(root, quarters) {
  const options = quarters.length ? quarters.map((quarter) => `<option value="${esc(quarter)}">${esc(quarter)}</option>`).join('') : '<option value="">No quarter evidence</option>';
  const a = root.querySelector('[data-cfhqoqr-a]');
  const b = root.querySelector('[data-cfhqoqr-b]');
  a.innerHTML = options;
  b.innerHTML = options;
  if (quarters.length > 1) b.value = quarters[1];
}

function syncControls(root) {
  const ready = Boolean(state.ledger && state.quarters.length);
  const a = root.querySelector('[data-cfhqoqr-a]');
  const b = root.querySelector('[data-cfhqoqr-b]');
  a.disabled = state.busy || !ready;
  b.disabled = state.busy || !ready;
  root.querySelector('[data-cfhqoqr-build]').disabled = state.busy || !ready || !state.quarters.includes(a.value) || !state.quarters.includes(b.value);
  root.querySelector('[data-cfhqoqr-download]').disabled = state.busy || !state.receipt;
  root.querySelector('[data-cfhqoqr-ledger]').disabled = state.busy;
}

function renderReceipt(root, receipt) {
  const comparison = receipt.comparison;
  const reasons = comparison.comparabilityGate.reasons.length ? comparison.comparabilityGate.reasons.join(', ') : 'all comparability checks passed';
  const rows = Object.entries(comparison.metrics).map(([key, metric]) => `<tr><td>${esc(metric.label || key)}</td><td>${formatValue(metric.periodAValue)}</td><td>${formatValue(metric.periodBValue)}</td><td>${metric.delta == null ? 'withheld' : formatValue(metric.delta)}</td><td>${esc(metric.direction)}</td></tr>`).join('');
  const result = root.querySelector('[data-cfhqoqr-result]');
  result.innerHTML = `
    <div class="cfhqoqr-grid">
      ${card('Receipt fingerprint', `<code>${esc(receipt.receiptFingerprint)}</code>`)}
      ${card('Period A', `<b>${esc(comparison.periodA.quarter)}</b>`)}
      ${card('Period B', `<b>${esc(comparison.periodB.quarter)}</b>`)}
      ${card('Comparability', comparison.comparisonAllowed ? '<b>allowed</b><br>deltas available' : '<b>blocked</b><br>raw evidence only')}
    </div>
    <div class="cfhqoqr-reasons"><b>Gate:</b> ${esc(reasons)}</div>
    <div class="cfhqoqr-table"><table><thead><tr><th>Metric</th><th>Period A</th><th>Period B</th><th>Δ B-A</th><th>Direction</th></tr></thead><tbody>${rows}</tbody></table></div>
    <details><summary>Receipt authority boundary</summary><pre>${esc(JSON.stringify(receipt.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhqoqr-status]');
  node.textContent = text;
  node.dataset.kind = kind;
}

function card(label, value) {
  return `<div class="cfhqoqr-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function formatValue(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'missing';
  return Number.isInteger(value) ? String(value) : Number(value).toPrecision(8).replace(/0+$/, '').replace(/\.$/, '');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhqoqr-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhqoqr-style-v1';
  style.textContent = '.cfhqoqr{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhqoqr-head{display:flex;justify-content:space-between;gap:12px}.cfhqoqr-head small{display:block;color:#64748b;max-width:800px}.cfhqoqr-head>span{font-size:11px;font-weight:800}.cfhqoqr-guard,.cfhqoqr-status,.cfhqoqr-reasons{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhqoqr-status[data-kind="bad"]{color:#b91c1c}.cfhqoqr-status[data-kind="ok"]{color:#047857}.cfhqoqr-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhqoqr-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhqoqr-controls input,.cfhqoqr-controls select,.cfhqoqr-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhqoqr-controls button{font-weight:700;cursor:pointer}.cfhqoqr-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhqoqr-result{margin-top:10px}.cfhqoqr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhqoqr-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhqoqr-card small{display:block;color:#64748b}.cfhqoqr code{font-size:11px;word-break:break-all}.cfhqoqr-table{overflow:auto;margin-top:9px}.cfhqoqr table{width:100%;border-collapse:collapse;font-size:12px}.cfhqoqr th,.cfhqoqr td{text-align:left;padding:7px;border-bottom:1px solid #e2e8f0}.cfhqoqr details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhqoqr summary{cursor:pointer;font-weight:700}.cfhqoqr pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
