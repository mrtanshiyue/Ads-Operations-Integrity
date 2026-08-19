import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleCsvAnalyticsQualityApiRoute } from '../cloudflare/runtime/csv-analytics-quality-api.js';

const actor = { user_id: 'user-dev-owner' };
const executedSql = [];

function statement(sql, responder) {
  return {
    bind(...params) {
      executedSql.push(sql);
      return {
        first: async () => responder('first', params, sql),
        all: async () => responder('all', params, sql),
      };
    },
  };
}

const controlDb = {
  prepare(sql) {
    return statement(sql, async (_mode, params) => {
      if (sql.includes('FROM user_global_roles')) return null;
      if (sql.includes('FROM store_members')) return { ok: 1 };
      if (sql.includes('FROM stores')) {
        assert.equal(params[0], 'store-dev-01');
        return { store_id: 'store-dev-01', d1_binding_key: 'STORE_01_DB', status: 'active' };
      }
      throw new Error(`Unexpected CONTROL_DB SQL: ${sql}`);
    });
  },
};

const storeDb = {
  prepare(sql) {
    return statement(sql, async (mode) => {
      if (sql.includes('GROUP_CONCAT(DISTINCT f.currency_code)')) {
        return {
          fact_count: 100,
          import_count: 1,
          observed_start_date: '2026-06-01',
          observed_end_date: '2026-06-02',
          currency_codes: 'USD',
          marketplaces: 'US',
          invalid_date_count: 0,
        };
      }
      if (sql.includes('AS missing_campaign_id')) {
        return {
          missing_campaign_id: 5,
          missing_ad_group_id: 2,
          missing_targeting_id: 10,
          missing_search_term: 0,
          unknown_match_type: 1,
          zero_impressions_and_clicks: 2,
          clicks_gt_impressions: 0,
          orders_gt_clicks: 0,
          negative_spend_or_sales: 0,
          affected_fact_count: 15,
          affected_import_count: 1,
        };
      }
      if (sql.includes('WITH duplicates AS')) {
        return { duplicate_group_count: 1, affected_facts: 2, affected_imports: 1 };
      }
      if (sql.includes('WITH overlaps AS')) {
        return { overlap_group_count: 0, affected_facts: 0, affected_imports: 0 };
      }
      if (sql.includes('SELECT DISTINCT f.report_date AS report_date')) {
        assert.equal(mode, 'all');
        return { results: [{ report_date: '2026-06-01' }, { report_date: '2026-06-02' }] };
      }
      throw new Error(`Unexpected STORE_DB SQL: ${sql}`);
    });
  },
};

const env = { CONTROL_DB: controlDb, STORE_01_DB: storeDb };
const request = new Request('https://example.test/api/v1/stores/store-dev-01/csv-analytics/quality?startDate=2026-06-01&endDate=2026-06-02', { method: 'GET' });
const response = await handleCsvAnalyticsQualityApiRoute({ request, env, actor, url: new URL(request.url) });
assert.equal(response.status, 200);
const payload = await response.json();

assert.equal(payload.dimension, 'quality');
assert.equal(payload.quality.qualityScore, 98.1);
assert.equal(payload.quality.issueCount, 6);
assert.equal(payload.quality.issueOccurrences, 21);
assert.equal(payload.quality.severity, 'high');
assert.equal(payload.quality.affectedFacts, 15);
assert.equal(payload.quality.affectedImports, 1);
assert.equal(payload.quality.reliabilityOnly, true);
assert.equal(payload.quality.changesIdentityAuthority, false);
assert.equal(payload.quality.changesRecommendationAuthority, false);
assert.equal(payload.quality.amazonExecutionAuthorized, false);
assert.equal(payload.coverage.factCount, 100);
assert.equal(payload.coverage.importCount, 1);
assert.equal(payload.coverage.missingDays, 0);
assert.equal(payload.coverage.campaignIdPresentRate, 0.95);
assert.equal(payload.coverage.targetingIdPresentRate, 0.9);
assert.deepEqual(payload.coverage.currencyCodes, ['USD']);
assert.deepEqual(payload.coverage.marketplaces, ['US']);
assert.equal(payload.governance.identityResolved, false);
assert.equal(payload.governance.identityAuthority, 'observed_csv_only');
assert.equal(payload.governance.qualityDoesNotChangeIdentityAuthority, true);
assert.equal(payload.governance.qualityDoesNotChangeRecommendationAuthority, true);
assert.equal(payload.governance.amazonExecutionAuthorized, false);
assert.equal(payload.meta.persisted, false);
assert.ok(payload.issues.some((issue) => issue.code === 'duplicate_logical_rows'));
assert.ok(payload.issues.some((issue) => issue.code === 'unknown_match_type'));

