import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleCsvAnalyticsApiRoute } from '../cloudflare/runtime/csv-analytics-api.js';

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

const juneTotals = {
  fact_count: 8753,
  impressions: 1390748,
  clicks: 14268,
  spend_micros: 13571980000,
  purchases: 1562,
  units_sold: 1577,
  sales_micros: 30544840000,
};

const storeDb = {
  prepare(sql) {
    return statement(sql, async (mode, params) => {
      const startDate = params[0];
      if (sql.includes('GROUP_CONCAT(DISTINCT f.source_import_id)')) {
        return startDate === '2026-06-01'
          ? {
              fact_count: 8753,
              observed_start_date: '2026-06-01',
              observed_end_date: '2026-06-30',
              included_import_ids: 'csv-d9ab3b06-f772-4257-add4-75eb35109f2d',
              provenance_classes: 'legacy_batch_only',
              authority_versions: '1',
              currency_codes: 'USD',
              marketplaces: 'US',
            }
          : { fact_count: 0 };
      }
      if (sql.includes('COALESCE(SUM(f.impressions), 0)')) {
        return startDate === '2026-06-01'
          ? juneTotals
          : { fact_count: 0, impressions: 0, clicks: 0, spend_micros: 0, purchases: 0, units_sold: 0, sales_micros: 0 };
      }
      if (sql.includes('SELECT COUNT(*) AS count') && sql.includes('grouped_rows')) return { count: 1 };
      if (sql.includes('WITH aggregated AS')) {
        assert.equal(mode, 'all');
        return {
          results: [{
            campaign_name: 'Readers Exact',
            campaign_id: 'observed-campaign-1',
            advertiser_account_id: 'observed-account-1',
            profile_id: null,
            impressions: 100,
            clicks: 10,
            spend_micros: 5000000,
            purchases: 2,
            units_sold: 2,
            sales_micros: 20000000,
          }],
        };
      }
      throw new Error(`Unexpected STORE_DB SQL: ${sql}`);
    });
  },
};

const env = { CONTROL_DB: controlDb, STORE_01_DB: storeDb };

async function call(path) {
  const request = new Request(`https://example.test${path}`, { method: 'GET' });
  const url = new URL(request.url);
  const response = await handleCsvAnalyticsApiRoute({ request, env, actor, url });
  assert.ok(response, `Route should match: ${path}`);
  const payload = await response.json();
  return { response, payload };
}

{
  const { response, payload } = await call('/api/v1/stores/store-dev-01/csv-analytics/overview?startDate=2026-06-01&endDate=2026-06-30');
  assert.equal(response.status, 200);
  assert.equal(payload.metrics.impressions, 1390748);
  assert.equal(payload.metrics.clicks, 14268);
  assert.equal(payload.metrics.spendMicros, 13571980000);
  assert.equal(payload.metrics.orders, 1562);
  assert.equal(payload.metrics.ctr, 14268 / 1390748);
  assert.equal(payload.metrics.cpcMicros, 13571980000 / 14268);
  assert.equal(payload.metrics.cvr, 1562 / 14268);
  assert.equal(payload.metrics.acos, 13571980000 / 30544840000);
  assert.equal(payload.metrics.roas, 30544840000 / 13571980000);
  assert.equal(payload.governance.sourceKind, 'csv_import');
  assert.equal(payload.governance.dataClass, 'business');
  assert.deepEqual(payload.governance.includedImportIds, ['csv-d9ab3b06-f772-4257-add4-75eb35109f2d']);
  assert.deepEqual(payload.governance.provenanceClasses, ['legacy_batch_only']);
  assert.equal(payload.governance.analyticsEligible, true);
  assert.equal(payload.governance.recommendationEligible, false);
  assert.equal(payload.governance.reviewEligible, false);
  assert.equal(payload.governance.amazonExecutionAuthorized, false);
  assert.equal(payload.governance.currencyCode, 'USD');
  assert.equal(payload.governance.marketplace, 'US');
  assert.equal(payload.comparison.available, false);
  assert.equal(payload.comparison.reason, 'comparison_period_has_no_business_facts');
  assert.equal(payload.comparison.delta, null);
}

{
  const { payload } = await call('/api/v1/stores/store-dev-01/csv-analytics/campaign?startDate=2026-06-01&endDate=2026-06-30&sort=salesMicros&direction=desc&page=1&limit=50');
  assert.equal(payload.dimension, 'campaign');
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].campaignId, 'observed-campaign-1');
  assert.equal(payload.items[0].identityResolved, false);
  assert.equal(payload.items[0].identityAuthority, 'observed_csv_only');
  assert.equal(payload.items[0].acos, 0.25);
  assert.equal(payload.items[0].roas, 4);
  assert.deepEqual(payload.pagination, { page: 1, limit: 50, totalItems: 1, totalPages: 1 });
}

{
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/csv-analytics/overview?startDate=2025-01-01&endDate=2026-12-31');
  const response = await handleCsvAnalyticsApiRoute({ request, env, actor, url: new URL(request.url) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'date_range_too_large');
}

{
  const request = new Request('https://example.test/api/v1/stores/store-dev-01/csv-analytics/campaign?startDate=2026-06-01&endDate=2026-06-30&sort=reportDate');
  const response = await handleCsvAnalyticsApiRoute({ request, env, actor, url: new URL(request.url) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_sort_for_dimension');
}

for (const sql of executedSql) {
  assert.doesNotMatch(sql, /FROM\s+csv_search_term_daily\b/i, 'Business analytics must never scan the ungoverned raw fact table');
}
assert.ok(executedSql.some((sql) => /FROM\s+csv_business_search_term_daily\s+f/i.test(sql)), 'Business view must be the fact source');

const source = await readFile(new URL('../cloudflare/runtime/csv-analytics-api.js', import.meta.url), 'utf8');
const entry = await readFile(new URL('../cloudflare/runtime/web-entry.js', import.meta.url), 'utf8').catch(() => '');
assert.doesNotMatch(source, /\bfetch\s*\(/, 'CSV analytics foundation must not perform network calls');
assert.doesNotMatch(source, /AMAZON_ADS_ENABLED\s*=\s*true|SYNC_TRIGGER_ENABLED\s*=\s*true/, 'CSV analytics must not enable Amazon/sync transport');
assert.match(source, /amazonExecutionAuthorized:\s*false/);
assert.match(source, /GOVERNED_PROVENANCE/);
assert.match(source, /legacy_batch_only|provenanceClasses/);
if (entry) {
  assert.match(entry, /handleCsvAnalyticsApiRoute/, 'CSV analytics handler must be wired into web-entry');
  assert.match(entry, /CSV_ANALYTICS_ROUTE_PATTERN/, 'CSV analytics route must remain inside the modular and Dev read-only boundaries');
}

console.log('csv analytics foundation contract: PASS');
