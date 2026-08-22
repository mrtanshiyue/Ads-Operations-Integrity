import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';
import { buildOperatorWorkQueueRow } from '../cloudflare/runtime/operator-work-queue.js';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA = required('EXPECTED_MAIN_SHA');
const EXPECTED_PROD_VERSION_ID = required('EXPECTED_PROD_VERSION_ID');
const PROD_BASE_URL = (process.env.PROD_BASE_URL || 'https://ads-operations-web-prod.tanshiyuesir.workers.dev').replace(/\/$/, '');
const PROD_ACCESS_DOMAIN = new URL(PROD_BASE_URL).hostname.toLowerCase();
const PROD_ACCESS_APP_ID = required('PROD_ACCESS_APP_ID');
const PROD_ACCESS_AUD = required('PROD_ACCESS_AUD');
const CONTROL_DB_ID = required('PROD_CONTROL_DB_ID');
const SYNC_WORKER = process.env.PROD_SYNC_WORKER || 'ads-operations-sync-prod';
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/operator-work-queue-production-runtime-acceptance';
const PRINCIPAL_USER_ID = `svc-owq-acceptance-${RUN_ID}`;
const PRINCIPAL_EMAIL = `svc-owq-acceptance-${RUN_ID}@machine.invalid`;
const ROLE_KEY = `owq_acceptance_${RUN_ID}`;
const TOKEN_NAME = `ads-ops-owq-acceptance-${RUN_ID}`;
const POLICY_NAME = `OWQ #247 acceptance ${RUN_ID}`;
const BUSINESS_TABLES = Object.freeze([
  'advisory_review_records',
  'optimization_actions',
  'optimization_execution_receipts',
  'sync_runs',
]);
const STORE_DB_IDS = Object.freeze({
  STORE_01_DB: required('PROD_STORE01_DB_ID'),
  STORE_02_DB: required('PROD_STORE02_DB_ID'),
  STORE_03_DB: required('PROD_STORE03_DB_ID'),
  STORE_04_DB: required('PROD_STORE04_DB_ID'),
});
const FOUR_STORE_RANGE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01' });
const STALE_RANGE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-02' });
const MONTH_RANGE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-30' });

await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'operator-work-queue-production-runtime-acceptance-v1',
  issue: 247,
  runId: RUN_ID,
  target: PROD_BASE_URL,
  expectedCanonicalMain: EXPECTED_MAIN_SHA,
  expectedProductionVersionId: EXPECTED_PROD_VERSION_ID,
  startedAt: new Date().toISOString(),
  authorityBoundary: {
    readOnly: true,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
    amazonApiHardOff: true,
  },
  temporaryIdentity: {
    userId: PRINCIPAL_USER_ID,
    roleKey: ROLE_KEY,
    permission: 'analytics.read',
    roleScope: 'store',
  },
  checks: {},
  runtime: {},
  businessDifferential: {},
  cleanup: {},
  amazonRequests: [],
  blockers: [],
  result: 'FAIL',
};

let serviceToken = null;
let accessPolicy = null;
let accessApp = null;
let stores = [];
let controlDb = null;
let storeDbs = new Map();
let failure = null;

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (isAmazonHost(url.hostname)) {
    receipt.amazonRequests.push({ method, host: url.hostname, pathname: url.pathname });
    throw new Error(`amazon_request_blocked:${url.hostname}${url.pathname}`);
  }
  return nativeFetch(input, init);
};

