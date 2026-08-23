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
  revokePermissionBeforeBatch = false,
  failAudit = false,
} = {}) {
  const state = {
    mapping: null,
    audits: [],
    permissions: { globalAllowed, storeAllowed },
    revokePermissionBeforeBatch,
    failAudit,
    batchCalls: 0,
    lastChanges: 0,
  };

  const db = {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async first() {
              if (sql.includes('FROM user_global_roles ugr')) return state.permissions.globalAllowed ? { ok: 1 } : null;
              if (sql.includes('FROM store_members sm')) return state.permissions.storeAllowed ? { ok: 1 } : null;
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
                if (!state.permissions.globalAllowed && !state.permissions.storeAllowed) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
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
                state.lastChanges = 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM product_store_map')) {
                if (!state.permissions.globalAllowed && !state.permissions.storeAllowed) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                const changed = state.mapping ? 1 : 0;
                if (changed) state.mapping = null;
                state.lastChanges = changed;
                return { success: true, meta: { changes: changed } };
              }
              if (sql.includes('INSERT INTO audit_log')) {
                if (state.failAudit) throw new Error('synthetic_audit_failure');
                if (sql.includes('WHERE changes()=1') && state.lastChanges !== 1) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                state.audits.push({
                  actorUserId: params[1], storeId: params[2], action: params[3], entityType: params[4],
                  entityId: params[5], details: JSON.parse(params[8]),
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
        state.permissions.globalAllowed = false;
        state.permissions.storeAllowed = false;
        state.revokePermissionBeforeBatch = false;
      }
      const snapshot = {
        mapping: state.mapping ? { ...state.mapping } : null,
        audits: state.audits.map((entry) => ({ ...entry })),
        lastChanges: state.lastChanges,
      };
      state.lastChanges = 0;
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      } catch (error) {
        state.mapping = snapshot.mapping;
        state.audits = snapshot.audits;
        state.lastChanges = snapshot.lastChanges;
        throw error;
      }
    },
  };
  return db;
}

