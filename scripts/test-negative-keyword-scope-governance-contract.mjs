import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleNegativeKeywordScopesApiRoute } from '../cloudflare/runtime/negative-keyword-scopes-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/negative-keyword-scopes-api.js'), 'utf8');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const clientSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-api-v1.js'), 'utf8');

function createDb({
  read = true,
  manage = true,
  storeExists = true,
  productExists = true,
  productInStore = true,
  negativeExists = true,
  negativeStatus = 'active',
  revokePermissionBeforeBatch = false,
  removeProductFromStoreBeforeBatch = false,
  retireNegativeBeforeBatch = false,
  failAudit = false,
} = {}) {
  const state = {
    storeScopes: new Map(),
    productScopes: new Map(),
    audits: [],
    permissions: { read, manage },
    storeExists,
    productExists,
    productInStore,
    negativeExists,
    negativeStatus,
    revokePermissionBeforeBatch,
    removeProductFromStoreBeforeBatch,
    retireNegativeBeforeBatch,
    failAudit,
    batchCalls: 0,
    lastChanges: 0,
  };

  const negativeRow = () => ({
    negative_keyword_id: 'negative-synth-dev-01',
    keyword_text: 'free reading glasses',
    normalized_term: 'free reading glasses',
    match_type: 'PHRASE',
    reason_code: 'irrelevant',
    status: state.negativeStatus,
    notes: 'synthetic negative',
  });

  const detail = (status, createdAt = '2026-08-16 10:40:00') => ({
    ...negativeRow(),
    keyword_status: state.negativeStatus,
    scope_status: status,
    scope_created_at: createdAt,
  });

  function canManage() {
    return state.permissions.manage;
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
                const permission = params[1];
                if (permission === 'negatives.read') return state.permissions.read ? { ok: 1 } : null;
                if (permission === 'negatives.manage') return state.permissions.manage ? { ok: 1 } : null;
              }
              if (sql.includes('FROM store_members sm')) return null;

              if (sql.includes('FROM stores')) {
                if (!state.storeExists || params[0] !== 'store-dev-01') return null;
                return {
                  store_id: 'store-dev-01',
                  store_code: 'DEV01',
                  display_name: 'Development Store',
                  marketplace_code: 'US',
                  amazon_region: 'NA',
                  status: 'active',
                };
              }

              if (sql.includes('FROM products')) {
                if (!state.productExists || params[0] !== 'product-synth-dev-01') return null;
                return {
                  product_id: 'product-synth-dev-01',
                  model_code: 'SYNTH-MODEL-01',
                  model_name: 'Synthetic Product 01',
                  brand: 'SYNTH',
                  status: 'active',
                };
              }

              if (sql.includes('FROM product_store_map')) {
                return state.productInStore && params[0] === 'store-dev-01' && params[1] === 'product-synth-dev-01'
                  ? { ok: 1 }
                  : null;
              }

              if (sql.includes('FROM negative_keyword_library') && !sql.includes('JOIN negative_keyword_library')) {
                if (!state.negativeExists || params[0] !== 'negative-synth-dev-01') return null;
                return negativeRow();
              }

              if (sql.includes('FROM negative_store_scope s') && sql.includes('JOIN negative_keyword_library')) {
                const status = state.storeScopes.get(`${params[0]}:${params[1]}`);
                return status ? detail(status) : null;
              }
              if (sql.includes('FROM negative_store_scope')) {
                const status = state.storeScopes.get(`${params[0]}:${params[1]}`);
                return status ? { store_id: params[0], negative_keyword_id: params[1], status, created_at: '2026-08-16 10:40:00' } : null;
              }

              if (sql.includes('FROM negative_product_scope s') && sql.includes('JOIN negative_keyword_library')) {
                const status = state.productScopes.get(`${params[0]}:${params[1]}:${params[2]}`);
                return status ? detail(status) : null;
              }
              if (sql.includes('FROM negative_product_scope')) {
                const status = state.productScopes.get(`${params[0]}:${params[1]}:${params[2]}`);
                return status ? { store_id: params[0], product_id: params[1], negative_keyword_id: params[2], status, created_at: '2026-08-16 10:40:00' } : null;
              }

              throw new Error(`unexpected first query: ${sql}`);
            },
            async all() {
              if (sql.includes('FROM negative_store_scope s')) {
                const rows = [...state.storeScopes.entries()].map(([key, status]) => {
                  const [storeId] = key.split(':');
                  return storeId === params[0] ? detail(status) : null;
                }).filter(Boolean);
                return { results: rows };
              }
              if (sql.includes('FROM negative_product_scope s')) {
                const rows = [...state.productScopes.entries()].map(([key, status]) => {
                  const [storeId, productId] = key.split(':');
                  return storeId === params[0] && productId === params[1] ? detail(status) : null;
                }).filter(Boolean);
                return { results: rows };
              }
              throw new Error(`unexpected all query: ${sql}`);
            },
            async run() {
              if (sql.includes('INSERT INTO negative_store_scope')) {
                const requestedStatus = params[2];
                if (
                  !canManage()
                  || !state.storeExists
                  || !state.negativeExists
                  || (requestedStatus === 'active' && state.negativeStatus !== 'active')
                ) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                state.storeScopes.set(`${params[0]}:${params[1]}`, requestedStatus);
                state.lastChanges = 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM negative_store_scope')) {
                const key = `${params[0]}:${params[1]}`;
                if (!canManage() || !state.storeExists || !state.storeScopes.has(key)) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                state.storeScopes.delete(key);
                state.lastChanges = 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO negative_product_scope')) {
                const requestedStatus = params[3];
                if (
                  !canManage()
                  || !state.storeExists
                  || !state.productExists
                  || !state.productInStore
                  || !state.negativeExists
                  || (requestedStatus === 'active' && state.negativeStatus !== 'active')
                ) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                state.productScopes.set(`${params[0]}:${params[1]}:${params[2]}`, requestedStatus);
                state.lastChanges = 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM negative_product_scope')) {
                const key = `${params[0]}:${params[1]}:${params[2]}`;
                if (!canManage() || !state.storeExists || !state.productExists || !state.productInStore || !state.productScopes.has(key)) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                state.productScopes.delete(key);
                state.lastChanges = 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO audit_log')) {
                if (state.failAudit) throw new Error('synthetic_audit_failure');
                if (sql.includes('WHERE changes()=1') && state.lastChanges !== 1) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                state.audits.push({
                  actorUserId: params[1],
                  storeId: params[2],
                  action: params[3],
                  entityType: params[4],
                  entityId: params[5],
                  details: JSON.parse(params[8]),
                });
                state.lastChanges = 1;
                return { success: true, meta: { changes: 1 } };
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
        state.permissions.manage = false;
        state.revokePermissionBeforeBatch = false;
      }
      if (state.removeProductFromStoreBeforeBatch) {
        state.productInStore = false;
        state.removeProductFromStoreBeforeBatch = false;
      }
      if (state.retireNegativeBeforeBatch) {
        state.negativeStatus = 'retired';
        state.retireNegativeBeforeBatch = false;
      }

      const snapshot = {
        storeScopes: new Map(state.storeScopes),
        productScopes: new Map(state.productScopes),
        audits: state.audits.map((entry) => ({ ...entry })),
        lastChanges: state.lastChanges,
      };
      state.lastChanges = 0;

      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      } catch (error) {
        state.storeScopes = new Map(snapshot.storeScopes);
        state.productScopes = new Map(snapshot.productScopes);
        state.audits = snapshot.audits;
        state.lastChanges = snapshot.lastChanges;
        throw error;
      }
    },
  };

  return db;
}

