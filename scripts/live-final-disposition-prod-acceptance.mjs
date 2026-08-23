import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA = required('EXPECTED_MAIN_SHA');
const EXPECTED_DEV_VERSION = required('EXPECTED_DEV_VERSION');
const EXPECTED_PROD_BUILD = required('EXPECTED_PROD_BUILD');
const EXPECTED_PROD_DEPLOYMENT = required('EXPECTED_PROD_DEPLOYMENT');
const EXPECTED_PROD_VERSION = required('EXPECTED_PROD_VERSION');
const PROD_WORKER = process.env.PROD_WORKER || 'ads-operations-web-prod';
const PROD_BASE_URL = (process.env.PROD_BASE_URL || 'https://ads-operations-web-prod.tanshiyuesir.workers.dev').replace(/\/$/, '');
const DEV_BASE_URL = (process.env.DEV_BASE_URL || 'https://ads-operations-web-dev.tanshiyuesir.workers.dev').replace(/\/$/, '');
const PROD_ACCESS_DOMAIN = new URL(PROD_BASE_URL).hostname.toLowerCase();
const PROD_ACCESS_APP_ID = required('PROD_ACCESS_APP_ID');
const PROD_ACCESS_AUD = required('PROD_ACCESS_AUD');
const SYNC_WORKER = process.env.PROD_SYNC_WORKER || 'ads-operations-sync-prod';
const EXPECTED_SYNC_DEPLOYMENT = 'cf0b0adf-96dc-437d-8298-15af58f992ce';
const EXPECTED_SYNC_VERSION = '295df84e-2103-4858-9895-49f67d4b10b4';
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/final-disposition-production-acceptance';
const PRINCIPAL_USER_ID = `svc-final-disposition-259-${RUN_ID}`;
const PRINCIPAL_EMAIL = `svc-final-disposition-259-${RUN_ID}@machine.invalid`;
const ROLE_KEY = `final_disposition_259_${RUN_ID}`;
const TOKEN_NAME = `ads-ops-final-disposition-259-${RUN_ID}`;
const POLICY_NAME = `Final Disposition #259 acceptance ${RUN_ID}`;
const REVIEW_CONTRACT = 'csv-recommendation-human-review-v1';
const SCOPE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01', limit: '50', sort: 'cost' });
const BUSINESS_TABLES = Object.freeze(['advisory_review_records', 'optimization_actions', 'optimization_execution_receipts', 'sync_runs']);
const CANONICAL_ADVISORY_STATES = new Set(['acknowledged', 'open', 'approved', 'rejected']);
const PUBLIC_DURABLE_STATES = new Set(['acknowledged', 'needs_review', 'approved', 'rejected']);

await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'human-review-final-disposition-production-acceptance-v1',
  issue: 259,
  runId: RUN_ID,
  expectedCanonicalMain: EXPECTED_MAIN_SHA,
  target: PROD_BASE_URL,
  scope: SCOPE,
  checks: {},
  runtime: {},
  transitions: [],
  queueEvidence: {},
  businessDifferential: {},
  cleanup: {},
  amazonRequests: [],
  blockers: [],
  result: 'FAIL',
  startedAt: new Date().toISOString(),
};

