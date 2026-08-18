import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const assetRelative = 'assets/cloudflare-native-csv-history-year-over-year-ytd-review-board-v1.js';
const assetSource = await readFile(path.join(distRoot, assetRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const comparisonTag = '<script type="module" src="assets/cloudflare-native-csv-history-year-over-year-ytd-comparison-v1.js?v=1.0.0"></script>';
const boardTag = '<script type="module" src="assets/cloudflare-native-csv-history-year-over-year-ytd-review-board-v1.js?v=1.0.0"></script>';
const monthlyReceiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(boardTag).length - 1, 1, 'YoY YTD review board asset must be injected exactly once');
assert.ok(indexSource.indexOf(comparisonTag) < indexSource.indexOf(boardTag), 'Review board must load after canonical YoY YTD comparison');
assert.ok(indexSource.indexOf(boardTag) < indexSource.indexOf(monthlyReceiptTag), 'Review board must load before legacy monthly receipt workflow');
assert.match(assetSource, /csv-history-year-over-year-ytd-review-board-v1/);
assert.match(assetSource, /Read-only projection of one explicit YoY YTD comparison/);
assert.match(assetSource, /does not classify business outcomes, recommend actions, or authorize execution/);
assert.match(assetSource, /read_only_projection_of_explicit_yoy_ytd_comparison/);
assert.match(assetSource, /outcomeQualityClassification: 'not_assigned'/);
assert.match(assetSource, /recommendationGenerated: false/);
assert.match(assetSource, /actionGenerated: false/);
assert.match(assetSource, /outcomeQualityClassificationApplied: false/);
assert.match(assetSource, /crossYearAggregationApplied: false/);
assert.match(assetSource, /crossYearNormalizationApplied: false/);
assert.match(assetSource, /ytdPeriodReaggregationApplied: false/);
assert.match(assetSource, /selectionAutoReordered: false/);
assert.match(assetSource, /Ad Contribution = Sales - Ad Spend only; it is not Net Profit/);

for (const pattern of [
  /\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /\bWebSocket\b/, /\bEventSource\b/,
  /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /CloudflareNativeAPI/, /\/api\/v1\//,
  /CONTROL_DB/, /STORE_01_DB/, /DATA_BUCKET/, /AMAZON_ADS_ENABLED/, /optimization-actions/, /execution-permits/,
]) assert.equal(pattern.test(assetSource), false, `Review board must remain explicit-local and execution-free: ${pattern}`);

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?yoyBoardEngine=${Date.now()}`);
const boardMod = await import(`${pathToFileURL(path.join(distRoot, assetRelative)).href}?yoyBoard=${Date.now()}`);
assert.equal(boardMod.CSV_HISTORY_YEAR_OVER_YEAR_YTD_REVIEW_BOARD_SCHEMA_VERSION, 'csv-history-year-over-year-ytd-review-board-v1');
assert.equal(boardMod.CSV_HISTORY_YEAR_OVER_YEAR_YTD_REVIEW_BOARD_UI_VERSION, '1.0.0');
assert.equal(typeof boardMod.buildHistoricalYearOverYearYtdReviewBoard, 'function');

const y2025q1 = await completeQuarter({ year: 2025, quarter: 1, seed: '2025-q1', metrics: { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 } });
const y2026q1 = await completeQuarter({ year: 2026, quarter: 1, seed: '2026-q1', metrics: { spendMicros: 5_000_000, salesMicros: 12_000_000, orders: 4, acos: 5 / 12, roas: 2.4 } });
const ledger = await ledgerFrom(...y2025q1, ...y2026q1);

const board = await boardMod.buildHistoricalYearOverYearYtdReviewBoard(ledger, '2025-YTD-Q1', '2026-YTD-Q1');
assert.equal(board.schemaVersion, 'csv-history-year-over-year-ytd-review-board-v1');
assert.equal(board.ledgerFingerprint, ledger.ledgerFingerprint);
assert.equal(board.operatorState, 'comparable_review_only');
assert.equal(board.comparisonAllowed, true);
assert.equal(board.interpretationAllowed, true);
assert.equal(board.rawEvidenceOnly, false);
assert.equal(board.boardPurpose, 'read_only_projection_of_explicit_yoy_ytd_comparison');
assert.equal(board.selectionPolicy, 'operator_selected_forward_adjacent_years_same_ytd_quarter_no_auto_reorder');
assert.equal(board.deltaBasis, 'ytd_period_b_minus_ytd_period_a');
assert.equal(board.selection.periodAKey, '2025-YTD-Q1');
assert.equal(board.selection.periodBKey, '2026-YTD-Q1');
assert.equal(board.selection.selectionAutoReordered, false);
assert.deepEqual(board.gate.reasons, []);
assert.equal(board.gate.forwardAdjacentYearsRequired, true);
assert.equal(board.gate.sameThroughQuarterRequired, true);
assert.equal(board.gate.blockedComparisonCannotBeUpgraded, true);
assert.equal(board.evidence.periodA.sourceQuarterCount, 1);
assert.equal(board.evidence.periodB.sourceQuarterCount, 1);
assert.equal(board.evidence.periodA.sourceContentSha256Count, 3);
assert.equal(board.evidence.periodB.sourceContentSha256Count, 3);
assert.equal(board.evidence.rawEvidenceRetained, true);
assert.equal(board.metrics.length, 6);
for (const metric of board.metrics) {
  assert.equal(metric.interpretationAllowed, true);
  assert.equal(metric.outcomeQualityClassification, 'not_assigned');
  assert.equal(metric.recommendationGenerated, false);
}
assert.equal(metric(board, 'spendMicros').periodAValue, 12_000_000);
assert.equal(metric(board, 'spendMicros').periodBValue, 15_000_000);
assert.equal(metric(board, 'spendMicros').delta, 3_000_000);
assert.equal(metric(board, 'spendMicros').movementDirection, 'increase');
assert.equal(metric(board, 'salesMicros').delta, 6_000_000);
assert.equal(metric(board, 'orders').delta, 3);
assert.equal(metric(board, 'adContributionMicros').delta, 3_000_000);
assert.equal(board.recommendationGenerated, false);
assert.equal(board.actionGenerated, false);
assert.equal(board.outcomeQualityClassificationApplied, false);
assert.equal(board.crossYearAggregationApplied, false);
assert.equal(board.crossYearNormalizationApplied, false);
assert.equal(board.ytdPeriodReaggregationApplied, false);
assert.equal(board.sameMonthAggregationApplied, false);
assert.equal(board.businessRowDeduplicationApplied, false);
assert.equal(board.overlapCollapseApplied, false);
assert.equal(board.gapRepairApplied, false);
assert.equal(board.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assertAuthorityFalse(board.authority);
assertAuthorityFalse(board.evidence.periodA.authority);
assertAuthorityFalse(board.evidence.periodB.authority);
assert.equal(Object.isFrozen(board), true);

const reversed = await boardMod.buildHistoricalYearOverYearYtdReviewBoard(ledger, '2026-YTD-Q1', '2025-YTD-Q1');
assert.equal(reversed.operatorState, 'blocked_raw_evidence_only');
assert.equal(reversed.comparisonAllowed, false);
assert.equal(reversed.interpretationAllowed, false);
assert.equal(reversed.rawEvidenceOnly, true);
assert.equal(reversed.selection.periodAKey, '2026-YTD-Q1');
assert.equal(reversed.selection.periodBKey, '2025-YTD-Q1');
assert.equal(reversed.selection.selectionAutoReordered, false);
assert.ok(reversed.gate.reasons.includes('years_not_forward_adjacent'));
assert.equal(reversed.evidence.rawEvidenceRetained, true);
for (const item of reversed.metrics) {
  assert.equal(item.delta, null);
  assert.equal(item.movementDirection, 'withheld_not_comparable');
  assert.equal(item.interpretationAllowed, false);
  assert.equal(item.outcomeQualityClassification, 'not_assigned');
  assert.equal(item.recommendationGenerated, false);
}
assert.equal(reversed.recommendationGenerated, false);
assert.equal(reversed.actionGenerated, false);
assertAuthorityFalse(reversed.authority);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-year-over-year-ytd-review-board-v1',
  canonicalYoYYtdComparisonReused: true,
  explicitPeriodSelectionOnly: true,
  allowedMovementProjection: true,
  blockedDeltasWithheld: true,
  blockedSelectionNotReordered: true,
  outcomeQualityClassificationApplied: false,
  recommendationGenerated: false,
  actionGenerated: false,
  rawEvidenceRetained: true,
  crossYearAggregationApplied: false,
  crossYearNormalizationApplied: false,
  ytdPeriodReaggregationApplied: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function metric(board, key) { const found = board.metrics.find((item) => item.key === key); assert.ok(found); return found; }
function assertAuthorityFalse(authority) {
  assert.equal(authority.authoritative, false);
  assert.equal(authority.canonicalAmazonIdentityResolved, false);
  assert.equal(authority.governancePersistenceAllowed, false);
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.amazonMutationAuthorized, false);
}
async function completeQuarter({ year, quarter, seed, metrics }) {
  const startMonth = (quarter - 1) * 3 + 1;
  const out = [];
  for (let index = 0; index < 3; index += 1) {
    const monthNumber = startMonth + index;
    const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
    const expectedDayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    out.push(await fixture({ seed: `${seed}-${index}`, month, startDate: `${month}-01`, endDate: `${month}-${String(expectedDayCount).padStart(2, '0')}`, expectedDayCount, metrics }));
  }
  return out;
}
async function ledgerFrom(...analyses) {
  let ledger = await engine.createCsvHistoryLedger(analyses[0]);
  for (const analysis of analyses.slice(1)) ledger = await engine.mergeCsvHistoryLedger(ledger, analysis);
  return ledger;
}
async function fixture({ seed, month, startDate, endDate, expectedDayCount, metrics }) {
  const contentSha256 = await sha256Hex(`${month}:${seed}:US:USD`);
  const sourceReceipt = { schemaVersion: 'csv-import-v1', reportType: 'spSearchTerm', sourceFileName: `${month}-${seed}.csv`, contentSha256, reportStartDate: startDate, reportEndDate: endDate, rowCount: 10, acceptedRows: 10, rejectedRows: 0, advertiserAccountId: null, profileId: null, marketplace: 'US', currencyCode: 'USD' };
  const inputSetFingerprint = await sha256Hex(canonicalJson([{ schemaVersion: sourceReceipt.schemaVersion, reportType: sourceReceipt.reportType, contentSha256, reportStartDate: startDate, reportEndDate: endDate, rowCount: 10 }]));
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: { kind: 'csv_import_set', batchCount: 1, contentSha256s: [contentSha256], inputSetFingerprint, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false },
    range: { startDate, endDate }, imports: [sourceReceipt],
    dataQuality: { authority, qualityState: 'single_window', safeForNaiveAggregation: true, contiguousCoverage: true, summary: { overlapPairCount: 0, gapCount: 0 } },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount: 0, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: { authority, summary: { monthlySnapshotCount: 1, aggregationSafe: true, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false }, monthlySnapshots: [{ periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount: expectedDayCount, factCount: 10, metrics, adContributionMicros: metrics.salesMicros - metrics.spendMicros, profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit', coverage: { expectedDayCount, coveredDayCount: expectedDayCount, coverageRatio: 1, complete: true }, reliability: { state: 'complete_coverage', aggregationSafe: true, coverageComplete: true, analyticalDecisionUse: 'observed_review_only' }, requiresHumanReview: true, persistenceAuthorized: false, executionAuthorized: false, amazonMutationAuthorized: false }] },
    analysis: { authority },
  };
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
