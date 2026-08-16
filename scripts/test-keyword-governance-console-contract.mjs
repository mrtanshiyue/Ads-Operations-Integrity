import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-keyword-governance-v1.js'), 'utf8');
const buildSource = await readFile(path.join(repoRoot, 'scripts/build-cloudflare-native-copy-all.mjs'), 'utf8');
const allowlistSource = await readFile(path.join(repoRoot, 'scripts/enforce-cloudflare-native-asset-allowlist.mjs'), 'utf8');

new vm.Script(source, { filename: 'cloudflare-native-keyword-governance-v1.js' });
assert.doesNotMatch(source, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(|wrangler\s+deploy/i);
assert.doesNotMatch(source, /fetch\s*\(/, 'keyword console must delegate transport to CloudflareNativeAPI');
assert.match(source, /keywords\.manage/);
assert.match(source, /products\.manage/);
assert.match(source, /Control D1/);

const calls = [];
const window = {
  CloudflareNativeAPI: {
    listKeywords(params) {
      calls.push({ method: 'listKeywords', params: { ...params } });
      return Promise.resolve({ items: [] });
    },
    createKeyword(body) {
      calls.push({ method: 'createKeyword', body: { ...body } });
      return Promise.resolve({ keyword: { keywordId: 'keyword-new', ...body } });
    },
    updateKeyword(keywordId, body) {
      calls.push({ method: 'updateKeyword', keywordId, body: { ...body } });
      return Promise.resolve({ keyword: { keywordId, ...body } });
    },
    listProducts(params) {
      calls.push({ method: 'listProducts', params: { ...params } });
      return Promise.resolve({ items: [] });
    },
    productKeywords(productId, params) {
      calls.push({ method: 'productKeywords', productId, params: { ...params } });
      return Promise.resolve({ items: [] });
    },
    putProductKeyword(productId, keywordId, body) {
      calls.push({ method: 'putProductKeyword', productId, keywordId, body: { ...body } });
      return Promise.resolve({ mapping: { productId, keywordId, ...body } });
    },
    deleteProductKeyword(productId, keywordId) {
      calls.push({ method: 'deleteProductKeyword', productId, keywordId });
      return Promise.resolve({ deleted: true });
    },
  },
};

vm.runInNewContext(source, { window, console, Set, Object, Array, String, Number, Boolean, Math, Error, Promise }, {
  filename: 'cloudflare-native-keyword-governance-v1.js',
});

const governance = window.CloudflareKeywordGovernance;
assert(governance, 'CloudflareKeywordGovernance was not installed');
assert.equal(governance.version, '1.0.0');

await governance.listLibrary({ q: 'reading glasses', status: 'active' });
await governance.createKeyword({
  keywordText: ' Reading Glasses Women ',
  intentClass: ' category ',
  semanticCluster: ' readers ',
});
await governance.updateKeyword('keyword-01', { lifecycleStatus: 'watch' });
await governance.listProducts({ q: 'YTDBNS' });
await governance.listProductMappings('product-01', { lifecycleStatus: 'active' });
await governance.putProductMapping('product-01', 'keyword-01', {
  relevanceScore: 850,
  priority: 25,
  isPrimary: true,
  notes: 'Primary conversion term',
});
await governance.deleteProductMapping('product-01', 'keyword-01');

const listCall = calls.find((call) => call.method === 'listKeywords');
assert.equal(listCall.params.limit, 200);
assert.equal(listCall.params.q, 'reading glasses');
assert.equal(listCall.params.status, 'active');

const createCall = calls.find((call) => call.method === 'createKeyword');
assert.equal(createCall.body.keywordText, 'Reading Glasses Women');
assert.equal(createCall.body.normalizedTerm, 'reading glasses women');
assert.equal(createCall.body.languageCode, 'en-US');
assert.equal(createCall.body.intentClass, 'category');
assert.equal(createCall.body.semanticCluster, 'readers');
assert.equal(createCall.body.lifecycleStatus, 'active');
assert.equal(createCall.body.sourceType, 'manual');

assert(calls.some((call) => call.method === 'updateKeyword'
  && call.keywordId === 'keyword-01'
  && call.body.lifecycleStatus === 'watch'));
assert(calls.some((call) => call.method === 'listProducts'
  && call.params.limit === 200
  && call.params.status === 'active'
  && call.params.q === 'YTDBNS'));
assert(calls.some((call) => call.method === 'productKeywords'
  && call.productId === 'product-01'
  && call.params.limit === 200
  && call.params.lifecycleStatus === 'active'));

const mappingCall = calls.find((call) => call.method === 'putProductKeyword');
assert.equal(mappingCall.productId, 'product-01');
assert.equal(mappingCall.keywordId, 'keyword-01');
assert.deepEqual(mappingCall.body, {
  relevanceScore: 850,
  priority: 25,
  isPrimary: true,
  notes: 'Primary conversion term',
});
assert(calls.some((call) => call.method === 'deleteProductKeyword'
  && call.productId === 'product-01'
  && call.keywordId === 'keyword-01'));

await assert.rejects(() => governance.createKeyword({ keywordText: '   ' }), /keyword_text_required/);
await assert.rejects(() => governance.listProductMappings('', {}), /product_id_required/);
await assert.rejects(() => governance.putProductMapping('product-01', '', {}), /keyword_id_required/);

assert.match(buildSource, /cloudflare-native-keyword-governance-v1\.js/,
  'native build must include the Phase 3 keyword governance console');
assert.match(allowlistSource, /cloudflare-native-keyword-governance-v1\.js/,
  'native asset allowlist must include the Phase 3 keyword governance console');

console.log(JSON.stringify({
  ok: true,
  contract: 'phase3-keyword-governance-console-v1',
  transport: 'CloudflareNativeAPI-only',
  amazonDormant: true,
  productionMutation: false,
  calls: calls.map((call) => call.method),
}, null, 2));
