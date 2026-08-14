import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleProductKeywordsApiRoute } from '../cloudflare/runtime/product-keywords-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/product-keywords-api.js'), 'utf8');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const clientSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-api-v1.js'), 'utf8');

function createDb({ productsManage = true, keywordsManage = true, productExists = true, keywordExists = true } = {}) {
  const state = { mapping: null, audits: [] };
  const db = {
    state,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes("JOIN app_roles ar") && sql.includes("role_scope = 'global'")) {
                const permission = params[1];
                if (permission === 'products.manage') return productsManage ? { ok: 1 } : null;
                if (permission === 'keywords.manage') return keywordsManage ? { ok: 1 } : null;
              }
              if (sql.includes('FROM products')) {
                if (!productExists || params[0] !== 'product-synth-dev-01') return null;
                return {
                  product_id: 'product-synth-dev-01', model_code: 'SYNTH-MODEL-01', model_name: 'Synthetic Product 01',
                  brand: 'SYNTH', status: 'active', created_at: '2026-08-14 09:35:29', updated_at: '2026-08-14 09:35:29',
                };
              }
              if (sql.includes('FROM keyword_library')) {
                if (!keywordExists || params[0] !== 'keyword-synth-dev-01') return null;
                return { keyword_id: 'keyword-synth-dev-01' };
              }
              if (sql.includes('FROM keyword_product_map m') && sql.includes('JOIN keyword_library')) {
                if (!state.mapping) return null;
                return {
                  keyword_id: 'keyword-synth-dev-01', keyword_text: 'reading glasses women', normalized_term: 'reading glasses women',
                  language_code: 'en-US', intent_class: 'commercial', semantic_cluster: 'reading-glasses', lifecycle_status: 'active',
                  source_type: 'manual', keyword_notes: null, relevance_score: state.mapping.relevanceScore,
                  priority: state.mapping.priority, is_primary: state.mapping.isPrimary ? 1 : 0, mapping_notes: state.mapping.notes,
                  mapped_at: state.mapping.mappedAt, mapping_updated_at: state.mapping.updatedAt,
                };
              }
              if (sql.includes('FROM keyword_product_map')) {
                return state.mapping ? { keyword_id: 'keyword-synth-dev-01', product_id: 'product-synth-dev-01' } : null;
              }
              throw new Error(`unexpected first query: ${sql}`);
            },
            async run() {
              if (sql.includes('INSERT INTO keyword_product_map')) {
                const now = state.mapping?.mappedAt || '2026-08-14 12:40:00';
                state.mapping = {
                  relevanceScore: params[2], priority: params[3], isPrimary: Boolean(params[4]), notes: params[5],
                  mappedAt: now, updatedAt: '2026-08-14 12:40:00',
                };
                return { success: true };
              }
              if (sql.includes('DELETE FROM keyword_product_map')) {
                state.mapping = null;
                return { success: true };
              }
              if (sql.includes('INSERT INTO audit_log')) {
                state.audits.push({ actorUserId: params[1], action: params[2], entityType: params[3], entityId: params[4], details: JSON.parse(params[7]) });
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

const db = createDb();
const putUrl = 'https://example.test/api/v1/products/product-synth-dev-01/keywords/keyword-synth-dev-01';
const putRequest = new Request(putUrl, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'cf-ray': 'gate10-put-ray' },
  body: JSON.stringify({ relevanceScore: 925, priority: 10, isPrimary: true, notes: 'primary product keyword' }),
});
const created = await handleProductKeywordsApiRoute({ request: putRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(putRequest.url) });
assert.equal(created.status, 201);
assert.equal(created.headers.get('cache-control'), 'no-store');
assert.equal(created.headers.get('x-request-id'), 'gate10-put-ray');
const createdPayload = await created.json();
assert.equal(createdPayload.product.productId, 'product-synth-dev-01');
assert.deepEqual(createdPayload.mapping, {
  keywordId: 'keyword-synth-dev-01', keywordText: 'reading glasses women', normalizedTerm: 'reading glasses women',
  languageCode: 'en-US', intentClass: 'commercial', semanticCluster: 'reading-glasses', lifecycleStatus: 'active',
  sourceType: 'manual', keywordNotes: null, relevanceScore: 925, priority: 10, isPrimary: true,
  mappingNotes: 'primary product keyword', mappedAt: '2026-08-14 12:40:00', updatedAt: '2026-08-14 12:40:00',
});
assert.equal(db.state.audits.length, 1);
assert.equal(db.state.audits[0].action, 'product_keyword.upsert');
assert.equal(db.state.audits[0].entityType, 'keyword_product_map');

