import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleProductKeywordsApiRoute } from '../cloudflare/runtime/product-keywords-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/product-keywords-api.js'), 'utf8');
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const clientSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-api-v1.js'), 'utf8');

function createDb({
  productsManage = true,
  keywordsManage = true,
  productExists = true,
  keywordExists = true,
  revokePermissionBeforeBatch = null,
  failAudit = false,
} = {}) {
  const state = {
    mapping: null,
    audits: [],
    permissions: { productsManage, keywordsManage },
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
              if (sql.includes('JOIN app_roles ar') && sql.includes("role_scope = 'global'")) {
                const permission = params[1];
                if (permission === 'products.manage') return state.permissions.productsManage ? { ok: 1 } : null;
                if (permission === 'keywords.manage') return state.permissions.keywordsManage ? { ok: 1 } : null;
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
                if (!state.permissions.productsManage || !state.permissions.keywordsManage) {
                  state.lastChanges = 0;
                  return { success: true, meta: { changes: 0 } };
                }
                const now = state.mapping?.mappedAt || '2026-08-14 12:40:00';
                state.mapping = {
                  relevanceScore: params[2], priority: params[3], isPrimary: Boolean(params[4]), notes: params[5],
                  mappedAt: now, updatedAt: '2026-08-14 12:40:00',
                };
                state.lastChanges = 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM keyword_product_map')) {
                if (!state.permissions.productsManage || !state.permissions.keywordsManage) {
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
                  actorUserId: params[1], action: params[2], entityType: params[3], entityId: params[4], details: JSON.parse(params[7]),
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
      if (state.revokePermissionBeforeBatch === 'products.manage') state.permissions.productsManage = false;
      if (state.revokePermissionBeforeBatch === 'keywords.manage') state.permissions.keywordsManage = false;
      state.revokePermissionBeforeBatch = null;
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

const putUrl = 'https://example.test/api/v1/products/product-synth-dev-01/keywords/keyword-synth-dev-01';
function makePutRequest(headers = {}, body = { relevanceScore: 925, priority: 10, isPrimary: true, notes: 'primary product keyword' }) {
  return new Request(putUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const db = createDb();
const putRequest = makePutRequest({ 'cf-ray': 'gate10-put-ray' });
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
assert.equal(db.state.batchCalls, 1);

const updateRequest = makePutRequest({}, { relevanceScore: 800, priority: 20, isPrimary: false });
const updated = await handleProductKeywordsApiRoute({ request: updateRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(updateRequest.url) });
assert.equal(updated.status, 200);
assert.equal((await updated.json()).mapping.relevanceScore, 800);
assert.equal(db.state.audits.length, 2);
assert.equal(db.state.batchCalls, 2);

const deniedRequest = makePutRequest({}, {});
const denied = await handleProductKeywordsApiRoute({ request: deniedRequest, env: { CONTROL_DB: createDb({ productsManage: false }) }, actor: { user_id: 'store-scoped-operator' }, url: new URL(deniedRequest.url) });
assert.equal(denied.status, 403);
assert.deepEqual(await denied.json(), { error: 'forbidden', permission: 'products.manage' });

const keywordDeniedRequest = makePutRequest({}, {});
const keywordDenied = await handleProductKeywordsApiRoute({ request: keywordDeniedRequest, env: { CONTROL_DB: createDb({ keywordsManage: false }) }, actor: { user_id: 'global-without-keywords-manage' }, url: new URL(keywordDeniedRequest.url) });
assert.equal(keywordDenied.status, 403);
assert.deepEqual(await keywordDenied.json(), { error: 'forbidden', permission: 'keywords.manage' });

const invalidRequest = makePutRequest({}, { relevanceScore: 1001 });
const invalid = await handleProductKeywordsApiRoute({ request: invalidRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(invalidRequest.url) });
assert.equal(invalid.status, 400);
assert.deepEqual(await invalid.json(), { error: 'invalid_relevance_score' });

const missingKeywordRequest = makePutRequest({}, {});
const missingKeyword = await handleProductKeywordsApiRoute({ request: missingKeywordRequest, env: { CONTROL_DB: createDb({ keywordExists: false }) }, actor: { user_id: 'user-dev-owner' }, url: new URL(missingKeywordRequest.url) });
assert.equal(missingKeyword.status, 404);
assert.deepEqual(await missingKeyword.json(), { error: 'keyword_not_found' });

const putAuditFailureDb = createDb({ failAudit: true });
const putAuditFailureRequest = makePutRequest();
await assert.rejects(
  handleProductKeywordsApiRoute({
    request: putAuditFailureRequest,
    env: { CONTROL_DB: putAuditFailureDb },
    actor: { user_id: 'user-dev-owner' },
    url: new URL(putAuditFailureRequest.url),
  }),
  /synthetic_audit_failure/,
);
assert.equal(putAuditFailureDb.state.mapping, null);
assert.equal(putAuditFailureDb.state.audits.length, 0);

const putRevokedDb = createDb({ revokePermissionBeforeBatch: 'keywords.manage' });
const putRevokedRequest = makePutRequest();
const putRevoked = await handleProductKeywordsApiRoute({
  request: putRevokedRequest,
  env: { CONTROL_DB: putRevokedDb },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(putRevokedRequest.url),
});
assert.equal(putRevoked.status, 403);
assert.deepEqual(await putRevoked.json(), { error: 'forbidden', permission: 'keywords.manage' });
assert.equal(putRevokedDb.state.mapping, null);
assert.equal(putRevokedDb.state.audits.length, 0);

const deleteRequest = new Request(putUrl, { method: 'DELETE', headers: { 'cf-ray': 'gate10-delete-ray' } });
const deleted = await handleProductKeywordsApiRoute({ request: deleteRequest, env: { CONTROL_DB: db }, actor: { user_id: 'user-dev-owner' }, url: new URL(deleteRequest.url) });
assert.equal(deleted.status, 200);
assert.deepEqual(await deleted.json(), { deleted: true, productId: 'product-synth-dev-01', keywordId: 'keyword-synth-dev-01' });
assert.equal(db.state.mapping, null);
assert.equal(db.state.audits.at(-1).action, 'product_keyword.delete');
assert.equal(db.state.batchCalls, 3);

const deleteAuditFailureDb = createDb();
const deleteAuditSeedRequest = makePutRequest();
const deleteAuditSeed = await handleProductKeywordsApiRoute({ request: deleteAuditSeedRequest, env: { CONTROL_DB: deleteAuditFailureDb }, actor: { user_id: 'user-dev-owner' }, url: new URL(deleteAuditSeedRequest.url) });
assert.equal(deleteAuditSeed.status, 201);
const deleteAuditCountBefore = deleteAuditFailureDb.state.audits.length;
deleteAuditFailureDb.state.failAudit = true;
const deleteAuditFailureRequest = new Request(putUrl, { method: 'DELETE' });
await assert.rejects(
  handleProductKeywordsApiRoute({
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
const deleteRevokedSeedRequest = makePutRequest();
const deleteRevokedSeed = await handleProductKeywordsApiRoute({ request: deleteRevokedSeedRequest, env: { CONTROL_DB: deleteRevokedDb }, actor: { user_id: 'user-dev-owner' }, url: new URL(deleteRevokedSeedRequest.url) });
assert.equal(deleteRevokedSeed.status, 201);
deleteRevokedDb.state.revokePermissionBeforeBatch = 'products.manage';
const deleteRevokedRequest = new Request(putUrl, { method: 'DELETE' });
const deleteRevoked = await handleProductKeywordsApiRoute({
  request: deleteRevokedRequest,
  env: { CONTROL_DB: deleteRevokedDb },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(deleteRevokedRequest.url),
});
assert.equal(deleteRevoked.status, 403);
assert.deepEqual(await deleteRevoked.json(), { error: 'forbidden', permission: 'products.manage' });
assert.ok(deleteRevokedDb.state.mapping);
assert.equal(deleteRevokedDb.state.audits.length, 1);

const missingDeleteRequest = new Request(putUrl, { method: 'DELETE' });
const missingDelete = await handleProductKeywordsApiRoute({ request: missingDeleteRequest, env: { CONTROL_DB: createDb() }, actor: { user_id: 'user-dev-owner' }, url: new URL(missingDeleteRequest.url) });
assert.equal(missingDelete.status, 404);
assert.deepEqual(await missingDelete.json(), { error: 'product_keyword_mapping_not_found' });

const nonAtomicDb = createDb();
nonAtomicDb.batch = undefined;
const nonAtomicRequest = makePutRequest();
await assert.rejects(
  handleProductKeywordsApiRoute({ request: nonAtomicRequest, env: { CONTROL_DB: nonAtomicDb }, actor: { user_id: 'user-dev-owner' }, url: new URL(nonAtomicRequest.url) }),
  /control_d1_atomic_batch_required/,
);

assert.match(apiSource, /app_roles ar[\s\S]*role_scope = 'global'/);
assert.match(apiSource, /ON CONFLICT\(keyword_id, product_id\) DO UPDATE/);
assert.match(apiSource, /actor_product_permission\.permission_key='products\.manage'/);
assert.match(apiSource, /actor_keyword_permission\.permission_key='keywords\.manage'/);
assert.match(apiSource, /INSERT INTO audit_log[\s\S]*WHERE changes\(\)=1/);
assert.match(apiSource, /db\.batch\(\[mutation, auditStatement\]\)/);
assert.match(apiSource, /control_d1_atomic_batch_required/);
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
    'product-keyword-mutation-time-dual-global-authority',
    'product-keyword-upsert-idempotency',
    'product-keyword-input-bounds',
    'product-keyword-audit-log',
    'product-keyword-atomic-audit-rollback',
    'product-keyword-delete-governance',
    'product-keyword-control-d1-atomic-batch-required',
    'product-keyword-control-d1-only',
    'product-keyword-client-write-contract',
  ],
}));