const actor = { user_id: 'user-dev-owner' };
const storeItemUrl = 'https://example.test/api/v1/stores/store-dev-01/negative-keywords/negative-synth-dev-01';
const productItemUrl = 'https://example.test/api/v1/stores/store-dev-01/products/product-synth-dev-01/negative-keywords/negative-synth-dev-01';

function storePutRequest(status = 'active', headers = {}) {
  return new Request(storeItemUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ status }),
  });
}

function productPutRequest(status = 'active', headers = {}) {
  return new Request(productItemUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ status }),
  });
}

const db = createDb();

const createStoreRequest = storePutRequest('active', { 'cf-ray': 'negative-store-put-ray' });
const createdStore = await handleNegativeKeywordScopesApiRoute({
  request: createStoreRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(createStoreRequest.url),
});
assert.equal(createdStore.status, 201);
assert.equal(createdStore.headers.get('cache-control'), 'no-store');
assert.equal(createdStore.headers.get('x-request-id'), 'negative-store-put-ray');
const createdStorePayload = await createdStore.json();
assert.equal(createdStorePayload.store.storeId, 'store-dev-01');
assert.equal(createdStorePayload.scope.negativeKeywordId, 'negative-synth-dev-01');
assert.equal(createdStorePayload.scope.scopeStatus, 'active');
assert.equal(db.state.audits.at(-1).action, 'negative_store_scope.upsert');
assert.equal(db.state.batchCalls, 1);

