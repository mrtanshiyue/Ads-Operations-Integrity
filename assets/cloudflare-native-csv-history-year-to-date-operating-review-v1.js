import { buildHistoricalQuarterlyOperatingReview } from './cloudflare-native-csv-history-quarterly-operating-review-v1.js';

export const CSV_HISTORY_YEAR_TO_DATE_OPERATING_REVIEW_SCHEMA_VERSION = 'csv-history-year-to-date-operating-review-v1';
export const CSV_HISTORY_YEAR_TO_DATE_OPERATING_REVIEW_UI_VERSION = '1.0.0';

const METRIC_KEYS = Object.freeze([
  'spendMicros',
  'salesMicros',
  'orders',
  'acos',
  'roas',
  'adContributionMicros',
]);

const state = {
  mounted: false,
  busy: false,
  ledger: null,
  review: null,
};

export async function buildHistoricalYearToDateOperatingReview(ledger) {
  const quarterlyReview = await buildHistoricalQuarterlyOperatingReview(ledger);
  const quarterGroups = new Map();
  for (const quarter of quarterlyReview.quarters) {
    const parsed = parseQuarterKey(quarter.quarter);
    if (!quarterGroups.has(parsed.year)) quarterGroups.set(parsed.year, []);
    quarterGroups.get(parsed.year).push(quarter);
  }

  const periods = [];
  for (const year of [...quarterGroups.keys()].sort()) {
    const observedQuarterNumbers = [...new Set(quarterGroups.get(year).map((item) => parseQuarterKey(item.quarter).quarter))].sort((a, b) => a - b);
    for (const throughQuarter of observedQuarterNumbers) {
      periods.push(buildYearToDatePeriod(quarterlyReview, year, throughQuarter));
    }
  }

  return deepFreeze({
    schemaVersion: CSV_HISTORY_YEAR_TO_DATE_OPERATING_REVIEW_SCHEMA_VERSION,
    ledgerFingerprint: quarterlyReview.ledgerFingerprint,
    aggregationBasis: 'validated_natural_quarters_q1_through_selected_quarter',
    selectionPolicy: 'observed_natural_quarter_endpoints_no_auto_fill_or_reorder',
    yearCount: quarterGroups.size,
    periodCount: periods.length,
    aggregationAllowedPeriodCount: periods.filter((item) => item.ytdAggregationAllowed).length,
    aggregationBlockedPeriodCount: periods.filter((item) => !item.ytdAggregationAllowed).length,
    sourceQuarterCount: quarterlyReview.quarterCount,
    quarterlyReviewSchemaVersion: quarterlyReview.schemaVersion,
    sameMonthAggregationApplied: false,
    normalizationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
    partialQuartersHidden: false,
    missingQuartersHidden: false,
    rawEvidenceRetainedWhenBlocked: true,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
    periods,
  });
}

function buildYearToDatePeriod(quarterlyReview, year, throughQuarter) {
  const expectedQuarterKeys = Array.from({ length: throughQuarter }, (_, index) => `${year}-Q${index + 1}`);
  const quarterMap = new Map();
  for (const quarter of quarterlyReview.quarters) {
    if (!quarterMap.has(quarter.quarter)) quarterMap.set(quarter.quarter, []);
    quarterMap.get(quarter.quarter).push(quarter);
  }
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
    completeQuarterSet: missingQuarterKeys.length === 0 && duplicateQuarterKeys.length === 0 && selectedQuarters.length === throughQuarter,
    quarterlyAggregationsAllowed: selectedQuarters.length > 0 && selectedQuarters.every((item) => item.quarterAggregationAllowed === true),
    quarterlyInterpretationsAllowed: selectedQuarters.length > 0 && selectedQuarters.every((item) => item.interpretationAllowed === true && item.rawEvidenceOnly === false),
    marketplaceCompatible: selectedQuarters.length > 0 && selectedQuarters.every((item) => typeof item.marketplace === 'string' && item.marketplace.length > 0) && marketplaces.length === 1,
    currencyCompatible: selectedQuarters.length > 0 && selectedQuarters.every((item) => typeof item.currencyCode === 'string' && item.currencyCode.length > 0) && currencies.length === 1,
    sourceInputSetFingerprintsDistinct: sourceInputSetFingerprints.length > 0 && new Set(sourceInputSetFingerprints).size === sourceInputSetFingerprints.length,
    sourceContentSha256sDistinct: sourceContentSha256s.length > 0 && new Set(sourceContentSha256s).size === sourceContentSha256s.length,
    metricValuesComplete: selectedQuarters.length > 0 && selectedQuarters.every((item) => METRIC_KEYS.every((key) => finiteMetric(item.metrics?.[key]))),
    profitabilityBasisCompatible: selectedQuarters.length > 0 && selectedQuarters.every((item) => item.profitabilityBasis === 'sales_minus_ad_spend_only_not_net_profit'),
    expectedQuarterSequenceExact: selectedQuarters.length === expectedQuarterKeys.length && selectedQuarters.every((item, index) => item.quarter === expectedQuarterKeys[index]),
    naturalQuarterWindowsExact: selectedQuarters.length > 0 && selectedQuarters.every((item) => {
      const [startDate, endDate] = quarterDateRange(item.quarter);
      return item.quarterStartDate === startDate && item.quarterEndDate === endDate;
    }),
  };

  const blockers = Object.entries(checks).filter(([, allowed]) => !allowed).map(([key]) => ytdBlocker(key));
  const ytdAggregationAllowed = blockers.length === 0;
  const metrics = ytdAggregationAllowed ? aggregateYtdMetrics(selectedQuarters) : withheldMetrics();
  const periodKey = `${year}-YTD-Q${throughQuarter}`;
  const throughQuarterKey = `${year}-Q${throughQuarter}`;
  const [, periodEndDate] = quarterDateRange(throughQuarterKey);

  return deepFreeze({
    schemaVersion: CSV_HISTORY_YEAR_TO_DATE_OPERATING_REVIEW_SCHEMA_VERSION,
    periodKey,
    year,
    throughQuarter: throughQuarterKey,
    periodStartDate: `${year}-01-01`,
    periodEndDate,
    expectedQuarterKeys,
    observedQuarterKeys: selectedQuarters.map((item) => item.quarter),
    missingQuarterKeys,
    duplicateQuarterKeys,
    sourceQuarterCount: selectedQuarters.length,
    ytdAggregationAllowed,
    aggregationWithheld: !ytdAggregationAllowed,
    interpretationAllowed: ytdAggregationAllowed,
    rawEvidenceOnly: !ytdAggregationAllowed,
    blockers,
    checks,
    marketplace: marketplaces.length === 1 ? marketplaces[0] : null,
    currencyCode: currencies.length === 1 ? currencies[0] : null,
    metrics,
    sourceInputSetFingerprints,
    sourceContentSha256s,
    rawQuarterEvidence: selectedQuarters.map(projectRawQuarterEvidence),
    rawEvidenceRetained: true,
    crossQuarterAggregationApplied: ytdAggregationAllowed && selectedQuarters.length > 1,
    sameMonthAggregationApplied: false,
    normalizationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
    quarterSelectionAutoReordered: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  });
}

