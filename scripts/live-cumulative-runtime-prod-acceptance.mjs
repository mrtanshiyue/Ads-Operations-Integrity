import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA = required('EXPECTED_MAIN_SHA');
const EXPECTED_DEV_VERSION = required('EXPECTED_DEV_VERSION');
const PROD_WORKER = process.env.PROD_WORKER || 'ads-operations-web-prod';
const DEV_BASE_URL = (process.env.DEV_BASE_URL || 'https://ads-operations-web-dev.tanshiyuesir.workers.dev').replace(/\/$/, '');
const PROD_BASE_URL = (process.env.PROD_BASE_URL || 'https://ads-operations-web-prod.tanshiyuesir.workers.dev').replace(/\/$/, '');
const PROD_ACCESS_DOMAIN = new URL(PROD_BASE_URL).hostname.toLowerCase();
const PROD_ACCESS_APP_ID = required('PROD_ACCESS_APP_ID');
const PROD_ACCESS_AUD = required('PROD_ACCESS_AUD');
const SYNC_WORKER = process.env.PROD_SYNC_WORKER || 'ads-operations-sync-prod';
const EXPECTED_SYNC_DEPLOYMENT = 'cf0b0adf-96dc-437d-8298-15af58f992ce';
const EXPECTED_SYNC_VERSION = '295df84e-2103-4858-9895-49f67d4b10b4';
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/cumulative-runtime-production-acceptance';
const PRINCIPAL_USER_ID = `svc-cumulative-acceptance-${RUN_ID}`;
const PRINCIPAL_EMAIL = `svc-cumulative-acceptance-${RUN_ID}@machine.invalid`;
const ROLE_KEY = `cumulative_acceptance_${RUN_ID}`;
const TOKEN_NAME = `ads-ops-cumulative-acceptance-${RUN_ID}`;
const POLICY_NAME = `Cumulative #255 acceptance ${RUN_ID}`;
const REVIEW_CONTRACT = 'csv-recommendation-human-review-v1';
const SCOPE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01', limit: '50', sort: 'cost' });
const BUSINESS_TABLES = Object.freeze(['advisory_review_records', 'optimization_actions', 'optimization_execution_receipts', 'sync_runs']);