let serviceToken = null;
let accessPolicy = null;
let controlDb = null;
let stores = [];
let storeDbs = new Map();
let authHeaders = null;
let store01 = null;
let store02 = null;
let reviewUrl01 = null;
let target = null;
let originalState = null;
let originalNote = null;
let restored = false;
let failure = null;
let corePassed = false;

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
  const main = await githubJson('https://api.github.com/repos/mrtanshiyue/Ads-Operations-Integrity/branches/main');
  assert.equal(main?.commit?.sha, EXPECTED_MAIN_SHA, 'canonical_main_drift');
  receipt.checks.canonicalMainExact = true;

  const devHealth = await appJson(`${DEV_BASE_URL}/api/health`);
  assert.equal(devHealth.status, 200, `development_health_${devHealth.status}`);
  assert.equal(devHealth.body?.environment, 'development');
  assert.equal(devHealth.body?.syncTriggerEnabled, false);
  assert.equal(devHealth.headers['x-runtime-worker-version'] || devHealth.body?.deployment?.versionId, EXPECTED_DEV_VERSION, 'development_version_drift');
  receipt.runtime.development = { version: EXPECTED_DEV_VERSION, exactMainAccepted: true };
  receipt.checks.developmentAcceptanceStillCurrent = true;

  const buildPayload = await cf(`/builds/builds/${encodeURIComponent(EXPECTED_PROD_BUILD)}`);
  const build = buildPayload.result || null;
  assert.equal(build?.status, 'stopped', 'production_build_not_stopped');
  assert.equal(build?.build_outcome, 'success', 'production_build_not_success');
  assert.equal(build?.build_trigger_metadata?.branch, 'main', 'production_build_branch_drift');
  assert.equal(build?.build_trigger_metadata?.commit_hash, EXPECTED_MAIN_SHA, 'production_build_commit_drift');
  receipt.runtime.productionBuild = { buildUuid: EXPECTED_PROD_BUILD, branch: 'main', commitHash: EXPECTED_MAIN_SHA };
  receipt.checks.productionBuildExactMain = true;

  const prodDeployments = await cf(`/workers/scripts/${encodeURIComponent(PROD_WORKER)}/deployments`);
  const prodHead = deploymentHead(prodDeployments);
  assert.equal(prodHead.id, EXPECTED_PROD_DEPLOYMENT, 'production_deployment_drift');
  assert.equal(prodHead.versionId, EXPECTED_PROD_VERSION, 'production_version_drift');
  receipt.runtime.production = prodHead;

  const prodSettings = await cf(`/workers/scripts/${encodeURIComponent(PROD_WORKER)}/settings`);
  const prodSchedules = await cf(`/workers/scripts/${encodeURIComponent(PROD_WORKER)}/schedules`);
  const prodBindings = bindings(prodSettings);
  assert.equal(textBinding(prodBindings, 'ACCESS_MODE'), 'enforce', 'production_access_mode_drift');
  assert.equal(textBinding(prodBindings, 'SYNC_TRIGGER_ENABLED'), 'false', 'production_sync_trigger_drift');
  assert.equal(textBinding(prodBindings, 'PHASE5_SINGLE_RUN_PERMIT_ID'), '', 'production_phase5_permit_drift');
  assert.equal(textBinding(prodBindings, 'PHASE5_SINGLE_RUN_REPORT_DATE'), '', 'production_phase5_date_drift');
  assert.equal(scheduleCount(prodSchedules), 0, 'production_web_schedule_drift');
  receipt.checks.productionWebSafetyBindingsExact = true;

  await assertProductionSyncHardOff();
  receipt.checks.productionSyncUntouchedHardOff = true;

  const accessAppPayload = await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}`);
  const accessApp = accessAppPayload.result || null;
  assert.equal(accessApp?.id, PROD_ACCESS_APP_ID, 'production_access_app_id_mismatch');
  assert.equal(String(accessApp?.domain || '').toLowerCase(), PROD_ACCESS_DOMAIN, 'production_access_domain_mismatch');
  assert.equal(String(accessApp?.aud || ''), PROD_ACCESS_AUD, 'production_access_aud_mismatch');
  receipt.checks.productionAccessAppExact = true;

  const existingTokens = await cf('/access/service_tokens?per_page=100');
  assert(!(existingTokens.result || []).some((row) => row?.name === TOKEN_NAME), 'acceptance_service_token_name_collision');
  const existingPolicies = await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies`);
  assert(!(existingPolicies.result || []).some((row) => row?.name === POLICY_NAME), 'acceptance_access_policy_name_collision');
  receipt.checks.ephemeralNamesCleanAtBaseline = true;

  const controlDbId = bindingId(prodBindings, 'CONTROL_DB');
  const storeDbIds = Object.fromEntries(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB'].map((name) => [name, bindingId(prodBindings, name)]));
  controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: controlDbId, apiToken: API_TOKEN });
  const storeRows = await controlDb.prepare(`
    SELECT store_id, store_code, d1_binding_key, sort_order
    FROM stores
    WHERE status='active' AND d1_binding_key IN ('STORE_01_DB','STORE_02_DB','STORE_03_DB','STORE_04_DB')
    ORDER BY sort_order, store_code, store_id
  `).all();
  stores = storeRows.results || [];
  assert.equal(stores.length, 4, `active_production_store_count:${stores.length}`);
  for (const store of stores) {
    storeDbs.set(store.store_id, createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: storeDbIds[store.d1_binding_key], apiToken: API_TOKEN }));
  }
  store01 = byBinding('STORE_01_DB');
  store02 = byBinding('STORE_02_DB');

  for (const store of stores) {
    const db = storeDbs.get(store.store_id);
    const ledger = await db.prepare("SELECT name FROM d1_migrations WHERE name='0025_store_advisory_review_final_disposition.sql'").all();
    assert.equal(ledger.results.length, 1, `0025_ledger_missing:${store.store_code}`);
    const table = await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='advisory_review_records'").first();
    assert(String(table?.sql || '').includes("'approved'"), `approved_state_missing:${store.store_code}`);
    assert(String(table?.sql || '').includes("'rejected'"), `rejected_state_missing:${store.store_code}`);
  }
  receipt.checks.fourStoreMigration0025Exact = true;

  receipt.businessDifferential.before = await businessSnapshot();
  assertNoExecutionRows(receipt.businessDifferential.before);

  serviceToken = (await cf('/access/service_tokens', {
    method: 'POST',
    body: { name: TOKEN_NAME, duration: '1h', enabled: true },
  })).result;
  assert(serviceToken?.id && serviceToken?.client_id && serviceToken?.client_secret, 'service_token_create_response_incomplete');
  receipt.cleanup.serviceTokenCreated = true;

  accessPolicy = (await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies`, {
    method: 'POST',
    body: { name: POLICY_NAME, decision: 'non_identity', include: [{ service_token: { token_id: serviceToken.id } }] },
  })).result;
  assert(accessPolicy?.id, 'access_policy_create_response_incomplete');
  assert.equal(accessPolicy.decision, 'non_identity', 'access_policy_not_non_identity');
  receipt.cleanup.accessPolicyCreated = true;

  await controlDb.prepare(`INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)`)
    .bind(ROLE_KEY, `Final Disposition #259 Acceptance ${RUN_ID}`).run();
  await controlDb.prepare(`INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'ads.write')`).bind(ROLE_KEY).run();
  await controlDb.prepare(`INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')`).bind(ROLE_KEY).run();
  await controlDb.prepare(`
    INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at)
    VALUES(?1,?2,?3,lower(?3),'Final Disposition #259 Acceptance Service','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `).bind(PRINCIPAL_USER_ID, serviceToken.client_id, PRINCIPAL_EMAIL).run();
  await controlDb.prepare(`INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)`)
    .bind(store01.store_id, PRINCIPAL_USER_ID, ROLE_KEY).run();

  const permissions = await controlDb.prepare(`SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key`).bind(ROLE_KEY).all();
  assert.deepEqual(permissions.results.map((row) => row.permission_key), ['ads.write', 'analytics.read']);
  const memberships = await controlDb.prepare(`SELECT store_id FROM store_members WHERE user_id=?1 ORDER BY store_id`).bind(PRINCIPAL_USER_ID).all();
  assert.deepEqual(memberships.results.map((row) => row.store_id), [store01.store_id]);
  receipt.checks.ephemeralStore01AdsWriteIdentity = true;

  authHeaders = serviceHeaders();
  await awaitServiceAuth(authHeaders);

  const health = await appJson(`${PROD_BASE_URL}/api/health`, { headers: authHeaders });
  assert.equal(health.status, 200, `production_health_${health.status}`);
  assert.equal(health.body?.environment, 'production');
  assert.equal(health.body?.syncTriggerEnabled, false);
  assert.equal(health.headers['x-runtime-worker-version'] || health.body?.deployment?.versionId, EXPECTED_PROD_VERSION, 'production_health_version_mismatch');
  receipt.checks.productionHealthExact = true;

  reviewUrl01 = reviewUrl(store01.store_id);
  const initial = await appJson(reviewUrl01, { headers: authHeaders });
  assert.equal(initial.status, 200, `production_review_get_${initial.status}`);
  validateHumanReviewPayload(initial.body, store01.store_id);

  const eligible = (initial.body.items || []).filter((item) => (
    item?.persistenceAuthorized === true
    && item?.review?.persisted === true
    && PUBLIC_DURABLE_STATES.has(item?.review?.state)
    && CANONICAL_ADVISORY_STATES.has(item?.review?.advisoryState)
  ));
  assert(eligible.length > 0, 'no_exact_current_persisted_review_available');
  target = eligible[0];
  originalState = target.review.state;
  originalNote = target.review.note ?? null;
  receipt.transitions.push({ phase: 'baseline', state: originalState, persisted: true });
  receipt.checks.existingExactCurrentReviewSelected = true;

  const targetDb = storeDbs.get(store01.store_id);
  const originalRow = await targetDb.prepare(`SELECT review_id,state,reviewer_note FROM advisory_review_records WHERE review_id=?1 LIMIT 1`)
    .bind(target.review.reviewId).first();
  assert(originalRow, 'selected_review_row_missing');
  assert.equal(originalRow.state, target.review.advisoryState, 'selected_review_advisory_state_mismatch');

  const beforeQueue = await queueSnapshot(store01.store_id, authHeaders);
  receipt.queueEvidence.baseline = compactQueue(beforeQueue);

  const approved = await transitionTo('approved', 'Production #259 final-disposition acceptance — review-only; no execution');
  assert.equal(approved.write.status, 200, 'approved_existing_row_expected_200');
  assert.equal(approved.write.body?.review?.state, 'approved');
  validateWriteAuthority(approved.write.body?.authority);
  assertCurrentProjection(approved.read.body, target.inboxItemId, target.recommendationFingerprint, 'approved');
  const approvedQueue = await queueSnapshot(store01.store_id, authHeaders);
  assertQueueTransition(beforeQueue, approvedQueue, originalState, 'approved');
  receipt.queueEvidence.approved = compactQueue(approvedQueue);
  receipt.transitions.push({ phase: 'approved', state: 'approved', persisted: true, existingRow: true });
  receipt.checks.approvedPersistenceLive = true;

  const rejected = await transitionTo('rejected', 'Production #259 final-disposition acceptance — review-only rejection; no execution');
  assert.equal(rejected.write.status, 200, 'rejected_existing_row_expected_200');
  assert.equal(rejected.write.body?.review?.state, 'rejected');
  validateWriteAuthority(rejected.write.body?.authority);
  assertCurrentProjection(rejected.read.body, target.inboxItemId, target.recommendationFingerprint, 'rejected');
  const rejectedQueue = await queueSnapshot(store01.store_id, authHeaders);
  assertQueueTransition(approvedQueue, rejectedQueue, 'approved', 'rejected');
  receipt.queueEvidence.rejected = compactQueue(rejectedQueue);
  receipt.transitions.push({ phase: 'rejected', state: 'rejected', persisted: true, existingRow: true });
  receipt.checks.rejectedPersistenceLive = true;

  const unsupported = await appJson(reviewUrl01, {
    method: 'POST', headers: authHeaders,
    body: { inboxItemId: target.inboxItemId, state: 'viewed' },
  });
  assert.equal(unsupported.status, 400, `unsupported_state_status:${unsupported.status}`);
  assert.equal(unsupported.body?.error, 'recommendation_review_state_not_supported');
  const afterUnsupported = await appJson(reviewUrl01, { headers: authHeaders });
  assert.equal(afterUnsupported.status, 200);
  assertCurrentProjection(afterUnsupported.body, target.inboxItemId, target.recommendationFingerprint, 'rejected');
  receipt.checks.unsupportedStateRejectedWithoutMutation = true;

  const restoredTransition = await transitionTo(originalState, originalNote);
  assert.equal(restoredTransition.write.status, 200, 'restore_existing_row_expected_200');
  assertCurrentProjection(restoredTransition.read.body, target.inboxItemId, target.recommendationFingerprint, originalState);
  const restoredQueue = await queueSnapshot(store01.store_id, authHeaders);
  assertQueueEqual(restoredQueue, beforeQueue);
  receipt.queueEvidence.restored = compactQueue(restoredQueue);
  receipt.transitions.push({ phase: 'restored', state: originalState, persisted: true, existingRow: true });
  restored = true;
  receipt.checks.originalReviewStateRestored = true;

  const store02Isolation = await appJson(reviewUrl(store02.store_id), { headers: authHeaders });
  assert.equal(store02Isolation.status, 403, `store02_rbac_expected_403_got_${store02Isolation.status}`);
  assert.equal(store02Isolation.body?.error, 'forbidden');
  receipt.checks.store02Isolation = true;

  const asset = await appText(`${PROD_BASE_URL}/assets/cloudflare-native-csv-recommendation-human-review-v1.js`, { headers: authHeaders });
  assert.equal(asset.status, 200, `production_human_review_ui_asset_${asset.status}`);
  for (const fragment of [
    "const VERSION = '1.4.0';",
    'data-cfhr-set="approved"',
    'data-cfhr-set="rejected"',
    'Approved / Rejected are Human Review dispositions only. They do not execute Amazon changes.',
  ]) assert(asset.body.includes(fragment), `production_ui_fragment_missing:${fragment}`);
  receipt.checks.productionUi140Exact = true;

  receipt.businessDifferential.after = await businessSnapshot();
  assert.deepEqual(receipt.businessDifferential.after, receipt.businessDifferential.before, 'business_or_execution_table_count_mutation_detected');
  assertNoExecutionRows(receipt.businessDifferential.after);
  receipt.checks.businessExecutionCountsUnchanged = true;

  await assertProductionSyncHardOff();
  assert.equal(receipt.amazonRequests.length, 0, 'amazon_request_attempt_detected');
  receipt.checks.amazonRequestsZero = true;
  corePassed = true;
} catch (error) {
  failure = error;
  receipt.error = { message: scrub(error?.message || String(error)), stack: scrub(String(error?.stack || '')).slice(0, 8000) };
  receipt.blockers.push(classifyBlocker(error));
} finally {
  if (!restored && target && originalState && authHeaders && reviewUrl01) {
    const ok = await attemptRestoreOriginalReview();
    receipt.cleanup.originalReviewStateEmergencyRestore = ok;
    restored = ok;
    if (!ok) receipt.blockers.push('original_review_state_restore_failed');
  }
  await cleanupTemporaryResources();
  await verifyCleanup();
  receipt.finishedAt = new Date().toISOString();
  receipt.result = corePassed && restored && receipt.cleanup.verified === true ? 'PASS' : 'FAIL';
  await writeFile(`${OUT}/receipt.json`, `${JSON.stringify(redactReceipt(receipt), null, 2)}\n`);
  console.log(JSON.stringify(redactReceipt({
    result: receipt.result,
    blockers: receipt.blockers,
    checks: receipt.checks,
    runtime: receipt.runtime,
    transitions: receipt.transitions,
    queueEvidence: receipt.queueEvidence,
    businessDifferential: receipt.businessDifferential,
    cleanup: receipt.cleanup,
    amazonRequests: receipt.amazonRequests.length,
  }), null, 2));
}

