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
} = {}) {
  const state = {
    storeScopes: new Map(),
    productScopes: new Map(),
    audits: [],
  };

  const negative = {
    negative_keyword_id: 'negative-synth-dev-01',
    keyword_text: 'free reading glasses',
    normalized_term: 'free reading glasses',
    match_type: 'PHRASE',
    reason_code: 'irrelevant',
    status: negativeStatus,
    notes: 'synthetic negative',
  };

  const detail = (status, createdAt = '2026-08-16 10:40:00') => ({
    ...negative,
    keyword_status: negative.status,
    scope_status: status,
    scope_created_at: createdAt,
  });

  const db = {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM user_global_roles ugr')) {
                const permission = params[1];
                if (permission === 'negatives.read') return read ? { ok: 1 } : null;
                if (permission === 'negatives.manage') return manage ? { ok: 1 } : null;
              }
              if (sql.includes('FROM store_members sm')) return null;

              if (sql.includes('FROM stores')) {
                if (!storeExists || params[0] !== 'store-dev-01') return null;
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
                if (!productExists || params[0] !== 'product-synth-dev-01') return null;
                return {
                  product_id: 'product-synth-dev-01',
                  model_code: 'SYNTH-MODEL-01',
                  model_name: 'Synthetic Product 01',
                  brand: 'SYNTH',
                  status: 'active',
                };
              }

              if (sql.includes('FROM product_store_map')) {
                return productInStore && params[0] === 'store-dev-01' && params[1] === 'product-synth-dev-01'
                  ? { ok: 1 }
                  : null;
              }

              if (sql.includes('FROM negative_keyword_library') && !sql.includes('JOIN negative_keyword_library')) {
                if (!negativeExists || params[0] !== 'negative-synth-dev-01') return null;
                return negative;
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
                state.storeScopes.set(`${params[0]}:${params[1]}`, params[2]);
                return { success: true };
              }
              if (sql.includes('DELETE FROM negative_store_scope')) {
                state.storeScopes.delete(`${params[0]}:${params[1]}`);
                return { success: true };
              }
              if (sql.includes('INSERT INTO negative_product_scope')) {
                state.productScopes.set(`${params[0]}:${params[1]}:${params[2]}`, params[3]);
                return { success: true };
              }
              if (sql.includes('DELETE FROM negative_product_scope')) {
                state.productScopes.delete(`${params[0]}:${params[1]}:${params[2]}`);
                return { success: true };
              }
              if (sql.includes('INSERT INTO audit_log')) {
                state.audits.push({
                  actorUserId: params[1],
                  storeId: params[2],
                  action: params[3],
                  entityType: params[4],
                  entityId: params[5],
                  details: JSON.parse(params[8]),
                });
                return { success: true };
              }
              throw new Error(`unexpected run query: ${sql}`);
            },
          };
        },
      };
    },
  };

  return db;
}

const actor = { user_id: 'user-dev-owner' };
const storeItemUrl = 'https://example.test/api/v1/stores/store-dev-01/negative-keywords/negative-synth-dev-01';
const productItemUrl = 'https://example.test/api/v1/stores/store-dev-01/products/product-synth-dev-01/negative-keywords/negative-synth-dev-01';

const db = createDb();

const createStoreRequest = new Request(storeItemUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'cf-ray': 'negative-store-put-ray' },
  body: JSON.stringify({ status: 'active' }),
});
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

const updateStoreRequest = new Request(storeItemUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'disabled' }),
});
const updatedStore = await handleNegativeKeywordScopesApiRoute({
  request: updateStoreRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(updateStoreRequest.url),
});
assert.equal(updatedStore.status, 200);
assert.equal((await updatedStore.json()).scope.scopeStatus, 'disabled');

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

const createProductRequest = new Request(productItemUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'cf-ray': 'negative-product-put-ray' },
  body: JSON.stringify({ status: 'active' }),
});
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

const deniedRequest = new Request(storeItemUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
const denied = await handleNegativeKeywordScopesApiRoute({
  request: deniedRequest,
  env: { CONTROL_DB: createDb({ manage: false }) },
  actor: { user_id: 'store-operator' },
  url: new URL(deniedRequest.url),
});
assert.equal(denied.status, 403);
assert.deepEqual(await denied.json(), { error: 'forbidden', permission: 'negatives.manage' });

const crossStoreRequest = new Request(productItemUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
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

const retiredRequest = new Request(storeItemUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'active' }),
});
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

const deleteStoreRequest = new Request(storeItemUrl, { method: 'DELETE' });
const deletedStore = await handleNegativeKeywordScopesApiRoute({
  request: deleteStoreRequest,
  env: { CONTROL_DB: db },
  actor,
  url: new URL(deleteStoreRequest.url),
});
assert.equal(deletedStore.status, 200);
assert.equal(db.state.audits.at(-1).action, 'negative_store_scope.delete');

assert.match(apiSource, /negative_store_scope/);
assert.match(apiSource, /negative_product_scope/);
assert.match(apiSource, /product_not_in_store/);
assert.match(apiSource, /negatives\.read/);
assert.match(apiSource, /negatives\.manage/);
assert.match(apiSource, /INSERT INTO audit_log/);
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
    'product-store-isolation',
    'retired-negative-activation-guard',
    'idempotent-scope-upsert',
    'scope-audit-log',
    'control-d1-only',
    'native-client-contract',
  ],
}));
