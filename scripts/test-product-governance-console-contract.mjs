import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-product-governance-v1.js'), 'utf8');
const buildSource = await readFile(path.join(repoRoot, 'scripts/build-cloudflare-native-copy-all.mjs'), 'utf8');
const allowlistSource = await readFile(path.join(repoRoot, 'scripts/enforce-cloudflare-native-asset-allowlist.mjs'), 'utf8');

new vm.Script(source, { filename: 'cloudflare-native-product-governance-v1.js' });
assert.doesNotMatch(source, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(|wrangler\s+deploy/i);
assert.doesNotMatch(source, /fetch\s*\(/, 'product console must delegate transport to CloudflareNativeAPI');
assert.match(source, /products\.manage/);
assert.match(source, /Control D1/);
assert.match(source, /audit log/);
assert.match(source, /storeId:\s*String\(store\.storeId\s*\|\|\s*store\.store_id\s*\|\|\s*''\)/,
  'product console must accept snake_case store_id from the live stores API');
assert.match(source, /storeCode:\s*String\(store\.storeCode\s*\|\|\s*store\.store_code\s*\|\|\s*''\)/,
  'product console must accept snake_case store_code from the live stores API');
assert.match(source, /displayName:\s*String\(store\.displayName\s*\|\|\s*store\.display_name\s*\|\|\s*''\)/,
  'product console must accept snake_case display_name from the live stores API');
assert.match(source, /marketplaceCode:\s*String\(store\.marketplaceCode\s*\|\|\s*store\.marketplace_code\s*\|\|\s*''\)/,
  'product console must accept snake_case marketplace_code from the live stores API');

const calls = [];
const window = {
  CloudflareNativeAPI: {
    listProducts(params) {
      calls.push({ method: 'listProducts', params: { ...params } });
      return Promise.resolve({ items: [] });
    },
    createProduct(body) {
      calls.push({ method: 'createProduct', body: { ...body } });
      return Promise.resolve({ product: { productId: 'product-new', ...body } });
    },
    updateProduct(productId, body) {
      calls.push({ method: 'updateProduct', productId, body: { ...body } });
      return Promise.resolve({ product: { productId, ...body } });
    },
    stores() {
      calls.push({ method: 'stores' });
      return Promise.resolve({ stores: [] });
    },
    storeProducts(storeId, params) {
      calls.push({ method: 'storeProducts', storeId, params: { ...params } });
      return Promise.resolve({ items: [] });
    },
    putStoreProduct(storeId, productId, sellerSku, body) {
      calls.push({ method: 'putStoreProduct', storeId, productId, sellerSku, body: { ...body } });
      return Promise.resolve({ mapping: { storeId, productId, sellerSku, ...body } });
    },
    deleteStoreProduct(storeId, productId, sellerSku) {
      calls.push({ method: 'deleteStoreProduct', storeId, productId, sellerSku });
      return Promise.resolve({ deleted: true });
    },
  },
};

vm.runInNewContext(source, { window, console, Set, Object, Array, String, Number, Boolean, Error, Promise }, {
  filename: 'cloudflare-native-product-governance-v1.js',
});

const governance = window.CloudflareProductGovernance;
assert(governance, 'CloudflareProductGovernance was not installed');
assert.equal(governance.version, '1.0.0');

await governance.listRegistry({ q: 'YTDBNS', status: 'active' });
await governance.createProduct({
  modelCode: ' RG-001 ',
  modelName: ' Reading Glasses ',
  brand: ' YTDBNS ',
});
await governance.updateProduct('product-01', { status: 'inactive' });
await governance.listStores();
await governance.listStoreMappings('store-dev-01', { productStatus: 'active', q: 'SKU-01' });
await governance.putStoreMapping('store-dev-01', 'product-01', ' SKU-01 ', {
  asin: ' B0TESTASIN ',
  parentAsin: ' B0PARENT ',
  listingStatus: ' ACTIVE ',
});
await governance.deleteStoreMapping('store-dev-01', 'product-01', 'SKU-01');

const listCall = calls.find((call) => call.method === 'listProducts');
assert.equal(listCall.params.limit, 200);
assert.equal(listCall.params.q, 'YTDBNS');
assert.equal(listCall.params.status, 'active');

const createCall = calls.find((call) => call.method === 'createProduct');
assert.deepEqual(createCall.body, {
  modelCode: 'RG-001',
  modelName: 'Reading Glasses',
  brand: 'YTDBNS',
  status: 'active',
  attributes: null,
});
assert(calls.some((call) => call.method === 'updateProduct'
  && call.productId === 'product-01'
  && call.body.status === 'inactive'));
assert(calls.some((call) => call.method === 'stores'));
assert(calls.some((call) => call.method === 'storeProducts'
  && call.storeId === 'store-dev-01'
  && call.params.limit === 200
  && call.params.productStatus === 'active'
  && call.params.q === 'SKU-01'));

const mappingCall = calls.find((call) => call.method === 'putStoreProduct');
assert.equal(mappingCall.storeId, 'store-dev-01');
assert.equal(mappingCall.productId, 'product-01');
assert.equal(mappingCall.sellerSku, 'SKU-01');
assert.deepEqual(mappingCall.body, {
  asin: 'B0TESTASIN',
  parentAsin: 'B0PARENT',
  listingStatus: 'ACTIVE',
});
assert(calls.some((call) => call.method === 'deleteStoreProduct'
  && call.storeId === 'store-dev-01'
  && call.productId === 'product-01'
  && call.sellerSku === 'SKU-01'));

await assert.rejects(() => governance.createProduct({ modelCode: '   ' }), /product_model_code_required/);
await assert.rejects(() => governance.updateProduct('', {}), /product_id_required/);
await assert.rejects(() => governance.listStoreMappings('', {}), /store_id_required/);
await assert.rejects(() => governance.putStoreMapping('store-dev-01', '', 'SKU', {}), /product_id_required/);
await assert.rejects(() => governance.putStoreMapping('store-dev-01', 'product-01', '   ', {}), /seller_sku_required/);

assert.match(buildSource, /cloudflare-native-product-governance-v1\.js/,
  'native build must include the Phase 3 product governance console');
assert.match(allowlistSource, /cloudflare-native-product-governance-v1\.js/,
  'native asset allowlist must include the Phase 3 product governance console');

console.log(JSON.stringify({
  ok: true,
  contract: 'phase3-product-governance-console-v1',
  transport: 'CloudflareNativeAPI-only',
  storeScopedRbac: true,
  storePayloadCompatibility: 'camelCase+snake_case',
  amazonDormant: true,
  productionMutation: false,
  calls: calls.map((call) => call.method),
}, null, 2));
