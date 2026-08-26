import { buildHistoricalQuarterlyOperatingReview } from './cloudflare-native-csv-history-quarterly-operating-review-v1.js';

export const CSV_HISTORY_ROLLING_12_OPERATING_REVIEW_SCHEMA_VERSION = 'csv-history-rolling-12-operating-review-v1';
export const CSV_HISTORY_ROLLING_12_OPERATING_REVIEW_UI_VERSION = '1.0.0';

const METRIC_KEYS = Object.freeze([
  'spendMicros',
  'salesMicros',
  'orders',
  'acos',
  'roas',
  'adContributionMicros',
]);

const state = { mounted: false, busy: false };

export async function buildHistoricalRolling12OperatingReview(ledger) {
  const quarterlyReview = await buildHistoricalQuarterlyOperatingReview(ledger);
  const quarterMap = new Map();
  for (const quarter of quarterlyReview.quarters) {
    if (!quarterMap.has(quarter.quarter)) quarterMap.set(quarter.quarter, []);
    quarterMap.get(quarter.quarter).push(quarter);
  }

  const observedEndpoints = [...quarterMap.keys()].sort(compareQuarterKeys);
  const windows = observedEndpoints.map((throughQuarter) => buildRollingWindow(quarterMap, throughQuarter));

  return deepFreeze({
    schemaVersion: CSV_HISTORY_ROLLING_12_OPERATING_REVIEW_SCHEMA_VERSION,
    ledgerFingerprint: quarterlyReview.ledgerFingerprint,
    aggregationBasis: 'four_forward_adjacent_validated_natural_quarters',
    rollingWindowCadence: 'quarter_aligned',
    windowLengthMonths: 12,
    windowLengthQuarters: 4,
    windowSelectionPolicy: 'observed_natural_quarter_endpoints_no_auto_fill_or_reorder',
    sourceQuarterCount: quarterlyReview.quarterCount,
    quarterlyReviewSchemaVersion: quarterlyReview.schemaVersion,
    windowCount: windows.length,
    aggregationAllowedWindowCount: windows.filter((item) => item.rolling12AggregationAllowed).length,
    aggregationBlockedWindowCount: windows.filter((item) => !item.rolling12AggregationAllowed).length,
    rawEvidenceRetainedWhenBlocked: true,
    crossWindowAggregationApplied: false,
    normalizationApplied: false,
    sameMonthAggregationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
    missingQuartersHidden: false,
    partialQuartersHidden: false,
    recommendationGenerated: false,
    actionGenerated: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
    windows,
  });
}

