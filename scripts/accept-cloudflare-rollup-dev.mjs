import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';
import {
  markStoreSyncStatus,
  refreshKeywordPerformanceRollupPartition,
  refreshProductDailySummaryDate,
  refreshStoreDailySummary,
} from '../cloudflare/runtime/rollup.js';
import { observedRollup } from '../cloudflare/runtime/rollup-observability.js';
import { handleAnalyticsApiRoute } from '../cloudflare/runtime/analytics-api.js';
import { handleDataHealthApiRoute } from '../cloudflare/runtime/data-health-api.js';
import { handleStoreDailyApiRoute } from '../cloudflare/runtime/store-daily-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = process.argv.includes('--execute');
const cleanupOnly = process.argv.includes('--cleanup-only');
if (!execute) throw new Error('remote_dev_acceptance_requires_execute_flag');

const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
const config = JSON.parse(await readFile(path.join(repoRoot, 'cloudflare/runtime/wrangler.native.jsonc'), 'utf8'));
const dev = config.env?.dev;
if (!dev || dev.name !== 'ads-operations-web-dev') throw new Error('remote_dev_web_environment_invalid');

const control = binding(dev.d1_databases, 'CONTROL_DB');
const store = binding(dev.d1_databases, 'STORE_01_DB');
assertDevDatabase(control, 'ads-ops-control-dev');
assertDevDatabase(store, 'ads-ops-store-dev');

const controlDb = createD1RestDatabase({ accountId, databaseId: control.database_id, apiToken });
const storeDb = createD1RestDatabase({ accountId, databaseId: store.database_id, apiToken });

const STORE_ID = 'store-dev-01';
const PROFILE_ID = 'profile-synth-dev-01';
const CAMPAIGN_ID = 'campaign-synth-dev-01';
const AD_GROUP_ID = 'adgroup-synth-dev-01';
const AD_PRODUCT = 'SYNTH_SP';
const START_DATE = '2026-08-11';
const END_DATE = '2026-08-12';
const AS_OF_DATE = END_DATE;
const WINDOW_DAYS = 30;
const KEYWORD_PREFIX = 'syn';
const OWNER_ACTOR = { user_id: 'user-dev-owner' };
const remoteEnv = { CONTROL_DB: controlDb, STORE_01_DB: storeDb };

await cleanupSyntheticData();
if (cleanupOnly) {
  console.log(JSON.stringify({ ok: true, mode: 'cleanup-only', environment: 'development' }));
  process.exit(0);
}

await seedControl();
await seedStore();
await assertForeignKeysClean('after-seed');

const sourceRows = {
  store: await scalar(storeDb, `SELECT COUNT(*) AS n FROM campaign_daily WHERE campaign_id=?1 AND report_date BETWEEN ?2 AND ?3 AND ad_product=?4`, [CAMPAIGN_ID, START_DATE, END_DATE, AD_PRODUCT]),
  product: await scalar(storeDb, `SELECT COUNT(*) AS n FROM advertised_product_daily WHERE row_key LIKE 'synth-dev-product-%' AND report_date=?1`, [END_DATE]),
  keyword: await scalar(storeDb, `
    SELECT COUNT(DISTINCT k.normalized_keyword) AS n
    FROM keyword_daily d JOIN keywords k ON k.keyword_id=d.keyword_id
    WHERE d.report_date BETWEEN date(?1, '-29 day') AND ?1 AND k.normalized_keyword LIKE 'syn%'
  `, [AS_OF_DATE]),
};
assert.deepEqual(sourceRows, { store: 2, product: 4, keyword: 3 });