const updateRequest = new Request(putUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relevanceScore: 800, priority: 20, isPrimary: false }) });
const updated = await handleProductKeywordsApiRoute({ request: updateRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(updateRequest.url) });
assert.equal(updated.status, 200);
assert.equal((await updated.json()).mapping.relevanceScore, 800);
assert.equal(db.state.audits.length, 2);

const deniedRequest = new Request(putUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
const denied = await handleProductKeywordsApiRoute({ request: deniedRequest, env: { CONTROL_DB: createDb({ productsManage: false }) }, actor: { user_id: 'store-scoped-operator' }, url: new URL(deniedRequest.url) });
assert.equal(denied.status, 403);
assert.deepEqual(await denied.json(), { error: 'forbidden', permission: 'products.manage' });

const keywordDeniedRequest = new Request(putUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
const keywordDenied = await handleProductKeywordsApiRoute({ request: keywordDeniedRequest, env: { CONTROL_DB: createDb({ keywordsManage: false }) }, actor: { user_id: 'global-without-keywords-manage' }, url: new URL(keywordDeniedRequest.url) });
assert.equal(keywordDenied.status, 403);
assert.deepEqual(await keywordDenied.json(), { error: 'forbidden', permission: 'keywords.manage' });

const invalidRequest = new Request(putUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relevanceScore: 1001 }) });
const invalid = await handleProductKeywordsApiRoute({ request: invalidRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(invalidRequest.url) });
assert.equal(invalid.status, 400);
assert.deepEqual(await invalid.json(), { error: 'invalid_relevance_score' });

const missingKeywordRequest = new Request(putUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
const missingKeyword = await handleProductKeywordsApiRoute({ request: missingKeywordRequest, env: { CONTROL_DB: createDb({ keywordExists: false }) }, actor: { user_id: 'user-dev-owner' }, url: new URL(missingKeywordRequest.url) });
assert.equal(missingKeyword.status, 404);
assert.deepEqual(await missingKeyword.json(), { error: 'keyword_not_found' });

const deleteRequest = new Request(putUrl, { method: 'DELETE', headers: { 'cf-ray': 'gate10-delete-ray' } });
const deleted = await handleProductKeywordsApiRoute({ request: deleteRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(deleteRequest.url) });
assert.equal(deleted.status, 200);
assert.deepEqual(await deleted.json(), { deleted: true, productId: 'product-synth-dev-01', keywordId: 'keyword-synth-dev-01' });
assert.equal(db.state.mapping, null);
assert.equal(db.state.audits.at(-1).action, 'product_keyword.delete');

const missingDeleteRequest = new Request(putUrl, { method: 'DELETE' });
const missingDelete = await handleProductKeywordsApiRoute({ request: missingDeleteRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(missingDeleteRequest.url) });
assert.equal(missingDelete.status, 404);
assert.deepEqual(await missingDelete.json(), { error: 'product_keyword_mapping_not_found' });

assert.match(apiSource, /app_roles ar[\s\S]*role_scope = 'global'/);
assert.match(apiSource, /ON CONFLICT\(keyword_id, product_id\) DO UPDATE/);
assert.match(apiSource, /INSERT INTO audit_log/);
assert.doesNotMatch(apiSource, /AMAZON_SYNC_WORKFLOW|STORE_01_DB|SYNC_TRIGGER_ENABLED/);
assert.match(webEntrySource, /PRODUCT_KEYWORDS_ROUTE_PATTERN/);
assert.match(webEntrySource, /keywords\(\?:\\\/\[\^\/\]\+\)\?/);
assert.match(clientSource, /putProductKeyword:\s*\(productId, keywordId, body\)/);
assert.match(clientSource, /deleteProductKeyword:\s*\(productId, keywordId\)/);
assert.match(clientSource, /method: 'PUT'/);
assert.match(clientSource, /method: 'DELETE'/);

console.log(JSON.stringify({
  ok: true,
  gate: 10,
  contracts: [
    'product-keyword-write-item-route',
    'product-keyword-global-governance-rbac',
    'product-keyword-upsert-idempotency',
    'product-keyword-input-bounds',
    'product-keyword-audit-log',
    'product-keyword-delete-governance',
    'product-keyword-control-d1-only',
    'product-keyword-client-write-contract',
  ],
}));
