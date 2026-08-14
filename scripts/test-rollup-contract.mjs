import assert from 'node:assert/strict';
import { markStoreSyncStatus, refreshStoreDailySummary } from '../cloudflare/runtime/rollup.js';

class BoundStatement {
  constructor(sql, args = []) {
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new BoundStatement(this.sql, args);
  }
  async run() {
    return { success: true };
  }
}

const storeDb = {
  prepare(sql) {
    return {
      bind(startDate, endDate) {
        assert.equal(startDate, '2026-08-01');
        assert.equal(endDate, '2026-08-02');
        return {
          async all() {
            return {
              results: [
                {
                  report_date: '2026-08-01', ad_product: 'SP', impressions: 100,
                  clicks: 10, cost_micros: 1_250_000, purchases: 2, units_sold: 2, sales_micros: 6_500_000,
                },
                {
                  report_date: '2026-08-02', ad_product: 'SP', impressions: 200,
                  clicks: 15, cost_micros: 2_000_000, purchases: 3, units_sold: 4, sales_micros: 9_500_000,
                },
              ],
            };
          },
        };
      },
    };
  },
};

const controlState = { batches: [], runs: [] };
const controlDb = {
  prepare(sql) {
    const base = new BoundStatement(sql);
    return {
      bind(...args) {
        const bound = base.bind(...args);
        bound.run = async () => {
          controlState.runs.push(bound);
          return { success: true };
        };
        return bound;
      },
    };
  },
  async batch(statements) {
    controlState.batches.push(statements);
    return statements.map(() => ({ success: true }));
  },
};

const result = await refreshStoreDailySummary({
  controlDb,
  storeDb,
  storeId: 'store-dev-01',
  startDate: '2026-08-01',
  endDate: '2026-08-02',
});
assert.deepEqual(result, {
  storeId: 'store-dev-01',
  startDate: '2026-08-01',
  endDate: '2026-08-02',
  days: 2,
  summaryRows: 2,
});
assert.equal(controlState.batches.length, 1);
assert.equal(controlState.batches[0].length, 3);
assert.match(controlState.batches[0][0].sql, /DELETE FROM store_daily_summary/);
assert.deepEqual(controlState.batches[0][0].args, ['store-dev-01', '2026-08-01', '2026-08-02']);
assert.match(controlState.batches[0][1].sql, /INSERT INTO store_daily_summary/);
assert.equal(controlState.batches[0][1].args[0], 'store-dev-01');
assert.equal(controlState.batches[0][1].args[5], 1_250_000);
assert.equal(controlState.batches[0][2].args[8], 9_500_000);

await markStoreSyncStatus({
  controlDb,
  storeId: 'store-dev-01',
  status: 'idle',
  lastSuccessAt: '2026-08-14T08:00:00Z',
  lagMinutes: 15,
});
assert.equal(controlState.runs.length, 1);
assert.match(controlState.runs[0].sql, /INSERT INTO store_sync_status/);
assert.deepEqual(controlState.runs[0].args.slice(0, 2), ['store-dev-01', 'idle']);

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

console.log(JSON.stringify({ ok: true, batchStatements: controlState.batches[0].length, syncStatusWrites: controlState.runs.length }));