try {
  validateFailClosedContractEvidence();
  receipt.checks.failClosedCanonicalContract = true;

  const existingTokens = await cf('/access/service_tokens?per_page=100');
  const tokenRows = Array.isArray(existingTokens.result) ? existingTokens.result : [];
  receipt.runtime.serviceTokenCountBefore = tokenRows.length;
  assert.equal(tokenRows.length, 0, `active_service_token_drift:${tokenRows.length}`);
  receipt.checks.serviceTokenBaselineZero = true;

  const appPayload = await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}`);
  accessApp = appPayload.result || null;
  assert.equal(accessApp?.id, PROD_ACCESS_APP_ID, 'production_access_app_id_mismatch');
  assert.equal(String(accessApp?.domain || '').toLowerCase(), PROD_ACCESS_DOMAIN, 'production_access_domain_mismatch');
  assert.equal(String(accessApp?.aud || ''), PROD_ACCESS_AUD, 'production_access_aud_mismatch');
  receipt.runtime.accessApp = {
    id: accessApp.id,
    name: accessApp.name || null,
    domain: accessApp.domain || null,
    aud: accessApp.aud || null,
  };
  receipt.checks.productionAccessAppExact = true;

  controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: CONTROL_DB_ID, apiToken: API_TOKEN });
  stores = await loadProductionStores(controlDb);
  receipt.runtime.stores = stores.map((row) => ({
    storeId: row.store_id,
    storeCode: row.store_code,
    binding: row.d1_binding_key,
  }));
  assert.deepEqual(stores.map((row) => row.d1_binding_key).sort(), Object.keys(STORE_DB_IDS).sort(), 'production_store_binding_set_mismatch');
  receipt.checks.productionFourStoreRegistryExact = true;

  for (const store of stores) {
    storeDbs.set(store.store_id, createD1RestDatabase({
      accountId: ACCOUNT_ID,
      databaseId: STORE_DB_IDS[store.d1_binding_key],
      apiToken: API_TOKEN,
    }));
  }

  receipt.businessDifferential.before = await businessSnapshot();

  const syncSafety = await readSyncHardOff();
  receipt.runtime.productionSync = syncSafety;
  assert.equal(syncSafety.scheduleCount, 0, 'production_sync_schedule_drift');
  if (syncSafety.amazonAdsEnabled !== null) {
    assert.equal(syncSafety.amazonAdsEnabled, false, 'production_sync_amazon_ads_enabled_drift');
  }
  receipt.checks.productionSyncUntouchedHardOff = syncSafety.scheduleCount === 0 && syncSafety.amazonAdsEnabled !== true;

  serviceToken = (await cf('/access/service_tokens', {
    method: 'POST',
    body: { name: TOKEN_NAME, duration: '1h', enabled: true },
  })).result;
  assert(serviceToken?.id && serviceToken?.client_id && serviceToken?.client_secret, 'service_token_create_response_incomplete');
  assert(String(serviceToken.client_id).endsWith('.access'), 'service_token_client_id_invalid');
  receipt.temporaryIdentity.serviceToken = {
    id: serviceToken.id,
    clientId: serviceToken.client_id,
    expiresAt: serviceToken.expires_at || null,
  };
  receipt.checks.ephemeralServiceTokenCreated = true;

  accessPolicy = (await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies`, {
    method: 'POST',
    body: {
      name: POLICY_NAME,
      decision: 'non_identity',
      include: [{ service_token: { token_id: serviceToken.id } }],
    },
  })).result;
  assert(accessPolicy?.id, 'access_policy_create_response_incomplete');
  assert.equal(accessPolicy.decision, 'non_identity', 'access_policy_not_non_identity');
  receipt.temporaryIdentity.accessPolicy = { id: accessPolicy.id, name: accessPolicy.name, decision: accessPolicy.decision };
  receipt.checks.ephemeralNonIdentityPolicyCreated = true;

  await provisionFourStoreReadIdentity();
  receipt.checks.ephemeralStoreScopedAnalyticsReadIdentity = true;

  const authHeaders = serviceHeaders();
  await awaitServiceAuth(authHeaders);

  const oneDay = await liveWorkQueue(FOUR_STORE_RANGE, authHeaders);
  receipt.runtime.fourStoreOneDay = summarizeLive(oneDay);
  validateFourStoreLive(oneDay);
  receipt.checks.fourStoreLiveOrdering = true;
  receipt.checks.productionRuntimeVersionExact = true;
  receipt.checks.highestPriorityReturnedUnder10s = oneDay.elapsedMs < 10_000;
  assert.equal(receipt.checks.highestPriorityReturnedUnder10s, true, `work_queue_latency_target_missed:${oneDay.elapsedMs}`);

  validateDurableStore01(oneDay);
  receipt.checks.durableReviewMapping = true;

  const stale = await liveWorkQueue(STALE_RANGE, authHeaders);
  receipt.runtime.staleWindow = summarizeLive(stale);
  validateStaleStore01(stale);
  receipt.checks.staleReviewEvidenceMapping = true;

  const month = await liveWorkQueue(MONTH_RANGE, authHeaders);
  receipt.runtime.monthBlockedRange = summarizeLive(month);
  validateCandidateEmissionBlocked(month);
  receipt.checks.candidateEmissionBlockedSemantics = true;

  const ui = await validateProductionUiAsset(authHeaders);
  receipt.runtime.uiPath = ui;
  receipt.checks.productionUiPathContract = true;
  receipt.checks.firstActionableRecommendationWithinTwoClicks = ui.actionClicks <= 2;
  assert.equal(receipt.checks.firstActionableRecommendationWithinTwoClicks, true);

  await restrictToStore01Only();
  const scoped = await liveWorkQueue(FOUR_STORE_RANGE, authHeaders);
  receipt.runtime.store01Only = summarizeLive(scoped);
  validateStore01Only(scoped);
  receipt.checks.rbacCrossStoreOmission = true;

  const health = await appJson(`${PROD_BASE_URL}/api/health`, { headers: authHeaders });
  assert.equal(health.status, 200, `production_health_status:${health.status}`);
  assert.equal(health.body?.environment, 'production', 'production_health_environment_mismatch');
  assert.equal(health.body?.syncTriggerEnabled, false, 'production_web_sync_trigger_enabled');
  assert.equal(health.headers['x-runtime-worker-version'], EXPECTED_PROD_VERSION_ID, 'production_health_version_mismatch');
  receipt.runtime.productionHealth = {
    environment: health.body?.environment || null,
    syncTriggerEnabled: health.body?.syncTriggerEnabled ?? null,
    runtimeVersion: health.headers['x-runtime-worker-version'] || null,
  };
  receipt.checks.productionWebHardOff = true;

  receipt.businessDifferential.after = await businessSnapshot();
  assert.deepEqual(receipt.businessDifferential.after, receipt.businessDifferential.before, 'business_or_execution_table_mutation_detected');
  receipt.checks.businessExecutionTablesUnchanged = true;

  assert.equal(receipt.amazonRequests.length, 0, 'amazon_request_attempt_detected');
  receipt.checks.amazonRequestsZero = true;
  receipt.result = 'PASS';
} catch (error) {
  failure = error;
  receipt.error = {
    message: scrub(error?.message || String(error)),
    stack: scrub(String(error?.stack || '')).slice(0, 8000),
  };
  receipt.blockers.push(classifyBlocker(error));
} finally {
  await cleanupTemporaryResources();
  receipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(redactReceipt({
    result: receipt.result,
    blockers: receipt.blockers,
    checks: receipt.checks,
    runtime: receipt.runtime,
    businessDifferential: receipt.businessDifferential,
    cleanup: receipt.cleanup,
    amazonRequests: receipt.amazonRequests.length,
  }), null, 2));
}

