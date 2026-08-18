import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const engineUrl = pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href;
const uiUrl = pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-history-ledger-v1.js')).href;
const engine = await import(`${engineUrl}?periodComparisonEngine=${Date.now()}`);
const ui = await import(`${uiUrl}?periodComparisonUi=${Date.now()}`);

assert.equal(ui.CSV_HISTORY_PERIOD_COMPARISON_SCHEMA_VERSION, 'csv-history-period-comparison-v1');
assert.equal(typeof ui.buildHistoricalPeriodComparison, 'function');

const partialA = await fixture({
  hashChar: 'a', month: '2026-08', startDate: '2026-08-01', endDate: '2026-08-14', expectedDayCount: 31, coveredDayCount: 14,
});
const partialB = await fixture({
  hashChar: 'b', month: '2026-09', startDate: '2026-09-01', endDate: '2026-09-30', expectedDayCount: 30, coveredDayCount: 14,
});
const partialLedger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(partialA), partialB);
const partialRows = ui.buildHistoricalMonthlyWorkspace(partialLedger).rows;
const partial = await ui.buildHistoricalPeriodComparison(partialLedger, select(partialRows[0]), select(partialRows[1]));
assert.equal(partial.schemaVersion, 'csv-history-period-comparison-v1');
assert.equal(partial.comparisonAllowed, false);
assert.equal(partial.interpretationAllowed, false);
assert.equal(partial.rawEvidenceOnly, true);
assert.equal(partial.deltaBasis, 'period_b_minus_period_a');
assert.equal(partial.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(partial.comparabilityGate.checks.coverageComplete, false);
assert.equal(partial.comparabilityGate.checks.reportWindowLengthCompatible, false);
assert.ok(partial.comparabilityGate.reasons.includes('incomplete_coverage'));
assert.ok(partial.comparabilityGate.reasons.includes('report_window_length_incompatible'));
assert.equal(partial.metrics.spendMicros.periodAValue, 4_000_000);
assert.equal(partial.metrics.spendMicros.periodBValue, 4_000_000);
assert.equal(partial.metrics.spendMicros.delta, null);
assert.equal(partial.metrics.spendMicros.direction, 'withheld_not_comparable');
assert.equal(partial.crossSnapshotAggregationApplied, false);
assert.equal(partial.normalizationApplied, false);
assertAuthorityFalse(partial.authority);

const sameEvidence = await ui.buildHistoricalPeriodComparison(partialLedger, select(partialRows[0]), select(partialRows[0]));
assert.equal(sameEvidence.comparisonAllowed, false);
assert.equal(sameEvidence.comparabilityGate.checks.distinctEvidence, false);
assert.equal(sameEvidence.comparabilityGate.checks.sourceFingerprintsDistinct, false);
assert.ok(sameEvidence.comparabilityGate.reasons.includes('same_evidence_selected_twice'));
assert.ok(sameEvidence.comparabilityGate.reasons.includes('source_fingerprint_reused'));

const completeA = await fixture({
  hashChar: 'c', month: '2026-08', startDate: '2026-08-01', endDate: '2026-08-31', expectedDayCount: 31, coveredDayCount: 31,
});
const completeB = await fixture({
  hashChar: 'd', month: '2026-09', startDate: '2026-09-01', endDate: '2026-09-30', expectedDayCount: 30, coveredDayCount: 30,
  metrics: { spendMicros: 5_000_000, salesMicros: 10_000_000, orders: 4, acos: 0.5, roas: 2 },
});
const completeLedger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(completeA), completeB);
const completeRows = ui.buildHistoricalMonthlyWorkspace(completeLedger).rows;
const allowed = await ui.buildHistoricalPeriodComparison(completeLedger, select(completeRows[0]), select(completeRows[1]));
assert.equal(allowed.comparisonAllowed, true);
assert.equal(allowed.interpretationAllowed, true);
assert.equal(allowed.rawEvidenceOnly, false);
assert.equal(allowed.comparabilityGate.reasons.length, 0);
assert.ok(Object.values(allowed.comparabilityGate.checks).every(Boolean));
assert.equal(allowed.comparabilityGate.periodAWindowDays, 31);
assert.equal(allowed.comparabilityGate.periodBWindowDays, 30);
assert.equal(allowed.comparabilityGate.completeCalendarPeriods, true);
assert.equal(allowed.comparabilityGate.checks.reportWindowLengthCompatible, true);
assertMetric(allowed, 'spendMicros', 1_000_000, 'increase');
assertMetric(allowed, 'salesMicros', 0, 'flat');
assertMetric(allowed, 'orders', 1, 'increase');
assertMetric(allowed, 'acos', 0.1, 'increase');
assertMetric(allowed, 'roas', -0.5, 'decrease');
assertMetric(allowed, 'adContributionMicros', -1_000_000, 'decrease');
assert.equal(allowed.metrics.adContributionMicros.periodAValue, 6_000_000);
assert.equal(allowed.metrics.adContributionMicros.periodBValue, 5_000_000);
assert.equal(allowed.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(allowed.authority);

const currencyBlocked = await comparisonAgainstCompleteA({
  hashChar: 'e', month: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31', expectedDayCount: 31, coveredDayCount: 31, currencyCode: 'EUR',
});
assertBlocked(currencyBlocked, 'currencyCompatible', 'currency_mismatch_or_unknown');

const marketplaceBlocked = await comparisonAgainstCompleteA({
  hashChar: 'f', month: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31', expectedDayCount: 31, coveredDayCount: 31, marketplace: 'CA',
});
assertBlocked(marketplaceBlocked, 'marketplaceCompatible', 'marketplace_mismatch_or_unknown');

const identityBlocked = await comparisonAgainstCompleteA({
  hashChar: '1', month: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31', expectedDayCount: 31, coveredDayCount: 31, ambiguousIdentityCount: 1,
});
assertBlocked(identityBlocked, 'observedIdentityUnambiguous', 'observed_identity_ambiguous_or_unknown');

const qualityBlocked = await comparisonAgainstCompleteA({
  hashChar: '2', month: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31', expectedDayCount: 31, coveredDayCount: 31, qualityState: 'verified_single_window',
});
assertBlocked(qualityBlocked, 'qualityStateCompatible', 'quality_state_mismatch_or_unknown');

const overlapB = await fixture({
  hashChar: '3', month: '2026-08', startDate: '2026-08-15', endDate: '2026-08-31', expectedDayCount: 31, coveredDayCount: 31,
});
const overlapLedger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(completeA), overlapB);
const overlapRows = ui.buildHistoricalMonthlyWorkspace(overlapLedger).rows;
const overlapBlocked = await ui.buildHistoricalPeriodComparison(overlapLedger, select(overlapRows[0]), select(overlapRows[1]));
assertBlocked(overlapBlocked, 'historicalOverlapFree', 'historical_overlap_detected');
assert.equal(overlapBlocked.metrics.adContributionMicros.delta, null);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-period-comparison-v1',
  comparabilityGateRequired: true,
  blockedComparisonRawEvidenceOnly: true,
  completeCalendarMonthComparisonAllowed: true,
  naturalMonthLengthDifferenceAllowedWhenComplete: true,
  deltaBasis: 'period_b_minus_period_a',
  coverageGate: true,
  overlapGate: true,
  identityAmbiguityGate: true,
  marketplaceGate: true,
  currencyGate: true,
  qualityStateGate: true,
  sourceFingerprintGate: true,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  crossSnapshotAggregationApplied: false,
  normalizationApplied: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