if (receipt.result !== 'PASS') {
  if (failure) console.error(scrub(failure?.message || String(failure)));
  process.exitCode = 1;
}

async function transitionTo(state, note) {
  const write = await appJson(reviewUrl01, {
    method: 'POST',
    headers: authHeaders,
    body: { inboxItemId: target.inboxItemId, state, note },
  });
  if (write.status !== 200) return { write, read: { status: 0, body: null } };
  const read = await appJson(reviewUrl01, { headers: authHeaders });
  assert.equal(read.status, 200, `review_reread_${state}_${read.status}`);
  validateHumanReviewPayload(read.body, store01.store_id);
  return { write, read };
}

async function attemptRestoreOriginalReview() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const write = await appJson(reviewUrl01, {
        method: 'POST', headers: authHeaders,
        body: { inboxItemId: target.inboxItemId, state: originalState, note: originalNote },
      });
      if (write.status === 200 && write.body?.review?.state === originalState) {
        const read = await appJson(reviewUrl01, { headers: authHeaders });
        const item = read.body?.items?.find((row) => row?.inboxItemId === target.inboxItemId);
        if (read.status === 200 && item?.review?.state === originalState) return true;
      }
    } catch {}
    await sleep(1000 * attempt);
  }
  return false;
}

function validateHumanReviewPayload(payload, expectedStoreId) {
  assert.equal(payload?.schemaVersion, REVIEW_CONTRACT, 'human_review_schema_mismatch');
  assert.equal(payload?.storeId, expectedStoreId, 'human_review_store_mismatch');
  validateWriteAuthority(payload?.authority);
  assert(Array.isArray(payload?.items) && payload.items.length > 0, 'human_review_items_empty');
  for (const item of payload.items) {
    assert.equal(item?.decisionPacket?.schemaVersion, 'recommendation-decision-packet-v1', 'decision_packet_schema_mismatch');
    assert.equal(item?.decisionPacket?.authority?.readOnly, true, 'decision_packet_read_only_invalid');
    assert.equal(item?.decisionPacket?.authority?.executionAuthorized, false, 'decision_packet_execution_invalid');
    assert.equal(item?.decisionPacket?.authority?.amazonMutationAuthorized, false, 'decision_packet_amazon_invalid');
  }
  const library = payload?.candidateLibrary;
  assert.equal(library?.schemaVersion, 'governed-keyword-negative-candidate-library-v1', 'candidate_library_schema_mismatch');
  assert.equal(library?.authority?.readOnly, true, 'candidate_library_read_only_invalid');
  assert.equal(library?.authority?.executionAuthorized, false, 'candidate_library_execution_invalid');
  assert.equal(library?.authority?.amazonMutationAuthorized, false, 'candidate_library_amazon_invalid');
  const learning = payload?.historicalLearning;
  assert.equal(learning?.schemaVersion, 'historical-review-learning-v1', 'historical_learning_schema_mismatch');
  assert.equal(learning?.authority?.readOnly, true, 'historical_learning_read_only_invalid');
  for (const key of ['adaptiveLearningAuthorized', 'ruleMutationAuthorized', 'recommendationMutationAuthorized', 'executionAuthorized', 'amazonMutationAuthorized']) {
    assert.equal(learning?.authority?.[key], false, `historical_learning_${key}_invalid`);
  }
  for (const key of ['approvedMeansExecuted', 'approvedMeansSuccessful', 'rejectedMeansFailed', 'finalDispositionIsEffectiveness', 'automaticFeedbackIntoRecommendations']) {
    assert.equal(learning?.semantics?.[key], false, `historical_learning_semantics_${key}_invalid`);
  }
}