const updateStoreRequest = storePutRequest('disabled');
const updatedStore = await handleNegativeKeywordScopesApiRoute({
  request: updateStoreRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(updateStoreRequest.url),
});
assert.equal(updatedStore.status, 200);
assert.equal((await updatedStore.json()).scope.scopeStatus, 'disabled');
assert.equal(db.state.batchCalls, 2);

const listStoreRequest = new Request('https://example.test/api/v1/stores/store-dev-01/negative-keywords?scopeStatus=disabled&matchType=PHRASE');
const listedStore = await handleNegativeKeywordScopesApiRoute({
  request: listStoreRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(listStoreRequest.url),
});
assert.equal(listedStore.status, 200);
const listedStorePayload = await listedStore.json();
assert.equal(listedStorePayload.items.length, 1);
assert.equal(listedStorePayload.items[0].scopeStatus, 'disabled');

const createProductRequest = productPutRequest('active', { 'cf-ray': 'negative-product-put-ray' });
const createdProduct = await handleNegativeKeywordScopesApiRoute({
  request: createProductRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(createProductRequest.url),
});
assert.equal(createdProduct.status, 201);
const createdProductPayload = await createdProduct.json();
assert.equal(createdProductPayload.product.productId, 'product-synth-dev-01');
assert.equal(createdProductPayload.scope.scopeStatus, 'active');
assert.equal(db.state.audits.at(-1).action, 'negative_product_scope.upsert');
assert.equal(db.state.batchCalls, 3);

const deniedRequest = storePutRequest();
const denied = await handleNegativeKeywordScopesApiRoute({
  request: deniedRequest,
  env: { CONTROL_DB: createDb({ manage: false }) },
  actor: { user_id: 'store-operator' },
  url: new URL(deniedRequest.url),
});
assert.equal(denied.status, 403);
assert.deepEqual(await denied.json(), { error: 'forbidden', permission: 'negatives.manage' });

const crossStoreRequest = productPutRequest();
const crossStore = await handleNegativeKeywordScopesApiRoute({
  request: crossStoreRequest,
  env: { CONTROL_DB: createDb({ productInStore: false }) },
  actor,
  url: new URL(crossStoreRequest.url),
});
assert.equal(crossStore.status, 409);
assert.deepEqual(await crossStore.json(), {
  error: 'product_not_in_store',
  storeId: 'store-dev-01',
  productId: 'product-synth-dev-01',
});

const retiredRequest = storePutRequest('active');
const retired = await handleNegativeKeywordScopesApiRoute({
  request: retiredRequest,
  env: { CONTROL_DB: createDb({ negativeStatus: 'retired' }) },
  actor,
  url: new URL(retiredRequest.url),
});
assert.equal(retired.status, 409);
assert.deepEqual(await retired.json(), { error: 'negative_keyword_retired' });

const invalidRequest = new Request(storeItemUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'paused' }),
});
const invalid = await handleNegativeKeywordScopesApiRoute({
  request: invalidRequest,
  env: { CONTROL_DB: createDb() },
  actor,
  url: new URL(invalidRequest.url),
});
assert.equal(invalid.status, 400);
assert.deepEqual(await invalid.json(), { error: 'invalid_negative_scope_status' });