const itemUrl = 'https://example.test/api/v1/stores/store-dev-01/products/product-synth-dev-01/SYNTH-SKU-G11';
function putRequest(headers = {}, body = { asin: 'SYNTH-ASIN-11', parentAsin: null, listingStatus: 'active' }) {
  return new Request(itemUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const db = createDb();
const initialPutRequest = putRequest({ 'cf-ray': 'gate11-put-ray' });
const created = await handleStoreProductsApiRoute({
  request: initialPutRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(initialPutRequest.url),
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
assert.equal(db.state.batchCalls, 1);

const listRequest = new Request('https://example.test/api/v1/stores/store-dev-01/products?limit=10');
const listed = await handleStoreProductsApiRoute({
  request: listRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(listRequest.url),
});
assert.equal(listed.status, 200);
assert.equal((await listed.json()).items[0].sellerSku, 'SYNTH-SKU-G11');

const updateRequest = putRequest({}, { asin: 'SYNTH-ASIN-11', parentAsin: 'SYNTH-PARENT-11', listingStatus: 'paused' });
const updated = await handleStoreProductsApiRoute({
  request: updateRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(updateRequest.url),
});
assert.equal(updated.status, 200);
assert.equal((await updated.json()).mapping.parentAsin, 'SYNTH-PARENT-11');
assert.equal(db.state.audits.length, 2);
assert.equal(db.state.batchCalls, 2);

const storeOperatorDb = createDb({ globalAllowed: false, storeAllowed: true });
const storeOperatorRequest = putRequest();
const storeOperatorAllowed = await handleStoreProductsApiRoute({
  request: storeOperatorRequest, env: { CONTROL_DB: storeOperatorDb }, actor: { user_id: 'store-operator' }, url: new URL(storeOperatorRequest.url),
});
assert.equal(storeOperatorAllowed.status, 201);
assert.equal(storeOperatorDb.state.audits.length, 1);

const deniedRequest = putRequest();
const denied = await handleStoreProductsApiRoute({
  request: deniedRequest, env: { CONTROL_DB: createDb({ globalAllowed: false, storeAllowed: false }) },
  actor: { user_id: 'unauthorized-user' }, url: new URL(deniedRequest.url),
});
assert.equal(denied.status, 403);
assert.deepEqual(await denied.json(), { error: 'forbidden', permission: 'products.manage' });

const conflictRequest = putRequest();
const conflict = await handleStoreProductsApiRoute({
  request: conflictRequest, env: { CONTROL_DB: createDb({ conflictingProductId: 'product-other' }) },
  actor: { user_id: 'user-dev-owner' }, url: new URL(conflictRequest.url),
});
assert.equal(conflict.status, 409);
assert.deepEqual(await conflict.json(), { error: 'seller_sku_product_conflict' });

const invalidFieldRequest = putRequest({}, { amazonMutation: true });
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

const putAuditFailureDb = createDb({ failAudit: true });
const putAuditFailureRequest = putRequest();
await assert.rejects(
  handleStoreProductsApiRoute({
    request: putAuditFailureRequest,
    env: { CONTROL_DB: putAuditFailureDb },
    actor: { user_id: 'user-dev-owner' },
    url: new URL(putAuditFailureRequest.url),
  }),
  /synthetic_audit_failure/,
);
assert.equal(putAuditFailureDb.state.mapping, null);
assert.equal(putAuditFailureDb.state.audits.length, 0);

const putRevokedDb = createDb({ revokePermissionBeforeBatch: true });
const putRevokedRequest = putRequest();
const putRevoked = await handleStoreProductsApiRoute({
  request: putRevokedRequest,
  env: { CONTROL_DB: putRevokedDb },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(putRevokedRequest.url),
});
assert.equal(putRevoked.status, 403);
assert.deepEqual(await putRevoked.json(), { error: 'forbidden', permission: 'products.manage' });
assert.equal(putRevokedDb.state.mapping, null);
assert.equal(putRevokedDb.state.audits.length, 0);

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
assert.equal(db.state.batchCalls, 3);

const deleteAuditFailureDb = createDb();
const deleteAuditSeedRequest = putRequest();
const deleteAuditSeed = await handleStoreProductsApiRoute({
  request: deleteAuditSeedRequest,
  env: { CONTROL_DB: deleteAuditFailureDb },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(deleteAuditSeedRequest.url),
});
assert.equal(deleteAuditSeed.status, 201);
const deleteAuditCountBefore = deleteAuditFailureDb.state.audits.length;
deleteAuditFailureDb.state.failAudit = true;
const deleteAuditFailureRequest = new Request(itemUrl, { method: 'DELETE' });
await assert.rejects(
  handleStoreProductsApiRoute({
    request: deleteAuditFailureRequest,
    env: { CONTROL_DB: deleteAuditFailureDb },
    actor: { user_id: 'user-dev-owner' },
    url: new URL(deleteAuditFailureRequest.url),
  }),
  /synthetic_audit_failure/,
);
assert.ok(deleteAuditFailureDb.state.mapping);
assert.equal(deleteAuditFailureDb.state.audits.length, deleteAuditCountBefore);

const deleteRevokedDb = createDb();
const deleteRevokedSeedRequest = putRequest();
const deleteRevokedSeed = await handleStoreProductsApiRoute({
  request: deleteRevokedSeedRequest,
  env: { CONTROL_DB: deleteRevokedDb },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(deleteRevokedSeedRequest.url),
});
assert.equal(deleteRevokedSeed.status, 201);
deleteRevokedDb.state.revokePermissionBeforeBatch = true;
const deleteRevokedRequest = new Request(itemUrl, { method: 'DELETE' });
const deleteRevoked = await handleStoreProductsApiRoute({
  request: deleteRevokedRequest,
  env: { CONTROL_DB: deleteRevokedDb },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(deleteRevokedRequest.url),
});
assert.equal(deleteRevoked.status, 403);
assert.deepEqual(await deleteRevoked.json(), { error: 'forbidden', permission: 'products.manage' });
assert.ok(deleteRevokedDb.state.mapping);
assert.equal(deleteRevokedDb.state.audits.length, 1);

const missingDeleteRequest = new Request(itemUrl, { method: 'DELETE' });
const missingDelete = await handleStoreProductsApiRoute({
  request: missingDeleteRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(missingDeleteRequest.url),
});
assert.equal(missingDelete.status, 404);
assert.deepEqual(await missingDelete.json(), { error: 'store_product_mapping_not_found' });

const nonAtomicDb = createDb();
nonAtomicDb.batch = undefined;
const nonAtomicRequest = putRequest();
await assert.rejects(
  handleStoreProductsApiRoute({
    request: nonAtomicRequest,
    env: { CONTROL_DB: nonAtomicDb },
    actor: { user_id: 'user-dev-owner' },
    url: new URL(nonAtomicRequest.url),
  }),
  /control_d1_atomic_batch_required/,
);

assert.match(apiSource, /app_roles ar[\s\S]*role_scope = 'global'/);
assert.match(apiSource, /app_roles ar[\s\S]*role_scope = 'store'/);
assert.match(apiSource, /ON CONFLICT\(store_id, product_id, seller_sku\) DO UPDATE/);
assert.match(apiSource, /actor_global_permission\.permission_key='products\.manage'/);
assert.match(apiSource, /actor_store_permission\.permission_key='products\.manage'/);
assert.match(apiSource, /INSERT INTO audit_log\([\s\S]*WHERE changes\(\)=1/);
assert.match(apiSource, /db\.batch\(\[mutation, auditStatement\]\)/);
assert.match(apiSource, /control_d1_atomic_batch_required/);
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
    'store-product-mutation-time-authority',
    'store-product-upsert-idempotency',
    'store-product-sku-conflict-protection',
    'store-product-input-bounds',
    'store-product-audit-log-with-store',
    'store-product-atomic-audit-rollback',
    'store-product-delete-governance',
    'store-product-control-d1-atomic-batch-required',
    'store-product-control-d1-only',
    'store-product-client-write-contract',
    'store-product-read-after-write-contract',
  ],
}));