for (const sql of executedSql) {
  assert.doesNotMatch(sql, /FROM\s+csv_search_term_daily\b/i, 'Quality analytics must not scan the ungoverned raw fact table');
}
assert.ok(executedSql.some((sql) => /FROM\s+csv_business_search_term_daily\s+f/i.test(sql)), 'Quality analytics must use the business authority view');

const source = await readFile(new URL('../cloudflare/runtime/csv-analytics-quality-api.js', import.meta.url), 'utf8');
const entry = await readFile(new URL('../cloudflare/runtime/web-entry.js', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../assets/cloudflare-native-csv-analytics-dashboard-v1.js', import.meta.url), 'utf8');

for (const code of [
  'missing_campaign_id',
  'missing_ad_group_id',
  'missing_targeting_id',
  'missing_search_term',
  'unknown_match_type',
  'zero_impressions_and_clicks',
  'clicks_gt_impressions',
  'orders_gt_clicks',
  'negative_spend_or_sales',
  'duplicate_logical_rows',
  'invalid_date',
  'currency_inconsistency',
  'marketplace_inconsistency',
  'import_overlap',
  'date_gaps',
]) assert.match(source, new RegExp(code), `Missing quality issue taxonomy: ${code}`);

assert.match(source, /'analytics\.read'/, 'Quality route must remain store-scoped analytics read');
assert.match(source, /qualityScore/);
assert.match(source, /affectedFacts/);
assert.match(source, /affectedImports/);
assert.match(source, /reliabilityOnly:\s*true/);
assert.match(source, /qualityDoesNotChangeIdentityAuthority:\s*true/);
assert.match(source, /qualityDoesNotChangeRecommendationAuthority:\s*true/);
assert.match(source, /amazonExecutionAuthorized:\s*false/);
assert.doesNotMatch(source, /\bfetch\s*\(/, 'Quality analytics must not perform network calls');
assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE)\s+/i, 'Quality analytics must remain read-only');
assert.doesNotMatch(source, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|amazon-ads-api/i, 'Quality analytics must remain isolated from Amazon transport');
assert.match(entry, /handleCsvAnalyticsQualityApiRoute/, 'Quality route must be wired into web-entry');
assert.match(entry, /match-type\|match_type\|quality/, 'Quality route must be inside modular and Dev read-only analytics boundaries');
assert.match(dashboard, /csvAnalytics\(storeId, 'quality', common\)/, 'Dashboard must load quality alongside analytics');
assert.match(dashboard, /Analytics data quality/);
assert.match(dashboard, /Reliability only · authority unchanged/);
assert.match(dashboard, /Quality does not change Amazon identity authority or recommendation eligibility/);
assert.match(dashboard, /\['CPC'/, 'Dashboard must surface CPC KPI');
assert.match(dashboard, /\['Units'/, 'Dashboard must surface Units KPI');
assert.match(dashboard, /\['Business facts'/, 'Dashboard must surface business fact count KPI');
assert.doesNotMatch(dashboard, /startSync\s*\(|optimization-actions|execution-permits|method:\s*['"](?:POST|PUT|PATCH|DELETE)/i, 'Quality dashboard must remain read-only');

console.log('csv analytics quality contract: PASS');