function validateWriteAuthority(authority) {
  assert.equal(authority?.reviewPersistenceSupported, true, 'review_persistence_authority_missing');
  assert.deepEqual(authority?.durableStates, ['acknowledged', 'needs_review', 'approved', 'rejected']);
  assert.equal(authority?.approvedRejectedPersistenceSupported, true, 'approved_rejected_persistence_not_supported');
  assert.equal(authority?.finalDispositionReviewOnly, true, 'final_disposition_not_review_only');
  assert.equal(authority?.optimizationActionPersistenceAuthorized, false, 'optimization_action_persistence_authorized');
  assert.equal(authority?.executionAuthorized, false, 'execution_authorized');
  assert.equal(authority?.amazonMutationAuthorized, false, 'amazon_mutation_authorized');
}

function assertCurrentProjection(payload, inboxItemId, fingerprint, expectedState) {
  validateHumanReviewPayload(payload, store01.store_id);
  const item = payload.items.find((row) => row?.inboxItemId === inboxItemId);
  assert(item, `current_item_missing:${expectedState}`);
  assert.equal(item?.recommendationFingerprint, fingerprint, `current_fingerprint_drift:${expectedState}`);
  assert.equal(item?.review?.state, expectedState, `current_review_state_${expectedState}`);
  assert.equal(item?.review?.persisted, true, `current_review_not_persisted:${expectedState}`);
  const libraryItem = payload?.candidateLibrary?.items?.find((row) => row?.inboxItemId === inboxItemId);
  assert(libraryItem, `candidate_library_item_missing:${expectedState}`);
  assert.equal(libraryItem?.currentFingerprint, fingerprint, `candidate_library_fingerprint_drift:${expectedState}`);
  assert.equal(libraryItem?.currentReviewState, expectedState, `candidate_library_state_${expectedState}`);
  assert.equal(libraryItem?.currentReviewPersisted, true, `candidate_library_not_persisted:${expectedState}`);
  const learningContext = payload?.historicalLearning?.contexts?.find((row) => row?.inboxItemId === inboxItemId && row?.currentFingerprint === fingerprint);
  assert(learningContext, `historical_learning_context_missing:${expectedState}`);
  assert.equal(learningContext?.currentCandidateActive, true, `historical_learning_current_inactive:${expectedState}`);
  assert.equal(learningContext?.currentReviewState, expectedState, `historical_learning_state_${expectedState}`);
  assert.equal(learningContext?.currentReviewPersisted, true, `historical_learning_not_persisted:${expectedState}`);
}