await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'cumulative-decision-intelligence-production-acceptance-v1',
  issue: 255,
  runId: RUN_ID,
  expectedCanonicalMain: EXPECTED_MAIN_SHA,
  expectedDevelopmentVersion: EXPECTED_DEV_VERSION,
  target: PROD_BASE_URL,
  scope: SCOPE,
  checks: {},
  runtime: {},
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

  const workers = await cf('/workers/scripts');
  const prodWorker = (workers.result || []).find((row) => row?.id === PROD_WORKER);
  assert(prodWorker?.tag, 'production_worker_tag_missing');
  receipt.runtime.productionWorkerTag = prodWorker.tag;

  const triggerPayload = await cf(`/builds/workers/${encodeURIComponent(prodWorker.tag)}/triggers`);
  const triggers = Array.isArray(triggerPayload.result) ? triggerPayload.result : [];
  assert.equal(triggers.length, 1, `production_trigger_count:${triggers.length}`);
  const trigger = triggers[0];
  assert(trigger?.trigger_uuid, 'production_trigger_uuid_missing');
  const triggerText = `${trigger.build_command || ''}\n${trigger.deploy_command || ''}`;
  assert(!/sync|wrangler\.sync/i.test(triggerText), 'production_trigger_contains_sync_semantics');
  assert(String(trigger.deploy_command || '').trim(), 'production_trigger_deploy_command_missing');
  receipt.runtime.productionTrigger = {
    uuid: trigger.trigger_uuid,
    buildCommand: trigger.build_command || null,
    deployCommand: trigger.deploy_command || null,
  };

  const baselineDeployments = await cf(`/workers/scripts/${encodeURIComponent(PROD_WORKER)}/deployments`);
  const baseline = deploymentHead(baselineDeployments);
  receipt.runtime.productionBaseline = baseline;

  const buildCreate = await cf(`/builds/triggers/${encodeURIComponent(trigger.trigger_uuid)}/builds`, {
    method: 'POST',
    body: { branch: 'main', commit_hash: EXPECTED_MAIN_SHA },
  });
  const buildUuid = buildCreate?.result?.build_uuid;
  assert(buildUuid, 'production_exact_main_build_uuid_missing');
  receipt.runtime.productionBuild = { buildUuid };
  receipt.checks.productionExactMainBuildTriggered = true;

  const build = await waitForBuild(buildUuid);
  assert.equal(build.build_outcome, 'success', `production_build_outcome:${build.build_outcome}`);
  assert.equal(build.status, 'stopped', `production_build_status:${build.status}`);
  assert.equal(build.build_trigger_metadata?.branch, 'main', 'production_build_branch_drift');
  assert.equal(build.build_trigger_metadata?.commit_hash, EXPECTED_MAIN_SHA, 'production_build_commit_drift');
  receipt.runtime.productionBuild = {
    buildUuid,
    outcome: build.build_outcome,
    status: build.status,
    branch: build.build_trigger_metadata?.branch || null,
    commitHash: build.build_trigger_metadata?.commit_hash || null,
    source: build.build_trigger_metadata?.build_trigger_source || null,
  };
  receipt.checks.productionExactMainBuildSuccess = true;

  const promoted = await waitForDeploymentAdvance(baseline.id);
  assert.notEqual(promoted.id, baseline.id, 'production_deployment_not_advanced');
  assert.notEqual(promoted.versionId, baseline.versionId, 'production_version_not_advanced');
  receipt.runtime.productionDeployment = promoted;
  receipt.checks.productionRuntimeAdvanced = true;

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
  receipt.runtime.accessApp = { id: accessApp.id, domain: accessApp.domain, aud: accessApp.aud };
  receipt.checks.productionAccessAppExact = true;

  const existingTokens = await cf('/access/service_tokens?per_page=100');
  const tokenRows = Array.isArray(existingTokens.result) ? existingTokens.result : [];
  assert.equal(tokenRows.length, 0, `active_service_token_drift:${tokenRows.length}`);
  receipt.checks.serviceTokenBaselineZero = true;

  const controlDbId = bindingId(prodBindings, 'CONTROL_DB');
  const storeDbIds = Object.fromEntries(['STORE_01_DB','STORE_02_DB','STORE_03_DB','STORE_04_DB'].map((name) => [name, bindingId(prodBindings, name)]));
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
  receipt.runtime.stores = stores.map((row) => ({ storeId: row.store_id, storeCode: row.store_code, binding: row.d1_binding_key }));
  receipt.businessDifferential.before = await businessSnapshot();

  serviceToken = (await cf('/access/service_tokens', {
    method: 'POST',
    body: { name: TOKEN_NAME, duration: '1h', enabled: true },
  })).result;
  assert(serviceToken?.id && serviceToken?.client_id && serviceToken?.client_secret, 'service_token_create_response_incomplete');
  receipt.cleanup.serviceTokenId = serviceToken.id;
  receipt.checks.ephemeralServiceTokenCreated = true;

  accessPolicy = (await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies`, {
    method: 'POST',
    body: { name: POLICY_NAME, decision: 'non_identity', include: [{ service_token: { token_id: serviceToken.id } }] },
  })).result;
  assert(accessPolicy?.id, 'access_policy_create_response_incomplete');
  assert.equal(accessPolicy.decision, 'non_identity', 'access_policy_not_non_identity');
  receipt.cleanup.accessPolicyId = accessPolicy.id;
  receipt.checks.ephemeralNonIdentityPolicyCreated = true;

  const store01 = byBinding('STORE_01_DB');
  const store02 = byBinding('STORE_02_DB');
  await controlDb.prepare(`INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)`).bind(ROLE_KEY, `Cumulative #255 Acceptance ${RUN_ID}`).run();
  await controlDb.prepare(`INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')`).bind(ROLE_KEY).run();
  await controlDb.prepare(`INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at) VALUES(?1,?2,?3,lower(?3),'Cumulative #255 Acceptance Service','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(PRINCIPAL_USER_ID, serviceToken.client_id, PRINCIPAL_EMAIL).run();
  await controlDb.prepare(`INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)`).bind(store01.store_id, PRINCIPAL_USER_ID, ROLE_KEY).run();
  const permissions = await controlDb.prepare(`SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key`).bind(ROLE_KEY).all();
  assert.deepEqual(permissions.results.map((row) => row.permission_key), ['analytics.read']);
  const memberships = await controlDb.prepare(`SELECT store_id FROM store_members WHERE user_id=?1 ORDER BY store_id`).bind(PRINCIPAL_USER_ID).all();
  assert.deepEqual(memberships.results.map((row) => row.store_id), [store01.store_id]);
  receipt.checks.ephemeralStore01AnalyticsReadIdentity = true;

  const authHeaders = serviceHeaders();
  await awaitServiceAuth(authHeaders);

  const health = await appJson(`${PROD_BASE_URL}/api/health`, { headers: authHeaders });
  assert.equal(health.status, 200, `production_health_${health.status}`);
  assert.equal(health.body?.environment, 'production');
  assert.equal(health.body?.syncTriggerEnabled, false);
  assert.equal(health.headers['x-runtime-worker-version'] || health.body?.deployment?.versionId, promoted.versionId, 'production_health_version_mismatch');
  receipt.runtime.productionHealth = { environment: health.body?.environment, syncTriggerEnabled: health.body?.syncTriggerEnabled, version: promoted.versionId };
  receipt.checks.productionHealthExact = true;

  const reviewUrl01 = reviewUrl(store01.store_id);
  const review = await appJson(reviewUrl01, { headers: authHeaders });
  assert.equal(review.status, 200, `production_review_get_${review.status}`);
  validateCumulativePayload(review.body, store01.store_id);
  receipt.runtime.cumulative = summarizeCumulative(review.body);
  receipt.checks.recommendationDecisionPacketLive = true;
  receipt.checks.candidateLibraryLive = true;
  receipt.checks.historicalLearningLive = true;
  receipt.checks.historicalOnlySeparationLive = true;

  const isolation = await appJson(reviewUrl(store02.store_id), { headers: authHeaders });
  assert.equal(isolation.status, 403, `store02_rbac_expected_403_got_${isolation.status}`);
  assert.equal(isolation.body?.error, 'forbidden');
  receipt.checks.storeIsolation = true;

  const asset = await appText(`${PROD_BASE_URL}/assets/cloudflare-native-csv-recommendation-human-review-v1.js`, { headers: authHeaders });
  assert.equal(asset.status, 200, `production_human_review_ui_asset_${asset.status}`);
  for (const fragment of [
    "const VERSION = '1.3.0';",
    "const DECISION_PACKET_VERSION = 'recommendation-decision-packet-v1';",
    "const CANDIDATE_LIBRARY_VERSION = 'governed-keyword-negative-candidate-library-v1';",
    "const HISTORICAL_LEARNING_VERSION = 'historical-review-learning-v1';",
    'Historical Review Learning',
    'Recurrence is not effectiveness',
  ]) assert(asset.body.includes(fragment), `production_ui_fragment_missing:${fragment}`);
  receipt.checks.productionUi130Exact = true;

  receipt.businessDifferential.after = await businessSnapshot();
  assert.deepEqual(receipt.businessDifferential.after, receipt.businessDifferential.before, 'business_or_execution_table_mutation_detected');
  receipt.checks.businessExecutionTablesUnchanged = true;

  assert.equal(receipt.amazonRequests.length, 0, 'amazon_request_attempt_detected');
  receipt.checks.amazonRequestsZero = true;
  corePassed = true;
} catch (error) {
  failure = error;
  receipt.error = { message: scrub(error?.message || String(error)), stack: scrub(String(error?.stack || '')).slice(0, 8000) };
  receipt.blockers.push(classifyBlocker(error));
} finally {
  await cleanupTemporaryResources();
  await verifyCleanup();
  receipt.finishedAt = new Date().toISOString();
  receipt.result = corePassed && receipt.cleanup.verified === true ? 'PASS' : 'FAIL';
  await writeFile(`${OUT}/receipt.json`, `${JSON.stringify(redactReceipt(receipt), null, 2)}\n`);
  console.log(JSON.stringify(redactReceipt({ result: receipt.result, blockers: receipt.blockers, checks: receipt.checks, runtime: receipt.runtime, businessDifferential: receipt.businessDifferential, cleanup: receipt.cleanup, amazonRequests: receipt.amazonRequests.length }), null, 2));
}

if (receipt.result !== 'PASS') {
  if (failure) console.error(scrub(failure?.message || String(failure)));
  process.exitCode = 1;
}

function validateCumulativePayload(payload, expectedStoreId) {
  assert.equal(payload?.schemaVersion, REVIEW_CONTRACT, 'human_review_schema_mismatch');
  assert.equal(payload?.storeId, expectedStoreId, 'human_review_store_mismatch');
  assert.equal(payload?.authority?.executionAuthorized, false, 'human_review_execution_authority');
  assert.equal(payload?.authority?.amazonMutationAuthorized, false, 'human_review_amazon_authority');
  assert(Array.isArray(payload?.items), 'human_review_items_missing');
  assert(payload.items.length > 0, 'human_review_items_empty');
  for (const item of payload.items) {
    const packet = item?.decisionPacket;
    assert.equal(packet?.schemaVersion, 'recommendation-decision-packet-v1', 'decision_packet_schema_mismatch');
    assert.equal(packet?.authority?.readOnly, true, 'decision_packet_read_only_invalid');
    assert.equal(packet?.authority?.executionAuthorized, false, 'decision_packet_execution_invalid');
    assert.equal(packet?.authority?.amazonMutationAuthorized, false, 'decision_packet_amazon_invalid');
    assert.equal(packet?.recommendation?.inboxItemId, item?.inboxItemId, 'decision_packet_identity_mismatch');
  }
  const library = payload?.candidateLibrary;
  assert.equal(library?.schemaVersion, 'governed-keyword-negative-candidate-library-v1', 'candidate_library_schema_mismatch');
  assert.equal(library?.authority?.readOnly, true, 'candidate_library_read_only_invalid');
  assert.equal(library?.authority?.executionAuthorized, false, 'candidate_library_execution_invalid');
  assert.equal(library?.authority?.amazonMutationAuthorized, false, 'candidate_library_amazon_invalid');
  if (library?.status?.available === true) assert.equal(Number(library?.summary?.candidateCount), Array.isArray(library?.items) ? library.items.length : -1, 'candidate_library_count_mismatch');

  const learning = payload?.historicalLearning;
  assert.equal(learning?.schemaVersion, 'historical-review-learning-v1', 'historical_learning_schema_mismatch');
  assert.equal(learning?.authority?.readOnly, true, 'historical_learning_read_only_invalid');
  for (const key of ['adaptiveLearningAuthorized','ruleMutationAuthorized','recommendationMutationAuthorized','executionAuthorized','amazonMutationAuthorized']) assert.equal(learning?.authority?.[key], false, `historical_learning_${key}_invalid`);
  for (const key of ['recurrenceIsEffectiveness','acknowledgedMeansApproved','acknowledgedMeansExecuted','needsReviewMeansRejected','historicalOutcomeAvailable','automaticFeedbackIntoRecommendations']) assert.equal(learning?.semantics?.[key], false, `historical_learning_semantics_${key}_invalid`);
  assert(Array.isArray(learning?.contexts), 'historical_learning_contexts_missing');
  for (const context of learning.contexts) {
    assert.equal(context?.authority?.readOnly, true, 'historical_context_read_only_invalid');
    assert.equal(context?.authority?.executionAuthorized, false, 'historical_context_execution_invalid');
    assert.equal(context?.authority?.amazonMutationAuthorized, false, 'historical_context_amazon_invalid');
    if (context?.currentCandidateActive === true) {
      assert(context?.currentFingerprint, 'historical_current_fingerprint_missing');
      assert(context?.currentReviewState, 'historical_current_review_state_missing');
      assert.equal(typeof context?.currentEvidenceDrift, 'boolean', 'historical_current_drift_missing');
    } else {
      for (const key of ['currentFingerprint','currentReviewState','currentReviewPersisted','currentMatchedRecordCount','staleEvidenceCount','currentEvidenceDrift']) assert.equal(context?.[key], null, `historical_only_fabricated_${key}`);
    }
  }
}

function summarizeCumulative(payload) {
  const learning = payload.historicalLearning || {};
  const library = payload.candidateLibrary || {};
  return {
    humanReviewSchema: payload.schemaVersion,
    itemCount: payload.items?.length || 0,
    decisionPacketSchema: payload.items?.[0]?.decisionPacket?.schemaVersion || null,
    candidateLibrary: { schemaVersion: library.schemaVersion || null, status: library.status || null, summary: library.summary || null, authority: library.authority || null },
    historicalLearning: { schemaVersion: learning.schemaVersion || null, summary: learning.summary || null, authority: learning.authority || null, semantics: learning.semantics || null, currentContextCount: (learning.contexts || []).filter((row) => row?.currentCandidateActive === true).length, historicalOnlyContextCount: (learning.contexts || []).filter((row) => row?.currentCandidateActive !== true).length },
  };
}

async function waitForBuild(buildUuid) {
  let last = null;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const payload = await cf(`/builds/builds/${encodeURIComponent(buildUuid)}`);
    last = payload.result || null;
    if (last?.status === 'stopped') return last;
    await sleep(5000);
  }
  throw new Error(`production_build_timeout:${buildUuid}:${last?.status || 'unknown'}`);
}

async function waitForDeploymentAdvance(baselineId) {
  let last = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const payload = await cf(`/workers/scripts/${encodeURIComponent(PROD_WORKER)}/deployments`);
    last = deploymentHead(payload);
    if (last.id !== baselineId) return last;
    await sleep(3000);
  }
  throw new Error(`production_deployment_advance_timeout:${baselineId}`);
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

async function cleanupTemporaryResources() {
  if (controlDb) {
    await cleanupStep('storeMembershipRemoved', async () => { await controlDb.prepare(`DELETE FROM store_members WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run(); });
    await cleanupStep('rolePermissionsRemoved', async () => { await controlDb.prepare(`DELETE FROM role_permissions WHERE role_key=?1`).bind(ROLE_KEY).run(); });
    await cleanupStep('temporaryRoleRemoved', async () => { await controlDb.prepare(`DELETE FROM app_roles WHERE role_key=?1 AND is_system=0`).bind(ROLE_KEY).run(); });
    await cleanupStep('servicePrincipalRemoved', async () => { await controlDb.prepare(`DELETE FROM users WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run(); });
  }
  await cleanupStep('accessPolicyDeleted', async () => { if (accessPolicy?.id) await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies/${encodeURIComponent(accessPolicy.id)}`, { method: 'DELETE' }); });
  await cleanupStep('serviceTokenDeleted', async () => { if (serviceToken?.id) await cf(`/access/service_tokens/${encodeURIComponent(serviceToken.id)}`, { method: 'DELETE' }); });
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

