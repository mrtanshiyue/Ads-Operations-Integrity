import { buildHistoricalYearToDateOperatingReview } from './cloudflare-native-csv-history-year-to-date-operating-review-v1.js';

export const CSV_HISTORY_YEAR_OVER_YEAR_YTD_COMPARISON_SCHEMA_VERSION = 'csv-history-year-over-year-ytd-comparison-v1';
export const CSV_HISTORY_YEAR_OVER_YEAR_YTD_COMPARISON_UI_VERSION = '1.0.0';

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

export async function buildHistoricalYearOverYearYtdComparison(ledger, periodAKey, periodBKey) {
  const review = await buildHistoricalYearToDateOperatingReview(ledger);
  const periodA = selectPeriod(review, periodAKey, 'A');
  const periodB = selectPeriod(review, periodBKey, 'B');
  const parsedA = parsePeriodKey(periodA.periodKey);
  const parsedB = parsePeriodKey(periodB.periodKey);
  const sourceInputSetA = new Set(periodA.sourceInputSetFingerprints || []);
  const sourceInputSetB = new Set(periodB.sourceInputSetFingerprints || []);
  const sourceContentA = new Set(periodA.sourceContentSha256s || []);
  const sourceContentB = new Set(periodB.sourceContentSha256s || []);

  const checks = {
    distinctPeriods: periodA.periodKey !== periodB.periodKey,
    forwardAdjacentYears: parsedB.year === parsedA.year + 1,
    sameThroughQuarter: parsedA.quarter === parsedB.quarter,
    periodAAggregationAllowed: periodA.ytdAggregationAllowed === true,
    periodBAggregationAllowed: periodB.ytdAggregationAllowed === true,
    marketplaceCompatible: Boolean(periodA.marketplace) && periodA.marketplace === periodB.marketplace,
    currencyCompatible: Boolean(periodA.currencyCode) && periodA.currencyCode === periodB.currencyCode,
    sourceInputSetsDisjoint: [...sourceInputSetA].every((value) => !sourceInputSetB.has(value)),
    sourceContentHashesDisjoint: [...sourceContentA].every((value) => !sourceContentB.has(value)),
    metricValuesComplete: METRICS.every((metric) => finiteMetric(periodA.metrics?.[metric.key]) && finiteMetric(periodB.metrics?.[metric.key])),
    profitabilityBasisCompatible: periodA.profitabilityBasis === 'sales_minus_ad_spend_only_not_net_profit'
      && periodB.profitabilityBasis === 'sales_minus_ad_spend_only_not_net_profit',
  };

  const reasons = Object.entries(checks).filter(([, allowed]) => !allowed).map(([key]) => comparisonReason(key));
  const comparisonAllowed = reasons.length === 0;
  const metrics = {};
  for (const metric of METRICS) {
    const periodAValue = finiteMetric(periodA.metrics?.[metric.key]) ? periodA.metrics[metric.key] : null;
    const periodBValue = finiteMetric(periodB.metrics?.[metric.key]) ? periodB.metrics[metric.key] : null;
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
    schemaVersion: CSV_HISTORY_YEAR_OVER_YEAR_YTD_COMPARISON_SCHEMA_VERSION,
    ledgerFingerprint: review.ledgerFingerprint,
    comparisonAllowed,
    interpretationAllowed: comparisonAllowed,
    rawEvidenceOnly: !comparisonAllowed,
    deltaBasis: 'ytd_period_b_minus_ytd_period_a',
    selectionPolicy: 'operator_selected_forward_adjacent_years_same_ytd_quarter_no_auto_reorder',
    periodA: projectPeriod(periodA),
    periodB: projectPeriod(periodB),
    comparabilityGate: {
      checks,
      reasons,
      forwardAdjacentYearsRequired: true,
      sameThroughQuarterRequired: true,
      blockedYtdPeriodCannotBeUpgraded: true,
    },
    metrics,
    crossYearAggregationApplied: false,
    crossYearNormalizationApplied: false,
    ytdPeriodReaggregationApplied: false,
    periodSelectionAutoReordered: false,
    sameMonthAggregationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  });
}

function selectPeriod(review, periodKey, role) {
  if (!/^\d{4}-YTD-Q[1-4]$/.test(String(periodKey || ''))) throw comparisonError(`CSV_HISTORY_YOY_YTD_PERIOD_${role}_KEY_INVALID`);
  const matches = review.periods.filter((item) => item.periodKey === periodKey);
  if (matches.length !== 1) throw comparisonError(`CSV_HISTORY_YOY_YTD_PERIOD_${role}_SELECTION_NOT_EXACT`);
  return matches[0];
}