async function comparisonAgainstCompleteA(options) {
  const candidate = await fixture(options);
  const ledger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(completeA), candidate);
  const rows = ui.buildHistoricalMonthlyWorkspace(ledger).rows;
  return ui.buildHistoricalPeriodComparison(ledger, select(rows[0]), select(rows[1]));
}

function select(row) {
  return {
    ledgerFingerprint: row.ledgerFingerprint,
    sourceInputSetFingerprint: row.sourceInputSetFingerprint,
    month: row.month,
  };
}

function assertMetric(comparison, key, delta, direction) {
  const actual = comparison.metrics[key].delta;
  if (Number.isInteger(delta)) assert.equal(actual, delta);
  else assert.ok(Math.abs(actual - delta) < 1e-12, `${key} delta ${actual} must be within tolerance of ${delta}`);
  assert.equal(comparison.metrics[key].direction, direction);
  assert.equal(comparison.metrics[key].interpretationAllowed, true);
}

function assertBlocked(comparison, check, reason) {
  assert.equal(comparison.comparisonAllowed, false);
  assert.equal(comparison.rawEvidenceOnly, true);
  assert.equal(comparison.comparabilityGate.checks[check], false);
  assert.ok(comparison.comparabilityGate.reasons.includes(reason));
}

function assertAuthorityFalse(authority) {
  assert.equal(authority.authoritative, false);
  assert.equal(authority.canonicalAmazonIdentityResolved, false);
  assert.equal(authority.governancePersistenceAllowed, false);
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.amazonMutationAuthorized, false);
}

async function fixture({
  hashChar,
  month,
  startDate,
  endDate,
  expectedDayCount,
  coveredDayCount,
  metrics = { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
  marketplace = 'US',
  currencyCode = 'USD',
  ambiguousIdentityCount = 0,
  qualityState = 'single_window',
}) {
  const contentSha256 = hashChar.repeat(64);
  const receipt = {
    schemaVersion: 'csv-import-v1',
    reportType: 'spSearchTerm',
    sourceFileName: `${month}.csv`,
    contentSha256,
    reportStartDate: startDate,
    reportEndDate: endDate,
    rowCount: 10,
    acceptedRows: 10,
    rejectedRows: 0,
    advertiserAccountId: null,
    profileId: null,
    marketplace,
    currencyCode,
  };
  const fingerprintPayload = [{
    schemaVersion: receipt.schemaVersion,
    reportType: receipt.reportType,
    contentSha256: receipt.contentSha256,
    reportStartDate: receipt.reportStartDate,
    reportEndDate: receipt.reportEndDate,
    rowCount: receipt.rowCount,
  }];
  const inputSetFingerprint = await sha256Hex(canonicalJson(fingerprintPayload));
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  const complete = coveredDayCount === expectedDayCount;
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: {
      kind: 'csv_import_set', batchCount: 1, contentSha256s: [contentSha256], inputSetFingerprint,
      canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false,
    },
    range: { startDate, endDate },
    imports: [receipt],
    dataQuality: {
      authority, qualityState, safeForNaiveAggregation: true, contiguousCoverage: true,
      summary: { overlapPairCount: 0, gapCount: 0 },
    },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: {
      authority,
      summary: { monthlySnapshotCount: 1, aggregationSafe: true, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false },
      monthlySnapshots: [{
        periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount, factCount: 10,
        metrics,
        adContributionMicros: metrics.salesMicros - metrics.spendMicros,
        profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
        coverage: { expectedDayCount, coveredDayCount, coverageRatio: coveredDayCount / expectedDayCount, complete },
        reliability: { state: complete ? 'complete_coverage' : 'incomplete_coverage', aggregationSafe: true, coverageComplete: complete, analyticalDecisionUse: complete ? 'observed_review_only' : 'review_with_partial_coverage' },
        requiresHumanReview: true, persistenceAuthorized: false, executionAuthorized: false, amazonMutationAuthorized: false,
      }],
    },
    analysis: { authority },
  };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
