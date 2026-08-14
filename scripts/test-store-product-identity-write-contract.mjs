import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleStoreProductsApiRoute } from '../cloudflare/runtime/store-products-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/store-products-api.js'), 'utf8');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const clientSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-api-v1.js'), 'utf8');

function createDb({
  globalAllowed = true,
  storeAllowed = false,
  storeExists = true,
  productExists = true,
  conflictingProductId = null,
} = {}) {
  const state = { mapping: null, audits: [] };
  const db = {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM user_global_roles')) return globalAllowed ? { ok: 1 } : null;
              if (sql.includes('FROM store_members')) return storeAllowed ? { ok: 1 } : null;
              if (sql.includes('FROM stores')) {
                if (!storeExists || params[0] !== 'store-dev-01') return null;
                return {
                  store_id: 'store-dev-01', store_code: 'DEV01', display_name: 'Development Store',
                  marketplace_code: 'US', amazon_region: 'NA', status: 'active',
                };
              }
              if (sql.includes('FROM products') && !sql.includes('JOIN products')) {
                if (!productExists || params[0] !== 'product-synth-dev-01') return null;
                return { product_id: 'product-synth-dev-01' };
              }
              if (sql.includes('FROM product_store_map psm') && sql.includes('JOIN products')) {
                if (!state.mapping) return null;
                return {
                  product_id: state.mapping.productId,
                  model_code: 'SYNTH-MODEL-01',
                  model_name: 'Synthetic Product 01',
                  brand: 'SYNTH',
                  product_status: 'active',
                  attributes_json: '{"kind":"synthetic"}',
                  seller_sku: state.mapping.sellerSku,
                  asin: state.mapping.asin,
                  parent_asin: state.mapping.parentAsin,
                  listing_status: state.mapping.listingStatus,
                  mapped_at: state.mapping.mappedAt,
                  updated_at: state.mapping.updatedAt,
                };
              }
              if (sql.includes('WHERE store_id=?1 AND seller_sku=?2')) {
                if (conflictingProductId) {
                  return { store_id: params[0], product_id: conflictingProductId, seller_sku: params[1] };
                }
                if (!state.mapping || state.mapping.sellerSku !== params[1]) return null;
                return { store_id: params[0], product_id: state.mapping.productId, seller_sku: state.mapping.sellerSku };
              }
              if (sql.includes('WHERE store_id=?1 AND product_id=?2 AND seller_sku=?3')) {
                if (!state.mapping) return null;
                if (state.mapping.productId !== params[1] || state.mapping.sellerSku !== params[2]) return null;
                return { store_id: params[0], product_id: state.mapping.productId, seller_sku: state.mapping.sellerSku };
              }
              throw new Error(`unexpected first query: ${sql}`);
            },
            async all() {
              if (!sql.includes('FROM product_store_map psm')) throw new Error(`unexpected all query: ${sql}`);
              if (!state.mapping) return { results: [] };
              return {
                results: [{
                  product_id: state.mapping.productId,
                  model_code: 'SYNTH-MODEL-01',
                  model_name: 'Synthetic Product 01',
                  brand: 'SYNTH',
                  product_status: 'active',
                  attributes_json: '{"kind":"synthetic"}',
                  seller_sku: state.mapping.sellerSku,
                  asin: state.mapping.asin,
                  parent_asin: state.mapping.parentAsin,
                  listing_status: state.mapping.listingStatus,
                  mapped_at: state.mapping.mappedAt,
                  updated_at: state.mapping.updatedAt,
                }],
              };
            },
            async run() {
              if (sql.includes('INSERT INTO product_store_map')) {
                const mappedAt = state.mapping?.mappedAt || '2026-08-14 13:30:00';
                state.mapping = {
                  productId: params[1],
                  sellerSku: params[2],
                  asin: params[3],
                  parentAsin: params[4],
                  listingStatus: params[5],
                  mappedAt,
                  updatedAt: '2026-08-14 13:30:00',
                };
                return { success: true };
              }
              if (sql.includes('DELETE FROM product_store_map')) {
                state.mapping = null;
                return { success: true };
              }
              if (sql.includes('INSERT INTO audit_log')) {
                state.audits.push({
                  actorUserId: params[1], storeId: params[2], action: params[3], entityType: params[4],
                  entityId: params[5], details: JSON.parse(params[8]),
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

const itemUrl = 'https://example.test/api/v1/stores/store-dev-01/products/product-synth-dev-01/SYNTH-SKU-G11';
const db = createDb();
const putRequest = new Request(itemUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'cf-ray': 'gate11-put-ray' },
  body: JSON.stringify({ asin: 'SYNTH-ASIN-11', parentAsin: null, listingStatus: 'active' }),
});
const created = await handleStoreProductsApiRoute({
  request: putRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(putRequest.url),
});
assert.equal(created.status, 201);
assert.equal(created.headers.get('cache-control'), 'no-store');
assert.equal(created.headers.get('x-request-id'), 'gate11-put-ray');
const createdPayload = await created.json();
assert.equal(createdPayload.store.storeId, 'store-dev-01');
assert.deepEqual(createdPayload.mapping, {
  productId: 'product-synth-dev-01', modelCode: 'SYNTH-MODEL-01', modelName: 'Synthetic Product 01', brand: 'SYNTH',
  productStatus: 'active', attributes: { kind: 'synthetic' }, sellerSku: 'SYNTH-SKU-G11', asin: 'SYNTH-ASIN-11',
  parentAsin: null, listingStatus: 'active', mappedAt: '2026-08-14 13:30:00', updatedAt: '2026-08-14 13:30:00',
});
assert.equal(db.state.audits.length, 1);
assert.equal(db.state.audits[0].storeId, 'store-dev-01');
assert.equal(db.state.audits[0].action, 'store_product.upsert');
assert.equal(db.state.audits[0].entityType, 'product_store_map');

const listRequest = new Request('https://example.test/api/v1/stores/store-dev-01/products?limit=10');
const listed = await handleStoreProductsApiRoute({
  request: listRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(listRequest.url),
});
assert.equal(listed.status, 200);
assert.equal((await listed.json()).items[0].sellerSku, 'SYNTH-SKU-G11');

const updateRequest = new Request(itemUrl, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ asin: 'SYNTH-ASIN-11', parentAsin: 'SYNTH-PARENT-11', listingStatus: 'paused' }),
});
const updated = await handleStoreProductsApiRoute({
  request: updateRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(updateRequest.url),
});
assert.equal(updated.status, 200);
assert.equal((await updated.json()).mapping.parentAsin, 'SYNTH-PARENT-11');
assert.equal(db.state.audits.length, 2);

