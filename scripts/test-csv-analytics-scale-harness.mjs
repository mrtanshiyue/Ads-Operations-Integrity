import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { benchmarkSqlForScale, setupSql, summarizeMetrics } from './csv-analytics-scale-harness.mjs';

const setup = setupSql(100000);
assert.ok(setup.some((sql) => /100000/.test(sql)), 'setup must deterministically bound the generated fact volume');
assert.ok(setup.some((sql) => /CREATE INDEX idx_bench_date/.test(sql)), 'benchmark facts must retain date-index behavior');
assert.ok(setup.some((sql) => sql === 'DROP TABLE IF EXISTS __csv_analytics_benchmark_facts'), 'benchmark setup must remove any prior isolated table before creating facts');

const tenK = benchmarkSqlForScale(10000);
const hundredK = benchmarkSqlForScale(100000);
for (const name of ['overview','daily','campaign','ad-group','targeting','search-term','match-type','quality','diagnostics']) {
  assert.ok(Array.isArray(tenK[name]) && tenK[name].length > 0, `10k benchmark missing ${name}`);
  assert.ok(Array.isArray(hundredK[name]) && hundredK[name].length > 0, `100k benchmark missing ${name}`);
}
assert.equal(tenK.quality.length, 5, 'quality benchmark must expose its repeated-scan query count');
assert.equal(tenK.diagnostics.length, 4, 'optimized diagnostics must remain a bounded four-query server bundle');
assert.match(hundredK['search-term'][0], /COUNT\(\*\) OVER\(\)/, 'high-cardinality table benchmark must include page-independent totals');
assert.match(hundredK.diagnostics[0], /json_group_array\(json_object/, 'diagnostics benchmark must model D1-side bounded ranking');
assert.doesNotMatch(hundredK.diagnostics.join('\n'), /LIMIT\s+5000/i, 'scale harness must not recreate the former browser cap');

assert.deepEqual(summarizeMetrics([
  { rows_read: 10, sql_duration_ms: 1.25, response_size_bytes: 100 },
  { rows_read: 20, sql_duration_ms: 2.5, response_size_bytes: 200 },
]), { rows_read: 30, sql_duration_ms: 3.75, response_size_bytes: 300, query_count: 2 });

const source = await readFile(new URL('./csv-analytics-scale-harness.mjs', import.meta.url), 'utf8');
assert.match(source, /CSV_SCALE_D1_DATABASE_ID/, 'live harness must require an explicitly selected D1 database');
assert.match(source, /finally\s*\{[\s\S]*DROP TABLE IF EXISTS \$\{TABLE\}/, 'benchmark cleanup must drop the isolated table in finally');
assert.doesNotMatch(source, /AMAZON_ADS_ENABLED|amazon-ads|SP-API|sync\/|execution-permits/i, 'scale harness must remain independent of Amazon transport/execution');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-analytics-scale-harness-v1',
  scales: [10000, 100000],
  dimensions: Object.keys(tenK),
  qualityQueryCount: tenK.quality.length,
  diagnosticsQueryCount: tenK.diagnostics.length,
  isolatedDevTable: true,
  cleanupInFinally: true,
  amazonExecutionAuthorized: false,
}, null, 2));
