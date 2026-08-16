import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleProductKeywordsApiRoute } from '../cloudflare/runtime/product-keywords-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const clientSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-api-v1.js'), 'utf8');

function createDb({ productsRead = true, keywordsRead = true, productExists = true } = {}) {
  const mappings = [
    {
      keyword_id: 'keyword-synth-dev-02', keyword_text: 'reading glasses women', normalized_term: 'reading glasses women',
      language_code: 'en-US', intent_class: 'commercial', semantic_cluster: 'reading-glasses', lifecycle_status: 'active',
      source_type: 'manual', keyword_notes: null, relevance_score: 950, priority: 10, is_primary: 1,
      mapping_notes: 'synthetic mapping', mapped_at: '2026-08-14 12:00:00', mapping_updated_at: '2026-08-14 12:00:00',
    },
    {
      keyword_id: 'keyword-synth-dev-01', keyword_text: 'readers for women', normalized_term: 'readers for women',
      language_code: 'en-US', intent_class: 'commercial', semantic_cluster: 'reading-glasses', lifecycle_status: 'watch',
      source_type: 'manual', keyword_notes: null, relevance_score: 800, priority: 20, is_primary: 0,
      mapping_notes: null, mapped_at: '2026-08-14 11:00:00', mapping_updated_at: '2026-08-14 11:00:00',
    },
  ];

  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes('FROM role_permissions')) {
                const permission = params[1];
                if (permission === 'products.read') return productsRead ? { ok: 1 } : null;
                if (permission === 'keywords.read') return keywordsRead ? { ok: 1 } : null;
              }
              if (sql.includes('FROM products')) {
                if (!productExists || params[0] !== 'product-synth-dev-01') return null;
                return {
                  product_id: 'product-synth-dev-01', model_code: 'SYNTH-MODEL-01', model_name: 'Synthetic Product 01',
                  brand: 'SYNTH', status: 'active', created_at: '2026-08-14 09:35:29', updated_at: '2026-08-14 09:35:29',
                };
              }
              throw new Error(`unexpected first query: ${sql}`);
            },
            async all() {
              if (!sql.includes('FROM keyword_product_map')) throw new Error(`unexpected all query: ${sql}`);
              return { results: mappings };
            },
          };
        },
      };
    },
  };
}

const request = new Request('https://example.test/api/v1/products/product-synth-dev-01/keywords?limit=1&q=reading&lifecycleStatus=active&isPrimary=true', {
  headers: { 'cf-ray': 'gate9-test-ray' },
});
const response = await handleProductKeywordsApiRoute({
  request, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(request.url),
});
assert(response, 'product keywords route must return a response');
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.equal(response.headers.get('x-request-id'), 'gate9-test-ray');
const payload = await response.json();
assert.deepEqual(payload.product, {
  productId: 'product-synth-dev-01', modelCode: 'SYNTH-MODEL-01', modelName: 'Synthetic Product 01', brand: 'SYNTH',
  productStatus: 'active', createdAt: '2026-08-14 09:35:29', updatedAt: '2026-08-14 09:35:29',
});
assert.equal(payload.items.length, 1);
assert.deepEqual(payload.items[0], {
  keywordId: 'keyword-synth-dev-02', keywordText: 'reading glasses women', normalizedTerm: 'reading glasses women',
  languageCode: 'en-US', intentClass: 'commercial', semanticCluster: 'reading-glasses', lifecycleStatus: 'active',
  sourceType: 'manual', keywordNotes: null, relevanceScore: 950, priority: 10, isPrimary: true,
  mappingNotes: 'synthetic mapping', mappedAt: '2026-08-14 12:00:00', updatedAt: '2026-08-14 12:00:00',
});
assert.equal(typeof payload.nextCursor, 'string');
assert(!JSON.stringify(payload).includes('CONTROL_DB'), 'binding identifiers must not leak to browser payload');

const productDeniedRequest = new Request('https://example.test/api/v1/products/product-synth-dev-01/keywords');
const productDenied = await handleProductKeywordsApiRoute({
  request: productDeniedRequest, env: { CONTROL_DB: createDb({ productsRead: false }) },
  actor: { user_id: 'user-without-product-read' }, url: new URL(productDeniedRequest.url),
});
assert.equal(productDenied.status, 403);
assert.deepEqual(await productDenied.json(), { error: 'forbidden', permission: 'products.read' });

const keywordDeniedRequest = new Request('https://example.test/api/v1/products/product-synth-dev-01/keywords');
const keywordDenied = await handleProductKeywordsApiRoute({
  request: keywordDeniedRequest, env: { CONTROL_DB: createDb({ keywordsRead: false }) },
  actor: { user_id: 'user-without-keyword-read' }, url: new URL(keywordDeniedRequest.url),
});
assert.equal(keywordDenied.status, 403);
assert.deepEqual(await keywordDenied.json(), { error: 'forbidden', permission: 'keywords.read' });

const missingRequest = new Request('https://example.test/api/v1/products/product-missing/keywords');
const missing = await handleProductKeywordsApiRoute({
  request: missingRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(missingRequest.url),
});
assert.equal(missing.status, 404);
assert.deepEqual(await missing.json(), { error: 'product_not_found' });

const invalidRequest = new Request('https://example.test/api/v1/products/product-synth-dev-01/keywords?isPrimary=maybe');
const invalid = await handleProductKeywordsApiRoute({
  request: invalidRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(invalidRequest.url),
});
assert.equal(invalid.status, 400);
assert.deepEqual(await invalid.json(), { error: 'invalid_is_primary' });

const writeRequest = new Request('https://example.test/api/v1/products/product-synth-dev-01/keywords', { method: 'POST' });
const writeResponse = await handleProductKeywordsApiRoute({
  request: writeRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(writeRequest.url),
});
assert.equal(writeResponse.status, 405);
assert.deepEqual(await writeResponse.json(), { error: 'method_not_allowed' });

assert.match(webEntrySource, /handleProductKeywordsApiRoute/);
assert.match(webEntrySource, /PRODUCT_KEYWORDS_ROUTE_PATTERN/);
assert.match(clientSource, /productKeywords:\s*\(productId, params\)/);
assert.match(clientSource, /\/products\/\$\{encodeURIComponent\(productId\)\}\/keywords/);

console.log(JSON.stringify({
  ok: true,
  gate: 9,
  contracts: [
    'product-keyword-route-same-origin',
    'product-keyword-central-read-rbac',
    'product-keyword-control-d1-map',
    'product-keyword-keyset-pagination',
    'product-keyword-read-only',
    'product-keyword-binding-not-exposed',
    'product-keyword-client-contract',
  ],
}));
