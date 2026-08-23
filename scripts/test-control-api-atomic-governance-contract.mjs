import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleControlApiRoute } from '../cloudflare/runtime/control-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/control-api.js'), 'utf8');
assert.equal((apiSource.match(/requireAtomicBatch\(db\);/g) || []).length, 6);
assert.match(apiSource, /WHERE changes\(\)=1/);
assert.match(apiSource, /actor_global_app_role\.role_scope='global'/);
assert.doesNotMatch(apiSource, /await audit\(/);

const now = '2026-08-23 10:00:00';
const actor = { user_id: 'owner-user' };

function productRow(overrides = {}) {
  return {
    product_id: 'product-01', model_code: 'P-001', model_name: 'Product 01', brand: 'YTDBNS',
    status: 'active', attributes_json: null, created_at: now, updated_at: now, ...overrides,
  };
}
function keywordRow(overrides = {}) {
  return {
    keyword_id: 'keyword-01', keyword_text: 'reading glasses', normalized_term: 'reading glasses', language_code: 'en-US',
    intent_class: null, semantic_cluster: null, lifecycle_status: 'active', source_type: 'manual', notes: null,
    created_at: now, updated_at: now, ...overrides,
  };
}
function negativeRow(overrides = {}) {
  return {
    negative_keyword_id: 'negative-01', keyword_text: 'free', normalized_term: 'free', match_type: 'EXACT',
    reason_code: null, status: 'active', notes: null, created_at: now, updated_at: now, ...overrides,
  };
}

function cloneMap(map) {
  return new Map([...map.entries()].map(([key, value]) => [key, { ...value }]));
}

function createDb({ failAudit = false, revokePermissionBeforeBatch = null } = {}) {
  const state = {
    permissions: new Set(['products.manage', 'keywords.manage', 'negatives.manage']),
    products: new Map([['product-01', productRow()]]),
    keywords: new Map([['keyword-01', keywordRow()]]),
    negatives: new Map([['negative-01', negativeRow()]]),
    audits: [],
    failAudit,
    revokePermissionBeforeBatch,
    batchCalls: 0,
    lastChanges: 0,
  };

  function permissionInSql(sql) {
    return sql.match(/actor_global_permission\.permission_key='([^']+)'/)?.[1] || null;
  }
  function changed(count) {
    state.lastChanges = count;
    return { success: true, meta: { changes: count } };
  }

  const db = {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async first() {
              if (sql.includes('FROM user_global_roles ugr')) {
                return state.permissions.has(params[1]) ? { ok: 1 } : null;
              }
              if (sql.includes('FROM products WHERE product_id=?1')) return state.products.get(params[0]) || null;
              if (sql.includes('FROM keyword_library WHERE keyword_id=?1')) return state.keywords.get(params[0]) || null;
              if (sql.includes('FROM negative_keyword_library WHERE negative_keyword_id=?1')) return state.negatives.get(params[0]) || null;
              throw new Error(`unexpected first query: ${sql}`);
            },
            async run() {
              if (sql.includes('INSERT INTO audit_log')) {
                if (state.failAudit) throw new Error('synthetic_audit_failure');
                if (sql.includes('WHERE changes()=1') && state.lastChanges !== 1) return changed(0);
                state.audits.push({
                  actorUserId: params[1], action: params[2], entityType: params[3], entityId: params[4],
                  details: JSON.parse(params[7]),
                });
                return changed(1);
              }

              const permission = permissionInSql(sql);
              if (permission && !state.permissions.has(permission)) return changed(0);

              if (sql.includes('INSERT INTO products')) {
                if ([...state.products.values()].some((row) => row.model_code === params[1])) {
                  throw new Error('UNIQUE constraint failed: products.model_code');
                }
                state.products.set(params[0], productRow({
                  product_id: params[0], model_code: params[1], model_name: params[2], brand: params[3],
                  status: params[4], attributes_json: params[5],
                }));
                return changed(1);
              }
              if (sql.includes('UPDATE products')) {
                const id = params[5];
                if (!state.products.has(id)) return changed(0);
                state.products.set(id, productRow({
                  ...state.products.get(id), model_code: params[0], model_name: params[1], brand: params[2],
                  status: params[3], attributes_json: params[4], updated_at: now,
                }));
                return changed(1);
              }
              if (sql.includes('INSERT INTO keyword_library')) {
                state.keywords.set(params[0], keywordRow({
                  keyword_id: params[0], keyword_text: params[1], normalized_term: params[2], language_code: params[3],
                  intent_class: params[4], semantic_cluster: params[5], lifecycle_status: params[6], source_type: params[7],
                  notes: params[8],
                }));
                return changed(1);
              }
              if (sql.includes('UPDATE keyword_library')) {
                const id = params[8];
                if (!state.keywords.has(id)) return changed(0);
                state.keywords.set(id, keywordRow({
                  ...state.keywords.get(id), keyword_text: params[0], normalized_term: params[1], language_code: params[2],
                  intent_class: params[3], semantic_cluster: params[4], lifecycle_status: params[5], source_type: params[6],
                  notes: params[7], updated_at: now,
                }));
                return changed(1);
              }
              if (sql.includes('INSERT INTO negative_keyword_library')) {
                state.negatives.set(params[0], negativeRow({
                  negative_keyword_id: params[0], keyword_text: params[1], normalized_term: params[2], match_type: params[3],
                  reason_code: params[4], status: params[5], notes: params[6],
                }));
                return changed(1);
              }
              if (sql.includes('UPDATE negative_keyword_library')) {
                const id = params[6];
                if (!state.negatives.has(id)) return changed(0);
                state.negatives.set(id, negativeRow({
                  ...state.negatives.get(id), keyword_text: params[0], normalized_term: params[1], match_type: params[2],
                  reason_code: params[3], status: params[4], notes: params[5], updated_at: now,
                }));
                return changed(1);
              }
              throw new Error(`unexpected run query: ${sql}`);
            },
          };
        },
      };
    },
    async batch(statements) {
      state.batchCalls += 1;
      if (state.revokePermissionBeforeBatch) {
        state.permissions.delete(state.revokePermissionBeforeBatch);
        state.revokePermissionBeforeBatch = null;
      }
      const snapshot = {
        products: cloneMap(state.products), keywords: cloneMap(state.keywords), negatives: cloneMap(state.negatives),
        audits: state.audits.map((entry) => ({ ...entry })), lastChanges: state.lastChanges,
      };
      state.lastChanges = 0;
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      } catch (error) {
        state.products = snapshot.products;
        state.keywords = snapshot.keywords;
        state.negatives = snapshot.negatives;
        state.audits = snapshot.audits;
        state.lastChanges = snapshot.lastChanges;
        throw error;
      }
    },
  };
  return db;
}