const storeRollup = await observedRollup({
  controlDb,
  metadata: { storeId: STORE_ID, rollupType: 'store_daily', partitionKey: 'synth-dev', startDate: START_DATE, endDate: END_DATE },
  work: async () => ({
    ...(await refreshStoreDailySummary({ controlDb, storeDb, storeId: STORE_ID, startDate: START_DATE, endDate: END_DATE })),
    sourceRows: sourceRows.store,
  }),
});
const productRollup = await observedRollup({
  controlDb,
  metadata: { storeId: STORE_ID, rollupType: 'product_daily', partitionKey: 'synth-dev', startDate: END_DATE, endDate: END_DATE },
  work: async () => ({
    ...(await refreshProductDailySummaryDate({ controlDb, storeDb, storeId: STORE_ID, reportDate: END_DATE })),
    sourceRows: sourceRows.product,
  }),
});
const keywordRollup = await observedRollup({
  controlDb,
  metadata: { storeId: STORE_ID, rollupType: 'keyword_window', partitionKey: KEYWORD_PREFIX, asOfDate: AS_OF_DATE, windowDays: WINDOW_DAYS },
  work: async () => ({
    ...(await refreshKeywordPerformanceRollupPartition({
      controlDb,
      storeDb,
      storeId: STORE_ID,
      asOfDate: AS_OF_DATE,
      windowDays: WINDOW_DAYS,
      partitionPrefix: KEYWORD_PREFIX,
    })),
    sourceRows: sourceRows.keyword,
  }),
});

assert.equal(storeRollup.summaryRows, 2);
assert.equal(productRollup.summaryRows, 2);
assert.equal(productRollup.unmappedRows, 1);
assert.equal(productRollup.ambiguousRows, 1);
assert.equal(keywordRollup.summaryRows, 2);
assert.equal(keywordRollup.unmappedRows, 1);
assert.equal(keywordRollup.ambiguousRows, 0);

await markStoreSyncStatus({
  controlDb,
  storeId: STORE_ID,
  status: 'idle',
  lastSuccessAt: new Date().toISOString(),
  lagMinutes: 0,
});

await verifyRemoteSummaries();
await verifyHandlerContracts();

let failureRunId = null;
try {
  await observedRollup({
    controlDb,
    metadata: { storeId: STORE_ID, rollupType: 'product_daily', partitionKey: 'synth-dev-failure', startDate: END_DATE, endDate: END_DATE },
    work: async () => {
      throw Object.assign(new Error('synthetic acceptance failure'), { code: 'acceptance_synthetic_failure' });
    },
  });
  assert.fail('synthetic failure rollup unexpectedly succeeded');
} catch (error) {
  assert.equal(error.code, 'acceptance_synthetic_failure');
}
const failed = await controlDb.prepare(`
  SELECT rollup_run_id, error_code, status
  FROM rollup_runs
  WHERE store_id=?1 AND rollup_type='product_daily' AND partition_key='synth-dev-failure'
  ORDER BY started_at DESC LIMIT 1
`).bind(STORE_ID).first();
assert.equal(failed?.status, 'failed');
assert.equal(failed?.error_code, 'acceptance_synthetic_failure');
failureRunId = failed.rollup_run_id;

const healthWithFailure = await invokeHandler(
  handleDataHealthApiRoute,
  `/api/v1/analytics/data-health?storeId=${encodeURIComponent(STORE_ID)}`,
);
assert.equal(healthWithFailure.status, 200);
assert(healthWithFailure.body.recentRollupFailures.some((row) => row.errorCode === 'acceptance_synthetic_failure'));

if (failureRunId) {
  await controlDb.prepare(`DELETE FROM rollup_runs WHERE rollup_run_id=?1`).bind(failureRunId).run();
}
await assertForeignKeysClean('after-rollup');

console.log(JSON.stringify({
  ok: true,
  environment: 'development',
  storeId: STORE_ID,
  sourceRows,
  rollups: {
    store: { summaryRows: storeRollup.summaryRows, rollupRunId: storeRollup.rollupRunId },
    product: {
      summaryRows: productRollup.summaryRows,
      unmappedRows: productRollup.unmappedRows,
      ambiguousRows: productRollup.ambiguousRows,
      rollupRunId: productRollup.rollupRunId,
    },
    keyword: {
      summaryRows: keywordRollup.summaryRows,
      unmappedRows: keywordRollup.unmappedRows,
      ambiguousRows: keywordRollup.ambiguousRows,
      rollupRunId: keywordRollup.rollupRunId,
    },
  },
  handlerChecks: ['search-terms-daily', 'analytics-overview', 'analytics-products', 'analytics-keywords', 'data-health'],
  syntheticFailureObserved: true,
  foreignKeysClean: true,
}));

