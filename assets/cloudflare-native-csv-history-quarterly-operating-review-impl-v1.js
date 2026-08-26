import { validateCsvHistoryLedger } from './csv-analysis-engine/csv-history-ledger.js';
import {
  buildHistoricalEvidenceDrilldown,
  buildHistoricalMonthlyWorkspace,
} from './cloudflare-native-csv-history-ledger-v1.js';

export const CSV_HISTORY_QUARTERLY_OPERATING_REVIEW_SCHEMA_VERSION = 'csv-history-quarterly-operating-review-v1';
export const CSV_HISTORY_QUARTERLY_OPERATING_REVIEW_UI_VERSION = '1.0.0';

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

export async function buildHistoricalQuarterlyOperatingReview(ledger) {
  const validated = await validateCsvHistoryLedger(ledger);
  const monthlyWorkspace = buildHistoricalMonthlyWorkspace(validated);
  const quarterGroups = new Map();
  for (const row of monthlyWorkspace.rows) {
    const quarterKey = quarterKeyForMonth(row.month);
    if (!quarterGroups.has(quarterKey)) quarterGroups.set(quarterKey, []);
    quarterGroups.get(quarterKey).push(row);
  }

  const quarters = [];
  for (const quarterKey of [...quarterGroups.keys()].sort()) {
    quarters.push(await buildQuarterEvidence(validated, quarterKey, quarterGroups.get(quarterKey)));
  }

  return deepFreeze({
    schemaVersion: CSV_HISTORY_QUARTERLY_OPERATING_REVIEW_SCHEMA_VERSION,
    ledgerFingerprint: validated.ledgerFingerprint,
    quarterCount: quarters.length,
    aggregationAllowedQuarterCount: quarters.filter((item) => item.quarterAggregationAllowed).length,
    aggregationBlockedQuarterCount: quarters.filter((item) => !item.quarterAggregationAllowed).length,
    sourceMonthlyEvidenceCount: monthlyWorkspace.rowCount,
    crossQuarterAggregationApplied: false,
    sameMonthAggregationApplied: false,
    normalizationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
    partialPeriodsHidden: false,
    missingMonthsHidden: false,
    rawEvidenceRetainedWhenBlocked: true,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
    quarters,
  });
}