function request(pathname, method, body) {
  return new Request(`https://example.test${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'cf-ray': `test-${method.toLowerCase()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function route(db, req) {
  return handleControlApiRoute({ request: req, env: { CONTROL_DB: db }, actor, url: new URL(req.url) });
}

const successDb = createDb();
const successRequest = request('/api/v1/products', 'POST', { modelCode: 'P-NEW', brand: 'YTDBNS' });
const successResponse = await route(successDb, successRequest);
assert.equal(successResponse.status, 201);
assert.equal(successDb.state.audits.length, 1);
assert.equal(successDb.state.audits[0].action, 'product.create');
assert.equal(successDb.state.batchCalls, 1);

const createCases = [
  { path: '/api/v1/products', body: { modelCode: 'P-ROLLBACK' }, map: 'products' },
  { path: '/api/v1/keywords', body: { keywordText: 'rollback keyword' }, map: 'keywords' },
  { path: '/api/v1/negative-keywords', body: { keywordText: 'rollback negative', matchType: 'PHRASE' }, map: 'negatives' },
];
for (const testCase of createCases) {
  const db = createDb({ failAudit: true });
  const before = db.state[testCase.map].size;
  const req = request(testCase.path, 'POST', testCase.body);
  await assert.rejects(route(db, req), /synthetic_audit_failure/);
  assert.equal(db.state[testCase.map].size, before, `${testCase.path} must roll back mutation when audit fails`);
  assert.equal(db.state.audits.length, 0);
  assert.equal(db.state.batchCalls, 1);
}

const updateCases = [
  { path: '/api/v1/products/product-01', body: { brand: 'Changed' }, permission: 'products.manage', map: 'products', id: 'product-01' },
  { path: '/api/v1/keywords/keyword-01', body: { notes: 'Changed' }, permission: 'keywords.manage', map: 'keywords', id: 'keyword-01' },
  { path: '/api/v1/negative-keywords/negative-01', body: { notes: 'Changed' }, permission: 'negatives.manage', map: 'negatives', id: 'negative-01' },
];
for (const testCase of updateCases) {
  const db = createDb({ revokePermissionBeforeBatch: testCase.permission });
  const before = { ...db.state[testCase.map].get(testCase.id) };
  const req = request(testCase.path, 'PATCH', testCase.body);
  const response = await route(db, req);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'forbidden', permission: testCase.permission });
  assert.deepEqual(db.state[testCase.map].get(testCase.id), before, `${testCase.path} must not mutate after permission revocation`);
  assert.equal(db.state.audits.length, 0);
  assert.equal(db.state.batchCalls, 1);
}

const noBatchDb = createDb();
delete noBatchDb.batch;
const noBatchRequest = request('/api/v1/products', 'POST', { modelCode: 'P-NOBATCH' });
await assert.rejects(route(noBatchDb, noBatchRequest), /control_d1_atomic_batch_required/);

console.log(JSON.stringify({
  ok: true,
  contract: 'control-api-atomic-governance-v1',
  createAuditRollback: ['product', 'keyword', 'negative_keyword'],
  updatePermissionRace: ['products.manage', 'keywords.manage', 'negatives.manage'],
  atomicBatchRequired: true,
  amazonDormant: true,
}, null, 2));