function serviceHeaders() {
  return { 'CF-Access-Client-Id': serviceToken.client_id, 'CF-Access-Client-Secret': serviceToken.client_secret, accept: 'application/json' };
}

function reviewUrl(storeId) {
  const params = new URLSearchParams({ reviewContract: REVIEW_CONTRACT, startDate: SCOPE.startDate, endDate: SCOPE.endDate, limit: SCOPE.limit, sort: SCOPE.sort });
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
  return { id: deployments[0].id, versionId: deployments[0]?.versions?.[0]?.version_id || null, createdOn: deployments[0].created_on || null };
}

function bindings(payload) { return Array.isArray(payload?.result?.bindings) ? payload.result.bindings : []; }
function textBinding(rows, name) { return rows.find((row) => row?.name === name)?.text ?? null; }
function bindingId(rows, name) { const row = rows.find((item) => item?.name === name); assert(row?.database_id || row?.id, `binding_missing:${name}`); return row.database_id || row.id; }
function scheduleCount(payload) { const rows = Array.isArray(payload?.result) ? payload.result : Array.isArray(payload?.result?.schedules) ? payload.result.schedules : []; return rows.length; }

async function cf(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`, {
    method,
    headers: { authorization: `Bearer ${API_TOKEN}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
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

async function appJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  const response = await fetch(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', cache: 'no-store' });
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
function classifyBlocker(error) { const message = scrub(error?.message || String(error)); if (/canonical_main_drift/.test(message)) return 'canonical_main_drift'; if (/production_build|deployment/.test(message)) return `production_promotion_failed:${message.slice(0,160)}`; if (/service_auth|access|403/i.test(message)) return `production_access_acceptance_failed:${message.slice(0,160)}`; if (/business_or_execution_table_mutation/.test(message)) return 'production_read_side_effect_detected'; return `production_cumulative_acceptance_failed:${message.slice(0,180)}`; }
function scrub(value) { let text = String(value || ''); if (API_TOKEN) text = text.split(API_TOKEN).join('[REDACTED_API_TOKEN]'); if (serviceToken?.client_secret) text = text.split(serviceToken.client_secret).join('[REDACTED_SERVICE_SECRET]'); return text.replace(/[\r\n\t]+/g, ' ').trim(); }
function redactReceipt(value) { return JSON.parse(JSON.stringify(value, (key, current) => /secret|apiToken/i.test(key) ? '[REDACTED]' : current)); }
function required(name) { const value = String(process.env[name] || '').trim(); if (!value) throw new Error(`${name}_required`); return value; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