function buildRollingWindow(quarterMap, throughQuarter) {
  const expectedQuarterKeys = Array.from({ length: 4 }, (_, index) => offsetQuarter(throughQuarter, index - 3));
  const missingQuarterKeys = expectedQuarterKeys.filter((key) => !quarterMap.has(key));
  const duplicateQuarterKeys = expectedQuarterKeys.filter((key) => (quarterMap.get(key)?.length || 0) > 1);
  const selectedQuarters = expectedQuarterKeys.flatMap((key) => quarterMap.get(key) || []);
  const marketplaces = uniqueValues(selectedQuarters.map((item) => item.marketplace));
  const currencies = uniqueValues(selectedQuarters.map((item) => item.currencyCode));
  const sourceInputSetFingerprints = selectedQuarters.flatMap((item) => item.sourceInputSetFingerprints || []).map(String).sort();
  const sourceContentSha256s = selectedQuarters
    .flatMap((item) => item.rawMonthlyEvidence || [])
    .flatMap((item) => item.contentSha256s || [])
    .map(String)
    .sort();

  const checks = {
    completeQuarterSet: missingQuarterKeys.length === 0 && duplicateQuarterKeys.length === 0 && selectedQuarters.length === 4,
    quarterlyAggregationsAllowed: selectedQuarters.length === 4 && selectedQuarters.every((item) => item.quarterAggregationAllowed === true),
    quarterlyInterpretationsAllowed: selectedQuarters.length === 4 && selectedQuarters.every((item) => item.interpretationAllowed === true && item.rawEvidenceOnly === false),
    marketplaceCompatible: selectedQuarters.length === 4 && selectedQuarters.every((item) => typeof item.marketplace === 'string' && item.marketplace.length > 0) && marketplaces.length === 1,
    currencyCompatible: selectedQuarters.length === 4 && selectedQuarters.every((item) => typeof item.currencyCode === 'string' && item.currencyCode.length > 0) && currencies.length === 1,
    sourceInputSetFingerprintsDistinct: selectedQuarters.length === 4 && sourceInputSetFingerprints.length > 0 && new Set(sourceInputSetFingerprints).size === sourceInputSetFingerprints.length,
    sourceContentSha256sDistinct: selectedQuarters.length === 4 && sourceContentSha256s.length > 0 && new Set(sourceContentSha256s).size === sourceContentSha256s.length,
    metricValuesComplete: selectedQuarters.length === 4 && selectedQuarters.every((item) => METRIC_KEYS.every((key) => finiteMetric(item.metrics?.[key]))),
    profitabilityBasisCompatible: selectedQuarters.length === 4 && selectedQuarters.every((item) => item.profitabilityBasis === 'sales_minus_ad_spend_only_not_net_profit'),
    expectedQuarterSequenceExact: selectedQuarters.length === 4 && selectedQuarters.every((item, index) => item.quarter === expectedQuarterKeys[index]),
    naturalQuarterWindowsExact: selectedQuarters.length === 4 && selectedQuarters.every((item) => {
      const [startDate, endDate] = quarterDateRange(item.quarter);
      return item.quarterStartDate === startDate && item.quarterEndDate === endDate;
    }),
  };

  const blockers = Object.entries(checks).filter(([, allowed]) => !allowed).map(([key]) => rolling12Blocker(key));
  const rolling12AggregationAllowed = blockers.length === 0;
  const metrics = rolling12AggregationAllowed ? aggregateRolling12Metrics(selectedQuarters) : withheldMetrics();
  const firstQuarter = expectedQuarterKeys[0];
  const [periodStartDate] = quarterDateRange(firstQuarter);
  const [, periodEndDate] = quarterDateRange(throughQuarter);

  return deepFreeze({
    schemaVersion: CSV_HISTORY_ROLLING_12_OPERATING_REVIEW_SCHEMA_VERSION,
    windowKey: `${throughQuarter}-R12`,
    throughQuarter,
    periodStartDate,
    periodEndDate,
    windowLengthMonths: 12,
    windowLengthQuarters: 4,
    expectedQuarterKeys,
    observedQuarterKeys: selectedQuarters.map((item) => item.quarter),
    missingQuarterKeys,
    duplicateQuarterKeys,
    sourceQuarterCount: selectedQuarters.length,
    rolling12AggregationAllowed,
    aggregationWithheld: !rolling12AggregationAllowed,
    interpretationAllowed: rolling12AggregationAllowed,
    rawEvidenceOnly: !rolling12AggregationAllowed,
    blockers,
    checks,
    marketplace: marketplaces.length === 1 ? marketplaces[0] : null,
    currencyCode: currencies.length === 1 ? currencies[0] : null,
    metrics,
    sourceInputSetFingerprints,
    sourceContentSha256s,
    rawQuarterEvidence: selectedQuarters.map(projectRawQuarterEvidence),
    rawEvidenceRetained: true,
    crossQuarterAggregationApplied: rolling12AggregationAllowed,
    crossWindowAggregationApplied: false,
    normalizationApplied: false,
    sameMonthAggregationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
    quarterSelectionAutoReordered: false,
    recommendationGenerated: false,
    actionGenerated: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  });
}

function aggregateRolling12Metrics(quarters) {
  const spendMicros = sumSafeIntegers(quarters.map((item) => item.metrics.spendMicros), 'CSV_HISTORY_R12_SPEND_OVERFLOW');
  const salesMicros = sumSafeIntegers(quarters.map((item) => item.metrics.salesMicros), 'CSV_HISTORY_R12_SALES_OVERFLOW');
  const orders = sumSafeIntegers(quarters.map((item) => item.metrics.orders), 'CSV_HISTORY_R12_ORDERS_OVERFLOW');
  const adContributionMicros = sumSafeIntegers(quarters.map((item) => item.metrics.adContributionMicros), 'CSV_HISTORY_R12_CONTRIBUTION_OVERFLOW');
  if (adContributionMicros !== salesMicros - spendMicros) throw rolling12Error('CSV_HISTORY_R12_CONTRIBUTION_MISMATCH');
  return {
    spendMicros,
    salesMicros,
    orders,
    acos: salesMicros === 0 ? null : spendMicros / salesMicros,
    roas: spendMicros === 0 ? null : salesMicros / spendMicros,
    adContributionMicros,
  };
}

function withheldMetrics() {
  return { spendMicros: null, salesMicros: null, orders: null, acos: null, roas: null, adContributionMicros: null };
}

