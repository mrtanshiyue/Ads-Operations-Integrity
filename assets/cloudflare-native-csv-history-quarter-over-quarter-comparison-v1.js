import { buildHistoricalQuarterlyOperatingReview } from './cloudflare-native-csv-history-quarterly-operating-review-v1.js';

export const CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_SCHEMA_VERSION = 'csv-history-quarter-over-quarter-comparison-v1';
export const CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_UI_VERSION = '1.0.0';

const METRICS = Object.freeze([
  Object.freeze({ key: 'spendMicros', label: 'Spend', unit: 'micros' }),
  Object.freeze({ key: 'salesMicros', label: 'Sales', unit: 'micros' }),
  Object.freeze({ key: 'orders', label: 'Orders', unit: 'count' }),
  Object.freeze({ key: 'acos', label: 'ACoS', unit: 'ratio' }),
  Object.freeze({ key: 'roas', label: 'ROAS', unit: 'ratio' }),
  Object.freeze({ key: 'adContributionMicros', label: 'Ad Contribution', unit: 'micros' }),
]);

const state = {
  mounted: false,
  busy: false,
  ledger: null,
  review: null,
};

export async function buildHistoricalQuarterOverQuarterComparison(ledger, quarterAKey, quarterBKey) {
  const review = await buildHistoricalQuarterlyOperatingReview(ledger);
  const quarterA = selectQuarter(review, quarterAKey, 'A');
  const quarterB = selectQuarter(review, quarterBKey, 'B');
  const sourceInputSetA = new Set(quarterA.sourceInputSetFingerprints || []);
  const sourceInputSetB = new Set(quarterB.sourceInputSetFingerprints || []);
  const contentHashesA = new Set(quarterA.rawMonthlyEvidence.flatMap((item) => item.contentSha256s || []));
  const contentHashesB = new Set(quarterB.rawMonthlyEvidence.flatMap((item) => item.contentSha256s || []));

  const checks = {
    distinctQuarters: quarterA.quarter !== quarterB.quarter,
    forwardAdjacentCalendarQuarters: nextQuarterKey(quarterA.quarter) === quarterB.quarter,
    quarterAAggregationAllowed: quarterA.quarterAggregationAllowed === true,
    quarterBAggregationAllowed: quarterB.quarterAggregationAllowed === true,
    marketplaceCompatible: Boolean(quarterA.marketplace) && quarterA.marketplace === quarterB.marketplace,
    currencyCompatible: Boolean(quarterA.currencyCode) && quarterA.currencyCode === quarterB.currencyCode,
    sourceInputSetsDisjoint: [...sourceInputSetA].every((value) => !sourceInputSetB.has(value)),
    sourceContentHashesDisjoint: [...contentHashesA].every((value) => !contentHashesB.has(value)),
    metricValuesComplete: METRICS.every((metric) => finiteMetric(quarterA.metrics[metric.key]) && finiteMetric(quarterB.metrics[metric.key])),
    profitabilityBasisCompatible: quarterA.profitabilityBasis === 'sales_minus_ad_spend_only_not_net_profit'
      && quarterB.profitabilityBasis === 'sales_minus_ad_spend_only_not_net_profit',
  };
  const reasons = Object.entries(checks).filter(([, allowed]) => !allowed).map(([key]) => comparisonReason(key));
  const comparisonAllowed = reasons.length === 0;
  const metrics = {};
  for (const metric of METRICS) {
    const periodAValue = finiteMetric(quarterA.metrics[metric.key]) ? quarterA.metrics[metric.key] : null;
    const periodBValue = finiteMetric(quarterB.metrics[metric.key]) ? quarterB.metrics[metric.key] : null;
    const delta = comparisonAllowed ? periodBValue - periodAValue : null;
    metrics[metric.key] = {
      label: metric.label,
      unit: metric.unit,
      periodAValue,
      periodBValue,
      delta,
      direction: comparisonAllowed ? deltaDirection(delta) : 'withheld_not_comparable',
      interpretationAllowed: comparisonAllowed,
    };
  }

  return deepFreeze({
    schemaVersion: CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_SCHEMA_VERSION,
    ledgerFingerprint: review.ledgerFingerprint,
    comparisonAllowed,
    interpretationAllowed: comparisonAllowed,
    rawEvidenceOnly: !comparisonAllowed,
    deltaBasis: 'quarter_b_minus_quarter_a',
    selectionPolicy: 'operator_selected_forward_adjacent_calendar_quarters_no_auto_reorder',
    periodA: projectQuarter(quarterA),
    periodB: projectQuarter(quarterB),
    comparabilityGate: {
      checks,
      reasons,
      forwardAdjacentCalendarQuartersRequired: true,
      blockedQuarterCannotBeUpgraded: true,
    },
    metrics,
    crossQuarterAggregationApplied: false,
    crossQuarterNormalizationApplied: false,
    quarterSelectionAutoReordered: false,
    sameMonthAggregationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  });
}