const storeAuditFailureDb = createDb({ failAudit: true });
const storeAuditFailureRequest = storePutRequest();
await assert.rejects(
  handleNegativeKeywordScopesApiRoute({
    request: storeAuditFailureRequest,
    env: { CONTROL_DB: storeAuditFailureDb },
    actor,
    url: new URL(storeAuditFailureRequest.url),
  }),
  /synthetic_audit_failure/,
);
assert.equal(storeAuditFailureDb.state.storeScopes.size, 0);
assert.equal(storeAuditFailureDb.state.audits.length, 0);

const storeDeleteRevokedDb = createDb();
const storeDeleteSeedRequest = storePutRequest();
const storeDeleteSeed = await handleNegativeKeywordScopesApiRoute({
  request: storeDeleteSeedRequest,
  env: { CONTROL_DB: storeDeleteRevokedDb },
  actor,
  url: new URL(storeDeleteSeedRequest.url),
});
assert.equal(storeDeleteSeed.status, 201);
storeDeleteRevokedDb.state.revokePermissionBeforeBatch = true;
const storeDeleteRevokedRequest = new Request(storeItemUrl, { method: 'DELETE' });
const storeDeleteRevoked = await handleNegativeKeywordScopesApiRoute({
  request: storeDeleteRevokedRequest,
  env: { CONTROL_DB: storeDeleteRevokedDb },
  actor,
  url: new URL(storeDeleteRevokedRequest.url),
});
assert.equal(storeDeleteRevoked.status, 403);
assert.deepEqual(await storeDeleteRevoked.json(), { error: 'forbidden', permission: 'negatives.manage' });
assert.equal(storeDeleteRevokedDb.state.storeScopes.get('store-dev-01:negative-synth-dev-01'), 'active');
assert.equal(storeDeleteRevokedDb.state.audits.length, 1);

const productMovedDb = createDb({ removeProductFromStoreBeforeBatch: true });
const productMovedRequest = productPutRequest();
const productMoved = await handleNegativeKeywordScopesApiRoute({
  request: productMovedRequest,
  env: { CONTROL_DB: productMovedDb },
  actor,
  url: new URL(productMovedRequest.url),
});
assert.equal(productMoved.status, 409);
assert.deepEqual(await productMoved.json(), {
  error: 'product_not_in_store',
  storeId: 'store-dev-01',
  productId: 'product-synth-dev-01',
});
assert.equal(productMovedDb.state.productScopes.size, 0);
assert.equal(productMovedDb.state.audits.length, 0);

const negativeRetiredRaceDb = createDb({ retireNegativeBeforeBatch: true });
const negativeRetiredRaceRequest = storePutRequest('active');
const negativeRetiredRace = await handleNegativeKeywordScopesApiRoute({
  request: negativeRetiredRaceRequest,
  env: { CONTROL_DB: negativeRetiredRaceDb },
  actor,
  url: new URL(negativeRetiredRaceRequest.url),
});
assert.equal(negativeRetiredRace.status, 409);
assert.deepEqual(await negativeRetiredRace.json(), { error: 'negative_keyword_retired' });
assert.equal(negativeRetiredRaceDb.state.storeScopes.size, 0);
assert.equal(negativeRetiredRaceDb.state.audits.length, 0);

const productDeleteAuditFailureDb = createDb();
const productDeleteSeedRequest = productPutRequest();
const productDeleteSeed = await handleNegativeKeywordScopesApiRoute({
  request: productDeleteSeedRequest,
  env: { CONTROL_DB: productDeleteAuditFailureDb },
  actor,
  url: new URL(productDeleteSeedRequest.url),
});
assert.equal(productDeleteSeed.status, 201);
const productDeleteAuditCountBefore = productDeleteAuditFailureDb.state.audits.length;
productDeleteAuditFailureDb.state.failAudit = true;
const productDeleteAuditFailureRequest = new Request(productItemUrl, { method: 'DELETE' });
await assert.rejects(
  handleNegativeKeywordScopesApiRoute({
    request: productDeleteAuditFailureRequest,
    env: { CONTROL_DB: productDeleteAuditFailureDb },
    actor,
    url: new URL(productDeleteAuditFailureRequest.url),
  }),
  /synthetic_audit_failure/,
);
assert.equal(productDeleteAuditFailureDb.state.productScopes.get('store-dev-01:product-synth-dev-01:negative-synth-dev-01'), 'active');
assert.equal(productDeleteAuditFailureDb.state.audits.length, productDeleteAuditCountBefore);