function projectPeriod(period) {
  return {
    periodKey: period.periodKey,
    year: period.year,
    throughQuarter: period.throughQuarter,
    periodStartDate: period.periodStartDate,
    periodEndDate: period.periodEndDate,
    expectedQuarterKeys: period.expectedQuarterKeys,
    observedQuarterKeys: period.observedQuarterKeys,
    missingQuarterKeys: period.missingQuarterKeys,
    duplicateQuarterKeys: period.duplicateQuarterKeys,
    sourceQuarterCount: period.sourceQuarterCount,
    ytdAggregationAllowed: period.ytdAggregationAllowed,
    interpretationAllowed: period.interpretationAllowed,
    rawEvidenceOnly: period.rawEvidenceOnly,
    blockers: period.blockers,
    marketplace: period.marketplace,
    currencyCode: period.currencyCode,
    metrics: period.metrics,
    sourceInputSetFingerprints: period.sourceInputSetFingerprints,
    sourceContentSha256s: period.sourceContentSha256s,
    rawQuarterEvidence: period.rawQuarterEvidence,
    rawEvidenceRetained: true,
    profitabilityBasis: period.profitabilityBasis,
    authority: noAuthority(),
  };
}

function parsePeriodKey(periodKey) {
  const match = /^(\d{4})-YTD-Q([1-4])$/.exec(String(periodKey || ''));
  if (!match) throw comparisonError('CSV_HISTORY_YOY_YTD_PERIOD_KEY_INVALID');
  return { year: Number(match[1]), quarter: Number(match[2]) };
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
    distinctPeriods: 'same_ytd_period_selected_twice',
    forwardAdjacentYears: 'years_not_forward_adjacent',
    sameThroughQuarter: 'ytd_through_quarter_mismatch',
    periodAAggregationAllowed: 'period_a_ytd_gate_blocked',
    periodBAggregationAllowed: 'period_b_ytd_gate_blocked',
    marketplaceCompatible: 'marketplace_mismatch_or_unknown',
    currencyCompatible: 'currency_mismatch_or_unknown',
    sourceInputSetsDisjoint: 'source_input_set_reused_across_ytd_periods',
    sourceContentHashesDisjoint: 'source_content_hash_reused_across_ytd_periods',
    metricValuesComplete: 'ytd_metric_values_incomplete',
    profitabilityBasisCompatible: 'profitability_basis_incompatible',
  })[key] || `yoy_ytd_gate_failed:${key}`;
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
  error.name = 'CsvHistoryYearOverYearYtdComparisonError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryYearOverYearYtdComparison', {
    value: Object.freeze({
      version: CSV_HISTORY_YEAR_OVER_YEAR_YTD_COMPARISON_UI_VERSION,
      schemaVersion: CSV_HISTORY_YEAR_OVER_YEAR_YTD_COMPARISON_SCHEMA_VERSION,
      authority: 'local_historical_year_over_year_ytd_comparison_only',
      buildHistoricalYearOverYearYtdComparison,
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
  const ytdHost = document.querySelector('[data-csv-history-year-to-date-operating-review]');
  if (!ytdHost) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-year-to-date-operating-review]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-year-over-year-ytd-comparison]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhyoy';
  root.dataset.csvHistoryYearOverYearYtdComparison = CSV_HISTORY_YEAR_OVER_YEAR_YTD_COMPARISON_UI_VERSION;
  root.innerHTML = `
    <div class="cfhyoy-head">
      <div><b>Year-over-Year YTD Comparison</b><small>Compare two operator-selected quarter-aligned YTD periods from an explicit local history ledger. Period B must be the next natural year and use the same YTD through-quarter. Delta direction is B − A.</small></div>
      <span>adjacent year · same YTD quarter · fail closed</span>
    </div>
    <div class="cfhyoy-guard">Both YTD gates must already be allowed. Reversed/skipped years, mismatched through-quarters, marketplace/currency mismatch, or evidence reuse withhold every delta and preserve raw YTD/quarter/month evidence. No selection is silently reordered.</div>
    <div class="cfhyoy-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhyoy-ledger></label>
      <label>Period A <select data-cfhyoy-a disabled></select></label>
      <label>Period B <select data-cfhyoy-b disabled></select></label>
      <button type="button" data-cfhyoy-compare disabled>Compare YoY YTD</button>
    </div>
    <div class="cfhyoy-status" data-cfhyoy-status>Explicit local-file ownership only. Ad Contribution means Sales - Ad Spend only, not Net Profit.</div>
    <div class="cfhyoy-result" data-cfhyoy-result hidden></div>`;
  ytdHost.insertAdjacentElement('afterend', root);

  root.querySelector('[data-cfhyoy-ledger]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget));
  root.querySelector('[data-cfhyoy-a]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhyoy-b]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhyoy-compare]').addEventListener('click', () => void compareFromUi(root));
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
  setStatus(root, 'Validating ledger and rebuilding quarter-aligned YTD gates…', 'loading');
  try {
    const parsed = JSON.parse(await file.text());
    state.ledger = parsed;
    state.review = await buildHistoricalYearToDateOperatingReview(parsed);
    fillSelects(root, state.review.periods);
    setStatus(root, `YTD evidence rebuilt from ledger ${state.review.ledgerFingerprint.slice(0, 12)} · ${state.review.periodCount} period(s).`, 'ok');
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
  const periodA = root.querySelector('[data-cfhyoy-a]').value;
  const periodB = root.querySelector('[data-cfhyoy-b]').value;
  if (!state.ledger || !periodA || !periodB || state.busy) return;
  state.busy = true;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Replaying YTD evidence and YoY comparability gate…', 'loading');
  try {
    const comparison = await buildHistoricalYearOverYearYtdComparison(state.ledger, periodA, periodB);
    renderComparison(root, comparison);
    setStatus(root, comparison.comparisonAllowed
      ? `${periodA} → ${periodB} comparison allowed. Deltas are B - A.`
      : `${periodA} → ${periodB} comparison blocked. Raw evidence retained; deltas withheld.`, comparison.comparisonAllowed ? 'ok' : 'bad');
  } catch (error) {
    setStatus(root, `YoY YTD comparison blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function fillSelects(root, periods) {
  const options = ['<option value="">Select YTD period</option>', ...periods.map((item) => `<option value="${esc(item.periodKey)}">${esc(item.periodKey)} · ${item.ytdAggregationAllowed ? 'allowed' : 'blocked/raw-only'}</option>`)].join('');
  root.querySelector('[data-cfhyoy-a]').innerHTML = options;
  root.querySelector('[data-cfhyoy-b]').innerHTML = options;
  root.querySelector('[data-cfhyoy-a]').disabled = false;
  root.querySelector('[data-cfhyoy-b]').disabled = false;
}

function resetSelects(root) {
  for (const selector of ['[data-cfhyoy-a]', '[data-cfhyoy-b]']) {
    const node = root.querySelector(selector);
    node.innerHTML = '<option value="">Select YTD period</option>';
    node.disabled = true;
  }
}

function renderComparison(root, comparison) {
  const rows = METRICS.map((metric) => {
    const item = comparison.metrics[metric.key];
    return `<tr><td>${esc(item.label)}</td><td>${formatMetric(item.periodAValue, item.unit)}</td><td>${formatMetric(item.periodBValue, item.unit)}</td><td>${formatMetric(item.delta, item.unit)}</td><td>${esc(item.direction)}</td></tr>`;
  }).join('');
  const result = root.querySelector('[data-cfhyoy-result]');
  result.innerHTML = `
    <div class="cfhyoy-grid">
      ${card('Comparison', comparison.comparisonAllowed ? '<b>allowed</b>' : '<b>blocked</b><br>raw evidence only')}
      ${card('Period A', `<b>${esc(comparison.periodA.periodKey)}</b>`)}
      ${card('Period B', `<b>${esc(comparison.periodB.periodKey)}</b>`)}
      ${card('Delta basis', '<b>B - A</b>')}
    </div>
    <div class="cfhyoy-table"><table><thead><tr><th>Metric</th><th>Period A</th><th>Period B</th><th>Δ</th><th>Direction</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="cfhyoy-guard">${comparison.comparisonAllowed ? 'Both YTD periods passed all comparability gates.' : `Blockers: ${esc(comparison.comparabilityGate.reasons.join(', '))}`}</div>`;
  result.hidden = false;
}

function syncControls(root) {
  const a = root.querySelector('[data-cfhyoy-a]');
  const b = root.querySelector('[data-cfhyoy-b]');
  root.querySelector('[data-cfhyoy-ledger]').disabled = state.busy;
  a.disabled = state.busy || !state.review;
  b.disabled = state.busy || !state.review;
  root.querySelector('[data-cfhyoy-compare]').disabled = state.busy || !state.ledger || !a.value || !b.value;
}

function clearResult(root) {
  root.querySelector('[data-cfhyoy-result]').hidden = true;
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhyoy-status]');
  node.textContent = text;
  node.dataset.kind = kind;
}

function card(label, value) {
  return `<div class="cfhyoy-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function formatMetric(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return 'withheld';
  if (unit === 'count' || unit === 'micros') return String(value);
  return Number(value).toPrecision(8).replace(/0+$/, '').replace(/\.$/, '');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhyoy-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhyoy-style-v1';
  style.textContent = '.cfhyoy{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhyoy-head{display:flex;justify-content:space-between;gap:12px}.cfhyoy-head small{display:block;color:#64748b;max-width:820px}.cfhyoy-head>span{font-size:11px;font-weight:800}.cfhyoy-guard,.cfhyoy-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhyoy-status[data-kind="bad"]{color:#b91c1c}.cfhyoy-status[data-kind="ok"]{color:#047857}.cfhyoy-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhyoy-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhyoy-controls input,.cfhyoy-controls select,.cfhyoy-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhyoy-controls button{font-weight:700;cursor:pointer}.cfhyoy-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhyoy-result{margin-top:10px}.cfhyoy-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhyoy-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhyoy-card small{display:block;color:#64748b}.cfhyoy-table{overflow:auto;margin-top:9px}.cfhyoy table{width:100%;border-collapse:collapse;font-size:12px}.cfhyoy th,.cfhyoy td{text-align:left;padding:7px;border-bottom:1px solid #e2e8f0}';
  document.head.appendChild(style);
}
