import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleStoreProductsApiRoute } from '../cloudflare/runtime/store-products-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const clientSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-api-v1.js'), 'utf8');

function createDb({ allowed = true } = {}) {
  const products = [
    {
      product_id: 'product-synth-dev-04',
      model_code: 'SYNTH-MODEL-04',
      model_name: 'Synthetic Product 04',
      brand: 'YTDBNS',
      product_status: 'active',
      attributes_json: '{"kind":"synthetic"}',
      seller_sku: 'SYNTH-SKU-04',
      asin: 'SYNTH-ASIN-X',
      parent_asin: null,
      listing_status: 'active',
      mapped_at: '2026-08-14 09:35:29',
      updated_at: '2026-08-14 09:35:29',
    },
    {
      product_id: 'product-synth-dev-03',
      model_code: 'SYNTH-MODEL-03',
      model_name: 'Synthetic Product 03',
      brand: 'YTDBNS',
      product_status: 'active',
      attributes_json: null,
      seller_sku: 'SYNTH-SKU-03',
      asin: 'SYNTH-ASIN-X',
      parent_asin: null,
      listing_status: 'active',
      mapped_at: '2026-08-14 09:35:29',
      updated_at: '2026-08-14 09:35:29',
    },
  ];

  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM user_global_roles')) return allowed ? { ok: 1 } : null;
              if (sql.includes('FROM store_members')) return null;
              if (sql.includes('FROM stores')) {
                if (params[0] !== 'store-dev-01') return null;
                return {
                  store_id: 'store-dev-01',
                  store_code: 'DEV01',
                  display_name: 'Development Store',
                  marketplace_code: 'US',
                  amazon_region: 'NA',
                  status: 'active',
                };
              }
              throw new Error(`unexpected first query: ${sql}`);
            },
            async all() {
              if (!sql.includes('FROM product_store_map')) throw new Error(`unexpected all query: ${sql}`);
              return { results: products };
            },
          };
        },
      };
    },
  };
}

const request = new Request('https://example.test/api/v1/stores/store-dev-01/products?limit=1&q=SYNTH&productStatus=active&listingStatus=active', {
  headers: { 'cf-ray': 'gate8-test-ray' },
});
const response = await handleStoreProductsApiRoute({
  request,
  env: { CONTROL_DB: createDb() },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(request.url),
});
assert(response, 'store products route must return a response');
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.equal(response.headers.get('x-request-id'), 'gate8-test-ray');
const payload = await response.json();
assert.deepEqual(payload.store, {
  storeId: 'store-dev-01',
  storeCode: 'DEV01',
  displayName: 'Development Store',
  marketplaceCode: 'US',
  amazonRegion: 'NA',
  status: 'active',
});
assert.equal(payload.items.length, 1);
assert.deepEqual(payload.items[0], {
  productId: 'product-synth-dev-04',
  modelCode: 'SYNTH-MODEL-04',
  modelName: 'Synthetic Product 04',
  brand: 'YTDBNS',
  productStatus: 'active',
  attributes: { kind: 'synthetic' },
  sellerSku: 'SYNTH-SKU-04',
  asin: 'SYNTH-ASIN-X',
  parentAsin: null,
  listingStatus: 'active',
  mappedAt: '2026-08-14 09:35:29',
  updatedAt: '2026-08-14 09:35:29',
});
assert.equal(typeof payload.nextCursor, 'string');
assert(!JSON.stringify(payload).includes('STORE_01_DB'), 'binding identifiers must not leak to browser payload');

const deniedRequest = new Request('https://example.test/api/v1/stores/store-dev-01/products');
const denied = await handleStoreProductsApiRoute({
  request: deniedRequest,
  env: { CONTROL_DB: createDb({ allowed: false }) },
  actor: { user_id: 'user-without-store-access' },
  url: new URL(deniedRequest.url),
});
assert.equal(denied.status, 403);
assert.deepEqual(await denied.json(), { error: 'forbidden', permission: 'ads.read' });

const invalidRequest = new Request('https://example.test/api/v1/stores/store-dev-01/products?productStatus=deleted');
const invalid = await handleStoreProductsApiRoute({
  request: invalidRequest,
  env: { CONTROL_DB: createDb() },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(invalidRequest.url),
});
assert.equal(invalid.status, 400);
assert.deepEqual(await invalid.json(), { error: 'invalid_product_status' });

assert.match(webEntrySource, /handleStoreProductsApiRoute/);
assert.match(webEntrySource, /\/products\$\/|stores.*products/s);
assert.match(clientSource, /storeProducts:\s*\(storeId, params\)/);
assert.match(clientSource, /\/stores\/\$\{encodeURIComponent\(storeId\)\}\/products/);

console.log(JSON.stringify({
  ok: true,
  gate: 8,
  contracts: [
    'store-product-route-same-origin',
    'store-product-ads-read-rbac',
    'store-product-control-d1-map',
    'store-product-keyset-pagination',
    'store-product-binding-not-exposed',
    'store-product-client-contract',
  ],
}));
