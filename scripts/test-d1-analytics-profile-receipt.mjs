import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const receipt = JSON.parse(await readFile(new URL('../docs/performance/d1-analytics-profile-2026-08-19.json', import.meta.url), 'utf8'));

assert.equal(receipt.schema, 'd1-analytics-profile-v1');
assert.equal(receipt.isolatedBenchmark.rows, 105036);
assert.equal(receipt.isolatedBenchmark.cleanupVerified, true);
assert.equal(receipt.safety.productionTouched, false);
assert.equal(receipt.safety.amazonExecutionTouched, false);
assert.equal(receipt.safety.temporaryBenchmarkRemoved, true);

const narrow = receipt.measurements.sevenDaySearchTermGrouping;
assert.ok(narrow.forcedReportDateIndex.rowsRead < narrow.withoutIndex.rowsRead);
assert.ok(narrow.forcedReportDateIndex.sqlDurationMs <= narrow.withoutIndex.sqlDurationMs);

const fullMonth = receipt.measurements.fullMonthTotals;
assert.equal(fullMonth.reportDateIndexAfterAnalyze.rowsRead, fullMonth.withoutIndex.rowsRead);
assert.ok(fullMonth.reportDateIndexAfterAnalyze.sqlDurationMs > fullMonth.withoutIndex.sqlDurationMs);

const globalDate = receipt.candidateDecisions.find((item) => item.candidate === 'global_report_date_index');
assert.equal(globalDate?.decision, 'rejected');
assert.equal(receipt.shipDecision, 'no_schema_change');
assert.equal(receipt.dod.globalCandidateMeetsDod, false);

console.log(JSON.stringify({
  ok: true,
  contract: 'd1-analytics-profile-receipt',
  narrowWindowCandidatePromising: true,
  unsafeGlobalIndexRejected: true,
  temporaryBenchmarkRemoved: true,
}));