async function verifyRemoteSummaries() {
  const storeRows = await controlDb.prepare(`
    SELECT report_date, impressions, clicks, cost_micros, purchases, units_sold, sales_micros
    FROM store_daily_summary
    WHERE store_id=?1 AND ad_product=?2 AND report_date BETWEEN ?3 AND ?4
    ORDER BY report_date
  `).bind(STORE_ID, AD_PRODUCT, START_DATE, END_DATE).all();
  assert.deepEqual(storeRows.results, [
    { report_date: START_DATE, impressions: 100, clicks: 10, cost_micros: 1250000, purchases: 2, units_sold: 2, sales_micros: 6500000 },
    { report_date: END_DATE, impressions: 200, clicks: 15, cost_micros: 2000000, purchases: 3, units_sold: 4, sales_micros: 9500000 },
  ]);

  const products = await controlDb.prepare(`
    SELECT product_id, impressions, clicks, cost_micros, purchases, units_sold, sales_micros
    FROM product_daily_summary
    WHERE store_id=?1 AND report_date=?2 AND ad_product=?3
    ORDER BY product_id
  `).bind(STORE_ID, END_DATE, AD_PRODUCT).all();
  assert.deepEqual(products.results, [
    { product_id: 'product-synth-dev-01', impressions: 100, clicks: 10, cost_micros: 1000000, purchases: 2, units_sold: 2, sales_micros: 5000000 },
    { product_id: 'product-synth-dev-02', impressions: 50, clicks: 5, cost_micros: 500000, purchases: 1, units_sold: 1, sales_micros: 2500000 },
  ]);

  const keywords = await controlDb.prepare(`
    SELECT keyword_id, impressions, clicks, cost_micros, purchases, units_sold, sales_micros
    FROM keyword_performance_rollup
    WHERE store_id=?1 AND as_of_date=?2 AND window_days=?3 AND keyword_id LIKE 'keyword-synth-dev-%'
    ORDER BY keyword_id
  `).bind(STORE_ID, AS_OF_DATE, WINDOW_DAYS).all();
  assert.deepEqual(keywords.results, [
    { keyword_id: 'keyword-synth-dev-reading', impressions: 1000, clicks: 100, cost_micros: 10000000, purchases: 20, units_sold: 22, sales_micros: 50000000 },
    { keyword_id: 'keyword-synth-dev-readers', impressions: 600, clicks: 60, cost_micros: 6000000, purchases: 12, units_sold: 13, sales_micros: 30000000 },
  ]);

  const runs = await controlDb.prepare(`
    SELECT rollup_type, partition_key, status, source_rows, summary_rows, unmapped_rows, ambiguous_rows, error_code
    FROM rollup_runs
    WHERE store_id=?1 AND ((partition_key='synth-dev' AND rollup_type IN ('store_daily','product_daily')) OR (partition_key=?2 AND rollup_type='keyword_window'))
    ORDER BY rollup_type
  `).bind(STORE_ID, KEYWORD_PREFIX).all();
  assert.equal(runs.results.length, 3);
  assert(runs.results.every((row) => row.status === 'succeeded' && row.error_code === null));
  assert.deepEqual(Object.fromEntries(runs.results.map((row) => [row.rollup_type, [row.source_rows, row.summary_rows, row.unmapped_rows, row.ambiguous_rows]])), {
    keyword_window: [3, 2, 1, 0],
    product_daily: [4, 2, 1, 1],
    store_daily: [2, 2, 0, 0],
  });

  const watermarks = await controlDb.prepare(`
    SELECT rollup_type, partition_key, summary_rows, unmapped_rows, ambiguous_rows, last_success_run_id
    FROM rollup_watermarks
    WHERE store_id=?1 AND ((partition_key='synth-dev' AND rollup_type IN ('store_daily','product_daily')) OR (partition_key=?2 AND rollup_type='keyword_window'))
    ORDER BY rollup_type
  `).bind(STORE_ID, KEYWORD_PREFIX).all();
  assert.equal(watermarks.results.length, 3);
  assert(watermarks.results.every((row) => row.last_success_run_id));
}