async function queueSnapshot(storeId, headers) {
  const url = new URL('/api/v1/analytics/data-health', PROD_BASE_URL);
  url.searchParams.set('includeDecisionQueue', 'true');
  url.searchParams.set('startDate', SCOPE.startDate);
  url.searchParams.set('endDate', SCOPE.endDate);
  url.searchParams.set('storeId', storeId);
  const response = await appJson(url.toString(), { headers });
  assert.equal(response.status, 200, `data_health_${response.status}`);
  assert.equal(response.body?.decisionQueue?.schemaVersion, 'four-store-decision-queue-summary-v1');
  assert.equal(response.body?.decisionQueue?.authority?.readOnly, true);
  assert.equal(response.body?.decisionQueue?.authority?.executionAuthorized, false);
  assert.equal(response.body?.decisionQueue?.authority?.amazonMutationAuthorized, false);
  assert.equal(response.body?.operatorWorkQueue?.authority?.readOnly, true);
  assert.equal(response.body?.operatorWorkQueue?.authority?.executionAuthorized, false);
  assert.equal(response.body?.operatorWorkQueue?.authority?.amazonMutationAuthorized, false);
  const row = response.body?.decisionQueue?.stores?.find((entry) => entry?.storeId === storeId);
  assert(row && row.unavailable === false, 'decision_queue_store_unavailable');
  for (const key of ['unreviewedCount', 'needsReviewCount', 'acknowledgedCount', 'approvedCount', 'rejectedCount', 'resolvedCount']) {
    assert(Number.isInteger(row[key]) && row[key] >= 0, `decision_queue_count_invalid:${key}`);
  }
  assert.equal(row.resolvedCount, row.approvedCount + row.rejectedCount, 'resolved_count_integrity');
  return row;
}