function aggregateYtdMetrics(quarters) {
  const spendMicros = sumSafeIntegers(quarters.map((item) => item.metrics.spendMicros), 'CSV_HISTORY_YTD_SPEND_OVERFLOW');
  const salesMicros = sumSafeIntegers(quarters.map((item) => item.metrics.salesMicros), 'CSV_HISTORY_YTD_SALES_OVERFLOW');
  const orders = sumSafeIntegers(quarters.map((item) => item.metrics.orders), 'CSV_HISTORY_YTD_ORDERS_OVERFLOW');
  const adContributionMicros = sumSafeIntegers(quarters.map((item) => item.metrics.adContributionMicros), 'CSV_HISTORY_YTD_CONTRIBUTION_OVERFLOW');
  if (adContributionMicros !== salesMicros - spendMicros) throw ytdError('CSV_HISTORY_YTD_CONTRIBUTION_MISMATCH');
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
  return {
    spendMicros: null,
    salesMicros: null,
    orders: null,
    acos: null,
    roas: null,
    adContributionMicros: null,
  };
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

function parseQuarterKey(quarterKey) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(quarterKey || ''));
  if (!match) throw ytdError('CSV_HISTORY_YTD_QUARTER_KEY_INVALID');
  return { year: match[1], quarter: Number(match[2]) };
}

function quarterDateRange(quarterKey) {
  const { year, quarter } = parseQuarterKey(quarterKey);
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return [`${year}-${String(startMonth).padStart(2, '0')}-01`, lastDayOfMonth(year, endMonth)];
}

function lastDayOfMonth(yearText, monthNumber) {
  const year = Number(yearText);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) throw ytdError('CSV_HISTORY_YTD_DATE_INVALID');
  const last = new Date(Date.UTC(year, monthNumber, 0));
  return `${String(last.getUTCFullYear()).padStart(4, '0')}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`;
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => value != null && value !== '').map(String))].sort();
}

function finiteMetric(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sumSafeIntegers(values, code) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw ytdError(code);
    total += value;
    if (!Number.isSafeInteger(total)) throw ytdError(code);
  }
  return total;
}

function ytdBlocker(key) {
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
  })[key] || `ytd_check_failed:${key}`;
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