async function verifyHandlerContracts() {
  const daily = await invokeHandler(
    handleStoreDailyApiRoute,
    `/api/v1/stores/${STORE_ID}/search-terms-daily?startDate=${START_DATE}&endDate=${END_DATE}&sort=cost&limit=100&q=synth`,
  );
  assert.equal(daily.status, 200);
  assert.equal(daily.body.grain, 'day');
  assert.equal(daily.body.items.length, 2);
  assert.deepEqual([...new Set(daily.body.items.map((row) => row.reportDate))].sort(), [START_DATE, END_DATE]);

  const overview = await invokeHandler(
    handleAnalyticsApiRoute,
    `/api/v1/analytics/overview?storeId=${STORE_ID}&startDate=${START_DATE}&endDate=${END_DATE}&adProduct=${AD_PRODUCT}`,
  );
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.totals, {
    impressions: 300,
    clicks: 25,
    costMicros: 3250000,
    purchases: 5,
    unitsSold: 6,
    salesMicros: 16000000,
  });
  assert.equal(overview.body.daily.length, 2);

  const products = await invokeHandler(
    handleAnalyticsApiRoute,
    `/api/v1/analytics/products?storeId=${STORE_ID}&startDate=${END_DATE}&endDate=${END_DATE}&adProduct=${AD_PRODUCT}&q=SYNTH&sort=cost&limit=50`,
  );
  assert.equal(products.status, 200);
  assert.equal(products.body.items.length, 2);
  assert.deepEqual(products.body.items.map((row) => row.productId).sort(), ['product-synth-dev-01', 'product-synth-dev-02']);

  const keywords = await invokeHandler(
    handleAnalyticsApiRoute,
    `/api/v1/analytics/keywords?storeId=${STORE_ID}&asOfDate=${AS_OF_DATE}&windowDays=${WINDOW_DAYS}&q=synth&sort=cost&limit=50`,
  );
  assert.equal(keywords.status, 200);
  assert.equal(keywords.body.items.length, 2);
  assert.deepEqual(keywords.body.items.map((row) => row.keywordId).sort(), ['keyword-synth-dev-readers', 'keyword-synth-dev-reading']);

  const health = await invokeHandler(
    handleDataHealthApiRoute,
    `/api/v1/analytics/data-health?storeId=${STORE_ID}`,
  );
  assert.equal(health.status, 200);
  assert.equal(health.body.stores.length, 1);
  assert.equal(health.body.stores[0].sync.status, 'idle');
  assert.equal(health.body.stores[0].sync.lagMinutes, 0);
  const rollups = health.body.stores[0].rollups.filter((row) => ['synth-dev', KEYWORD_PREFIX].includes(row.partitionKey));
  assert.equal(rollups.length, 3);
}