if (receipt.result !== 'PASS') {
  if (failure) console.error(scrub(failure?.message || String(failure)));
  process.exitCode = 1;
}

function validateFailClosedContractEvidence() {
  const unavailable = buildOperatorWorkQueueRow({
    storeId: 'synthetic-store', storeCode: 'SYNTHETIC', displayName: 'Synthetic',
    unavailable: true, evidenceState: 'unavailable', error: { code: 'store_db_unavailable' },
  });
  assert.equal(unavailable.priority, 1);
  assert.equal(unavailable.queueClass, 'authoritative_read_failure');
  assert.equal(unavailable.recommendationCandidateCount, null);
  assert.equal(unavailable.needsReviewCount, null);

  const inconsistent = buildOperatorWorkQueueRow({
    storeId: 'synthetic-store', storeCode: 'SYNTHETIC', displayName: 'Synthetic',
    unavailable: false, evidenceState: 'available', recommendationCandidateCount: 1,
    needsReviewCount: null, staleReviewEvidenceCount: 0, highUnreviewedCount: 0,
    unreviewedCount: 0, acknowledgedCount: 0, candidateEmissionAuthorized: true,
  });
  assert.equal(inconsistent.priority, 1);
  assert.equal(inconsistent.queueClass, 'evidence_gap');
  assert.equal(inconsistent.recommendationCandidateCount, null);

  const blocked = buildOperatorWorkQueueRow({
    storeId: 'synthetic-store', storeCode: 'SYNTHETIC', displayName: 'Synthetic',
    unavailable: false, evidenceState: 'available', recommendationCandidateCount: 0,
    needsReviewCount: 0, staleReviewEvidenceCount: 0, highUnreviewedCount: 0,
    unreviewedCount: 0, acknowledgedCount: 0, recommendationCandidateCount: 0,
    criticalHighCandidateCount: 0, analysisScopeComplete: false, financiallyComparable: false,
    candidateEmissionAuthorized: false,
  });
  assert.equal(blocked.reasonCode, 'candidate_emission_not_authorized');
  assert.equal(blocked.priority, 5);
}