const deleteProductRequest = new Request(productItemUrl, { method: 'DELETE', headers: { 'cf-ray': 'negative-product-delete-ray' } });
const deletedProduct = await handleNegativeKeywordScopesApiRoute({
  request: deleteProductRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(deleteProductRequest.url),
});
assert.equal(deletedProduct.status, 200);
assert.deepEqual(await deletedProduct.json(), {
  deleted: true,
  storeId: 'store-dev-01',
  productId: 'product-synth-dev-01',
  negativeKeywordId: 'negative-synth-dev-01',
});
assert.equal(db.state.audits.at(-1).action, 'negative_product_scope.delete');
assert.equal(db.state.batchCalls, 4);

const deleteStoreRequest = new Request(storeItemUrl, { method: 'DELETE' });
const deletedStore = await handleNegativeKeywordScopesApiRoute({
  request: deleteStoreRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(deleteStoreRequest.url),
});
assert.equal(deletedStore.status, 200);
assert.equal(db.state.audits.at(-1).action, 'negative_store_scope.delete');
assert.equal(db.state.batchCalls, 5);

const nonAtomicDb = createDb();
nonAtomicDb.batch = undefined;
const nonAtomicRequest = storePutRequest();
await assert.rejects(
  handleNegativeKeywordScopesApiRoute({
    request: nonAtomicRequest,
    env: { CONTROL_DB: nonAtomicDb },
    actor,
    url: new URL(nonAtomicRequest.url),
  }),
  /control_d1_atomic_batch_required/,
);

assert.match(apiSource, /negative_store_scope/);
assert.match(apiSource, /negative_product_scope/);
assert.match(apiSource, /product_not_in_store/);
assert.match(apiSource, /negatives\.read/);
assert.match(apiSource, /negatives\.manage/);
assert.match(apiSource, /actor_global_permission\.permission_key='negatives\.manage'/);
assert.match(apiSource, /actor_store_permission\.permission_key='negatives\.manage'/);
assert.match(apiSource, /target_mapping\.store_id=\?1 AND target_mapping\.product_id=\?2/);
assert.match(apiSource, /target_negative\.status='active'/);
assert.match(apiSource, /INSERT INTO audit_log[\s\S]*WHERE changes\(\)=1/);
assert.match(apiSource, /db\.batch\(\[mutation, auditStatement\]\)/);
assert.match(apiSource, /control_d1_atomic_batch_required/);
assert.doesNotMatch(apiSource, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|STORE_01_DB|SYNC_TRIGGER_ENABLED/);

assert.match(webEntrySource, /handleNegativeKeywordScopesApiRoute/);
assert.match(webEntrySource, /NEGATIVE_KEYWORD_SCOPE_ROUTE_PATTERNS/);
assert.match(clientSource, /storeNegativeKeywords:/);
assert.match(clientSource, /putStoreNegativeKeyword:/);
assert.match(clientSource, /deleteStoreNegativeKeyword:/);
assert.match(clientSource, /productNegativeKeywords:/);
assert.match(clientSource, /putProductNegativeKeyword:/);
assert.match(clientSource, /deleteProductNegativeKeyword:/);

console.log(JSON.stringify({
  ok: true,
  module: 'negative-keyword-scope-governance',
  contracts: [
    'store-negative-scope-read-write',
    'product-negative-scope-read-write',
    'store-scoped-rbac',
    'negative-scope-mutation-time-authority',
    'product-store-isolation',
    'product-store-membership-race-guard',
    'retired-negative-activation-guard',
    'retired-negative-race-guard',
    'idempotent-scope-upsert',
    'scope-audit-log',
    'scope-atomic-audit-rollback',
    'control-d1-atomic-batch-required',
    'control-d1-only',
    'native-client-contract',
  ],
}));
