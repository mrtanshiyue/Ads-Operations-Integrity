import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const dashboard = await readFile(new URL('../assets/cloudflare-native-csv-analytics-dashboard-v1.js', import.meta.url), 'utf8');
const drilldown = await readFile(new URL('../assets/cloudflare-native-csv-analytics-drilldown-v1.js', import.meta.url), 'utf8');
const diagnostics = await readFile(new URL('../assets/cloudflare-native-csv-local-diagnostics-v1.js', import.meta.url), 'utf8');
const apiClient = await readFile(new URL('../assets/cloudflare-native-api-v1.js', import.meta.url), 'utf8');

assert.match(apiClient, /csvAnalytics:\s*\(storeId, dimension, params\)/, 'Native API must expose the governed CSV analytics route');
assert.match(apiClient, /cloudflare-native-csv-analytics-dashboard-v1\.js/, 'CSV analytics dashboard must be self-loaded from the same-origin Native client');
assert.match(apiClient, /cloudflare-native-csv-analytics-drilldown-v1\.js/, 'Governed hierarchy drilldown must be self-loaded from the same-origin Native client');
assert.match(apiClient, /cloudflare-native-csv-local-diagnostics-v1\.js/, 'Local diagnostics must be self-loaded from the same-origin Native client');
assert.match(dashboard, /CSV · LOCAL DATA · READ ONLY/, 'Dashboard read-only source identity must be visible');
assert.match(dashboard, /Recommendation\/review remain blocked by provenance authority/, 'Legacy provenance gate must be visible');
assert.match(dashboard, /Observed IDs never imply canonical Amazon identity/, 'Observed CSV IDs must not be presented as canonical identity');
assert.match(dashboard, /Comparable period unavailable/, 'Missing comparison periods must not be rendered as fabricated zero deltas');
assert.match(dashboard, /cloudflare-operator-store-change/, 'Dashboard must follow the operator store context');
assert.match(dashboard, /startDate/, 'Dashboard must expose a date range');
assert.match(dashboard, /dimension/, 'Dashboard must expose dimension switching');
assert.match(dashboard, /pagination|totalPages/, 'Dashboard must expose pagination');
assert.match(dashboard, /Analytics data quality/, 'Dashboard must surface analytics quality');
assert.match(dashboard, /Reliability only · authority unchanged/, 'Quality must be explicitly limited to reliability');
assert.match(dashboard, /Quality does not change Amazon identity authority or recommendation eligibility/, 'Quality must not elevate authority');
assert.match(dashboard, /\['CPC'/, 'Dashboard must surface CPC');
assert.match(dashboard, /\['Units'/, 'Dashboard must surface units');
assert.match(dashboard, /\['Business facts'/, 'Dashboard must surface business fact count');
assert.doesNotMatch(dashboard, /\bfetch\s*\(/, 'Dashboard must delegate transport to CloudflareNativeAPI');
assert.doesNotMatch(dashboard, /startSync\s*\(|optimization-actions|execution-permits|method:\s*['"](?:POST|PUT|PATCH|DELETE)/i, 'Dashboard must remain read-only and isolated from execution/write controls');
assert.doesNotMatch(dashboard, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|amazon-ads-api/i, 'Dashboard must not touch Amazon transport switches');

assert.match(drilldown, /Campaign → Ad Group → Targeting → Search Term/, 'Governed hierarchy path must be visible');
assert.match(drilldown, /campaignId/, 'Campaign observed-ID filter must be propagated');
assert.match(drilldown, /adGroupId/, 'Ad-group observed-ID filter must be propagated');
assert.match(drilldown, /targetingId/, 'Targeting observed-ID filter must be propagated');
assert.match(drilldown, /matchType/, 'Match-type filter must be productized');
assert.match(drilldown, /Scoped total, page-independent/, 'Scoped totals must be explicitly page-independent');
assert.match(drilldown, /aria-disabled/, 'Rows without required observed IDs must fail closed for drill-down');
assert.match(drilldown, /observed · non-canonical/, 'Observed IDs must remain visibly non-canonical');
assert.match(drilldown, /never authorize Amazon mutation/, 'Hierarchy UI must explicitly remain non-executing');
assert.doesNotMatch(drilldown, /\bfetch\s*\(/, 'Drilldown must delegate transport to CloudflareNativeAPI');
assert.doesNotMatch(drilldown, /startSync\s*\(|optimization-actions|execution-permits|method:\s*['"](?:POST|PUT|PATCH|DELETE)/i, 'Drilldown must remain read-only and isolated from execution/write controls');
assert.doesNotMatch(drilldown, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|amazon-ads-api/i, 'Drilldown must not touch Amazon transport switches');

assert.match(diagnostics, /Local business diagnostics/, 'Local diagnostics panel must be visible');
assert.match(diagnostics, /diagnostic · non-authoritative/, 'Diagnostics must be visibly non-authoritative');
assert.match(diagnostics, /not approved optimization recommendations/, 'Diagnostics must remain distinct from recommendations');
for (const rule of [
  'high_spend_zero_orders',
  'high_acos',
  'high_roas',
  'high_conversion',
  'large_click_volume',
  'low_conversion',
  'campaign_spend_concentration',
  'campaign_sales_concentration',
  'acos_outlier',
  'traffic_without_conversion',
  'spend_leader',
  'efficiency_leader',
  'spend_spike',
  'sales_drop',
  'acos_deterioration',
  'roas_improvement',
  'conversion_shift',
]) assert.match(diagnostics, new RegExp(rule), `Missing local diagnostic rule: ${rule}`);
assert.match(diagnostics, /MAX_SEARCH_TERM_ROWS = 5000/, 'Diagnostics must declare bounded search-term coverage');
assert.match(diagnostics, /searchTermComplete/, 'Diagnostics must surface whether search-term coverage is complete');
assert.match(diagnostics, /authoritative:\s*false/, 'Diagnostics must not become authority');
assert.match(diagnostics, /recommendationAuthorized:\s*false/, 'Diagnostics must not become recommendations');
assert.match(diagnostics, /amazonExecutionAuthorized:\s*false/, 'Diagnostics must not authorize Amazon execution');
assert.doesNotMatch(diagnostics, /\bfetch\s*\(/, 'Diagnostics must delegate transport to CloudflareNativeAPI');
assert.doesNotMatch(diagnostics, /startSync\s*\(|optimization-actions|execution-permits|method:\s*['"](?:POST|PUT|PATCH|DELETE)/i, 'Diagnostics must remain read-only and isolated from execution/write controls');
assert.doesNotMatch(diagnostics, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|amazon-ads-api/i, 'Diagnostics must not touch Amazon transport switches');

const calls = [];
const window = {
  CloudflareNativeAPI: {
    csvAnalytics(storeId, dimension, params) {
      calls.push({ storeId, dimension, params: { ...params } });
      if (dimension === 'overview') {
        return Promise.resolve({
          metrics: {},
          governance: { analyticsEligible: true, recommendationEligible: false, provenanceClasses: ['legacy_batch_only'], factCount: 8753 },
          comparison: { available: false },
        });
      }
      if (dimension === 'quality') {
        return Promise.resolve({
          quality: {
            qualityScore: 98.1,
            issueCount: 2,
            issueOccurrences: 7,
            severity: 'medium',
            affectedFacts: 7,
            reliabilityOnly: true,
            changesIdentityAuthority: false,
            changesRecommendationAuthority: false,
            amazonExecutionAuthorized: false,
          },
          coverage: { observedDays: 30, expectedDays: 30, missingDays: 0, campaignIdPresentRate: 0.99, targetingIdPresentRate: 0.9 },
          issues: [],
        });
      }
      return Promise.resolve({ items: [], pagination: { page: params.page || 1, limit: params.limit || 25, totalItems: 0, totalPages: 0 } });
    },
  },
  addEventListener() {},
};
vm.runInNewContext(dashboard, { window, globalThis: window, console, Intl, Date, Promise, Object, Array, String, Number, Math, Set, Map }, { filename: 'cloudflare-native-csv-analytics-dashboard-v1.js' });
assert.equal(window.CloudflareCsvAnalyticsDashboard.version, '1.1.0');
const snapshot = await window.CloudflareCsvAnalyticsDashboard.loadSnapshot({
  storeId: 'store-dev-01',
  startDate: '2026-06-01',
  endDate: '2026-06-30',
  dimension: 'campaign',
  sort: 'salesMicros',
  direction: 'desc',
  page: 2,
  limit: 25,
  q: ' readers ',
});
assert.ok(snapshot.overview && snapshot.daily && snapshot.table && snapshot.quality);
assert.deepEqual(calls.map((call) => call.dimension), ['overview', 'daily', 'campaign', 'quality']);
assert.equal(calls[0].storeId, 'store-dev-01');
assert.equal(calls[0].params.startDate, '2026-06-01');
assert.equal(calls[1].params.limit, 366);
assert.equal(calls[1].params.sort, 'reportDate');
assert.equal(calls[2].params.page, 2);
assert.equal(calls[2].params.sort, 'salesMicros');
assert.equal(calls[2].params.q, 'readers');
assert.equal(calls[3].params.startDate, '2026-06-01');
assert.equal(calls[3].params.endDate, '2026-06-30');
assert.equal(snapshot.quality.quality.reliabilityOnly, true);
assert.equal(snapshot.quality.quality.changesIdentityAuthority, false);
assert.equal(snapshot.quality.quality.changesRecommendationAuthority, false);
assert.equal(snapshot.quality.quality.amazonExecutionAuthorized, false);

const drilldownWindow = { addEventListener() {} };
vm.runInNewContext(drilldown, {
  window: drilldownWindow,
  globalThis: drilldownWindow,
  console,
  Intl,
  Date,
  Promise,
  Object,
  Array,
  String,
  Number,
  Math,
  Set,
  Map,
}, { filename: 'cloudflare-native-csv-analytics-drilldown-v1.js' });
assert.equal(drilldownWindow.CloudflareCsvAnalyticsDrilldown.version, '1.0.0');
const filtered = drilldownWindow.CloudflareCsvAnalyticsDrilldown.buildRequestParams({
  startDate: '2026-06-01',
  endDate: '2026-06-30',
  campaignId: '108748301332024',
  adGroupId: '474054107145274',
  targetingId: '442451552344752',
  matchType: 'EXACT',
  marketplace: 'US',
  profileId: 'profile-observed',
  advertiserAccountId: 'amzn1.ads-account.g.example',
  q: 'reading glasses',
  sort: 'salesMicros',
  direction: 'desc',
  page: 3,
  limit: 50,
});
assert.deepEqual({ ...filtered }, {
  startDate: '2026-06-01',
  endDate: '2026-06-30',
  campaignId: '108748301332024',
  adGroupId: '474054107145274',
  targetingId: '442451552344752',
  matchType: 'EXACT',
  marketplace: 'US',
  profileId: 'profile-observed',
  advertiserAccountId: 'amzn1.ads-account.g.example',
  q: 'reading glasses',
  sort: 'salesMicros',
  direction: 'desc',
  page: 3,
  limit: 50,
});
assert.deepEqual({ ...drilldownWindow.CloudflareCsvAnalyticsDrilldown.activeFilters() }, { matchType: null });

const diagnosticsWindow = { addEventListener() {} };
vm.runInNewContext(diagnostics, {
  window: diagnosticsWindow,
  globalThis: diagnosticsWindow,
  console,
  Intl,
  Date,
  Promise,
  Object,
  Array,
  String,
  Number,
  Math,
  Set,
  Map,
}, { filename: 'cloudflare-native-csv-local-diagnostics-v1.js' });
assert.equal(diagnosticsWindow.CloudflareCsvLocalDiagnostics.version, '1.0.0');
const diagnosticBundle = diagnosticsWindow.CloudflareCsvLocalDiagnostics.generateDiagnostics({
  searchTerms: [
    { searchTerm: 'waste term', impressions: 1000, clicks: 40, spendMicros: 90000000, orders: 0, salesMicros: 0 },
    { searchTerm: 'efficient term', impressions: 700, clicks: 30, spendMicros: 10000000, orders: 12, salesMicros: 90000000 },
    { searchTerm: 'expensive term', impressions: 600, clicks: 25, spendMicros: 50000000, orders: 1, salesMicros: 10000000 },
    { searchTerm: 'low conversion', impressions: 800, clicks: 35, spendMicros: 30000000, orders: 0, salesMicros: 0 },
    { searchTerm: 'normal term', impressions: 500, clicks: 10, spendMicros: 8000000, orders: 2, salesMicros: 20000000 },
  ],
  campaigns: [
    { campaignName: 'Concentrated', campaignId: 'campaign-observed-1', impressions: 3000, clicks: 300, spendMicros: 80000000, orders: 10, salesMicros: 120000000 },
    { campaignName: 'Other A', campaignId: 'campaign-observed-2', impressions: 800, clicks: 80, spendMicros: 10000000, orders: 8, salesMicros: 40000000 },
    { campaignName: 'Other B', campaignId: 'campaign-observed-3', impressions: 600, clicks: 60, spendMicros: 10000000, orders: 6, salesMicros: 30000000 },
  ],
  matchTypes: [
    { matchType: 'PHRASE', clicks: 100, spendMicros: 20000000, orders: 20, salesMicros: 80000000 },
    { matchType: 'BROAD', clicks: 80, spendMicros: 40000000, orders: 5, salesMicros: 20000000 },
  ],
  daily: [
    ...Array.from({ length: 7 }, (_, index) => ({ reportDate: `2026-06-0${index + 1}`, impressions: 1000, clicks: 100, spendMicros: 10000000, orders: 10, salesMicros: 30000000 })),
    { reportDate: '2026-06-08', impressions: 1500, clicks: 150, spendMicros: 20000000, orders: 3, salesMicros: 10000000 },
  ],
  searchTermTotal: 5,
  searchTermComplete: true,
});
assert.equal(diagnosticBundle.kind, 'diagnostic_bundle');
assert.equal(diagnosticBundle.authoritative, false);
assert.equal(diagnosticBundle.recommendationAuthorized, false);
assert.equal(diagnosticBundle.reviewAuthorized, false);
assert.equal(diagnosticBundle.amazonExecutionAuthorized, false);
assert.equal(diagnosticBundle.coverage.searchTermComplete, true);
assert.ok(diagnosticBundle.observations.length > 0);
assert.ok(diagnosticBundle.observations.every((item) => item.kind === 'diagnostic' && item.authoritative === false && item.recommendationAuthorized === false && item.amazonExecutionAuthorized === false));
assert.ok(diagnosticBundle.observations.some((item) => item.rule === 'high_spend_zero_orders'));
assert.ok(diagnosticBundle.observations.some((item) => item.rule === 'campaign_spend_concentration'));
assert.ok(diagnosticBundle.observations.some((item) => item.rule === 'spend_leader'));
assert.ok(diagnosticBundle.observations.some((item) => item.rule === 'spend_spike'));
assert.ok(diagnosticBundle.observations.some((item) => item.rule === 'sales_drop'));
const campaignObservation = diagnosticBundle.observations.find((item) => item.category === 'campaign');
assert.equal(campaignObservation?.evidence?.identityResolved, false);

console.log('csv analytics dashboard contract: PASS');