const storeOperatorDb = createDb({ globalAllowed: false, storeAllowed: true });
const storeOperatorRequest = new Request(itemUrl, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
});
const storeOperatorAllowed = await handleStoreProductsApiRoute({
  request: storeOperatorRequest, env: { CONTROL_DB: storeOperatorDb }, actor: { user_id: 'store-operator' }, url: new URL(storeOperatorRequest.url),
});
assert.equal(storeOperatorAllowed.status, 201);

const deniedRequest = new Request(itemUrl, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
});
const denied = await handleStoreProductsApiRoute({
  request: deniedRequest, env: { CONTROL_DB: createDb({ globalAllowed: false, storeAllowed: false }) },
  actor: { user_id: 'unauthorized-user' }, url: new URL(deniedRequest.url),
});
assert.equal(denied.status, 403);
assert.deepEqual(await denied.json(), { error: 'forbidden', permission: 'products.manage' });

const conflictRequest = new Request(itemUrl, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
});
const conflict = await handleStoreProductsApiRoute({
  request: conflictRequest, env: { CONTROL_DB: createDb({ conflictingProductId: 'product-other' }) },
  actor: { user_id: 'user-dev-owner' }, url: new URL(conflictRequest.url),
});
assert.equal(conflict.status, 409);
assert.deepEqual(await conflict.json(), { error: 'seller_sku_product_conflict' });

const invalidFieldRequest = new Request(itemUrl, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amazonMutation: true }),
});
const invalidField = await handleStoreProductsApiRoute({
  request: invalidFieldRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(invalidFieldRequest.url),
});
assert.equal(invalidField.status, 400);
assert.deepEqual(await invalidField.json(), { error: 'unsupported_store_product_field' });

const tooLongSku = 'X'.repeat(129);
const invalidSkuRequest = new Request(`https://example.test/api/v1/stores/store-dev-01/products/product-synth-dev-01/${tooLongSku}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
});
const invalidSku = await handleStoreProductsApiRoute({
  request: invalidSkuRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(invalidSkuRequest.url),
});
assert.equal(invalidSku.status, 400);
assert.deepEqual(await invalidSku.json(), { error: 'invalid_seller_sku' });

const deleteRequest = new Request(itemUrl, { method: 'DELETE', headers: { 'cf-ray': 'gate11-delete-ray' } });
const deleted = await handleStoreProductsApiRoute({
  request: deleteRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(deleteRequest.url),
});
assert.equal(deleted.status, 200);
assert.deepEqual(await deleted.json(), {
  deleted: true, storeId: 'store-dev-01', productId: 'product-synth-dev-01', sellerSku: 'SYNTH-SKU-G11',
});
assert.equal(db.state.mapping, null);
assert.equal(db.state.audits.at(-1).action, 'store_product.delete');
assert.equal(db.state.audits.at(-1).storeId, 'store-dev-01');

const missingDeleteRequest = new Request(itemUrl, { method: 'DELETE' });
const missingDelete = await handleStoreProductsApiRoute({
  request: missingDeleteRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(missingDeleteRequest.url),
});
assert.equal(missingDelete.status, 404);
assert.deepEqual(await missingDelete.json(), { error: 'store_product_mapping_not_found' });

assert.match(apiSource, /app_roles ar[\s\S]*role_scope = 'global'/);
assert.match(apiSource, /app_roles ar[\s\S]*role_scope = 'store'/);
assert.match(apiSource, /ON CONFLICT\(store_id, product_id, seller_sku\) DO UPDATE/);
assert.match(apiSource, /INSERT INTO audit_log\(event_id, actor_user_id, store_id/);
assert.doesNotMatch(apiSource, /AMAZON_SYNC_WORKFLOW|STORE_01_DB|SYNC_TRIGGER_ENABLED/);
assert.match(webEntrySource, /STORE_PRODUCTS_ROUTE_PATTERN[\s\S]*products\(\?:/);
assert.match(clientSource, /putStoreProduct:\s*\(storeId, productId, sellerSku, body\)/);
assert.match(clientSource, /deleteStoreProduct:\s*\(storeId, productId, sellerSku\)/);
assert.match(clientSource, /method: 'PUT'/);
assert.match(clientSource, /method: 'DELETE'/);

console.log(JSON.stringify({
  ok: true,
  gate: 11,
  contracts: [
    'store-product-write-item-route',
    'store-product-scoped-governance-rbac',
    'store-product-upsert-idempotency',
    'store-product-sku-conflict-protection',
    'store-product-input-bounds',
    'store-product-audit-log-with-store',
    'store-product-delete-governance',
    'store-product-control-d1-only',
    'store-product-client-write-contract',
    'store-product-read-after-write-contract',
  ],
}));