function ytdError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryYearToDateOperatingReviewError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryYearToDateOperatingReview', {
    value: Object.freeze({
      version: CSV_HISTORY_YEAR_TO_DATE_OPERATING_REVIEW_UI_VERSION,
      schemaVersion: CSV_HISTORY_YEAR_TO_DATE_OPERATING_REVIEW_SCHEMA_VERSION,
      authority: 'local_historical_quarter_aligned_ytd_review_only',
      buildHistoricalYearToDateOperatingReview,
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
  const preferredHost = document.querySelector('[data-csv-history-quarter-over-quarter-comparison-receipt-verification]');
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
  if (document.querySelector('[data-csv-history-year-to-date-operating-review]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhytd';
  root.dataset.csvHistoryYearToDateOperatingReview = CSV_HISTORY_YEAR_TO_DATE_OPERATING_REVIEW_UI_VERSION;
  root.innerHTML = `
    <div class="cfhytd-head">
      <div><b>Year-to-Date Operating Review</b><small>Quarter-aligned YTD only. Each period starts at Q1 and consumes canonical natural-quarter evidence through the selected observed quarter. Partial or blocked quarters are never promoted into YTD metrics.</small></div>
      <span>Q1 → observed quarter · fail closed</span>
    </div>
    <div class="cfhytd-guard">YTD aggregation is allowed only when every required quarter has already passed the canonical quarterly integrity gate and cross-quarter marketplace, currency, source, metric, and profitability checks remain compatible. Ad Contribution = Sales - Ad Spend only; it is not Net Profit.</div>
    <div class="cfhytd-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhytd-ledger></label>
    </div>
    <div class="cfhytd-status" data-cfhytd-status>Explicit local-file ownership: no ledger or YTD result is silently persisted.</div>
    <div class="cfhytd-result" data-cfhytd-result hidden></div>`;
  host.insertAdjacentElement('afterend', root);
  root.querySelector('[data-cfhytd-ledger]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget));
  state.mounted = true;
}

async function loadLedger(root, input) {
  const file = input.files?.[0];
  state.ledger = null;
  state.review = null;
  root.querySelector('[data-cfhytd-result]').hidden = true;
  if (!file || state.busy) return;
  state.busy = true;
  input.disabled = true;
  setStatus(root, 'Rebuilding canonical quarterly evidence and quarter-aligned YTD periods…', 'loading');
  try {
    state.ledger = JSON.parse(await file.text());
    state.review = await buildHistoricalYearToDateOperatingReview(state.ledger);
    renderReview(root, state.review);
    setStatus(root, `Built ${state.review.periodCount} YTD period(s): ${state.review.aggregationAllowedPeriodCount} allowed, ${state.review.aggregationBlockedPeriodCount} blocked.`, 'ok');
  } catch (error) {
    setStatus(root, `YTD review blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    input.disabled = false;
  }
}

function renderReview(root, review) {
  const rows = review.periods.map((period) => `<tr>
    <td><b>${esc(period.periodKey)}</b><small>${esc(period.periodStartDate)} → ${esc(period.periodEndDate)}</small></td>
    <td>${period.ytdAggregationAllowed ? '<b>allowed</b>' : `<b>blocked</b><small>${esc(period.blockers.join(', '))}</small>`}</td>
    <td>${formatMetric(period.metrics.spendMicros)}</td>
    <td>${formatMetric(period.metrics.salesMicros)}</td>
    <td>${formatMetric(period.metrics.orders)}</td>
    <td>${formatRatio(period.metrics.acos)}</td>
    <td>${formatRatio(period.metrics.roas)}</td>
    <td>${formatMetric(period.metrics.adContributionMicros)}</td>
  </tr>`).join('');
  const result = root.querySelector('[data-cfhytd-result]');
  result.innerHTML = `
    <div class="cfhytd-grid">
      ${card('Ledger', `<code>${esc(review.ledgerFingerprint)}</code>`)}
      ${card('YTD periods', `<b>${review.periodCount}</b>`)}
      ${card('Allowed', `<b>${review.aggregationAllowedPeriodCount}</b>`)}
      ${card('Blocked', `<b>${review.aggregationBlockedPeriodCount}</b>`)}
    </div>
    <div class="cfhytd-table"><table><thead><tr><th>Period</th><th>Gate</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>ROAS</th><th>Ad Contribution</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  result.hidden = false;
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhytd-status]');
  node.textContent = text;
  node.dataset.kind = kind;
}

function card(label, value) {
  return `<div class="cfhytd-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function formatMetric(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'withheld';
  return Number.isInteger(value) ? String(value) : Number(value).toPrecision(8).replace(/0+$/, '').replace(/\.$/, '');
}

function formatRatio(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'withheld';
  return Number(value).toPrecision(8).replace(/0+$/, '').replace(/\.$/, '');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhytd-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhytd-style-v1';
  style.textContent = '.cfhytd{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhytd-head{display:flex;justify-content:space-between;gap:12px}.cfhytd-head small,.cfhytd td small{display:block;color:#64748b;max-width:820px}.cfhytd-head>span{font-size:11px;font-weight:800}.cfhytd-guard,.cfhytd-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhytd-status[data-kind="bad"]{color:#b91c1c}.cfhytd-status[data-kind="ok"]{color:#047857}.cfhytd-controls{display:flex;gap:8px;margin-top:9px}.cfhytd-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhytd-controls input{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhytd-result{margin-top:10px}.cfhytd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}.cfhytd-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhytd-card small{display:block;color:#64748b}.cfhytd code{font-size:11px;word-break:break-all}.cfhytd-table{overflow:auto;margin-top:9px}.cfhytd table{width:100%;border-collapse:collapse;font-size:12px}.cfhytd th,.cfhytd td{text-align:left;padding:7px;border-bottom:1px solid #e2e8f0;vertical-align:top}';
  document.head.appendChild(style);
}