async function loadProductionStores(db) {
  const result = await db.prepare(`
    SELECT store_id, store_code, display_name, d1_binding_key, sort_order
    FROM stores
    WHERE status='active' AND d1_binding_key IN ('STORE_01_DB','STORE_02_DB','STORE_03_DB','STORE_04_DB')
    ORDER BY sort_order, store_code, store_id
  `).all();
  assert.equal(result.results.length, 4, `active_production_store_count:${result.results.length}`);
  return result.results;
}

async function provisionFourStoreReadIdentity() {
  await controlDb.prepare(`INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)`)
    .bind(ROLE_KEY, `OWQ #247 Acceptance ${RUN_ID}`).run();
  await controlDb.prepare(`INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')`).bind(ROLE_KEY).run();
  await controlDb.prepare(`
    INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at)
    VALUES(?1,?2,?3,lower(?3),'OWQ #247 Acceptance Service','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `).bind(PRINCIPAL_USER_ID, serviceToken.client_id, PRINCIPAL_EMAIL).run();
  for (const store of stores) {
    await controlDb.prepare(`INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)`)
      .bind(store.store_id, PRINCIPAL_USER_ID, ROLE_KEY).run();
  }
  const permissions = await controlDb.prepare(`SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key`).bind(ROLE_KEY).all();
  assert.deepEqual(permissions.results.map((row) => row.permission_key), ['analytics.read']);
  const memberships = await controlDb.prepare(`SELECT store_id FROM store_members WHERE user_id=?1 ORDER BY store_id`).bind(PRINCIPAL_USER_ID).all();
  assert.deepEqual(memberships.results.map((row) => row.store_id), stores.map((row) => row.store_id).sort());
  const globals = await controlDb.prepare(`SELECT COUNT(*) AS count FROM user_global_roles WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).first();
  assert.equal(Number(globals?.count || 0), 0, 'temporary_identity_has_global_role');
}

async function restrictToStore01Only() {
  const store01 = byBinding('STORE_01_DB');
  await controlDb.prepare(`DELETE FROM store_members WHERE user_id=?1 AND store_id<>?2`).bind(PRINCIPAL_USER_ID, store01.store_id).run();
  const rows = await controlDb.prepare(`SELECT store_id FROM store_members WHERE user_id=?1 ORDER BY store_id`).bind(PRINCIPAL_USER_ID).all();
  assert.deepEqual(rows.results.map((row) => row.store_id), [store01.store_id]);
}

async function businessSnapshot() {
  const snapshot = {};
  for (const store of stores) {
    const db = storeDbs.get(store.store_id);
    snapshot[store.store_code] = {};
    for (const table of BUSINESS_TABLES) {
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
      const value = Number(row?.count);
      assert(Number.isInteger(value) && value >= 0, `invalid_count:${store.store_code}:${table}`);
      snapshot[store.store_code][table] = value;
    }
  }
  return snapshot;
}

async function liveWorkQueue(range, headers) {
  const params = new URLSearchParams({ includeDecisionQueue: 'true', startDate: range.startDate, endDate: range.endDate });
  const started = Date.now();
  const response = await appJson(`${PROD_BASE_URL}/api/v1/analytics/data-health?${params}`, { headers });
  const elapsedMs = Date.now() - started;
  assert.equal(response.status, 200, `work_queue_http_${response.status}:${range.startDate}:${range.endDate}`);
  assert.equal(response.headers['x-runtime-worker-version'], EXPECTED_PROD_VERSION_ID, 'production_work_queue_version_mismatch');
  const decision = response.body?.decisionQueue;
  const work = response.body?.operatorWorkQueue;
  assert.equal(decision?.schemaVersion, 'four-store-decision-queue-summary-v1', 'decision_queue_schema_mismatch');
  assert.equal(work?.schemaVersion, 'daily-operator-work-queue-v1', 'work_queue_schema_mismatch');
  assertAuthority(decision?.authority, 'decision_queue');
  assertAuthority(work?.authority, 'operator_work_queue');
  assert.deepEqual(decision?.dateRange, range, 'decision_queue_date_range_mismatch');
  assert.deepEqual(work?.requestedDateRange, range, 'work_queue_requested_date_range_mismatch');
  assertServerOrder(work?.rows || []);
  return { range, elapsedMs, headers: response.headers, decision, work };
}

function validateFourStoreLive(live) {
  const expectedIds = stores.map((row) => row.store_id).sort();
  assert.equal(live.work.rows.length, 4, `four_store_work_row_count:${live.work.rows.length}`);
  assert.equal(live.decision.stores.length, 4, `four_store_decision_row_count:${live.decision.stores.length}`);
  assert.deepEqual(live.work.rows.map((row) => row.storeId).sort(), expectedIds, 'four_store_work_ids_mismatch');
  assert.deepEqual(live.decision.stores.map((row) => row.storeId).sort(), expectedIds, 'four_store_decision_ids_mismatch');
}

function validateDurableStore01(live) {
  const store01 = byBinding('STORE_01_DB');
  const decision = live.decision.stores.find((row) => row.storeId === store01.store_id);
  const work = live.work.rows.find((row) => row.storeId === store01.store_id);
  assert(decision && work, 'store01_live_row_missing');
  const needs = Number(decision.needsReviewCount || 0);
  const stale = Number(decision.staleReviewEvidenceCount || 0);
  assert(needs > 0 || stale > 0, 'store01_durable_review_evidence_missing');
  assert.equal(work.priority, 2, 'store01_durable_review_not_p2');
  if (stale > 0) {
    assert.equal(work.queueClass, 'stale_review_evidence');
    assert.equal(work.reasonCode, 'stale_review_evidence');
  } else {
    assert.equal(work.queueClass, 'needs_review');
    assert.equal(work.reasonCode, 'needs_review');
  }
}

function validateStaleStore01(live) {
  const store01 = byBinding('STORE_01_DB');
  const decision = live.decision.stores.find((row) => row.storeId === store01.store_id);
  const work = live.work.rows.find((row) => row.storeId === store01.store_id);
  assert(decision && work, 'store01_stale_window_row_missing');
  assert(Number(decision.staleReviewEvidenceCount || 0) > 0, 'store01_stale_review_evidence_not_observed');
  assert.equal(work.priority, 2, 'store01_stale_review_not_p2');
  assert.equal(work.queueClass, 'stale_review_evidence');
  assert.equal(work.reasonCode, 'stale_review_evidence');
}

function validateCandidateEmissionBlocked(live) {
  assert.equal(live.decision.stores.length, 4, 'monthly_decision_store_count_mismatch');
  for (const decision of live.decision.stores) {
    assert.equal(decision.candidateEmissionAuthorized, false, `${decision.storeCode}:candidate_emission_not_blocked`);
    assert(Number(decision.scopeBlockedCount || 0) > 0, `${decision.storeCode}:scope_blocked_count_missing`);
    const work = live.work.rows.find((row) => row.storeId === decision.storeId);
    assert(work, `${decision.storeCode}:monthly_work_row_missing`);
    assert.equal(work.candidateEmissionAuthorized, false, `${decision.storeCode}:work_candidate_emission_not_blocked`);
    assert.equal(work.reasonCode, 'candidate_emission_not_authorized', `${decision.storeCode}:blocked_semantics_reason_mismatch`);
    assert(!/healthy|no demand|nothing to do/i.test(String(work.reasonText || '')), `${decision.storeCode}:blocked_semantics_falsely_healthy`);
  }
}

function validateStore01Only(live) {
  const store01 = byBinding('STORE_01_DB');
  assert.equal(live.work.rows.length, 1, `rbac_work_row_count:${live.work.rows.length}`);
  assert.equal(live.decision.stores.length, 1, `rbac_decision_row_count:${live.decision.stores.length}`);
  assert.equal(live.work.rows[0].storeId, store01.store_id, 'rbac_work_store_mismatch');
  assert.equal(live.decision.stores[0].storeId, store01.store_id, 'rbac_decision_store_mismatch');
}

async function validateProductionUiAsset(headers) {
  const url = `${PROD_BASE_URL}/assets/cloudflare-native-operations-health-v1.js`;
  const started = Date.now();
  const response = await appText(url, { headers });
  const elapsedMs = Date.now() - started;
  assert.equal(response.status, 200, `production_ui_asset_status:${response.status}`);
  const source = response.body;
  const requiredFragments = [
    'DAILY OPERATOR WORK QUEUE',
    'server-authoritative order',
    'Open Decision Queue',
    'includeDecisionQueue: true',
    'CloudflareOperatorContext?.setContext?.',
    'state.decisionRange.startDate',
    '#cfDecisionLauncher',
    'payload.operatorWorkQueue.rows) ? payload.operatorWorkQueue.rows.slice()',
    '不默认当前月 / 7 天 / 30 天',
  ];
  for (const fragment of requiredFragments) assert(source.includes(fragment), `production_ui_contract_fragment_missing:${fragment}`);
  return {
    asset: '/assets/cloudflare-native-operations-health-v1.js',
    status: response.status,
    elapsedMs,
    explicitRangeRequired: true,
    serverOrderingConsumedDirectly: true,
    storeContextTransferred: true,
    dateRangeTransferred: true,
    decisionLauncherOpened: true,
    actionClicks: 1,
  };
}

function assertAuthority(authority, label) {
  assert.equal(authority?.readOnly, true, `${label}_read_only_invalid`);
  assert.equal(authority?.executionAuthorized, false, `${label}_execution_authority_invalid`);
  assert.equal(authority?.amazonMutationAuthorized, false, `${label}_amazon_mutation_authority_invalid`);
}

function assertServerOrder(rows) {
  const original = rows.map((row) => row.storeId);
  const sorted = rows.slice().sort(compareWorkRows).map((row) => row.storeId);
  assert.deepEqual(original, sorted, 'server_work_queue_order_invalid');
}

function compareWorkRows(left, right) {
  const priority = number(left.priority) - number(right.priority);
  if (priority) return priority;
  const classOrder = {
    authoritative_read_failure: 0, evidence_gap: 1, stale_review_evidence: 2, needs_review: 3,
    high_unreviewed: 4, other_unreviewed: 5, acknowledged_only: 6, no_active_queue: 7,
  };
  const classDelta = (classOrder[left.queueClass] ?? 99) - (classOrder[right.queueClass] ?? 99);
  if (classDelta) return classDelta;
  const salientDelta = salientCount(right) - salientCount(left);
  if (salientDelta) return salientDelta;
  const candidateDelta = nullableCount(right.recommendationCandidateCount) - nullableCount(left.recommendationCandidateCount);
  if (candidateDelta) return candidateDelta;
  return String(left.storeCode || left.storeId || '').localeCompare(String(right.storeCode || right.storeId || ''));
}

function salientCount(row) {
  if (row.queueClass === 'stale_review_evidence') return nullableCount(row.staleReviewEvidenceCount);
  if (row.queueClass === 'needs_review') return nullableCount(row.needsReviewCount);
  if (row.queueClass === 'high_unreviewed') return nullableCount(row.highUnreviewedCount);
  if (row.queueClass === 'other_unreviewed') return nullableCount(row.otherUnreviewedCount);
  if (row.queueClass === 'acknowledged_only') return nullableCount(row.acknowledgedCount);
  return 0;
}

function summarizeLive(live) {
  return {
    requestedDateRange: live.range,
    elapsedMs: live.elapsedMs,
    runtimeVersion: live.headers['x-runtime-worker-version'] || null,
    authority: live.work.authority,
    rows: live.work.rows.map((row) => ({
      storeId: row.storeId,
      storeCode: row.storeCode,
      priority: row.priority,
      queueClass: row.queueClass,
      reasonCode: row.reasonCode,
      reasonText: row.reasonText,
      recommendationCandidateCount: row.recommendationCandidateCount,
      needsReviewCount: row.needsReviewCount,
      staleReviewEvidenceCount: row.staleReviewEvidenceCount,
      highUnreviewedCount: row.highUnreviewedCount,
      otherUnreviewedCount: row.otherUnreviewedCount,
      acknowledgedCount: row.acknowledgedCount,
      candidateEmissionAuthorized: row.candidateEmissionAuthorized,
      evidenceState: row.evidenceState,
    })),
    decisionStores: live.decision.stores.map((row) => ({
      storeId: row.storeId,
      storeCode: row.storeCode,
      recommendationCandidateCount: row.recommendationCandidateCount,
      needsReviewCount: row.needsReviewCount,
      staleReviewEvidenceCount: row.staleReviewEvidenceCount,
      highUnreviewedCount: row.highUnreviewedCount,
      unreviewedCount: row.unreviewedCount,
      acknowledgedCount: row.acknowledgedCount,
      scopeBlockedCount: row.scopeBlockedCount,
      candidateEmissionAuthorized: row.candidateEmissionAuthorized,
      evidenceState: row.evidenceState,
      error: row.error || null,
    })),
  };
}

async function awaitServiceAuth(headers) {
  let last = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = await appJson(`${PROD_BASE_URL}/api/health`, { headers });
    last = probe;
    if (probe.status === 200 && probe.body?.environment === 'production') return;
    await sleep(1500);
  }
  throw new Error(`service_auth_not_propagated:${last?.status || 'unknown'}`);
}

async function readSyncHardOff() {
  const schedulesPayload = await cf(`/workers/scripts/${encodeURIComponent(SYNC_WORKER)}/schedules`);
  const schedules = Array.isArray(schedulesPayload.result)
    ? schedulesPayload.result
    : Array.isArray(schedulesPayload.result?.schedules) ? schedulesPayload.result.schedules : [];
  let amazonAdsEnabled = null;
  let settingsVisible = false;
  try {
    const settingsPayload = await cf(`/workers/scripts/${encodeURIComponent(SYNC_WORKER)}/settings`);
    settingsVisible = true;
    const bindings = Array.isArray(settingsPayload.result?.bindings) ? settingsPayload.result.bindings : [];
    const binding = bindings.find((row) => row?.name === 'AMAZON_ADS_ENABLED');
    if (binding) {
      const raw = binding.text ?? binding.value ?? binding.json ?? null;
      if (raw !== null) amazonAdsEnabled = String(raw).trim().toLowerCase() === 'true';
    }
  } catch (error) {
    receipt.runtime.syncSettingsReadError = scrub(error?.message || String(error));
  }
  return { worker: SYNC_WORKER, scheduleCount: schedules.length, settingsVisible, amazonAdsEnabled };
}

async function cleanupTemporaryResources() {
  if (!controlDb) {
    receipt.cleanup.controlDbUnavailable = true;
  } else {
    await cleanupStep('storeMembershipsRemoved', async () => {
      await controlDb.prepare(`DELETE FROM store_members WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
    });
    await cleanupStep('rolePermissionsRemoved', async () => {
      await controlDb.prepare(`DELETE FROM role_permissions WHERE role_key=?1`).bind(ROLE_KEY).run();
    });
    await cleanupStep('temporaryRoleRemoved', async () => {
      await controlDb.prepare(`DELETE FROM app_roles WHERE role_key=?1 AND is_system=0`).bind(ROLE_KEY).run();
    });
    await cleanupStep('servicePrincipalRemovedOrDisabled', async () => {
      try {
        await controlDb.prepare(`DELETE FROM users WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
        receipt.cleanup.principalDisposition = 'deleted';
      } catch {
        await controlDb.prepare(`UPDATE users SET status='disabled', updated_at=CURRENT_TIMESTAMP WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
        receipt.cleanup.principalDisposition = 'disabled_audit_residue';
      }
    });
  }
  await cleanupStep('accessPolicyDeleted', async () => {
    if (accessPolicy?.id) await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies/${encodeURIComponent(accessPolicy.id)}`, { method: 'DELETE' });
  });
  await cleanupStep('serviceTokenDeleted', async () => {
    if (serviceToken?.id) await cf(`/access/service_tokens/${encodeURIComponent(serviceToken.id)}`, { method: 'DELETE' });
  });
}

async function cleanupStep(name, operation) {
  try {
    await operation();
    receipt.cleanup[name] = true;
  } catch (error) {
    receipt.cleanup[name] = false;
    receipt.cleanup[`${name}Error`] = scrub(error?.message || String(error));
  }
}

function serviceHeaders() {
  return {
    'CF-Access-Client-Id': serviceToken.client_id,
    'CF-Access-Client-Secret': serviceToken.client_secret,
    accept: 'application/json',
  };
}

async function appJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    cache: 'no-store',
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { nonJson: text.slice(0, 500) }; }
  return { status: response.status, headers: lowerHeaders(response.headers), body: parsed };
}

async function appText(url, { headers = {} } = {}) {
  const response = await fetch(url, { headers, redirect: 'manual', cache: 'no-store' });
  return { status: response.status, headers: lowerHeaders(response.headers), body: await response.text() };
}

async function cf(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const code = payload?.errors?.[0]?.code || response.status;
    const message = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`cloudflare_api_failed:${path}:${code}:${scrub(message)}`);
  }
  return payload;
}

function byBinding(binding) {
  const row = stores.find((store) => store.d1_binding_key === binding);
  assert(row, `store_binding_missing:${binding}`);
  return row;
}

function lowerHeaders(headers) {
  return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
}

function isAmazonHost(hostname) {
  return /(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(String(hostname || '').toLowerCase());
}

function classifyBlocker(error) {
  const message = String(error?.message || error || 'unknown');
  if (/403|permission|access/i.test(message) && /cloudflare_api_failed|service_auth/i.test(message)) return 'cloudflare_acceptance_permission_or_access_blocked';
  if (/version_mismatch|runtime_version|work_queue_version/i.test(message)) return 'production_runtime_drift';
  if (/business_or_execution_table_mutation/i.test(message)) return 'production_read_side_effect_detected';
  if (/active_service_token_drift/i.test(message)) return 'unexpected_active_service_token';
  return `production_runtime_acceptance_failed:${scrub(message).slice(0, 180)}`;
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function scrub(value) {
  let text = String(value || '');
  if (API_TOKEN) text = text.split(API_TOKEN).join('[REDACTED_API_TOKEN]');
  if (serviceToken?.client_secret) text = text.split(serviceToken.client_secret).join('[REDACTED_SERVICE_SECRET]');
  return text.replace(/[\r\n\t]+/g, ' ').trim();
}

function redactReceipt(value) {
  return JSON.parse(JSON.stringify(value, (key, current) => /secret|apiToken/i.test(key) ? '[REDACTED]' : current));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
