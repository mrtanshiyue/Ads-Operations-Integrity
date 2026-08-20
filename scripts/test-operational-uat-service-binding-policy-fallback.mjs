import assert from 'node:assert/strict';
import { handleOperationalUatEphemeralServiceRoute } from '../cloudflare/runtime/operational-uat-ephemeral-service-route.js';

const queries = [];
const db = {
  prepare(sql) {
    const text = String(sql || '');
    queries.push(text);
    const statement = {
      bind() { return statement; },
      async first() {
        if (/FROM\s+users\s+u/i.test(text)) return null;
        return null;
      },
      async all() {
        if (/FROM\s+app_roles\s+ar/i.test(text) && /ads\.read/i.test(text)) {
          return {
            results: [
              { role_key: 'owner', role_scope: 'global', priority: 1, permission_key: 'ads.read' },
              { role_key: 'viewer', role_scope: 'store', priority: 90, permission_key: 'ads.read' },
            ],
          };
        }
        if (/FROM\s+stores/i.test(text)) {
          return {
            results: [
              { store_id: 'store-01', store_code: 'STORE01' },
              { store_id: 'store-02', store_code: 'STORE02' },
            ],
          };
        }
        return { results: [] };
      },
    };
    return statement;
  },
};

const request = new Request('https://service-binding.internal/api/v1/operational-uat/live-probe', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-operational-uat-internal-binding': 'cloudflare-service-binding-v1',
    'x-operational-uat-confirm': 'non-amazon-live-probe-v1',
  },
  body: JSON.stringify({ caseId: 'permission.store-access-mismatch' }),
});

const response = await handleOperationalUatEphemeralServiceRoute({
  request,
  env: {
    APP_ENV: 'production',
    ACCESS_MODE: 'enforce',
    OPERATIONAL_UAT_ACCESS_AUD: 'configured-secondary-audience',
    CONTROL_DB: db,
  },
});

assert.equal(response.status, 200);
const payload = await response.json();
assert.equal(payload.caseId, 'permission.store-access-mismatch');
assert.equal(payload.verified, true);
assert.equal(payload.authorizationMode, 'cloudflare_service_binding');
assert.equal(payload.amazonExecutionAttempted, false);
assert.equal(payload.crossStoreLeakageDetected, false);
assert.equal(payload.fabricatedZeroPerformance, false);
assert.equal(payload.businessFactPersistenceAttempted, false);
assert.equal(payload.failClosed, true);
assert.equal(payload.observed.policyProbe, 'production_control_db_read_only_policy_simulation');
assert.equal(payload.observed.allowedStorePermission, true);
assert.equal(payload.observed.deniedStorePermission, false);
assert.equal(payload.observed.assignedGlobalRoleCount, 0);
assert.equal(payload.observed.persistentActorCreated, false);
assert.equal(payload.observed.permissionMutationAttempted, false);
assert.equal(payload.observed.persistenceScope, 'none');
assert.equal(payload.observed.fallbackFromPersistedCandidateReason, 'no_non_global_store_member_candidate');
assert.ok(queries.length >= 3);
assert.ok(queries.every((sql) => sql.trim().toUpperCase().startsWith('SELECT')));

console.log(JSON.stringify({
  ok: true,
  caseId: payload.caseId,
  policyProbe: payload.observed.policyProbe,
  readOnlyQueries: queries.length,
}));
