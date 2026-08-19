import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateCsvDiagnostics } from '../cloudflare/runtime/csv-analytics-diagnostics-api.js';

const [server, ui, entry] = await Promise.all([
  readFile(new URL('../cloudflare/runtime/csv-analytics-diagnostics-api.js', import.meta.url), 'utf8'),
  readFile(new URL('../assets/cloudflare-native-csv-local-diagnostics-v1.js', import.meta.url), 'utf8'),
  readFile(new URL('../cloudflare/runtime/web-entry.js', import.meta.url), 'utf8'),
]);

const searchTerms = Array.from({ length: 6557 }, (_, index) => ({
  searchTerm: `term-${index}`,
  impressions: 100 + index,
  clicks: 1 + (index % 40),
  spendMicros: 1_000_000 + index * 1000,
  orders: index % 7 === 0 ? 0 : 1 + (index % 4),
  salesMicros: index % 7 === 0 ? 0 : 5_000_000 + index * 2000,
}));
const bundle = generateCsvDiagnostics({
  searchTerms,
  campaigns: [
    { campaignName: 'A', campaignId: 'observed-a', impressions: 1000, clicks: 100, spendMicros: 80_000_000, orders: 10, salesMicros: 120_000_000 },
    { campaignName: 'B', campaignId: 'observed-b', impressions: 800, clicks: 80, spendMicros: 20_000_000, orders: 8, salesMicros: 50_000_000 },
  ],
  matchTypes: [
    { matchType: 'EXACT', clicks: 100, spendMicros: 20_000_000, orders: 20, salesMicros: 80_000_000 },
    { matchType: 'BROAD', clicks: 80, spendMicros: 40_000_000, orders: 5, salesMicros: 20_000_000 },
  ],
  daily: Array.from({ length: 8 }, (_, index) => ({
    reportDate: `2026-06-${String(index + 1).padStart(2, '0')}`,
    impressions: 1000,
    clicks: 100,
    spendMicros: index === 7 ? 20_000_000 : 10_000_000,
    orders: index === 7 ? 3 : 10,
    salesMicros: index === 7 ? 10_000_000 : 30_000_000,
  })),
});

assert.equal(bundle.kind, 'diagnostic_bundle');
assert.equal(bundle.computeLocation, 'worker_server_side');
assert.equal(bundle.coverage.totalGroups, 6557);
assert.equal(bundle.coverage.analyzedGroups, 6557);
assert.equal(bundle.coverage.coverageRatio, 1);
assert.equal(bundle.coverage.partial, false);
assert.equal(bundle.coverage.truncationReason, null);
assert.equal(bundle.coverage.searchTermComplete, true);
assert.equal(bundle.authoritative, false);
assert.equal(bundle.recommendationAuthorized, false);
assert.equal(bundle.reviewAuthorized, false);
assert.equal(bundle.amazonExecutionAuthorized, false);
assert.ok(bundle.observations.length <= 80);

const scaleBundle = generateCsvDiagnostics({
  searchTermAnalysis: {
    totalGroups: 100000,
    thresholds: { spendP90: 90, clicksP50: 50, clicksP75: 75, clicksP90: 90, acosP90: 0.9, roasP90: 5, cvrP25: 0.02, cvrP90: 0.2 },
    observations: [{
      kind: 'diagnostic', category: 'search-term', rule: 'high_acos', severity: 'medium', subject: 'ranked in D1', explanation: 'server-ranked',
      evidence: { impressions: 1, clicks: 1, spendMicros: 1, orders: 1, salesMicros: 1, acos: 1, roas: 1, cvr: 1 },
      authoritative: false, recommendationAuthorized: false, amazonExecutionAuthorized: false,
    }],
  },
});
assert.equal(scaleBundle.coverage.totalGroups, 100000, 'D1-ranked diagnostics must truthfully cover all grouped search terms');
assert.equal(scaleBundle.coverage.analyzedGroups, 100000);
assert.equal(scaleBundle.coverage.partial, false);
assert.equal(scaleBundle.searchTermComputeLocation, 'd1_ranked_server_side');
assert.equal(scaleBundle.observations.length, 1, 'Worker must receive ranked observations rather than 100k grouped rows');

for (const rule of [
  'high_spend_zero_orders', 'high_acos', 'high_roas', 'high_conversion', 'large_click_volume', 'low_conversion',
  'campaign_spend_concentration', 'campaign_sales_concentration', 'acos_outlier', 'traffic_without_conversion',
  'spend_leader', 'efficiency_leader', 'spend_spike', 'sales_drop', 'acos_deterioration', 'roas_improvement', 'conversion_shift',
]) assert.match(server, new RegExp(rule), `Missing server-side diagnostic rule: ${rule}`);

assert.match(server, /csv_business_search_term_daily/, 'Server diagnostics must read governed CSV business facts');
assert.match(server, /GROUP BY[\s\S]*f\.search_term/, 'Search-term aggregation must execute on D1');
assert.match(server, /GROUP BY f\.campaign_name/, 'Campaign aggregation must execute on D1');
assert.match(server, /GROUP BY f\.report_date/, 'Daily aggregation must execute on D1');
assert.match(server, /GROUP BY f\.match_type/, 'Match-type aggregation must execute on D1');
assert.match(server, /json_group_array\(json_object/, 'High-cardinality search diagnostics must be ranked and bounded inside D1');
assert.match(server, /SELECT COUNT\(\*\) FROM metrics/, 'Full grouped cardinality must be computed inside D1');
assert.doesNotMatch(server, /function readSearchTerms\s*\(/, 'Runtime must not materialize every search-term group in Worker memory');
assert.doesNotMatch(server, /\bLIMIT\s+5000\b/i, 'Server diagnostics must not cap search-term groups at 5000');
assert.doesNotMatch(server, /amazon-ads|AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|optimization-actions|execution-permits/i, 'Diagnostics server must remain isolated from Amazon/execution transports');
assert.doesNotMatch(server, /request\.method\s*===\s*['"](?:POST|PUT|PATCH|DELETE)/i, 'Diagnostics route must remain read-only');

assert.match(ui, /csvAnalytics\(scope\.storeId, 'diagnostics', common\)/, 'Browser diagnostics must request one server-side bundle');
assert.doesNotMatch(ui, /readAllSearchTerms\s*\(/, 'Browser must not download all search-term pages');
assert.match(ui, /full server-side coverage/i, 'Operator status must identify server-side full coverage');
assert.match(entry, /csv-analytics\\\/.*diagnostics|diagnostics\)\$\//, 'Web entry must admit diagnostics route');
assert.match(entry, /handleCsvAnalyticsDiagnosticsApiRoute/, 'Web entry must dispatch diagnostics handler');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-server-side-diagnostics-v2',
  juneGroupsCovered: 6557,
  scaleGroupsCovered: 100000,
  d1RankedSearchDiagnostics: true,
  browserPaginationCapRemovedFromRuntime: true,
  workerSearchTermMaterializationRemoved: true,
  authoritative: false,
  recommendationAuthorized: false,
  reviewAuthorized: false,
  amazonExecutionAuthorized: false,
}, null, 2));