async function buildQuarterEvidence(ledger, quarterKey, rowsInput) {
  const rows = [...rowsInput].sort((left, right) => left.month.localeCompare(right.month) || left.sourceInputSetFingerprint.localeCompare(right.sourceInputSetFingerprint));
  const expectedMonths = expectedMonthsForQuarter(quarterKey);
  const rowsByMonth = new Map();
  for (const row of rows) {
    if (!rowsByMonth.has(row.month)) rowsByMonth.set(row.month, []);
    rowsByMonth.get(row.month).push(row);
  }
  const missingMonths = expectedMonths.filter((month) => !rowsByMonth.has(month));
  const duplicateEvidenceMonths = expectedMonths.filter((month) => (rowsByMonth.get(month)?.length || 0) > 1);

  const evidence = [];
  for (const row of rows) {
    const drilldown = await buildHistoricalEvidenceDrilldown(ledger, {
      ledgerFingerprint: ledger.ledgerFingerprint,
      sourceInputSetFingerprint: row.sourceInputSetFingerprint,
      month: row.month,
      metricKey: 'adContributionMicros',
    });
    evidence.push(drilldown);
  }
  evidence.sort((left, right) => left.selectedMonth.localeCompare(right.selectedMonth) || left.evidenceKey.sourceInputSetFingerprint.localeCompare(right.evidenceKey.sourceInputSetFingerprint));

  const overlapPairs = ledger.historyWindowEvidence?.overlapPairs || [];
  const selectedFingerprints = new Set(evidence.map((item) => item.source.inputSetFingerprint));
  const participatesInHistoricalOverlap = overlapPairs.some((pair) => selectedFingerprints.has(pair.leftInputSetFingerprint) || selectedFingerprints.has(pair.rightInputSetFingerprint));
  const marketplaces = uniqueValues(evidence.flatMap((item) => item.source.marketplaceCodes));
  const currencies = uniqueValues(evidence.flatMap((item) => item.source.currencyCodes));
  const sourceHashes = evidence.flatMap((item) => item.source.contentSha256s);
  const ambiguousIdentityCounts = evidence.map((item) => Number(item.observedIdentity.summary?.ambiguousIdentityCount));
  const exactMonthEvidence = expectedMonths.map((month) => evidence.filter((item) => item.selectedMonth === month));

  const checks = {
    completeMonthSet: missingMonths.length === 0 && duplicateEvidenceMonths.length === 0 && rows.length === 3,
    coverageComplete: evidence.length > 0 && evidence.every((item) => item.coverage.coverageComplete === true),
    safeForNaiveAggregation: evidence.length > 0 && evidence.every((item) => item.decision.safeForNaiveAggregation === true),
    contiguousCoverage: evidence.length > 0 && evidence.every((item) => item.decision.contiguousCoverage === true),
    decisionStatesReviewable: evidence.length > 0 && evidence.every((item) => item.decision.decisionState !== 'blocked_overlap_or_invalid_window'),
    qualityStatesKnown: evidence.length > 0 && evidence.every((item) => item.decision.qualityState && item.decision.qualityState !== 'unknown'),
    historicalOverlapFree: !participatesInHistoricalOverlap,
    observedIdentityUnambiguous: ambiguousIdentityCounts.length > 0 && ambiguousIdentityCounts.every((count) => Number.isSafeInteger(count) && count === 0),
    marketplaceCompatible: evidence.length > 0 && evidence.every((item) => item.source.marketplaceCodes.length === 1) && marketplaces.length === 1,
    currencyCompatible: evidence.length > 0 && evidence.every((item) => item.source.currencyCodes.length === 1) && currencies.length === 1,
    calendarMonthRoles: evidence.length > 0 && evidence.every((item) => item.period.monthlySnapshot?.periodRole === 'calendar_month'),
    calendarWindowsExact: evidence.length > 0 && evidence.every((item) => exactCalendarMonthWindow(item.selectedMonth, item.coverage.periodStartDate, item.coverage.periodEndDate)),
    sourceFingerprintsDistinct: new Set(evidence.map((item) => item.source.inputSetFingerprint)).size === evidence.length,
    sourceContentDistinct: new Set(sourceHashes).size === sourceHashes.length,
    metricValuesComplete: evidence.length > 0 && evidence.every((item) => METRIC_KEYS.every((key) => finiteMetric(item.metrics[key]))),
    expectedMonthEvidenceExact: exactMonthEvidence.every((items) => items.length === 1),
  };

  const blockers = Object.entries(checks).filter(([, allowed]) => !allowed).map(([key]) => quarterBlocker(key));
  const quarterAggregationAllowed = blockers.length === 0;
  const selectedEvidence = quarterAggregationAllowed ? exactMonthEvidence.map((items) => items[0]) : [];
  const metrics = quarterAggregationAllowed ? aggregateQuarterMetrics(selectedEvidence) : withheldMetrics();
  const [quarterStartDate, quarterEndDate] = quarterDateRange(quarterKey);

  return deepFreeze({
    schemaVersion: CSV_HISTORY_QUARTERLY_OPERATING_REVIEW_SCHEMA_VERSION,
    quarter: quarterKey,
    quarterStartDate,
    quarterEndDate,
    expectedMonths,
    observedMonths: uniqueValues(rows.map((row) => row.month)),
    missingMonths,
    duplicateEvidenceMonths,
    sourceEvidenceCount: evidence.length,
    quarterAggregationAllowed,
    aggregationWithheld: !quarterAggregationAllowed,
    interpretationAllowed: quarterAggregationAllowed,
    rawEvidenceOnly: !quarterAggregationAllowed,
    blockers,
    checks,
    marketplace: marketplaces.length === 1 ? marketplaces[0] : null,
    currencyCode: currencies.length === 1 ? currencies[0] : null,
    metrics,
    sourceInputSetFingerprints: evidence.map((item) => item.source.inputSetFingerprint).sort(),
    historicalOverlapPairCount: overlapPairs.length,
    rawMonthlyEvidence: evidence.map(projectRawMonthlyEvidence),
    rawEvidenceRetained: true,
    sameMonthAggregationApplied: false,
    normalizationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  });
}

