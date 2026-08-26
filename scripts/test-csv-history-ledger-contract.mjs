import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const engineRelative = 'assets/csv-analysis-engine/csv-history-ledger.js';
const uiPublicRelative = 'assets/cloudflare-native-csv-history-ledger-v1.js';
const uiRelative = 'assets/cloudflare-native-csv-history-ledger-impl-v1.js';
const engineSource = await readFile(path.join(distRoot, engineRelative), 'utf8');
const uiPublicSource = await readFile(path.join(distRoot, uiPublicRelative), 'utf8');
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const monthlyTag = '<script type="module" src="assets/cloudflare-native-csv-monthly-workspace-v1.js?v=1.0.0"></script>';
const historyTag = '<script type="module" src="assets/cloudflare-native-csv-history-ledger-v1.js?v=1.4.0"></script>';
const provenanceTag = '<script type="module" src="assets/cloudflare-native-csv-provenance-audit-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(historyTag).length - 1, 1, 'History ledger UI must be injected exactly once');
assert.ok(indexSource.indexOf(monthlyTag) < indexSource.indexOf(historyTag), 'History ledger must load after monthly workspace');
assert.ok(indexSource.indexOf(historyTag) < indexSource.indexOf(provenanceTag), 'History ledger must load before provenance audit');
assert.match(uiPublicSource, /export \* from '\.\/cloudflare-native-csv-history-ledger-impl-v1\.js';/, 'History ledger public path must remain a thin canonical implementation wrapper');
assert.match(uiSource, /Historical Local-Data Ledger/);
assert.match(uiSource, /Explicit local-file ownership/);
assert.match(uiSource, /Overlap or gaps are recorded, never silently normalized/);
assert.match(uiSource, /Download updated ledger/);
assert.match(uiSource, /Historical Monthly Workspace/);
assert.match(uiSource, /Same-month evidence from multiple snapshots is displayed separately, never cross-snapshot aggregated/);
assert.match(uiSource, /Ad Contribution = Sales - Ad Spend only; it is not Net Profit/);
assert.match(uiSource, /Historical Trend Evidence/);
assert.match(uiSource, /Partial, blocked, duplicate-month, and missing-value evidence is never hidden or merged/);
assert.match(uiSource, /Trend normalization: none\. Cross-snapshot aggregation: none/);
assert.match(uiSource, /Selected Historical Evidence/);
assert.match(uiSource, /ledger fingerprint \+ input-set fingerprint \+ month/i);
assert.match(uiSource, /navigation into immutable evidence/i);
assert.match(uiSource, /data-cfhl-evidence-nav/);
assert.match(uiSource, /crossSnapshotAggregationApplied: false/);
assert.match(uiSource, /partialPeriodsHidden: false/);
assert.match(uiSource, /missingValuesHidden: false/);
assert.match(engineSource, /CSV_HISTORY_DUPLICATE_INPUT_SET_FINGERPRINT/);
assert.match(engineSource, /CSV_HISTORY_DUPLICATE_CONTENT_HASH/);
assert.match(engineSource, /CSV_HISTORY_SOURCE_RECEIPT_MISMATCH/);
assert.match(engineSource, /CSV_HISTORY_BATCH_COUNT_MISMATCH/);
assert.match(engineSource, /CSV_HISTORY_AUTHORITY_ESCALATION_BLOCKED/);
assert.match(engineSource, /CSV_HISTORY_SOURCE_KIND_INVALID/);
assert.match(engineSource, /normalizationApplied: false/);
assert.match(engineSource, /businessRowDeduplicationApplied: false/);

for (const pattern of [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /CloudflareNativeAPI/,
  /\/api\/v1\//,
  /CONTROL_DB/,
  /STORE_01_DB/,
  /DATA_BUCKET/,
  /AMAZON_ADS_ENABLED/,
  /optimization-actions/,
  /execution-permits/,
]) {
  assert.equal(pattern.test(`${engineSource}\n${uiPublicSource}\n${uiSource}`), false, `History ledger must remain transport/storage/execution free: ${pattern}`);
}