function selectQuarter(review, quarterKey, role) {
  if (!/^\d{4}-Q[1-4]$/.test(String(quarterKey || ''))) throw comparisonError(`CSV_HISTORY_QOQ_PERIOD_${role}_KEY_INVALID`);
  const matches = review.quarters.filter((item) => item.quarter === quarterKey);
  if (matches.length !== 1) throw comparisonError(`CSV_HISTORY_QOQ_PERIOD_${role}_SELECTION_NOT_EXACT`);
  return matches[0];
}

function projectQuarter(quarter) {
  return {
    quarter: quarter.quarter,
    quarterStartDate: quarter.quarterStartDate,
    quarterEndDate: quarter.quarterEndDate,
    expectedMonths: quarter.expectedMonths,
    observedMonths: quarter.observedMonths,
    missingMonths: quarter.missingMonths,
    duplicateEvidenceMonths: quarter.duplicateEvidenceMonths,
    sourceEvidenceCount: quarter.sourceEvidenceCount,
    quarterAggregationAllowed: quarter.quarterAggregationAllowed,
    rawEvidenceOnly: quarter.rawEvidenceOnly,
    blockers: quarter.blockers,
    marketplace: quarter.marketplace,
    currencyCode: quarter.currencyCode,
    metrics: quarter.metrics,
    sourceInputSetFingerprints: quarter.sourceInputSetFingerprints,
    rawMonthlyEvidence: quarter.rawMonthlyEvidence,
    rawEvidenceRetained: true,
    profitabilityBasis: quarter.profitabilityBasis,
    authority: noAuthority(),
  };
}

function nextQuarterKey(quarterKey) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(quarterKey || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const quarter = Number(match[2]);
  return quarter === 4 ? `${year + 1}-Q1` : `${year}-Q${quarter + 1}`;
}

