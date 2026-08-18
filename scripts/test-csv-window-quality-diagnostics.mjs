import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSV_WINDOW_QUALITY_SCHEMA_VERSION,
  analyzeCsvWindowQuality,
} from '../cloudflare/runtime/csv-window-quality-analysis.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'csv-analysis-engine', 'csv-window-quality-analysis.js');
const sourcePath = path.join(repoRoot, 'cloudflare', 'runtime', 'csv-window-quality-analysis.js');
const [source, built] = await Promise.all([readFile(sourcePath, 'utf8'), readFile(builtPath, 'utf8')]);
assert.equal(built, source, 'Built window-quality module must be byte-identical to canonical runtime source');

const clean = analyzeCsvWindowQuality([
  window('a', 'one.csv', '2026-08-01', '2026-08-07'),
  window('b', 'two.csv', '2026-08-08', '2026-08-14'),
]);
assert.equal(clean.schemaVersion, CSV_WINDOW_QUALITY_SCHEMA_VERSION);
assert.equal(clean.qualityState, 'clean_contiguous');
assert.equal(clean.safeForNaiveAggregation, true);
assert.equal(clean.contiguousCoverage, true);
assert.equal(clean.requiresHumanReview, false);
assert.equal(clean.summary.overlapPairCount, 0);
assert.equal(clean.summary.exactDuplicateWindowCount, 0);
assert.equal(clean.summary.gapCount, 0);
assert.equal(clean.summary.reportedWindowDayCount, 14);
assert.equal(clean.summary.uniqueCoveredDayCount, 14);
assert.equal(clean.summary.overlapExcessDayCount, 0);
assert.equal(clean.summary.coverageSpanDayCount, 14);
assert.deepEqual(clean.mergedCoverage.map((item) => [item.startDate, item.endDate]), [['2026-08-01', '2026-08-14']]);

const overlap = analyzeCsvWindowQuality([
  window('c', 'left.csv', '2026-08-01', '2026-08-07'),
  window('d', 'right.csv', '2026-08-05', '2026-08-10'),
]);
assert.equal(overlap.qualityState, 'overlap_detected');
assert.equal(overlap.safeForNaiveAggregation, false);
assert.equal(overlap.contiguousCoverage, true);
assert.equal(overlap.requiresHumanReview, true);
assert.equal(overlap.summary.overlapPairCount, 1);
assert.equal(overlap.summary.exactDuplicateWindowCount, 0);
assert.equal(overlap.summary.reportedWindowDayCount, 13);
assert.equal(overlap.summary.uniqueCoveredDayCount, 10);
assert.equal(overlap.summary.overlapExcessDayCount, 3);
assert.equal(overlap.overlapPairs[0].relation, 'partial_overlap');
assert.equal(overlap.overlapPairs[0].overlapStartDate, '2026-08-05');
assert.equal(overlap.overlapPairs[0].overlapEndDate, '2026-08-07');
assert.equal(overlap.overlapPairs[0].overlapDayCount, 3);
assert.equal(overlap.overlapPairs[0].doubleCountRisk, true);

const duplicateWindow = analyzeCsvWindowQuality([
  window('e', 'same-window-a.csv', '2026-08-01', '2026-08-07'),
  window('f', 'same-window-b.csv', '2026-08-01', '2026-08-07'),
]);
assert.equal(duplicateWindow.qualityState, 'overlap_detected');
assert.equal(duplicateWindow.summary.overlapPairCount, 1);
assert.equal(duplicateWindow.summary.exactDuplicateWindowCount, 1);
assert.equal(duplicateWindow.summary.overlapExcessDayCount, 7);
assert.equal(duplicateWindow.overlapPairs[0].relation, 'exact_duplicate_window');
assert.notEqual(duplicateWindow.overlapPairs[0].left.contentSha256, duplicateWindow.overlapPairs[0].right.contentSha256, 'same date window can have different content hashes');

