import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  OPERATIONAL_UAT_CASES,
  executeOperationalUatCase,
} from '../cloudflare/runtime/operational-uat-live-probe.js';
import {
  authorizeOperationalUatEphemeralServiceAccess,
} from '../cloudflare/runtime/operational-uat-ephemeral-service-route.js';

class FakeControlDb {
  prepare(sql) {
    return new FakeStatement(String(sql));
  }
}

class FakeStatement {
  constructor(sql, params = []) {
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new FakeStatement(this.sql, params);
  }

  async first() {
    if (this.sql.includes('__operational_uat_intentionally_missing_table_v1')) {
      throw new Error('no such table: intentional operational UAT probe');
    }
    if (this.sql.includes('SELECT u.user_id, sm.store_id AS allowed_store_id')) {
      return { user_id: 'uat-limited-user', allowed_store_id: 'store-01' };
    }
    if (this.sql.includes('SELECT s.store_id')) {
      return { store_id: 'store-02' };
    }
    if (this.sql.includes('FROM user_global_roles ugr')) return null;
    if (this.sql.includes('FROM store_members sm')) {
      return this.params[1] === 'store-01' ? { ok: 1 } : null;
    }
    return null;
  }
}

const request = new Request('https://example.invalid/api/v1/operational-uat/live-probe', { method: 'POST' });
const expected = new Map([
  ['csv.duplicate-import', 200],
  ['csv.missing-identifiers', 200],
  ['csv.date-gaps', 200],
  ['csv.import-overlap', 200],
  ['permission.store-access-mismatch', 200],
  ['failure.d1-query', 503],
  ['failure.stale-request', 409],
  ['failure.worker-error', 500],
  ['failure.missing-binding', 503],
]);

assert.deepEqual(OPERATIONAL_UAT_CASES, [...expected.keys()]);
assert.equal(OPERATIONAL_UAT_CASES.includes('failure.release-rollback'), false, 'rollback must remain a real deployment drill');

const ephemeralAuthorized = authorizeOperationalUatEphemeralServiceAccess({
  configured: true,
  authenticated: true,
  identity: { principalType: 'service_token', sub: 'temporary-uat-client.access' },
});
assert.equal(ephemeralAuthorized.ok, true);
assert.equal(ephemeralAuthorized.authorizationMode, 'secondary_access_service_token');
assert.equal(ephemeralAuthorized.sub, 'temporary-uat-client.access');

for (const [label, access, status] of [
  ['not configured', { configured: false, authenticated: false }, 503],
  ['not authenticated', { configured: true, authenticated: false }, 401],
  ['human principal', { configured: true, authenticated: true, identity: { principalType: 'user', sub: 'human-sub' } }, 403],
  ['malformed service subject', { configured: true, authenticated: true, identity: { principalType: 'service_token', sub: 'not-access-client' } }, 403],
]) {
  const result = authorizeOperationalUatEphemeralServiceAccess(access);
  assert.equal(result.ok, false, `${label} must fail closed`);
  assert.equal(result.status, status, `${label} status`);
}

for (const [caseId, expectedStatus] of expected) {
  const env = { CONTROL_DB: new FakeControlDb() };
  const response = await executeOperationalUatCase(caseId, { request, env, actor: { principalType: 'service_token' } });
  assert.equal(response.status, expectedStatus, `${caseId} status`);
  const payload = await response.json();
  assert.equal(payload.caseId, caseId, `${caseId} case id`);
  assert.equal(payload.verified, true, `${caseId} verified`);
  assert.equal(payload.amazonExecutionAttempted, false, `${caseId} no Amazon execution`);
  assert.equal(payload.crossStoreLeakageDetected, false, `${caseId} no cross-store leakage`);
  assert.equal(payload.fabricatedZeroPerformance, false, `${caseId} no fabricated zero performance`);
  assert.equal(payload.businessFactPersistenceAttempted, false, `${caseId} no business fact persistence`);
  assert.equal(payload.failClosed, true, `${caseId} fail closed`);
}

const duplicate = await executeOperationalUatCase('csv.duplicate-import', { request, env: {} });
const duplicateBody = await duplicate.json();
assert.equal(duplicateBody.observed.secondAction, 'csv_import_duplicate');
assert.equal(duplicateBody.observed.duplicateReusedOriginalImportId, true);
assert.equal(duplicateBody.observed.commitCount, 1);
assert.equal(duplicateBody.observed.sourcePersistCount, 1);
assert.equal(duplicateBody.observed.persistenceScope, 'request_memory_only');

const gaps = await executeOperationalUatCase('csv.date-gaps', { request, env: {} });
const gapsBody = await gaps.json();
assert.equal(gapsBody.observed.qualityState, 'gap_detected');
assert.equal(gapsBody.observed.gapStartDate, '2026-01-02');
assert.equal(gapsBody.observed.gapEndDate, '2026-01-02');

const overlap = await executeOperationalUatCase('csv.import-overlap', { request, env: {} });
const overlapBody = await overlap.json();
assert.equal(overlapBody.observed.qualityState, 'overlap_detected');
assert.equal(overlapBody.observed.doubleCountRisk, true);
assert.equal(overlapBody.observed.safeForNaiveAggregation, false);

for (const path of [
  '../cloudflare/runtime/operational-uat-live-probe.js',
  '../cloudflare/runtime/operational-uat-ephemeral-service-route.js',
]) {
  const source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
  for (const forbidden of ['AMAZON_SYNC_WORKFLOW', 'advertising-api.amazon', 'sellingpartnerapi', 'amazon-ads']) {
    assert.equal(source.includes(forbidden), false, `${path} must not reference ${forbidden}`);
  }
}

const runtimeEntry = await fs.readFile(new URL('../cloudflare/runtime/runtime-observed-entry.js', import.meta.url), 'utf8');
assert.match(runtimeEntry, /handleOperationalUatEphemeralServiceRoute/);
assert.match(runtimeEntry, /OPERATIONAL_UAT_ROUTE|operational-uat\/live-probe/);
assert.doesNotMatch(runtimeEntry, /handleOperationalUatLiveProbeRoute/);

console.log(JSON.stringify({
  ok: true,
  contract: 'operational-uat-live-probe',
  caseCount: OPERATIONAL_UAT_CASES.length,
  releaseRollbackExcluded: true,
  ephemeralServiceAuthorizationOnly: true,
  noPersistentActorBindingRequired: true,
  noAmazonExecution: true,
  noBusinessFactPersistence: true,
}));