function aggregateQuarterMetrics(evidence) {
  const spendMicros = sumSafeIntegers(evidence.map((item) => item.metrics.spendMicros), 'CSV_HISTORY_QUARTERLY_SPEND_OVERFLOW');
  const salesMicros = sumSafeIntegers(evidence.map((item) => item.metrics.salesMicros), 'CSV_HISTORY_QUARTERLY_SALES_OVERFLOW');
  const orders = sumSafeIntegers(evidence.map((item) => item.metrics.orders), 'CSV_HISTORY_QUARTERLY_ORDERS_OVERFLOW');
  const adContributionMicros = sumSafeIntegers(evidence.map((item) => item.metrics.adContributionMicros), 'CSV_HISTORY_QUARTERLY_CONTRIBUTION_OVERFLOW');
  if (adContributionMicros !== salesMicros - spendMicros) throw quarterlyError('CSV_HISTORY_QUARTERLY_CONTRIBUTION_MISMATCH');
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

function projectRawMonthlyEvidence(item) {
  return {
    evidenceKey: item.evidenceKey,
    month: item.selectedMonth,
    metrics: item.metrics,
    coverage: item.coverage,
    decision: item.decision,
    marketplaceCodes: item.source.marketplaceCodes,
    currencyCodes: item.source.currencyCodes,
    contentSha256s: item.source.contentSha256s,
    sourceFileNames: item.source.sourceFileNames,
    observedIdentitySummary: item.observedIdentity.summary,
    profitabilityBasis: item.profitabilityBasis,
    authority: noAuthority(),
  };
}

function quarterKeyForMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw quarterlyError('CSV_HISTORY_QUARTERLY_MONTH_INVALID');
  const [yearText, monthText] = month.split('-');
  const monthNumber = Number(monthText);
  if (!Number.isSafeInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) throw quarterlyError('CSV_HISTORY_QUARTERLY_MONTH_INVALID');
  return `${yearText}-Q${Math.floor((monthNumber - 1) / 3) + 1}`;
}

function expectedMonthsForQuarter(quarterKey) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(quarterKey || ''));
  if (!match) throw quarterlyError('CSV_HISTORY_QUARTERLY_KEY_INVALID');
  const year = match[1];
  const startMonth = (Number(match[2]) - 1) * 3 + 1;
  return [0, 1, 2].map((offset) => `${year}-${String(startMonth + offset).padStart(2, '0')}`);
}

function quarterDateRange(quarterKey) {
  const months = expectedMonthsForQuarter(quarterKey);
  return [`${months[0]}-01`, lastDayOfMonth(months[2])];
}

function exactCalendarMonthWindow(month, startDate, endDate) {
  return startDate === `${month}-01` && endDate === lastDayOfMonth(month);
}

function lastDayOfMonth(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!match) throw quarterlyError('CSV_HISTORY_QUARTERLY_MONTH_INVALID');
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) throw quarterlyError('CSV_HISTORY_QUARTERLY_MONTH_INVALID');
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
    if (!Number.isSafeInteger(value)) throw quarterlyError(code);
    total += value;
    if (!Number.isSafeInteger(total)) throw quarterlyError(code);
  }
  return total;
}