async function invokeHandler(handler, pathname) {
  const request = new Request(`https://acceptance.invalid${pathname}`, { headers: { 'cf-ray': 'dev-remote-acceptance' } });
  const url = new URL(request.url);
  const response = await handler({ request, env: remoteEnv, actor: OWNER_ACTOR, url });
  assert(response instanceof Response, `handler did not return Response for ${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function seedControl() {
  await controlDb.batch([
    controlDb.prepare(`INSERT INTO products(product_id,model_code,model_name,brand,status) VALUES(?1,?2,?3,?4,'active')`).bind('product-synth-dev-01','SYNTH-MODEL-01','Synthetic Product 01','SYNTH'),
    controlDb.prepare(`INSERT INTO products(product_id,model_code,model_name,brand,status) VALUES(?1,?2,?3,?4,'active')`).bind('product-synth-dev-02','SYNTH-MODEL-02','Synthetic Product 02','SYNTH'),
    controlDb.prepare(`INSERT INTO products(product_id,model_code,model_name,brand,status) VALUES(?1,?2,?3,?4,'active')`).bind('product-synth-dev-03','SYNTH-MODEL-03','Synthetic Product 03','SYNTH'),
    controlDb.prepare(`INSERT INTO products(product_id,model_code,model_name,brand,status) VALUES(?1,?2,?3,?4,'active')`).bind('product-synth-dev-04','SYNTH-MODEL-04','Synthetic Product 04','SYNTH'),
    controlDb.prepare(`INSERT INTO product_store_map(store_id,product_id,seller_sku,asin,listing_status) VALUES(?1,?2,?3,?4,'active')`).bind(STORE_ID,'product-synth-dev-01','SYNTH-SKU-01','SYNTH-ASIN-01'),
    controlDb.prepare(`INSERT INTO product_store_map(store_id,product_id,seller_sku,asin,listing_status) VALUES(?1,?2,?3,?4,'active')`).bind(STORE_ID,'product-synth-dev-02','SYNTH-SKU-02','SYNTH-ASIN-02'),
    controlDb.prepare(`INSERT INTO product_store_map(store_id,product_id,seller_sku,asin,listing_status) VALUES(?1,?2,?3,?4,'active')`).bind(STORE_ID,'product-synth-dev-03','SYNTH-SKU-03','SYNTH-ASIN-X'),
    controlDb.prepare(`INSERT INTO product_store_map(store_id,product_id,seller_sku,asin,listing_status) VALUES(?1,?2,?3,?4,'active')`).bind(STORE_ID,'product-synth-dev-04','SYNTH-SKU-04','SYNTH-ASIN-X'),
    controlDb.prepare(`INSERT INTO keyword_library(keyword_id,keyword_text,normalized_term,language_code,intent_class,semantic_cluster,lifecycle_status,source_type) VALUES(?1,?2,?3,'en-US','acceptance','synthetic','active','manual')`).bind('keyword-synth-dev-reading','Synthetic Reading Glasses','syn reading glasses'),
    controlDb.prepare(`INSERT INTO keyword_library(keyword_id,keyword_text,normalized_term,language_code,intent_class,semantic_cluster,lifecycle_status,source_type) VALUES(?1,?2,?3,'en-US','acceptance','synthetic','active','manual')`).bind('keyword-synth-dev-readers','Synthetic Readers','syn readers'),
  ]);
}

async function seedStore() {
  await storeDb.batch([
    storeDb.prepare(`INSERT INTO amazon_profiles(profile_id,marketplace_id,country_code,currency_code,timezone,account_name,account_type,status) VALUES(?1,'ATVPDKIKX0DER','US','USD','America/Los_Angeles','Synthetic Dev Profile','seller','active')`).bind(PROFILE_ID),
    storeDb.prepare(`INSERT INTO campaigns(campaign_id,profile_id,ad_product,name,state,targeting_type) VALUES(?1,?2,?3,'Synthetic Dev Campaign','ENABLED','MANUAL')`).bind(CAMPAIGN_ID,PROFILE_ID,AD_PRODUCT),
    storeDb.prepare(`INSERT INTO ad_groups(ad_group_id,profile_id,campaign_id,name,state,default_bid_micros) VALUES(?1,?2,?3,'Synthetic Dev Ad Group','ENABLED',2500000)`).bind(AD_GROUP_ID,PROFILE_ID,CAMPAIGN_ID),
    storeDb.prepare(`INSERT INTO keywords(keyword_id,profile_id,campaign_id,ad_group_id,keyword_text,normalized_keyword,match_type,state,bid_micros) VALUES(?1,?2,?3,?4,?5,?6,'BROAD','ENABLED',2500000)`).bind('keyword-synth-dev-reading',PROFILE_ID,CAMPAIGN_ID,AD_GROUP_ID,'Synthetic Reading Glasses','syn reading glasses'),
    storeDb.prepare(`INSERT INTO keywords(keyword_id,profile_id,campaign_id,ad_group_id,keyword_text,normalized_keyword,match_type,state,bid_micros) VALUES(?1,?2,?3,?4,?5,?6,'PHRASE','ENABLED',2200000)`).bind('keyword-synth-dev-readers',PROFILE_ID,CAMPAIGN_ID,AD_GROUP_ID,'Synthetic Readers','syn readers'),
    storeDb.prepare(`INSERT INTO keywords(keyword_id,profile_id,campaign_id,ad_group_id,keyword_text,normalized_keyword,match_type,state,bid_micros) VALUES(?1,?2,?3,?4,?5,?6,'EXACT','ENABLED',1800000)`).bind('keyword-synth-dev-unmapped',PROFILE_ID,CAMPAIGN_ID,AD_GROUP_ID,'Synthetic Mystery Term','syn mystery term'),
    storeDb.prepare(`INSERT INTO campaign_daily(profile_id,report_date,ad_product,campaign_id,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES(?1,?2,?3,?4,100,10,1250000,2,2,6500000)`).bind(PROFILE_ID,START_DATE,AD_PRODUCT,CAMPAIGN_ID),
    storeDb.prepare(`INSERT INTO campaign_daily(profile_id,report_date,ad_product,campaign_id,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES(?1,?2,?3,?4,200,15,2000000,3,4,9500000)`).bind(PROFILE_ID,END_DATE,AD_PRODUCT,CAMPAIGN_ID),
    storeDb.prepare(`INSERT INTO advertised_product_daily(row_key,profile_id,report_date,ad_product,campaign_id,ad_group_id,advertised_asin,advertised_sku,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES('synth-dev-product-01',?1,?2,?3,?4,?5,'SYNTH-ASIN-01','SYNTH-SKU-01',100,10,1000000,2,2,5000000)`).bind(PROFILE_ID,END_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
    storeDb.prepare(`INSERT INTO advertised_product_daily(row_key,profile_id,report_date,ad_product,campaign_id,ad_group_id,advertised_asin,advertised_sku,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES('synth-dev-product-02',?1,?2,?3,?4,?5,'SYNTH-ASIN-02',NULL,50,5,500000,1,1,2500000)`).bind(PROFILE_ID,END_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
    storeDb.prepare(`INSERT INTO advertised_product_daily(row_key,profile_id,report_date,ad_product,campaign_id,ad_group_id,advertised_asin,advertised_sku,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES('synth-dev-product-03',?1,?2,?3,?4,?5,'SYNTH-ASIN-X',NULL,10,1,100000,0,0,0)`).bind(PROFILE_ID,END_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
    storeDb.prepare(`INSERT INTO advertised_product_daily(row_key,profile_id,report_date,ad_product,campaign_id,ad_group_id,advertised_asin,advertised_sku,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES('synth-dev-product-04',?1,?2,?3,?4,?5,'SYNTH-UNKNOWN',NULL,5,1,50000,0,0,0)`).bind(PROFILE_ID,END_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
    storeDb.prepare(`INSERT INTO keyword_daily(profile_id,report_date,ad_product,campaign_id,ad_group_id,keyword_id,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES(?1,?2,?3,?4,?5,'keyword-synth-dev-reading',400,40,4000000,8,9,20000000)`).bind(PROFILE_ID,START_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
    storeDb.prepare(`INSERT INTO keyword_daily(profile_id,report_date,ad_product,campaign_id,ad_group_id,keyword_id,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES(?1,?2,?3,?4,?5,'keyword-synth-dev-reading',600,60,6000000,12,13,30000000)`).bind(PROFILE_ID,END_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
    storeDb.prepare(`INSERT INTO keyword_daily(profile_id,report_date,ad_product,campaign_id,ad_group_id,keyword_id,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES(?1,?2,?3,?4,?5,'keyword-synth-dev-readers',600,60,6000000,12,13,30000000)`).bind(PROFILE_ID,END_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
    storeDb.prepare(`INSERT INTO keyword_daily(profile_id,report_date,ad_product,campaign_id,ad_group_id,keyword_id,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES(?1,?2,?3,?4,?5,'keyword-synth-dev-unmapped',30,3,300000,0,0,0)`).bind(PROFILE_ID,END_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
    storeDb.prepare(`INSERT INTO search_term_daily(row_key,profile_id,report_date,ad_product,campaign_id,ad_group_id,keyword_id,search_term,normalized_search_term,match_type,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES('synth-dev-search-01',?1,?2,?3,?4,?5,'keyword-synth-dev-reading','Synthetic Query','synthetic query','BROAD',40,4,400000,1,1,2000000)`).bind(PROFILE_ID,START_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
    storeDb.prepare(`INSERT INTO search_term_daily(row_key,profile_id,report_date,ad_product,campaign_id,ad_group_id,keyword_id,search_term,normalized_search_term,match_type,impressions,clicks,cost_micros,purchases,units_sold,sales_micros) VALUES('synth-dev-search-02',?1,?2,?3,?4,?5,'keyword-synth-dev-reading','Synthetic Query','synthetic query','BROAD',60,6,600000,1,2,3000000)`).bind(PROFILE_ID,END_DATE,AD_PRODUCT,CAMPAIGN_ID,AD_GROUP_ID),
  ]);
}

async function cleanupSyntheticData() {
  await controlDb.batch([
    controlDb.prepare(`DELETE FROM rollup_watermarks WHERE store_id=?1 AND partition_key IN ('synth-dev','syn','synth-dev-failure')`).bind(STORE_ID),
    controlDb.prepare(`DELETE FROM rollup_runs WHERE store_id=?1 AND partition_key IN ('synth-dev','syn','synth-dev-failure')`).bind(STORE_ID),
    controlDb.prepare(`DELETE FROM store_daily_summary WHERE store_id=?1 AND ad_product=?2`).bind(STORE_ID,AD_PRODUCT),
    controlDb.prepare(`DELETE FROM product_daily_summary WHERE store_id=?1 AND ad_product=?2`).bind(STORE_ID,AD_PRODUCT),
    controlDb.prepare(`DELETE FROM keyword_performance_rollup WHERE store_id=?1 AND keyword_id LIKE 'keyword-synth-dev-%'`).bind(STORE_ID),
    controlDb.prepare(`DELETE FROM product_store_map WHERE store_id=?1 AND product_id LIKE 'product-synth-dev-%'`).bind(STORE_ID),
    controlDb.prepare(`DELETE FROM products WHERE product_id LIKE 'product-synth-dev-%'`),
    controlDb.prepare(`DELETE FROM keyword_library WHERE keyword_id LIKE 'keyword-synth-dev-%'`),
  ]);
  await storeDb.batch([
    storeDb.prepare(`DELETE FROM search_term_daily WHERE row_key LIKE 'synth-dev-%'`),
    storeDb.prepare(`DELETE FROM advertised_product_daily WHERE row_key LIKE 'synth-dev-%'`),
    storeDb.prepare(`DELETE FROM keyword_daily WHERE keyword_id LIKE 'keyword-synth-dev-%'`),
    storeDb.prepare(`DELETE FROM campaign_daily WHERE campaign_id=?1 AND ad_product=?2`).bind(CAMPAIGN_ID,AD_PRODUCT),
    storeDb.prepare(`DELETE FROM keywords WHERE keyword_id LIKE 'keyword-synth-dev-%'`),
    storeDb.prepare(`DELETE FROM ad_groups WHERE ad_group_id=?1`).bind(AD_GROUP_ID),
    storeDb.prepare(`DELETE FROM campaigns WHERE campaign_id=?1`).bind(CAMPAIGN_ID),
    storeDb.prepare(`DELETE FROM amazon_profiles WHERE profile_id=?1`).bind(PROFILE_ID),
  ]);
}

async function assertForeignKeysClean(stage) {
  const [controlFk, storeFk] = await Promise.all([
    controlDb.prepare('PRAGMA foreign_key_check').all(),
    storeDb.prepare('PRAGMA foreign_key_check').all(),
  ]);
  assert.equal(controlFk.results.length, 0, `${stage}: control foreign_key_check failed`);
  assert.equal(storeFk.results.length, 0, `${stage}: store foreign_key_check failed`);
}

async function scalar(db, sql, args = []) {
  const row = await db.prepare(sql).bind(...args).first();
  return Number(row?.n || 0);
}

function binding(items, name) {
  const found = (items || []).find((item) => item.binding === name);
  if (!found) throw new Error(`remote_dev_binding_missing:${name}`);
  return found;
}

function assertDevDatabase(value, expectedName) {
  if (value.database_name !== expectedName) throw new Error(`remote_dev_database_name_invalid:${expectedName}`);
  if (!value.database_id || /REPLACE|PROD/i.test(value.database_id)) throw new Error(`remote_dev_database_id_invalid:${expectedName}`);
  if (!String(value.database_name).endsWith('-dev')) throw new Error(`remote_dev_database_not_dev:${expectedName}`);
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`remote_dev_env_required:${name}`);
  return value;
}