const mod = await import(`${pathToFileURL(path.join(distRoot, engineRelative)).href}?contract=${Date.now()}`);
const uiMod = await import(`${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`);
assert.equal(mod.CSV_HISTORY_LEDGER_SCHEMA_VERSION, 'csv-history-ledger-v1');
assert.equal(mod.CSV_HISTORY_SNAPSHOT_SCHEMA_VERSION, 'csv-history-snapshot-v1');
assert.equal(uiMod.CSV_HISTORY_LEDGER_UI_VERSION, '1.4.0');
assert.equal(uiMod.CSV_HISTORY_MONTHLY_WORKSPACE_SCHEMA_VERSION, 'csv-history-monthly-workspace-v1');
assert.equal(uiMod.CSV_HISTORY_TREND_SCHEMA_VERSION, 'csv-history-trend-v1');
assert.equal(uiMod.CSV_HISTORY_EVIDENCE_DRILLDOWN_SCHEMA_VERSION, 'csv-history-evidence-drilldown-v1');
assert.equal(typeof uiMod.buildHistoricalMonthlyWorkspace, 'function');
assert.equal(typeof uiMod.buildHistoricalTrend, 'function');
assert.equal(typeof uiMod.buildHistoricalEvidenceDrilldown, 'function');
assert.deepEqual(uiMod.CSV_HISTORY_TREND_METRICS.map((item) => item.key), [
  'spendMicros', 'salesMicros', 'orders', 'acos', 'roas', 'adContributionMicros',
]);

