import { deriveSearchTermMetrics } from './decision-intelligence.js';

export const CSV_PERIOD_ANALYSIS_SCHEMA_VERSION = 'csv-period-over-period-v1';
export const CSV_TRAILING_PERIOD_DAYS = Object.freeze([7, 14, 30, 60, 90]);
const DAY_MS = 86_400_000;
const NON_AUTHORITY = Object.freeze({
  mode: 'csv_period_observation_only',
  authoritative: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function analyzeCsvPeriodOverPeriod(facts, options = {}) {
  if (!Array.isArray(facts)) throw periodError('CSV_PERIOD_FACTS_REQUIRED');
  const validFacts = facts.map(validateFact).sort((left, right) => left.reportDate.localeCompare(right.reportDate) || String(left.rowKey || '').localeCompare(String(right.rowKey || '')));
  const observationStartDate = validFacts[0]?.reportDate || null;
  const observationEndDate = validFacts[validFacts.length - 1]?.reportDate || null;
  const dataQuality = options.dataQuality || null;
  const coverage = normalizeCoverage(dataQuality?.mergedCoverage || []);
  const aggregationSafe = dataQuality?.safeForNaiveAggregation !== false;

  if (!observationEndDate) {
    return Object.freeze({
      schemaVersion: CSV_PERIOD_ANALYSIS_SCHEMA_VERSION,
      authority: NON_AUTHORITY,
      observationRange: Object.freeze({ startDate: null, endDate: null }),
      summary: Object.freeze({ factCount: 0, trailingComparisonCount: 0, monthlySnapshotCount: 0, aggregationSafe, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false }),
      trailingComparisons: Object.freeze([]),
      monthlySnapshots: Object.freeze([]),
    });
  }

  const trailingComparisons = CSV_TRAILING_PERIOD_DAYS.map((days) => buildTrailingComparison(validFacts, coverage, aggregationSafe, observationEndDate, days));
  const monthlySnapshots = buildMonthlySnapshots(validFacts, coverage, aggregationSafe, observationStartDate, observationEndDate);

  return Object.freeze({
    schemaVersion: CSV_PERIOD_ANALYSIS_SCHEMA_VERSION,
    authority: NON_AUTHORITY,
    observationRange: Object.freeze({ startDate: observationStartDate, endDate: observationEndDate }),
    summary: Object.freeze({
      factCount: validFacts.length,
      trailingComparisonCount: trailingComparisons.length,
      monthlySnapshotCount: monthlySnapshots.length,
      fullyCoveredTrailingComparisonCount: trailingComparisons.filter((item) => item.reliability.state === 'observed').length,
      incompleteTrailingComparisonCount: trailingComparisons.filter((item) => item.reliability.state === 'incomplete_coverage').length,
      blockedTrailingComparisonCount: trailingComparisons.filter((item) => item.reliability.state === 'blocked_overlap_or_invalid_window').length,
      aggregationSafe,
      canonicalAmazonIdentityResolved: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    trailingComparisons: Object.freeze(trailingComparisons),
    monthlySnapshots: Object.freeze(monthlySnapshots),
  });
}

function buildTrailingComparison(facts, coverage, aggregationSafe, endDate, days) {
  const currentEnd = parseDate(endDate);
  const currentStart = currentEnd - (days - 1) * DAY_MS;
  const previousEnd = currentStart - DAY_MS;
  const previousStart = previousEnd - (days - 1) * DAY_MS;
  const current = snapshot(facts, coverage, currentStart, currentEnd, aggregationSafe, 'trailing_current');
  const previous = snapshot(facts, coverage, previousStart, previousEnd, aggregationSafe, 'trailing_previous');
  const reliability = comparisonReliability(aggregationSafe, current.coverage.coverageRatio, previous.coverage.coverageRatio);
  return Object.freeze({
    periodType: 'trailing_days',
    days,
    current,
    previous,
    change: metricChange(current.metrics, previous.metrics),
    reliability,
    requiresHumanReview: true,
    persistenceAuthorized: false,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
  });
}

function buildMonthlySnapshots(facts, coverage, aggregationSafe, startDate, endDate) {
  const first = monthStart(parseDate(startDate));
  const last = monthStart(parseDate(endDate));
  const rows = [];
  for (let cursor = first; cursor <= last; cursor = addMonths(cursor, 1)) {
    const start = cursor;
    const end = addMonths(cursor, 1) - DAY_MS;
    const base = snapshot(facts, coverage, start, end, aggregationSafe, 'calendar_month');
    rows.push({
      ...base,
      month: formatDate(start).slice(0, 7),
      monthComplete: base.coverage.coverageRatio === 1,
      comparisonToPreviousMonth: null,
    });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1] || null;
    const comparison = previous ? Object.freeze({
      change: metricChange(current.metrics, previous.metrics),
      reliability: comparisonReliability(aggregationSafe, current.coverage.coverageRatio, previous.coverage.coverageRatio),
    }) : null;
    rows[index] = Object.freeze({
      ...current,
      comparisonToPreviousMonth: comparison,
      requiresHumanReview: true,
      persistenceAuthorized: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    });
  }
  return rows;
}

function snapshot(facts, coverage, startDay, endDay, aggregationSafe, periodRole) {
  const selected = facts.filter((fact) => {
    const day = parseDate(fact.reportDate);
    return day >= startDay && day <= endDay;
  });
  const totals = aggregateFacts(selected);
  const metrics = deriveSearchTermMetrics(totals);
  const coveredDayCount = coverageDays(coverage, startDay, endDay);
  const expectedDayCount = daysInclusive(startDay, endDay);
  const coverageRatio = expectedDayCount > 0 ? coveredDayCount / expectedDayCount : 0;
  return Object.freeze({
    periodRole,
    startDate: formatDate(startDay),
    endDate: formatDate(endDay),
    expectedDayCount,
    coveredDayCount,
    factCount: selected.length,
    metrics,
    adContributionMicros: metrics.salesMicros - metrics.spendMicros,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    coverage: Object.freeze({
      expectedDayCount,
      coveredDayCount,
      coverageRatio: round4(coverageRatio),
      complete: coverageRatio === 1,
    }),
    reliability: snapshotReliability(aggregationSafe, coverageRatio),
  });
}

function aggregateFacts(facts) {
  const aggregate = { impressions: 0, clicks: 0, purchases: 0, unitsSold: 0, costMicros: 0, salesMicros: 0 };
  for (const fact of facts) {
    aggregate.impressions += nonNegative(fact.impressions);
    aggregate.clicks += nonNegative(fact.clicks);
    aggregate.purchases += nonNegative(fact.purchases);
    aggregate.unitsSold += nonNegative(fact.unitsSold);
    aggregate.costMicros += nonNegative(fact.costMicros ?? fact.spendMicros);
    aggregate.salesMicros += nonNegative(fact.salesMicros);
  }
  return aggregate;
}

function metricChange(current, previous) {
  return Object.freeze({
    spendPct: percentChange(current.spendMicros, previous.spendMicros),
    salesPct: percentChange(current.salesMicros, previous.salesMicros),
    ordersPct: percentChange(current.orders, previous.orders),
    clicksPct: percentChange(current.clicks, previous.clicks),
    impressionsPct: percentChange(current.impressions, previous.impressions),
    acosDelta: nullableDelta(current.acos, previous.acos),
    roasDelta: nullableDelta(current.roas, previous.roas),
    cvrDelta: nullableDelta(current.cvr, previous.cvr),
    ctrDelta: nullableDelta(current.ctr, previous.ctr),
    cpcPct: percentChange(current.cpcMicros, previous.cpcMicros),
  });
}

function snapshotReliability(aggregationSafe, coverageRatio) {
  const state = !aggregationSafe ? 'blocked_overlap_or_invalid_window' : coverageRatio === 1 ? 'observed' : 'incomplete_coverage';
  return Object.freeze({
    state,
    aggregationSafe,
    coverageComplete: coverageRatio === 1,
    analyticalDecisionUse: !aggregationSafe ? 'blocked' : coverageRatio === 1 ? 'review_only' : 'review_with_partial_coverage',
  });
}

function comparisonReliability(aggregationSafe, currentCoverageRatio, previousCoverageRatio) {
  const coverageComplete = currentCoverageRatio === 1 && previousCoverageRatio === 1;
  const state = !aggregationSafe ? 'blocked_overlap_or_invalid_window' : coverageComplete ? 'observed' : 'incomplete_coverage';
  return Object.freeze({
    state,
    aggregationSafe,
    currentCoverageComplete: currentCoverageRatio === 1,
    previousCoverageComplete: previousCoverageRatio === 1,
    analyticalDecisionUse: !aggregationSafe ? 'blocked' : coverageComplete ? 'review_only' : 'review_with_partial_coverage',
  });
}

function normalizeCoverage(items) {
  return items.map((item) => {
    const startDay = parseDate(item?.startDate);
    const endDay = parseDate(item?.endDate);
    if (startDay === null || endDay === null || endDay < startDay) throw periodError('CSV_PERIOD_COVERAGE_INVALID');
    return Object.freeze({ startDay, endDay });
  }).sort((left, right) => left.startDay - right.startDay || left.endDay - right.endDay);
}

function coverageDays(coverage, startDay, endDay) {
  let count = 0;
  for (const item of coverage) {
    const start = Math.max(startDay, item.startDay);
    const end = Math.min(endDay, item.endDay);
    if (start <= end) count += daysInclusive(start, end);
  }
  return count;
}

function validateFact(fact) {
  if (!fact || typeof fact !== 'object') throw periodError('CSV_PERIOD_FACT_INVALID');
  if (parseDate(fact.reportDate) === null) throw periodError('CSV_PERIOD_REPORT_DATE_INVALID');
  return fact;
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}
function formatDate(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }
function monthStart(timestamp) { const date = new Date(timestamp); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1); }
function addMonths(timestamp, months) { const date = new Date(timestamp); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1); }
function daysInclusive(startDay, endDay) { return Math.floor((endDay - startDay) / DAY_MS) + 1; }
function nonNegative(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; }
function percentChange(current, previous) { const a = Number(current); const b = Number(previous); return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? round4((a - b) / b) : null; }
function nullableDelta(current, previous) { return current == null || previous == null ? null : round4(Number(current) - Number(previous)); }
function round4(value) { return Math.round(value * 10_000) / 10_000; }
function periodError(code) { const error = new Error(code); error.name = 'CsvPeriodOverPeriodError'; error.code = code; return error; }
