import assert from 'node:assert/strict';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const transientCalls = [];
const transientSleeps = [];
const transientDb = createD1RestDatabase({
  accountId: 'account-test',
  databaseId: 'database-test',
  apiToken: 'token-test',
  sleepImpl: async (ms) => transientSleeps.push(ms),
  fetchImpl: async (_url, init) => {
    transientCalls.push(JSON.parse(init.body));
    if (transientCalls.length === 1) {
      return response(200, { success: false, result: null, errors: [{ code: 7500, message: 'transient internal error' }] });
    }
    return response(200, {
      success: true,
      errors: [],
      result: [{ success: true, results: [{ n: 2 }], meta: { total_attempts: 1 } }],
    });
  },
});
const transientResult = await transientDb.prepare('SELECT COUNT(*) AS n FROM campaign_daily WHERE campaign_id=?1')
  .bind('campaign-test')
  .first();
assert.deepEqual(transientResult, { n: 2 });
assert.equal(transientCalls.length, 2);
assert.deepEqual(transientSleeps, [100]);
assert.deepEqual(transientCalls[0], {
  sql: 'SELECT COUNT(*) AS n FROM campaign_daily WHERE campaign_id=?1',
  params: ['campaign-test'],
});

let writeCalls = 0;
let writeSleeps = 0;
const writeDb = createD1RestDatabase({
  accountId: 'account-test',
  databaseId: 'database-test',
  apiToken: 'token-test',
  sleepImpl: async () => { writeSleeps += 1; },
  fetchImpl: async () => {
    writeCalls += 1;
    return response(200, { success: false, result: null, errors: [{ code: 7500, message: 'transient internal error' }] });
  },
});
await assert.rejects(
  writeDb.prepare('INSERT INTO t(id) VALUES(?1)').bind('id-1').run(),
  /d1_rest_query_failed:7500/,
);
assert.equal(writeCalls, 1);
assert.equal(writeSleeps, 0);

let forbiddenCalls = 0;
const forbiddenDb = createD1RestDatabase({
  accountId: 'account-test',
  databaseId: 'database-test',
  apiToken: 'token-test',
  sleepImpl: async () => assert.fail('403 must not be retried'),
  fetchImpl: async () => {
    forbiddenCalls += 1;
    return response(403, { success: false, result: null, errors: [{ code: 9109, message: 'forbidden' }] });
  },
});
await assert.rejects(
  forbiddenDb.prepare('SELECT 1 AS ok').first(),
  (error) => error.message === 'd1_rest_query_failed:9109' && error.httpStatus === 403 && error.apiCode === 9109,
);
assert.equal(forbiddenCalls, 1);

let pragmaCalls = 0;
const pragmaDb = createD1RestDatabase({
  accountId: 'account-test',
  databaseId: 'database-test',
  apiToken: 'token-test',
  sleepImpl: async () => {},
  fetchImpl: async () => {
    pragmaCalls += 1;
    if (pragmaCalls === 1) return response(503, { success: false, result: null, errors: [] });
    return response(200, { success: true, errors: [], result: [{ success: true, results: [], meta: {} }] });
  },
});
const pragma = await pragmaDb.prepare('PRAGMA foreign_key_check').all();
assert.deepEqual(pragma.results, []);
assert.equal(pragmaCalls, 2);

console.log(JSON.stringify({
  ok: true,
  contracts: [
    'transient-read-retry',
    'write-no-retry',
    'permission-error-no-retry',
    'foreign-key-read-retry',
  ],
}));

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}