const august = await fixture({ hashChar: 'b', startDate: '2026-08-01', endDate: '2026-08-14', month: '2026-08' });
const september = await fixture({ hashChar: 'c', startDate: '2026-09-01', endDate: '2026-09-30', month: '2026-09' });
const snapshot = await mod.buildCsvHistorySnapshot(august);
assert.equal(snapshot.sourceKind, 'csv_import_set');
assert.equal(snapshot.createdFromLocalEvidenceOnly, true);
assert.equal(snapshot.safeForNaiveAggregation, true);
assert.equal(snapshot.contiguousCoverage, true);
assert.equal(snapshot.authority.authoritative, false);
assert.equal(snapshot.authority.canonicalAmazonIdentityResolved, false);
assert.equal(snapshot.authority.governancePersistenceAllowed, false);
assert.equal(snapshot.authority.executionAuthorized, false);
assert.equal(snapshot.authority.amazonMutationAuthorized, false);
assert.equal(snapshot.monthlySnapshots[0].profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(snapshot.monthlySnapshots[0].adContributionMicros, 6000000);

const one = await mod.createCsvHistoryLedger(august);
assert.equal(one.snapshots.length, 1);
assert.match(one.ledgerFingerprint, /^[a-f0-9]{64}$/);
assert.equal(one.historyWindowEvidence.normalizationApplied, false);
assert.equal(one.historyWindowEvidence.businessRowDeduplicationApplied, false);
const oneSerialized = mod.serializeCsvHistoryLedger(one);
assert.equal(mod.serializeCsvHistoryLedger(one), oneSerialized, 'Ledger serialization must be deterministic');
assert.deepEqual(await mod.parseCsvHistoryLedger(oneSerialized), one, 'Serialized ledger must round-trip through full validation');

const two = await mod.mergeCsvHistoryLedger(one, september);
assert.equal(two.snapshots.length, 2);
assert.deepEqual(two.snapshots.map((item) => item.reportStartDate), ['2026-08-01', '2026-09-01']);
assert.equal(two.historyWindowEvidence.overlapPairCount, 0);
assert.equal(two.historyWindowEvidence.gapCount, 1, 'Historical gap must be preserved as evidence');
assert.notEqual(two.ledgerFingerprint, one.ledgerFingerprint);

const monthlyWorkspace = uiMod.buildHistoricalMonthlyWorkspace(two);
assert.equal(monthlyWorkspace.schemaVersion, 'csv-history-monthly-workspace-v1');
assert.equal(monthlyWorkspace.rowCount, 2);
assert.equal(monthlyWorkspace.distinctMonthCount, 2);
assert.equal(monthlyWorkspace.multiEvidenceMonthCount, 0);
assert.equal(monthlyWorkspace.crossSnapshotAggregationApplied, false);
assert.equal(monthlyWorkspace.normalizationApplied, false);
assert.equal(monthlyWorkspace.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.deepEqual(monthlyWorkspace.rows.map((item) => item.month), ['2026-08', '2026-09']);
assert.deepEqual(monthlyWorkspace.rows.map((item) => item.sourceInputSetFingerprint), two.snapshots.map((item) => item.inputSetFingerprint));
assert.ok(monthlyWorkspace.rows.every((item) => item.adContributionMicros === item.salesMicros - item.spendMicros));
assert.ok(monthlyWorkspace.rows.every((item) => item.profitabilityBasis === 'sales_minus_ad_spend_only_not_net_profit'));
assert.ok(monthlyWorkspace.rows.every((item) => item.decisionState === 'partial_coverage_review'));
assert.equal(monthlyWorkspace.authority.authoritative, false);
assert.equal(monthlyWorkspace.authority.canonicalAmazonIdentityResolved, false);
assert.equal(monthlyWorkspace.authority.governancePersistenceAllowed, false);
assert.equal(monthlyWorkspace.authority.executionAuthorized, false);
assert.equal(monthlyWorkspace.authority.amazonMutationAuthorized, false);

const expectedTrendValues = new Map([
  ['spendMicros', [4000000, 4000000]],
  ['salesMicros', [10000000, 10000000]],
  ['orders', [3, 3]],
  ['acos', [0.4, 0.4]],
  ['roas', [2.5, 2.5]],
  ['adContributionMicros', [6000000, 6000000]],
]);
for (const [metricKey, expectedValues] of expectedTrendValues) {
  const trend = uiMod.buildHistoricalTrend(two, metricKey);
  assert.equal(trend.schemaVersion, 'csv-history-trend-v1');
  assert.equal(trend.metricKey, metricKey);
  assert.equal(trend.pointCount, 2);
  assert.equal(trend.missingValueCount, 0);
  assert.equal(trend.partialCoveragePointCount, 2, 'Partial historical periods must remain visible in trend evidence');
  assert.equal(trend.blockedPointCount, 0);
  assert.equal(trend.crossSnapshotAggregationApplied, false);
  assert.equal(trend.normalizationApplied, false);
  assert.equal(trend.partialPeriodsHidden, false);
  assert.equal(trend.missingValuesHidden, false);
  assert.equal(trend.coverageBound, true);
  assert.equal(trend.qualityStateBound, true);
  assert.equal(trend.sourceFingerprintBound, true);
  assert.deepEqual(trend.points.map((point) => point.value), expectedValues);
  assert.deepEqual(trend.points.map((point) => point.month), ['2026-08', '2026-09']);
  assert.deepEqual(trend.points.map((point) => point.sourceInputSetFingerprint), two.snapshots.map((item) => item.inputSetFingerprint));
  assert.ok(trend.points.every((point) => point.coverageComplete === false));
  assert.ok(trend.points.every((point) => point.decisionState === 'partial_coverage_review'));
  assert.ok(trend.points.every((point) => point.crossSnapshotAggregationApplied === false));
  assert.equal(trend.authority.authoritative, false);
  assert.equal(trend.authority.canonicalAmazonIdentityResolved, false);
  assert.equal(trend.authority.governancePersistenceAllowed, false);
  assert.equal(trend.authority.executionAuthorized, false);
  assert.equal(trend.authority.amazonMutationAuthorized, false);
  if (metricKey === 'adContributionMicros') assert.equal(trend.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
  else assert.equal(trend.profitabilityBasis, null);
}
assert.throws(
  () => uiMod.buildHistoricalTrend(two, 'netProfit'),
  (error) => error?.code === 'CSV_HISTORY_TREND_METRIC_UNSUPPORTED',
  'Net Profit is not a supported historical trend metric',
);

const firstMonthlyRow = monthlyWorkspace.rows[0];
const monthlyEvidence = await uiMod.buildHistoricalEvidenceDrilldown(two, {
  ledgerFingerprint: firstMonthlyRow.ledgerFingerprint,
  sourceInputSetFingerprint: firstMonthlyRow.sourceInputSetFingerprint,
  month: firstMonthlyRow.month,
});
assert.equal(monthlyEvidence.schemaVersion, 'csv-history-evidence-drilldown-v1');
assert.equal(monthlyEvidence.navigationOnly, true);
assert.equal(monthlyEvidence.analyticalAuthorityCreated, false);
assert.deepEqual(monthlyEvidence.evidenceKey, {
  ledgerFingerprint: two.ledgerFingerprint,
  sourceInputSetFingerprint: firstMonthlyRow.sourceInputSetFingerprint,
  month: '2026-08',
});
assert.equal(monthlyEvidence.selectedMonth, '2026-08');
assert.equal(monthlyEvidence.metric.key, 'adContributionMicros');
assert.equal(monthlyEvidence.metric.value, 6000000);
assert.equal(monthlyEvidence.coverage.coverageComplete, false);
assert.equal(monthlyEvidence.decision.qualityState, 'single_window');
assert.equal(monthlyEvidence.decision.decisionState, 'partial_coverage_review');
assert.equal(monthlyEvidence.decision.safeForNaiveAggregation, true);
assert.equal(monthlyEvidence.decision.contiguousCoverage, true);
assert.equal(monthlyEvidence.source.inputSetFingerprint, firstMonthlyRow.sourceInputSetFingerprint);
assert.deepEqual(monthlyEvidence.source.contentSha256s, ['b'.repeat(64)]);
assert.deepEqual(monthlyEvidence.source.sourceFileNames, ['2026-08.csv']);
assert.equal(monthlyEvidence.source.sourceReceiptCount, 1);
assert.equal(monthlyEvidence.source.rowCount, 10);
assert.equal(monthlyEvidence.source.acceptedRows, 10);
assert.equal(monthlyEvidence.source.rejectedRows, 0);
assert.equal(monthlyEvidence.source.sourceReceipts[0].contentSha256, 'b'.repeat(64));
assert.equal(monthlyEvidence.observedIdentity.summary.identityCount, 3);
assert.equal(monthlyEvidence.observedIdentity.summary.ambiguousIdentityCount, 0);
assert.equal(monthlyEvidence.observedIdentity.canonicalAmazonIdentityResolved, false);
assert.equal(monthlyEvidence.hierarchy.summary.campaignCount, 1);
assert.equal(monthlyEvidence.hierarchy.summary.adGroupCount, 1);
assert.equal(monthlyEvidence.hierarchy.summary.targetingCount, 2);
assert.equal(monthlyEvidence.period.monthlySnapshot.month, '2026-08');
assert.equal(monthlyEvidence.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(monthlyEvidence.crossSnapshotAggregationApplied, false);
assert.equal(monthlyEvidence.normalizationApplied, false);
assert.equal(monthlyEvidence.authority.authoritative, false);
assert.equal(monthlyEvidence.authority.canonicalAmazonIdentityResolved, false);
assert.equal(monthlyEvidence.authority.governancePersistenceAllowed, false);
assert.equal(monthlyEvidence.authority.executionAuthorized, false);
assert.equal(monthlyEvidence.authority.amazonMutationAuthorized, false);
assert.equal(Object.isFrozen(monthlyEvidence), true);

const salesTrend = uiMod.buildHistoricalTrend(two, 'salesMicros');
const firstTrendPoint = salesTrend.points[0];
const trendEvidence = await uiMod.buildHistoricalEvidenceDrilldown(two, {
  ledgerFingerprint: firstTrendPoint.ledgerFingerprint,
  sourceInputSetFingerprint: firstTrendPoint.sourceInputSetFingerprint,
  month: firstTrendPoint.month,
  metricKey: firstTrendPoint.metricKey,
});
assert.deepEqual(trendEvidence.evidenceKey, monthlyEvidence.evidenceKey, 'Monthly row and trend point must resolve the same deterministic evidence key');
assert.equal(trendEvidence.metric.key, 'salesMicros');
assert.equal(trendEvidence.metric.value, 10000000);
assert.equal(trendEvidence.period.monthlySnapshot.month, monthlyEvidence.period.monthlySnapshot.month);
assert.equal(trendEvidence.source.sourceReceipts[0].contentSha256, monthlyEvidence.source.sourceReceipts[0].contentSha256);

const overlapping = await fixture({ hashChar: 'd', startDate: '2026-08-10', endDate: '2026-08-20', month: '2026-08' });
const withOverlap = await mod.mergeCsvHistoryLedger(one, overlapping);
assert.equal(withOverlap.historyWindowEvidence.overlapPairCount, 1);
assert.equal(withOverlap.historyWindowEvidence.overlapDetected, true);
assert.equal(withOverlap.historyWindowEvidence.normalizationApplied, false);
assert.equal(withOverlap.snapshots.length, 2, 'Overlapping snapshots must remain separate evidence records');
const sameMonthWorkspace = uiMod.buildHistoricalMonthlyWorkspace(withOverlap);
assert.equal(sameMonthWorkspace.rowCount, 2);
assert.equal(sameMonthWorkspace.distinctMonthCount, 1);
assert.equal(sameMonthWorkspace.multiEvidenceMonthCount, 1);
assert.equal(sameMonthWorkspace.crossSnapshotAggregationApplied, false);
assert.ok(sameMonthWorkspace.rows.every((item) => item.sameMonthEvidenceCount === 2));
assert.ok(sameMonthWorkspace.rows.every((item) => item.sameMonthMultipleSnapshots === true));
assert.ok(sameMonthWorkspace.rows.every((item) => item.crossSnapshotAggregationApplied === false));
assert.notEqual(sameMonthWorkspace.rows[0].sourceInputSetFingerprint, sameMonthWorkspace.rows[1].sourceInputSetFingerprint);
const sameMonthTrend = uiMod.buildHistoricalTrend(withOverlap, 'salesMicros');
assert.equal(sameMonthTrend.pointCount, 2);
assert.equal(sameMonthTrend.multiEvidencePointCount, 2);
assert.deepEqual(sameMonthTrend.points.map((point) => point.month), ['2026-08', '2026-08']);
assert.ok(sameMonthTrend.points.every((point) => point.sameMonthEvidenceCount === 2));
assert.ok(sameMonthTrend.points.every((point) => point.sameMonthMultipleSnapshots === true));
assert.notEqual(sameMonthTrend.points[0].sourceInputSetFingerprint, sameMonthTrend.points[1].sourceInputSetFingerprint);
assert.equal(sameMonthTrend.crossSnapshotAggregationApplied, false);

const sameMonthEvidence = [];
for (const row of sameMonthWorkspace.rows) {
  sameMonthEvidence.push(await uiMod.buildHistoricalEvidenceDrilldown(withOverlap, {
    ledgerFingerprint: row.ledgerFingerprint,
    sourceInputSetFingerprint: row.sourceInputSetFingerprint,
    month: row.month,
    metricKey: 'salesMicros',
  }));
}
assert.equal(sameMonthEvidence.length, 2);
assert.notEqual(sameMonthEvidence[0].evidenceKey.sourceInputSetFingerprint, sameMonthEvidence[1].evidenceKey.sourceInputSetFingerprint);
assert.notEqual(sameMonthEvidence[0].source.contentSha256s[0], sameMonthEvidence[1].source.contentSha256s[0], 'Same-month snapshots must drill down to separate immutable source hashes');
assert.ok(sameMonthEvidence.every((item) => item.selectedMonth === '2026-08'));
assert.ok(sameMonthEvidence.every((item) => item.decision.sameMonthEvidenceCount === 2));

await assert.rejects(
  () => uiMod.buildHistoricalEvidenceDrilldown(two, {
    ledgerFingerprint: 'f'.repeat(64),
    sourceInputSetFingerprint: firstMonthlyRow.sourceInputSetFingerprint,
    month: '2026-08',
  }),
  (error) => error?.code === 'CSV_HISTORY_EVIDENCE_LEDGER_FINGERPRINT_UNKNOWN',
  'Unknown ledger fingerprints must fail closed',
);
await assert.rejects(
  () => uiMod.buildHistoricalEvidenceDrilldown(two, {
    ledgerFingerprint: two.ledgerFingerprint,
    sourceInputSetFingerprint: 'e'.repeat(64),
    month: '2026-08',
  }),
  (error) => error?.code === 'CSV_HISTORY_EVIDENCE_INPUT_SET_FINGERPRINT_UNKNOWN',
  'Unknown input-set fingerprints must fail closed',
);
await assert.rejects(
  () => uiMod.buildHistoricalEvidenceDrilldown(two, {
    ledgerFingerprint: two.ledgerFingerprint,
    sourceInputSetFingerprint: firstMonthlyRow.sourceInputSetFingerprint,
    month: '2026-10',
  }),
  (error) => error?.code === 'CSV_HISTORY_EVIDENCE_MONTH_NOT_IN_SNAPSHOT',
  'A month outside the selected snapshot must fail closed',
);
await assert.rejects(
  () => uiMod.buildHistoricalEvidenceDrilldown(two, {
    ledgerFingerprint: two.ledgerFingerprint,
    sourceInputSetFingerprint: firstMonthlyRow.sourceInputSetFingerprint,
    month: '2026-08',
    metricKey: 'netProfit',
  }),
  (error) => error?.code === 'CSV_HISTORY_EVIDENCE_METRIC_UNSUPPORTED',
  'Net Profit must not become a drilldown metric',
);

const duplicateMonthResult = structuredClone(august);
duplicateMonthResult.periods.monthlySnapshots.push(structuredClone(duplicateMonthResult.periods.monthlySnapshots[0]));
const duplicateMonthLedger = await mod.createCsvHistoryLedger(duplicateMonthResult);
await assert.rejects(
  () => uiMod.buildHistoricalEvidenceDrilldown(duplicateMonthLedger, {
    ledgerFingerprint: duplicateMonthLedger.ledgerFingerprint,
    sourceInputSetFingerprint: duplicateMonthLedger.snapshots[0].inputSetFingerprint,
    month: '2026-08',
  }),
  (error) => error?.code === 'CSV_HISTORY_EVIDENCE_SELECTION_AMBIGUOUS',
  'Duplicate month evidence inside one snapshot must fail closed as an ambiguous selection key',
);

const nonCsvResult = structuredClone(august);
nonCsvResult.imports[0].sourceFileName = '2026-08.json';
const nonCsvLedger = await mod.createCsvHistoryLedger(nonCsvResult);
await assert.rejects(
  () => uiMod.buildHistoricalEvidenceDrilldown(nonCsvLedger, {
    ledgerFingerprint: nonCsvLedger.ledgerFingerprint,
    sourceInputSetFingerprint: nonCsvLedger.snapshots[0].inputSetFingerprint,
    month: '2026-08',
  }),
  (error) => error?.code === 'CSV_HISTORY_EVIDENCE_SOURCE_FILE_INVALID',
  'Non-CSV source filenames must fail closed in evidence navigation',
);

const evidenceInvalidHash = JSON.parse(oneSerialized);
evidenceInvalidHash.snapshots[0].contentSha256s = ['x'.repeat(64)];
await assert.rejects(
  () => uiMod.buildHistoricalEvidenceDrilldown(evidenceInvalidHash, {
    ledgerFingerprint: one.ledgerFingerprint,
    sourceInputSetFingerprint: one.snapshots[0].inputSetFingerprint,
    month: '2026-08',
  }),
  'Invalid historical source hashes must fail closed before navigation',
);
const evidenceReceiptMismatch = JSON.parse(oneSerialized);
evidenceReceiptMismatch.snapshots[0].contentSha256s = ['e'.repeat(64)];
await assert.rejects(
  () => uiMod.buildHistoricalEvidenceDrilldown(evidenceReceiptMismatch, {
    ledgerFingerprint: one.ledgerFingerprint,
    sourceInputSetFingerprint: one.snapshots[0].inputSetFingerprint,
    month: '2026-08',
  }),
  (error) => error?.code === 'CSV_HISTORY_SOURCE_RECEIPT_MISMATCH',
  'Receipt/hash mismatch must fail closed before navigation',
);
const evidenceEscalation = JSON.parse(oneSerialized);
evidenceEscalation.authority.executionAuthorized = true;
await assert.rejects(
  () => uiMod.buildHistoricalEvidenceDrilldown(evidenceEscalation, {
    ledgerFingerprint: one.ledgerFingerprint,
    sourceInputSetFingerprint: one.snapshots[0].inputSetFingerprint,
    month: '2026-08',
  }),
  (error) => error?.code === 'CSV_HISTORY_AUTHORITY_ESCALATION_BLOCKED',
  'Authority escalation must fail closed before navigation',
);

const missingAcos = JSON.parse(oneSerialized);
missingAcos.snapshots[0].monthlySnapshots[0].metrics.acos = null;
const missingTrend = uiMod.buildHistoricalTrend(missingAcos, 'acos');
assert.equal(missingTrend.pointCount, 1);
assert.equal(missingTrend.missingValueCount, 1);
assert.equal(missingTrend.missingValuesHidden, false);
assert.equal(missingTrend.points[0].missingValue, true);
assert.equal(missingTrend.points[0].value, null);
assert.match(missingTrend.points[0].sourceInputSetFingerprint, /^[a-f0-9]{64}$/);

const blockedEvidence = JSON.parse(oneSerialized);
blockedEvidence.snapshots[0].safeForNaiveAggregation = false;
const blockedTrend = uiMod.buildHistoricalTrend(blockedEvidence, 'spendMicros');
assert.equal(blockedTrend.pointCount, 1);
assert.equal(blockedTrend.blockedPointCount, 1);
assert.equal(blockedTrend.partialPeriodsHidden, false);
assert.equal(blockedTrend.points[0].decisionState, 'blocked_overlap_or_invalid_window');

await assert.rejects(
  () => mod.mergeCsvHistoryLedger(one, august),
  (error) => error?.code === 'CSV_HISTORY_DUPLICATE_INPUT_SET_FINGERPRINT',
  'Duplicate input-set fingerprints must fail closed',
);

const duplicateHashDifferentWindow = await fixture({ hashChar: 'b', startDate: '2026-08-15', endDate: '2026-08-31', month: '2026-08' });
await assert.rejects(
  () => mod.mergeCsvHistoryLedger(one, duplicateHashDifferentWindow),
  (error) => error?.code === 'CSV_HISTORY_DUPLICATE_CONTENT_HASH',
  'Duplicate source SHA-256 across snapshots must fail closed',
);

await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, kind: 'amazon_api' } }),
  (error) => error?.code === 'CSV_HISTORY_SOURCE_KIND_INVALID',
);
await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, batchCount: 2 } }),
  (error) => error?.code === 'CSV_HISTORY_BATCH_COUNT_MISMATCH',
);
await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, contentSha256s: ['e'.repeat(64)] } }),
  (error) => error?.code === 'CSV_HISTORY_SOURCE_RECEIPT_MISMATCH',
);
await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, executionAuthorized: true } }),
  (error) => error?.code === 'CSV_HISTORY_AUTHORITY_ESCALATION_BLOCKED',
);
await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, inputSetFingerprint: 'x'.repeat(64) } }),
  (error) => error?.code === 'CSV_HISTORY_INPUT_SET_FINGERPRINT_INVALID',
);