function assertQueueTransition(before, after, fromState, toState) {
  const from = queueKey(fromState);
  const to = queueKey(toState);
  if (from === to) {
    assertQueueEqual(after, before);
    return;
  }
  for (const key of ['unreviewedCount', 'needsReviewCount', 'acknowledgedCount', 'approvedCount', 'rejectedCount']) {
    let expected = before[key];
    if (key === from) expected -= 1;
    if (key === to) expected += 1;
    assert.equal(after[key], expected, `queue_transition_${fromState}_to_${toState}:${key}`);
  }
  const fromResolved = fromState === 'approved' || fromState === 'rejected';
  const toResolved = toState === 'approved' || toState === 'rejected';
  assert.equal(after.resolvedCount, before.resolvedCount + Number(toResolved) - Number(fromResolved), `queue_transition_resolved:${fromState}_to_${toState}`);
}

function assertQueueEqual(actual, expected) {
  for (const key of ['unreviewedCount', 'needsReviewCount', 'acknowledgedCount', 'approvedCount', 'rejectedCount', 'resolvedCount']) {
    assert.equal(actual[key], expected[key], `queue_restore_mismatch:${key}`);
  }
}

function queueKey(state) {
  if (state === 'needs_review') return 'needsReviewCount';
  if (state === 'acknowledged') return 'acknowledgedCount';
  if (state === 'approved') return 'approvedCount';
  if (state === 'rejected') return 'rejectedCount';
  if (state === 'unreviewed') return 'unreviewedCount';
  throw new Error(`unsupported_queue_state:${state}`);
}

