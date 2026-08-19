import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const dashboard = await readFile(new URL('../assets/cloudflare-native-csv-analytics-dashboard-v1.js', import.meta.url), 'utf8');
const drilldown = await readFile(new URL('../assets/cloudflare-native-csv-analytics-drilldown-v1.js', import.meta.url), 'utf8');
const apiClient = await readFile(new URL('../assets/cloudflare-native-api-v1.js', import.meta.url), 'utf8');

assert.match(apiClient, /csvAnalytics:\s*\(storeId, dimension, params\)/, 'Native API must expose the governed CSV analytics route');
assert.match(apiClient, /cloudflare-native-csv-analytics-dashboard-v1\.js/, 'CSV analytics dashboard must be self-loaded from the same-origin Native client');
assert.match(apiClient, /cloudflare-native-csv-analytics-drilldown-v1\.js/, 'Governed hierarchy drilldown must be self-loaded from the same-origin Native client');
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

console.log('csv analytics dashboard contract: PASS');