function projectRawQuarterEvidence(item) {
  return {
    quarter: item.quarter,
    quarterStartDate: item.quarterStartDate,
    quarterEndDate: item.quarterEndDate,
    quarterAggregationAllowed: item.quarterAggregationAllowed,
    interpretationAllowed: item.interpretationAllowed,
    rawEvidenceOnly: item.rawEvidenceOnly,
    blockers: item.blockers,
    checks: item.checks,
    marketplace: item.marketplace,
    currencyCode: item.currencyCode,
    metrics: item.metrics,
    sourceInputSetFingerprints: item.sourceInputSetFingerprints,
    rawMonthlyEvidence: item.rawMonthlyEvidence,
    profitabilityBasis: item.profitabilityBasis,
    authority: noAuthority(),
  };
}

function offsetQuarter(quarterKey, delta) {
  const { year, quarter } = parseQuarterKey(quarterKey);
  const zeroBased = year * 4 + (quarter - 1) + delta;
  const nextYear = Math.floor(zeroBased / 4);
  const nextQuarter = ((zeroBased % 4) + 4) % 4 + 1;
  return `${nextYear}-Q${nextQuarter}`;
}

function parseQuarterKey(quarterKey) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(quarterKey || ''));
  if (!match) throw rolling12Error('CSV_HISTORY_R12_QUARTER_KEY_INVALID');
  return { year: Number(match[1]), quarter: Number(match[2]) };
}

function compareQuarterKeys(left, right) {
  const a = parseQuarterKey(left);
  const b = parseQuarterKey(right);
  return a.year === b.year ? a.quarter - b.quarter : a.year - b.year;
}

function quarterDateRange(quarterKey) {
  const { year, quarter } = parseQuarterKey(quarterKey);
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return [`${String(year).padStart(4, '0')}-${String(startMonth).padStart(2, '0')}-01`, lastDayOfMonth(year, endMonth)];
}

function lastDayOfMonth(year, monthNumber) {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) throw rolling12Error('CSV_HISTORY_R12_DATE_INVALID');
  const last = new Date(Date.UTC(year, monthNumber, 0));
  return `${String(last.getUTCFullYear()).padStart(4, '0')}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`;
}

function uniqueValues(values) { return [...new Set(values.filter((value) => value != null && value !== '').map(String))].sort(); }
function finiteMetric(value) { return typeof value === 'number' && Number.isFinite(value); }
function sumSafeIntegers(values, code) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw rolling12Error(code);
    total += value;
    if (!Number.isSafeInteger(total)) throw rolling12Error(code);
  }
  return total;
}

function rolling12Blocker(key) {
  return ({
    completeQuarterSet: 'missing_or_duplicate_quarter_evidence',
    quarterlyAggregationsAllowed: 'quarterly_aggregation_blocked',
    quarterlyInterpretationsAllowed: 'quarterly_interpretation_blocked',
    marketplaceCompatible: 'marketplace_mismatch_or_unknown',
    currencyCompatible: 'currency_mismatch_or_unknown',
    sourceInputSetFingerprintsDistinct: 'source_input_set_reused_across_quarters',
    sourceContentSha256sDistinct: 'source_content_reused_across_quarters',
    metricValuesComplete: 'quarterly_metric_values_incomplete',
    profitabilityBasisCompatible: 'profitability_basis_mismatch',
    expectedQuarterSequenceExact: 'quarter_sequence_invalid',
    naturalQuarterWindowsExact: 'non_natural_quarter_window',
  })[key] || `rolling12_check_failed:${key}`;
}