function compactQueue(row) {
  return Object.fromEntries(['unreviewedCount', 'needsReviewCount', 'acknowledgedCount', 'approvedCount', 'rejectedCount', 'resolvedCount', 'staleReviewEvidenceCount'].map((key) => [key, row?.[key] ?? null]));
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

function assertNoExecutionRows(snapshot) {
  for (const [storeCode, counts] of Object.entries(snapshot || {})) {
    assert.equal(Number(counts.optimization_actions || 0), 0, `optimization_actions_nonzero:${storeCode}`);
    assert.equal(Number(counts.optimization_execution_receipts || 0), 0, `optimization_execution_receipts_nonzero:${storeCode}`);
  }
}

async function cleanupTemporaryResources() {
  if (controlDb) {
    await cleanupStep('storeMembershipRemoved', async () => { await controlDb.prepare(`DELETE FROM store_members WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run(); });
    await cleanupStep('rolePermissionsRemoved', async () => { await controlDb.prepare(`DELETE FROM role_permissions WHERE role_key=?1`).bind(ROLE_KEY).run(); });
    await cleanupStep('temporaryRoleRemoved', async () => { await controlDb.prepare(`DELETE FROM app_roles WHERE role_key=?1 AND is_system=0`).bind(ROLE_KEY).run(); });
    await cleanupStep('servicePrincipalRemoved', async () => { await controlDb.prepare(`DELETE FROM users WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run(); });
  }
  await cleanupStep('accessPolicyDeleted', async () => {
    if (accessPolicy?.id) await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies/${encodeURIComponent(accessPolicy.id)}`, { method: 'DELETE' });
  });
  await cleanupStep('serviceTokenDeleted', async () => {
    if (serviceToken?.id) await cf(`/access/service_tokens/${encodeURIComponent(serviceToken.id)}`, { method: 'DELETE' });
  });
}

async function verifyCleanup() {
  try {
    if (controlDb) {
      const membership = await controlDb.prepare(`SELECT COUNT(*) AS count FROM store_members WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).first();
      const permissions = await controlDb.prepare(`SELECT COUNT(*) AS count FROM role_permissions WHERE role_key=?1`).bind(ROLE_KEY).first();
      const role = await controlDb.prepare(`SELECT COUNT(*) AS count FROM app_roles WHERE role_key=?1`).bind(ROLE_KEY).first();
      const user = await controlDb.prepare(`SELECT COUNT(*) AS count FROM users WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).first();
      assert.equal(Number(membership?.count || 0), 0, 'cleanup_membership_residue');
      assert.equal(Number(permissions?.count || 0), 0, 'cleanup_permission_residue');
      assert.equal(Number(role?.count || 0), 0, 'cleanup_role_residue');
      assert.equal(Number(user?.count || 0), 0, 'cleanup_user_residue');
    }
    const tokens = await cf('/access/service_tokens?per_page=100');
    assert(!(tokens.result || []).some((row) => row?.name === TOKEN_NAME), 'cleanup_service_token_residue');
    const policies = await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies`);
    assert(!(policies.result || []).some((row) => row?.name === POLICY_NAME), 'cleanup_access_policy_residue');
    receipt.cleanup.verified = true;
  } catch (error) {
    receipt.cleanup.verified = false;
    receipt.cleanup.verifyError = scrub(error?.message || String(error));
    receipt.blockers.push(`cleanup_failed:${receipt.cleanup.verifyError}`);
  }
}

async function cleanupStep(name, operation) {
  try { await operation(); receipt.cleanup[name] = true; }
  catch (error) { receipt.cleanup[name] = false; receipt.cleanup[`${name}Error`] = scrub(error?.message || String(error)); }
}

async function assertProductionSyncHardOff() {
  const deployments = await cf(`/workers/scripts/${encodeURIComponent(SYNC_WORKER)}/deployments`);
  const head = deploymentHead(deployments);
  assert.equal(head.id, EXPECTED_SYNC_DEPLOYMENT, 'production_sync_deployment_drift');
  assert.equal(head.versionId, EXPECTED_SYNC_VERSION, 'production_sync_version_drift');
  const settings = await cf(`/workers/scripts/${encodeURIComponent(SYNC_WORKER)}/settings`);
  assert.equal(textBinding(bindings(settings), 'AMAZON_ADS_ENABLED'), 'false', 'production_sync_amazon_enabled_drift');
  const schedules = await cf(`/workers/scripts/${encodeURIComponent(SYNC_WORKER)}/schedules`);
  assert.equal(scheduleCount(schedules), 0, 'production_sync_schedule_drift');
  receipt.runtime.productionSync = { deployment: head.id, version: head.versionId, amazonAdsEnabled: false, scheduleCount: 0 };
}

async function awaitServiceAuth(headers) {
  let last = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const probe = await appJson(`${PROD_BASE_URL}/api/health`, { headers });
    last = probe;
    if (probe.status === 200 && probe.body?.environment === 'production') return;
    await sleep(1500);
  }
  throw new Error(`service_auth_not_propagated:${last?.status || 'unknown'}`);
}

function serviceHeaders() {
  return {
    'CF-Access-Client-Id': serviceToken.client_id,
    'CF-Access-Client-Secret': serviceToken.client_secret,
    accept: 'application/json',
  };
}

function reviewUrl(storeId) {
  const params = new URLSearchParams({
    reviewContract: REVIEW_CONTRACT,
    startDate: SCOPE.startDate,
    endDate: SCOPE.endDate,
    limit: SCOPE.limit,
    sort: SCOPE.sort,
  });
  return `${PROD_BASE_URL}/api/v1/stores/${encodeURIComponent(storeId)}/advisory-reviews?${params}`;
}

function byBinding(binding) {
  const row = stores.find((store) => store.d1_binding_key === binding);
  assert(row, `store_binding_missing:${binding}`);
  return row;
}

function deploymentHead(payload) {
  const deployments = Array.isArray(payload?.result?.deployments) ? payload.result.deployments : [];
  assert(deployments.length > 0, 'deployment_list_empty');
  return {
    id: deployments[0].id,
    versionId: deployments[0]?.versions?.[0]?.version_id || null,
    createdOn: deployments[0].created_on || null,
  };
}

function bindings(payload) { return Array.isArray(payload?.result?.bindings) ? payload.result.bindings : []; }
function textBinding(rows, name) { return rows.find((row) => row?.name === name)?.text ?? null; }
function bindingId(rows, name) {
  const row = rows.find((item) => item?.name === name);
  assert(row?.database_id || row?.id, `binding_missing:${name}`);
  return row.database_id || row.id;
}
function scheduleCount(payload) {
  const rows = Array.isArray(payload?.result) ? payload.result : Array.isArray(payload?.result?.schedules) ? payload.result.schedules : [];
  return rows.length;
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
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : { success: response.ok, result: null }; } catch { payload = { success: response.ok, result: null }; }
  if (!response.ok || payload?.success === false) {
    const code = payload?.errors?.[0]?.code || response.status;
    const message = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`cloudflare_api_failed:${path}:${code}:${scrub(message)}`);
  }
  return payload;
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