function quarterBlocker(key) {
  return ({
    completeMonthSet: 'missing_or_duplicate_month_evidence',
    coverageComplete: 'partial_month_coverage',
    safeForNaiveAggregation: 'unsafe_monthly_quality_state',
    contiguousCoverage: 'non_contiguous_monthly_coverage',
    decisionStatesReviewable: 'blocked_monthly_decision_state',
    qualityStatesKnown: 'unknown_monthly_quality_state',
    historicalOverlapFree: 'historical_window_overlap_detected',
    observedIdentityUnambiguous: 'ambiguous_observed_identity',
    marketplaceCompatible: 'marketplace_mismatch_or_unknown',
    currencyCompatible: 'currency_mismatch_or_unknown',
    calendarMonthRoles: 'non_calendar_month_evidence',
    calendarWindowsExact: 'calendar_month_window_not_exact',
    sourceFingerprintsDistinct: 'source_fingerprint_reuse',
    sourceContentDistinct: 'source_content_hash_reuse',
    metricValuesComplete: 'quarter_metric_values_incomplete',
    expectedMonthEvidenceExact: 'expected_month_evidence_not_exact',
  })[key] || `quarter_gate_failed:${key}`;
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

function quarterlyError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryQuarterlyOperatingReviewError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryQuarterlyOperatingReview', {
    value: Object.freeze({
      version: CSV_HISTORY_QUARTERLY_OPERATING_REVIEW_UI_VERSION,
      schemaVersion: CSV_HISTORY_QUARTERLY_OPERATING_REVIEW_SCHEMA_VERSION,
      authority: 'local_historical_quarterly_operating_review_only',
      buildHistoricalQuarterlyOperatingReview,
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
  if (joint.querySelector('[data-csv-history-quarterly-operating-review]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhqor';
  root.dataset.csvHistoryQuarterlyOperatingReview = CSV_HISTORY_QUARTERLY_OPERATING_REVIEW_UI_VERSION;
  root.innerHTML = `
    <div class="cfhqor-head">
      <div><b>Quarterly Operating Review</b><small>Build calendar-quarter operating evidence from an explicit local history ledger. A quarter aggregates only when all three exact calendar months pass the evidence gate.</small></div>
      <span>ledger-bound · fail closed</span>
    </div>
    <div class="cfhqor-guard">Missing months, same-month duplicate evidence, partial coverage, overlap, identity ambiguity, marketplace/currency mismatch, or unsafe windows withhold quarterly metrics. Raw monthly evidence remains visible. Ad Contribution = Sales - Ad Spend only; it is not Net Profit.</div>
    <div class="cfhqor-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhqor-ledger></label>
      <button type="button" data-cfhqor-build disabled>Build quarterly review</button>
    </div>
    <div class="cfhqor-status" data-cfhqor-status>Explicit local-file ownership only. The ledger and review remain in memory for this page session.</div>
    <div class="cfhqor-result" data-cfhqor-result hidden></div>`;

  const history = joint.querySelector('[data-csv-history-ledger]');
  const provenance = joint.querySelector('[data-csv-provenance-audit]');
  if (history) history.insertAdjacentElement('afterend', root);
  else if (provenance) provenance.insertAdjacentElement('beforebegin', root);
  else joint.appendChild(root);

  root.querySelector('[data-cfhqor-ledger]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget));
  root.querySelector('[data-cfhqor-build]').addEventListener('click', () => void buildFromUi(root));
  state.mounted = true;
}

async function loadLedger(root, input) {
  const file = input.files?.[0];
  state.ledger = null;
  state.review = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating explicit local history ledger…', 'loading');
  try {
    state.ledger = await validateCsvHistoryLedger(JSON.parse(await file.text()));
    setStatus(root, `Ledger validated: ${state.ledger.ledgerFingerprint.slice(0, 12)} · ${state.ledger.snapshots.length} immutable snapshot${state.ledger.snapshots.length === 1 ? '' : 's'}.`, 'ok');
  } catch (error) {
    setStatus(root, `Ledger blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function buildFromUi(root) {
  if (!state.ledger || state.busy) return;
  state.busy = true;
  state.review = null;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Evaluating exact calendar-quarter evidence gates…', 'loading');
  try {
    state.review = await buildHistoricalQuarterlyOperatingReview(state.ledger);
    renderReview(root, state.review);
    setStatus(root, `Quarterly review built locally: ${state.review.aggregationAllowedQuarterCount} allowed · ${state.review.aggregationBlockedQuarterCount} blocked/raw-only.`, 'ok');
  } catch (error) {
    setStatus(root, `Quarterly review blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function renderReview(root, review) {
  const result = root.querySelector('[data-cfhqor-result]');
  const rows = review.quarters.map((quarter) => {
    const metrics = quarter.metrics;
    return `<tr>
      <td><b>${esc(quarter.quarter)}</b><br><small>${esc(quarter.expectedMonths.join(' · '))}</small></td>
      <td>${quarter.quarterAggregationAllowed ? '<b>allowed</b>' : '<b>blocked</b><br><small>raw evidence only</small>'}</td>
      <td>${formatMicros(metrics.spendMicros)}</td>
      <td>${formatMicros(metrics.salesMicros)}</td>
      <td>${formatNumber(metrics.orders)}</td>
      <td>${formatRatio(metrics.acos)}</td>
      <td>${formatRatio(metrics.roas)}</td>
      <td>${formatMicros(metrics.adContributionMicros)}</td>
      <td>${quarter.blockers.length ? esc(quarter.blockers.join(', ')) : 'all quarter checks passed'}</td>
    </tr>`;
  }).join('');
  const details = review.quarters.map((quarter) => `<details><summary>${esc(quarter.quarter)} raw monthly evidence · ${esc(quarter.sourceEvidenceCount)} item(s)</summary><pre>${esc(JSON.stringify(quarter.rawMonthlyEvidence, null, 2))}</pre></details>`).join('');
  result.innerHTML = `
    <div class="cfhqor-grid">
      ${card('Quarters', `<b>${esc(review.quarterCount)}</b>`)}
      ${card('Aggregation allowed', `<b>${esc(review.aggregationAllowedQuarterCount)}</b>`)}
      ${card('Blocked / raw only', `<b>${esc(review.aggregationBlockedQuarterCount)}</b>`)}
      ${card('Authority', '<b>review only</b><br>no execution')}
    </div>
    <div class="cfhqor-table"><table><thead><tr><th>Quarter</th><th>Gate</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>ROAS</th><th>Ad Contribution</th><th>Blockers</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="cfhqor-details">${details}</div>`;
  result.hidden = false;
}

function syncControls(root) {
  root.querySelector('[data-cfhqor-ledger]').disabled = state.busy;
  root.querySelector('[data-cfhqor-build]').disabled = state.busy || !state.ledger;
}

function clearResult(root) {
  const result = root.querySelector('[data-cfhqor-result]');
  result.hidden = true;
  result.innerHTML = '';
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhqor-status]');
  node.textContent = text;
  node.dataset.kind = kind;
}

function formatMicros(value) {
  return value == null ? 'withheld' : (value / 1_000_000).toFixed(2);
}

function formatNumber(value) {
  return value == null ? 'withheld' : String(value);
}

function formatRatio(value) {
  return value == null ? 'withheld' : Number(value).toFixed(4);
}

function card(label, value) {
  return `<div class="cfhqor-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhqor-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhqor-style-v1';
  style.textContent = '.cfhqor{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhqor-head{display:flex;justify-content:space-between;gap:12px}.cfhqor-head small{display:block;color:#64748b;max-width:800px}.cfhqor-head>span{font-size:11px;font-weight:800}.cfhqor-guard,.cfhqor-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhqor-status[data-kind="bad"]{color:#b91c1c}.cfhqor-status[data-kind="ok"]{color:#047857}.cfhqor-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhqor-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhqor-controls input,.cfhqor-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhqor-controls button{font-weight:700;cursor:pointer}.cfhqor-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhqor-result{margin-top:10px}.cfhqor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}.cfhqor-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px}.cfhqor-card small{display:block;color:#64748b}.cfhqor-table{overflow:auto;margin-top:10px}.cfhqor-table table{border-collapse:collapse;width:100%;min-width:980px}.cfhqor-table th,.cfhqor-table td{padding:7px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}.cfhqor-details details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhqor-details summary{cursor:pointer;font-weight:700}.cfhqor-details pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