function noAuthority() {
  return { authoritative: false, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
function rolling12Error(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryRolling12OperatingReviewError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryRolling12OperatingReview', {
    value: Object.freeze({
      version: CSV_HISTORY_ROLLING_12_OPERATING_REVIEW_UI_VERSION,
      schemaVersion: CSV_HISTORY_ROLLING_12_OPERATING_REVIEW_SCHEMA_VERSION,
      authority: 'local_historical_quarter_aligned_rolling_12_review_only',
      buildHistoricalRolling12OperatingReview,
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
  const preferredHost = document.querySelector('[data-csv-history-year-over-year-ytd-review-board]');
  const fallbackHost = document.querySelector('[data-csv-history-quarterly-operating-review]');
  const host = preferredHost || fallbackHost;
  if (!host) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-quarterly-operating-review]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-rolling-12-operating-review]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhr12';
  root.dataset.csvHistoryRolling12OperatingReview = CSV_HISTORY_ROLLING_12_OPERATING_REVIEW_UI_VERSION;
  root.innerHTML = `
    <div class="cfhr12-head"><div><b>Rolling-12 Operating Review</b><small>Quarter-aligned trailing 12 months only: four consecutive canonical natural quarters ending at each observed quarter. The contract reuses quarterly integrity outcomes and never reconstructs or repairs monthly evidence.</small></div><span>4 quarters · quarter-aligned · fail closed</span></div>
    <div class="cfhr12-guard">Missing/blocked quarters, marketplace or currency mismatch, source reuse, incomplete metrics, or profitability-basis mismatch withhold all six window metrics while raw quarter/month evidence remains visible. ACoS and ROAS are recomputed from Rolling-12 totals. Ad Contribution = Sales - Ad Spend only; it is not Net Profit.</div>
    <div class="cfhr12-controls"><label>History ledger <input type="file" accept="application/json,.json" data-cfhr12-ledger></label></div>
    <div class="cfhr12-status" data-cfhr12-status>Explicit local-file ownership only. No ledger or review result is silently persisted.</div>
    <div class="cfhr12-result" data-cfhr12-result hidden></div>`;
  host.insertAdjacentElement('afterend', root);
  root.querySelector('[data-cfhr12-ledger]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget));
  state.mounted = true;
}

async function loadLedger(root, input) {
  const file = input.files?.[0];
  root.querySelector('[data-cfhr12-result]').hidden = true;
  if (!file || state.busy) return;
  state.busy = true;
  input.disabled = true;
  setStatus(root, 'Rebuilding canonical quarterly evidence and quarter-aligned Rolling-12 windows…', 'loading');
  try {
    const review = await buildHistoricalRolling12OperatingReview(JSON.parse(await file.text()));
    renderReview(root, review);
    setStatus(root, `Built ${review.windowCount} Rolling-12 window(s): ${review.aggregationAllowedWindowCount} allowed, ${review.aggregationBlockedWindowCount} blocked.`, 'ok');
  } catch (error) {
    setStatus(root, `Rolling-12 review blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    input.disabled = false;
  }
}

function renderReview(root, review) {
  const rows = review.windows.map((window) => `<tr>
    <td><b>${esc(window.windowKey)}</b><small>${esc(window.periodStartDate)} → ${esc(window.periodEndDate)}</small></td>
    <td>${window.rolling12AggregationAllowed ? '<b>allowed</b>' : `<b>blocked</b><small>${esc(window.blockers.join(', '))}</small>`}</td>
    <td>${format(window.metrics.spendMicros)}</td><td>${format(window.metrics.salesMicros)}</td><td>${format(window.metrics.orders)}</td>
    <td>${format(window.metrics.acos)}</td><td>${format(window.metrics.roas)}</td><td>${format(window.metrics.adContributionMicros)}</td>
  </tr>`).join('');
  const result = root.querySelector('[data-cfhr12-result]');
  result.innerHTML = `<div class="cfhr12-grid">${card('Ledger', `<code>${esc(review.ledgerFingerprint)}</code>`)}${card('Windows', `<b>${review.windowCount}</b>`)}${card('Allowed', `<b>${review.aggregationAllowedWindowCount}</b>`)}${card('Blocked', `<b>${review.aggregationBlockedWindowCount}</b>`)}</div><div class="cfhr12-table"><table><thead><tr><th>Window</th><th>Gate</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>ROAS</th><th>Ad Contribution</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  result.hidden = false;
}

function setStatus(root, text, kind = '') { const node = root.querySelector('[data-cfhr12-status]'); node.textContent = text; node.dataset.kind = kind; }
function card(label, value) { return `<div class="cfhr12-card"><small>${esc(label)}</small><div>${value}</div></div>`; }
function format(value) { return value == null || !Number.isFinite(Number(value)) ? 'withheld' : Number.isInteger(value) ? String(value) : Number(value).toPrecision(8).replace(/0+$/, '').replace(/\.$/, ''); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function installStyles() {
  if (document.getElementById('cfhr12-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhr12-style-v1';
  style.textContent = '.cfhr12{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhr12-head{display:flex;justify-content:space-between;gap:12px}.cfhr12-head small,.cfhr12 td small{display:block;color:#64748b;max-width:830px}.cfhr12-head>span{font-size:11px;font-weight:800}.cfhr12-guard,.cfhr12-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhr12-status[data-kind="bad"]{color:#b91c1c}.cfhr12-status[data-kind="ok"]{color:#047857}.cfhr12-controls{display:flex;gap:8px;margin-top:9px}.cfhr12-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhr12-controls input{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhr12-result{margin-top:10px}.cfhr12-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}.cfhr12-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhr12-card small{display:block;color:#64748b}.cfhr12 code{font-size:11px;word-break:break-all}.cfhr12-table{overflow:auto;margin-top:9px}.cfhr12 table{width:100%;border-collapse:collapse;font-size:12px}.cfhr12 th,.cfhr12 td{text-align:left;padding:7px;border-bottom:1px solid #e2e8f0;vertical-align:top}';
  document.head.appendChild(style);
}