async function githubJson(url) {
  const response = await nativeFetch(url, { headers: { accept: 'application/vnd.github+json' } });
  assert(response.ok, `github_http_${response.status}`);
  return response.json();
}

function lowerHeaders(headers) { return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value])); }
function isAmazonHost(hostname) { return /(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(String(hostname || '').toLowerCase()); }
function classifyBlocker(error) {
  const message = scrub(error?.message || String(error));
  if (/canonical_main_drift/.test(message)) return 'canonical_main_drift';
  if (/production_(deployment|version|build)/.test(message)) return `production_runtime_drift:${message.slice(0, 160)}`;
  if (/service_auth|access|403/i.test(message)) return `production_access_acceptance_failed:${message.slice(0, 160)}`;
  if (/restore/.test(message)) return `review_restore_failed:${message.slice(0, 160)}`;
  if (/business_or_execution/.test(message)) return 'production_business_execution_side_effect_detected';
  return `production_final_disposition_acceptance_failed:${message.slice(0, 180)}`;
}
function scrub(value) {
  let text = String(value || '');
  if (API_TOKEN) text = text.split(API_TOKEN).join('[REDACTED_API_TOKEN]');
  if (serviceToken?.client_secret) text = text.split(serviceToken.client_secret).join('[REDACTED_SERVICE_SECRET]');
  return text.replace(/[\r\n\t]+/g, ' ').trim();
}
function redactReceipt(value) { return JSON.parse(JSON.stringify(value, (key, current) => /secret|apiToken|email|reviewId|inboxItemId|fingerprint/i.test(key) ? '[REDACTED]' : current)); }
function required(name) { const value = String(process.env[name] || '').trim(); if (!value) throw new Error(`${name}_required`); return value; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