const tampered = JSON.parse(oneSerialized);
tampered.ledgerFingerprint = 'f'.repeat(64);
await assert.rejects(
  () => mod.validateCsvHistoryLedger(tampered),
  (error) => error?.code === 'CSV_HISTORY_LEDGER_FINGERPRINT_MISMATCH',
  'Imported ledger fingerprint drift must fail closed',
);
const escalated = JSON.parse(oneSerialized);
escalated.authority.executionAuthorized = true;
await assert.rejects(
  () => mod.validateCsvHistoryLedger(escalated),
  (error) => error?.code === 'CSV_HISTORY_AUTHORITY_ESCALATION_BLOCKED',
  'Imported authority escalation must fail closed',
);

const contributionMismatch = JSON.parse(mod.serializeCsvHistoryLedger(one));
contributionMismatch.snapshots[0].monthlySnapshots[0].adContributionMicros += 1;
assert.throws(
  () => uiMod.buildHistoricalMonthlyWorkspace(contributionMismatch),
  (error) => error?.code === 'CSV_HISTORY_MONTHLY_CONTRIBUTION_MISMATCH',
  'Monthly workspace must reject Ad Contribution drift',
);
const monthlyEscalation = JSON.parse(mod.serializeCsvHistoryLedger(one));
monthlyEscalation.authority.executionAuthorized = true;
assert.throws(
  () => uiMod.buildHistoricalMonthlyWorkspace(monthlyEscalation),
  (error) => error?.code === 'CSV_HISTORY_MONTHLY_AUTHORITY_ESCALATION_BLOCKED',
  'Monthly workspace must reject authority escalation',
);
const invalidMonthlySource = JSON.parse(mod.serializeCsvHistoryLedger(one));
invalidMonthlySource.snapshots[0].inputSetFingerprint = 'x'.repeat(64);
assert.throws(
  () => uiMod.buildHistoricalMonthlyWorkspace(invalidMonthlySource),
  (error) => error?.code === 'CSV_HISTORY_MONTHLY_SOURCE_FINGERPRINT_INVALID',
  'Monthly workspace must keep every row bound to a valid input-set fingerprint',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-ledger-v1',
  deterministicLedgerFingerprint: true,
  explicitLocalFileOwnership: true,
  duplicateInputSetBlocked: true,
  duplicateSourceHashBlocked: true,
  sourceReceiptHashSetVerified: true,
  batchCountVerified: true,
  overlapPreservedAsEvidence: true,
  gapPreservedAsEvidence: true,
  historicalMonthlyWorkspace: true,
  sameMonthEvidenceSeparated: true,
  historicalTrendEvidence: true,
  historicalEvidenceDrilldown: true,
  evidenceNavigationOnly: true,
  deterministicEvidenceKey: ['ledgerFingerprint', 'sourceInputSetFingerprint', 'month'],
  sameMonthDrilldownSeparated: true,
  sourceReceiptDrilldownVerified: true,
  supportedTrendMetrics: uiMod.CSV_HISTORY_TREND_METRICS.map((item) => item.key),
  partialTrendPeriodsHidden: false,
  missingTrendValuesHidden: false,
  trendCoverageBound: true,
  trendQualityStateBound: true,
  trendSourceFingerprintBound: true,
  crossSnapshotAggregationApplied: false,
  adContributionBasisVerified: true,
  normalizationApplied: false,
  businessRowDeduplicationApplied: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

async function fixture({ hashChar, startDate, endDate, month }) {
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
    marketplace: 'US',
    currencyCode: 'USD',
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
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: {
      kind: 'csv_import_set',
      batchCount: 1,
      contentSha256s: [contentSha256],
      inputSetFingerprint,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
    range: { startDate, endDate },
    imports: [receipt],
    dataQuality: {
      authority,
      qualityState: 'single_window',
      safeForNaiveAggregation: true,
      contiguousCoverage: true,
      summary: { overlapPairCount: 0, gapCount: 0 },
    },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount: 0, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: {
      authority,
      summary: { monthlySnapshotCount: 1, aggregationSafe: true, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false },
      monthlySnapshots: [{
        periodRole: 'calendar_month', month, startDate, endDate,
        expectedDayCount: 31, coveredDayCount: 14, factCount: 10,
        metrics: { spendMicros: 4000000, salesMicros: 10000000, orders: 3, acos: 0.4, roas: 2.5 },
        adContributionMicros: 6000000,
        profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
        coverage: { expectedDayCount: 31, coveredDayCount: 14, coverageRatio: 0.4516, complete: false },
        reliability: { state: 'incomplete_coverage', aggregationSafe: true, coverageComplete: false, analyticalDecisionUse: 'review_with_partial_coverage' },
        requiresHumanReview: true,
        persistenceAuthorized: false,
        executionAuthorized: false,
        amazonMutationAuthorized: false,
      }],
    },
    analysis: { authority },
  };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