const contained = analyzeCsvWindowQuality([
  window('1', 'outer.csv', '2026-08-01', '2026-08-10'),
  window('2', 'inner.csv', '2026-08-03', '2026-08-05'),
]);
assert.equal(contained.overlapPairs[0].relation, 'right_contained_in_left');
assert.equal(contained.overlapPairs[0].overlapDayCount, 3);
assert.equal(contained.summary.overlapExcessDayCount, 3);

const gap = analyzeCsvWindowQuality([
  window('3', 'before.csv', '2026-08-01', '2026-08-03'),
  window('4', 'after.csv', '2026-08-05', '2026-08-07'),
]);
assert.equal(gap.qualityState, 'gap_detected');
assert.equal(gap.safeForNaiveAggregation, true);
assert.equal(gap.contiguousCoverage, false);
assert.equal(gap.requiresHumanReview, true);
assert.equal(gap.summary.gapCount, 1);
assert.equal(gap.summary.gapDayCount, 1);
assert.equal(gap.summary.reportedWindowDayCount, 6);
assert.equal(gap.summary.uniqueCoveredDayCount, 6);
assert.equal(gap.summary.coverageSpanDayCount, 7);
assert.deepEqual(gap.gaps[0], {
  gapStartDate: '2026-08-04',
  gapEndDate: '2026-08-04',
  gapDayCount: 1,
  previousCoverageEndDate: '2026-08-03',
  nextCoverageStartDate: '2026-08-05',
  requiresHumanReview: true,
});

const overlapAndGap = analyzeCsvWindowQuality([
  window('5', 'one.csv', '2026-08-01', '2026-08-04'),
  window('6', 'two.csv', '2026-08-03', '2026-08-05'),
  window('7', 'three.csv', '2026-08-08', '2026-08-09'),
]);
assert.equal(overlapAndGap.qualityState, 'overlap_and_gap_detected');
assert.equal(overlapAndGap.summary.overlapPairCount, 1);
assert.equal(overlapAndGap.summary.gapCount, 1);
assert.equal(overlapAndGap.summary.gapDayCount, 2);

const incomplete = analyzeCsvWindowQuality([
  window('8', 'valid.csv', '2026-08-01', '2026-08-01'),
  { ...window('9', 'missing.csv', '2026-08-02', '2026-08-02'), reportStartDate: null, reportEndDate: null },
]);
assert.equal(incomplete.qualityState, 'incomplete_date_evidence');
assert.equal(incomplete.safeForNaiveAggregation, false);
assert.equal(incomplete.summary.invalidWindowCount, 1);
assert.equal(incomplete.windows.find((item) => !item.validDateRange)?.issueCode, 'missing_date_range');

const reversed = analyzeCsvWindowQuality([
  window('d', 'right.csv', '2026-08-05', '2026-08-10'),
  window('c', 'left.csv', '2026-08-01', '2026-08-07'),
]);
assert.deepEqual(reversed, overlap, 'window-quality diagnostics must be input-order independent');

for (const result of [clean, overlap, duplicateWindow, contained, gap, overlapAndGap, incomplete]) {
  assert.equal(result.authority.authoritative, false);
  assert.equal(result.authority.governancePersistenceAllowed, false);
  assert.equal(result.authority.executionAuthorized, false);
  assert.equal(result.authority.amazonMutationAuthorized, false);
}

console.log(JSON.stringify({
  ok: true,
  contract: CSV_WINDOW_QUALITY_SCHEMA_VERSION,
  cleanContiguous: true,
  partialOverlapDetected: true,
  duplicateWindowDetected: true,
  containedWindowDetected: true,
  coverageGapDetected: true,
  overlapAndGapDetected: true,
  incompleteDateEvidenceDetected: true,
  inputOrderIndependent: true,
  persistenceAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function window(hashChar, sourceFileName, reportStartDate, reportEndDate) {
  return {
    schemaVersion: 'csv-import-v1',
    reportType: 'spSearchTerm',
    sourceFileName,
    contentSha256: String(hashChar).repeat(64),
    reportStartDate,
    reportEndDate,
    rowCount: 1,
  };
}