function finiteMetric(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function deltaDirection(delta) {
  if (delta === 0) return 'flat';
  return delta > 0 ? 'increase' : 'decrease';
}

function comparisonReason(key) {
  return ({
    distinctQuarters: 'same_quarter_selected_twice',
    forwardAdjacentCalendarQuarters: 'quarters_not_forward_adjacent',
    quarterAAggregationAllowed: 'period_a_quarter_gate_blocked',
    quarterBAggregationAllowed: 'period_b_quarter_gate_blocked',
    marketplaceCompatible: 'marketplace_mismatch_or_unknown',
    currencyCompatible: 'currency_mismatch_or_unknown',
    sourceInputSetsDisjoint: 'source_input_set_reused_across_quarters',
    sourceContentHashesDisjoint: 'source_content_hash_reused_across_quarters',
    metricValuesComplete: 'quarter_metric_values_incomplete',
    profitabilityBasisCompatible: 'profitability_basis_incompatible',
  })[key] || `qoq_gate_failed:${key}`;
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

function comparisonError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryQuarterOverQuarterComparisonError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryQuarterOverQuarterComparison', {
    value: Object.freeze({
      version: CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_UI_VERSION,
      schemaVersion: CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_SCHEMA_VERSION,
      authority: 'local_historical_quarter_over_quarter_comparison_only',
      buildHistoricalQuarterOverQuarterComparison,
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
  const quarterlyHost = document.querySelector('[data-csv-history-quarterly-operating-review]');
  if (!quarterlyHost) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-quarterly-operating-review]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-quarter-over-quarter-comparison]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhqoq';
  root.dataset.csvHistoryQuarterOverQuarterComparison = CSV_HISTORY_QUARTER_OVER_QUARTER_COMPARISON_UI_VERSION;
  root.innerHTML = `
    <div class="cfhqoq-head">
      <div><b>Quarter-over-Quarter Comparison</b><small>Compare two operator-selected calendar quarters from an explicit local history ledger. Period B must be the immediately following quarter. Delta direction is B − A.</small></div>
      <span>forward adjacent · fail closed</span>
    </div>
    <div class="cfhqoq-guard">Both quarter gates must already be allowed. Blocked quarters, reversed/non-adjacent selections, marketplace/currency mismatch, or evidence reuse withhold every delta and preserve raw quarter evidence. No selection is silently reordered.</div>
    <div class="cfhqoq-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhqoq-ledger></label>
      <label>Period A <select data-cfhqoq-a disabled></select></label>
      <label>Period B <select data-cfhqoq-b disabled></select></label>
      <button type="button" data-cfhqoq-compare disabled>Compare quarters</button>
    </div>
    <div class="cfhqoq-status" data-cfhqoq-status>Explicit local-file ownership only. Ad Contribution means Sales - Ad Spend only, not Net Profit.</div>
    <div class="cfhqoq-result" data-cfhqoq-result hidden></div>`;
  quarterlyHost.insertAdjacentElement('afterend', root);

  root.querySelector('[data-cfhqoq-ledger]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget));
  root.querySelector('[data-cfhqoq-a]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhqoq-b]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhqoq-compare]').addEventListener('click', () => void compareFromUi(root));
  state.mounted = true;
}

async function loadLedger(root, input) {
  const file = input.files?.[0];
  state.ledger = null;
  state.review = null;
  clearResult(root);
  resetSelects(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating ledger and rebuilding quarter gates…', 'loading');
  try {
    const parsed = JSON.parse(await file.text());
    state.ledger = parsed;
    state.review = await buildHistoricalQuarterlyOperatingReview(parsed);
    fillSelects(root, state.review.quarters);
    setStatus(root, `Quarter evidence rebuilt from ledger ${state.review.ledgerFingerprint.slice(0, 12)} · ${state.review.quarterCount} quarter(s).`, 'ok');
  } catch (error) {
    state.ledger = null;
    state.review = null;
    setStatus(root, `Ledger blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function compareFromUi(root) {
  const quarterA = root.querySelector('[data-cfhqoq-a]').value;
  const quarterB = root.querySelector('[data-cfhqoq-b]').value;
  if (!state.ledger || !quarterA || !quarterB || state.busy) return;
  state.busy = true;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Replaying quarterly evidence and comparability gate…', 'loading');
  try {
    const comparison = await buildHistoricalQuarterOverQuarterComparison(state.ledger, quarterA, quarterB);
    renderComparison(root, comparison);
    setStatus(root, comparison.comparisonAllowed
      ? `${quarterA} → ${quarterB} comparison allowed. Deltas are B - A.`
      : `${quarterA} → ${quarterB} comparison blocked. Raw quarter evidence retained; deltas withheld.`, comparison.comparisonAllowed ? 'ok' : 'bad');
  } catch (error) {
    setStatus(root, `QoQ comparison blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function fillSelects(root, quarters) {
  const options = ['<option value="">Select quarter</option>', ...quarters.map((item) => `<option value="${esc(item.quarter)}">${esc(item.quarter)} · ${item.quarterAggregationAllowed ? 'allowed' : 'blocked/raw-only'}</option>`)].join('');
  root.querySelector('[data-cfhqoq-a]').innerHTML = options;
  root.querySelector('[data-cfhqoq-b]').innerHTML = options;
  root.querySelector('[data-cfhqoq-a]').disabled = false;
  root.querySelector('[data-cfhqoq-b]').disabled = false;
}

function resetSelects(root) {
  for (const selector of ['[data-cfhqoq-a]', '[data-cfhqoq-b]']) {
    const node = root.querySelector(selector);
    node.innerHTML = '<option value="">Select quarter</option>';
    node.disabled = true;
  }
}

function renderComparison(root, comparison) {
  const result = root.querySelector('[data-cfhqoq-result]');
  const metricRows = METRICS.map((metric) => {
    const item = comparison.metrics[metric.key];
    return `<tr><td>${esc(item.label)}</td><td>${formatMetric(item.periodAValue, item.unit)}</td><td>${formatMetric(item.periodBValue, item.unit)}</td><td>${formatMetric(item.delta, item.unit)}</td><td>${esc(item.direction)}</td></tr>`;
  }).join('');
  result.innerHTML = `
    <div class="cfhqoq-grid">
      ${card('Comparison', comparison.comparisonAllowed ? '<b>allowed</b>' : '<b>blocked</b><br>raw evidence only')}
      ${card('Period A', `<b>${esc(comparison.periodA.quarter)}</b>`)}
      ${card('Period B', `<b>${esc(comparison.periodB.quarter)}</b>`)}
      ${card('Delta basis', '<b>B - A</b>')}
    </div>
    <div class="cfhqoq-table"><table><thead><tr><th>Metric</th><th>Period A</th><th>Period B</th><th>Δ</th><th>Direction</th></tr></thead><tbody>${metricRows}</tbody></table></div>
    <div class="cfhqoq-guard">${comparison.comparisonAllowed ? 'Both quarters passed all gates.' : `Blockers: ${esc(comparison.comparabilityGate.reasons.join(', '))}`}</div>
    <details><summary>Period A raw quarter evidence</summary><pre>${esc(JSON.stringify(comparison.periodA, null, 2))}</pre></details>
    <details><summary>Period B raw quarter evidence</summary><pre>${esc(JSON.stringify(comparison.periodB, null, 2))}</pre></details>
    <details><summary>QoQ authority boundary</summary><pre>${esc(JSON.stringify(comparison.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function syncControls(root) {
  root.querySelector('[data-cfhqoq-ledger]').disabled = state.busy;
  const a = root.querySelector('[data-cfhqoq-a]');
  const b = root.querySelector('[data-cfhqoq-b]');
  if (state.review) {
    a.disabled = state.busy;
    b.disabled = state.busy;
  }
  root.querySelector('[data-cfhqoq-compare]').disabled = state.busy || !state.ledger || !a.value || !b.value;
}

function clearResult(root) {
  const result = root.querySelector('[data-cfhqoq-result]');
  result.hidden = true;
  result.innerHTML = '';
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhqoq-status]');
  node.textContent = text;
  node.dataset.kind = kind;
}

function formatMetric(value, unit) {
  if (value == null) return 'withheld';
  if (unit === 'micros') return (value / 1_000_000).toFixed(2);
  if (unit === 'ratio') return Number(value).toFixed(4);
  return String(value);
}

function card(label, value) {
  return `<div class="cfhqoq-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhqoq-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhqoq-style-v1';
  style.textContent = '.cfhqoq{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhqoq-head{display:flex;justify-content:space-between;gap:12px}.cfhqoq-head small{display:block;color:#64748b;max-width:800px}.cfhqoq-head>span{font-size:11px;font-weight:800}.cfhqoq-guard,.cfhqoq-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhqoq-status[data-kind="bad"]{color:#b91c1c}.cfhqoq-status[data-kind="ok"]{color:#047857}.cfhqoq-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhqoq-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhqoq-controls input,.cfhqoq-controls select,.cfhqoq-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhqoq-controls button{font-weight:700;cursor:pointer}.cfhqoq-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhqoq-result{margin-top:10px}.cfhqoq-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}.cfhqoq-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px}.cfhqoq-card small{display:block;color:#64748b}.cfhqoq-table{overflow:auto;margin-top:10px}.cfhqoq-table table{border-collapse:collapse;width:100%;min-width:700px}.cfhqoq-table th,.cfhqoq-table td{padding:7px;border-bottom:1px solid #e2e8f0;text-align:left}.cfhqoq details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhqoq summary{cursor:pointer;font-weight:700}.cfhqoq pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
