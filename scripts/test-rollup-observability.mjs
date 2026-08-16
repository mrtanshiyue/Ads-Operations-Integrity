import assert from 'node:assert/strict';
import { observedRollup } from '../cloudflare/runtime/rollup-observability.js';

if (!globalThis.crypto?.randomUUID) {
  throw new Error('crypto.randomUUID is required by the test runtime');
}

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async run() {
    this.db.runs.push(this);
    return { success: true };
  }
}

const db = {
  runs: [],
  batches: [],
  prepare(sql) { return new Statement(this, sql); },
  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true }));
  },
};

const success = await observedRollup({
  controlDb: db,
  metadata: {
    storeId: 'store-dev-01',
    rollupType: 'product_daily',
    startDate: '2026-08-14',
    endDate: '2026-08-14',
  },
  work: async ({ rollupRunId }) => ({
    marker: rollupRunId,
    sourceRows: 10,
    summaryRows: 7,
    unmappedRows: 2,
    ambiguousRows: 1,
  }),
});
assert.equal(typeof success.rollupRunId, 'string');
assert.equal(success.marker, success.rollupRunId);
assert.equal(db.runs.length, 1);
assert.match(db.runs[0].sql, /INSERT INTO rollup_runs/);
assert.equal(db.runs[0].args[1], 'store-dev-01');
assert.equal(db.runs[0].args[2], 'product_daily');
assert.equal(db.batches.length, 1);
assert.equal(db.batches[0].length, 2);
assert.match(db.batches[0][0].sql, /UPDATE rollup_runs/);
assert.match(db.batches[0][1].sql, /INSERT INTO rollup_watermarks/);
assert.deepEqual(db.batches[0][0].args.slice(1), [10, 7, 2, 1]);
assert.equal(db.batches[0][1].args[3], '2026-08-14');
assert.equal(db.batches[0][1].args[4], null);

const failDb = {
  runs: [],
  batches: [],
  prepare(sql) { return new Statement(this, sql); },
  async batch(statements) { this.batches.push(statements); return []; },
};
const expected = Object.assign(new Error('mapping exploded'), { code: 'mapping_failed' });
await assert.rejects(
  observedRollup({
    controlDb: failDb,
    metadata: {
      storeId: 'store-dev-01',
      rollupType: 'keyword_window',
      partitionKey: 'r',
      asOfDate: '2026-08-14',
      windowDays: 30,
    },
    work: async () => { throw expected; },
  }),
  /mapping exploded/,
);
assert.equal(failDb.runs.length, 2);
assert.match(failDb.runs[1].sql, /SET status = 'failed'/);
assert.equal(failDb.runs[1].args[1], 'mapping_failed');
assert.equal(failDb.batches.length, 0);

await assert.rejects(
  observedRollup({
    controlDb: db,
    metadata: { storeId: 'store-dev-01', rollupType: 'keyword_window', asOfDate: '2026-08-14' },
    work: async () => ({}),
  }),
  /rollup_observer_keyword_metadata_required/,
);

console.log(JSON.stringify({
  ok: true,
  successLedgerWrites: db.runs.length,
  successCompletionBatchStatements: db.batches[0].length,
  failureLedgerWrites: failDb.runs.length,
}));
