import assert from 'node:assert/strict';
import {
  markStoreSyncStatus,
  refreshKeywordPerformanceRollupPartition,
  refreshProductDailySummaryDate,
  refreshStoreDailySummary,
} from '../cloudflare/runtime/rollup.js';

class BoundStatement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new BoundStatement(this.db, this.sql, args);
  }
  async all() {
    return { results: this.db.resolve(this.sql, this.args) || [] };
  }
  async run() {
    this.db.state.runs.push(this);
    return { success: true };
  }
}

function createDb(resolve) {
  const state = { batches: [], runs: [] };
  return {
    state,
    resolve,
    prepare(sql) {
      return new BoundStatement(this, sql);
    },
    async batch(statements) {
      state.batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
}

const controlDb = createDb((sql, args) => {
  if (/SELECT product_id, seller_sku, asin/.test(sql)) {
    assert.equal(args[0], 'store-dev-01');
    return [
      { product_id: 'p1', seller_sku: 'SKU-1', asin: 'ASIN-1' },
      { product_id: 'p2', seller_sku: 'SKU-2', asin: 'ASIN-2' },
      { product_id: 'p3', seller_sku: 'SKU-3', asin: 'ASIN-X' },
      { product_id: 'p4', seller_sku: 'SKU-4', asin: 'ASIN-X' },
    ];
  }
  if (/SELECT keyword_id, normalized_term/.test(sql)) {
    assert.equal(args[0], 'en-US');
    assert.equal(args[1], 'r%');
    return [
      { keyword_id: 'kw-reading', normalized_term: 'reading glasses' },
      { keyword_id: 'kw-readers', normalized_term: 'readers' },
    ];
  }
  return [];
});

const storeDb = createDb((sql, args) => {
  if (/FROM campaign_daily/.test(sql)) {
    assert.deepEqual(args, ['2026-08-01', '2026-08-02']);
    return [
      {
        report_date: '2026-08-01', ad_product: 'SP', impressions: 100,
        clicks: 10, cost_micros: 1_250_000, purchases: 2, units_sold: 2, sales_micros: 6_500_000,
      },
      {
        report_date: '2026-08-02', ad_product: 'SP', impressions: 200,
        clicks: 15, cost_micros: 2_000_000, purchases: 3, units_sold: 4, sales_micros: 9_500_000,
      },
    ];
  }
  if (/FROM advertised_product_daily/.test(sql)) {
    assert.deepEqual(args, ['2026-08-02']);
    return [
      {
        report_date: '2026-08-02', ad_product: 'SP', advertised_sku: 'sku-1', advertised_asin: 'asin-1',
        impressions: 100, clicks: 10, cost_micros: 1_000_000, purchases: 2, units_sold: 2, sales_micros: 5_000_000,
      },
      {
        report_date: '2026-08-02', ad_product: 'SP', advertised_sku: '', advertised_asin: 'asin-2',
        impressions: 50, clicks: 5, cost_micros: 500_000, purchases: 1, units_sold: 1, sales_micros: 2_500_000,
      },
      {
        report_date: '2026-08-02', ad_product: 'SP', advertised_sku: '', advertised_asin: 'ASIN-X',
        impressions: 10, clicks: 1, cost_micros: 100_000, purchases: 0, units_sold: 0, sales_micros: 0,
      },
      {
        report_date: '2026-08-02', ad_product: 'SP', advertised_sku: 'UNKNOWN', advertised_asin: 'UNKNOWN',
        impressions: 5, clicks: 1, cost_micros: 50_000, purchases: 0, units_sold: 0, sales_micros: 0,
      },
    ];
  }
  if (/FROM keyword_daily d/.test(sql)) {
    assert.deepEqual(args, ['2026-07-04', '2026-08-02', 'r%']);
    return [
      { normalized_keyword: 'reading glasses', impressions: 1000, clicks: 100, cost_micros: 10_000_000, purchases: 20, units_sold: 22, sales_micros: 50_000_000 },
      { normalized_keyword: 'readers', impressions: 600, clicks: 60, cost_micros: 6_000_000, purchases: 12, units_sold: 13, sales_micros: 30_000_000 },
      { normalized_keyword: 'rare mystery term', impressions: 30, clicks: 3, cost_micros: 300_000, purchases: 0, units_sold: 0, sales_micros: 0 },
    ];
  }
  return [];
});

const storeSummary = await refreshStoreDailySummary({
  controlDb,
  storeDb,
  storeId: 'store-dev-01',
  startDate: '2026-08-01',
  endDate: '2026-08-02',
});
assert.deepEqual(storeSummary, {
  storeId: 'store-dev-01', startDate: '2026-08-01', endDate: '2026-08-02', days: 2, summaryRows: 2,
});
assert.equal(controlDb.state.batches[0].length, 3);
assert.match(controlDb.state.batches[0][0].sql, /DELETE FROM store_daily_summary/);

const productSummary = await refreshProductDailySummaryDate({
  controlDb,
  storeDb,
  storeId: 'store-dev-01',
  reportDate: '2026-08-02',
});
assert.deepEqual(productSummary, {
  storeId: 'store-dev-01', reportDate: '2026-08-02', summaryRows: 2, unmappedRows: 1, ambiguousRows: 1,
});
const productBatch = controlDb.state.batches[1];
assert.equal(productBatch.length, 3);
assert.match(productBatch[0].sql, /DELETE FROM product_daily_summary/);
assert.equal(productBatch[1].args[1], 'p1');
assert.equal(productBatch[2].args[1], 'p2');

const keywordSummary = await refreshKeywordPerformanceRollupPartition({
  controlDb,
  storeDb,
  storeId: 'store-dev-01',
  asOfDate: '2026-08-02',
  windowDays: 30,
  partitionPrefix: 'R',
});
assert.deepEqual(keywordSummary, {
  storeId: 'store-dev-01',
  asOfDate: '2026-08-02',
  startDate: '2026-07-04',
  windowDays: 30,
  partitionPrefix: 'r',
  summaryRows: 2,
  unmappedRows: 1,
  ambiguousRows: 0,
});
const keywordBatch = controlDb.state.batches[2];
assert.equal(keywordBatch.length, 3);
assert.match(keywordBatch[0].sql, /DELETE FROM keyword_performance_rollup/);
assert.deepEqual(keywordBatch.slice(1).map((stmt) => stmt.args[1]), ['kw-reading', 'kw-readers']);

await markStoreSyncStatus({
  controlDb,
  storeId: 'store-dev-01',
  status: 'idle',
  lastSuccessAt: '2026-08-14T08:00:00Z',
  lagMinutes: 15,
});
assert.equal(controlDb.state.runs.length, 1);
assert.match(controlDb.state.runs[0].sql, /INSERT INTO store_sync_status/);

await assert.rejects(
  refreshStoreDailySummary({
    controlDb,
    storeDb,
    storeId: 'store-dev-01',
    startDate: '2025-01-01',
    endDate: '2026-08-02',
  }),
  /rollup_date_range_too_large/,
);
await assert.rejects(
  markStoreSyncStatus({ controlDb, storeId: 'store-dev-01', status: 'mystery' }),
  /sync_status_invalid/,
);

console.log(JSON.stringify({
  ok: true,
  storeSummaryRows: storeSummary.summaryRows,
  productSummaryRows: productSummary.summaryRows,
  productUnmappedRows: productSummary.unmappedRows,
  productAmbiguousRows: productSummary.ambiguousRows,
  keywordSummaryRows: keywordSummary.summaryRows,
  keywordUnmappedRows: keywordSummary.unmappedRows,
}));
