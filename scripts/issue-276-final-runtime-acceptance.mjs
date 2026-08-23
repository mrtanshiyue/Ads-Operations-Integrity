import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA = required('EXPECTED_MAIN_SHA');
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/issue-276-final-runtime-acceptance';
const REVIEW_CONTRACT = 'csv-recommendation-human-review-v1';
const SCOPE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01', limit: '50', sort: 'cost' });

const DEV = Object.freeze({
  key: 'development',
  worker: 'ads-operations-web-dev',
  baseUrl: 'https://ads-operations-web-dev.tanshiyuesir.workers.dev',
  controlDbId: '2093b94f-27d5-4a4c-ada1-ff14af5c8de2',
  store01DbId: '123b2a32-d78b-4de9-8318-08e35cefb008',
  expectedOriginalVersion: 'bd3fcb2d-f4a7-4f04-afb3-b6287c17d32a',
  isolationStoreId: 'store-dev-02',
});
const PROD = Object.freeze({
  key: 'production',
  worker: 'ads-operations-web-prod',
  baseUrl: 'https://ads-operations-web-prod.tanshiyuesir.workers.dev',
  controlDbId: '2122248c-1fd4-4ccd-b611-9f9d2f3decbf',
  store01DbId: '2e53bbad-5680-431c-bcf7-68e89b231ea1',
  store02DbId: 'a5d8e5b0-8d29-48a7-b200-6aa14a2fb997',
  buildTrigger: 'fa90d482-de7b-466b-9ada-04404569ede9',
});
const PROD_SYNC = Object.freeze({ worker: 'ads-operations-sync-prod' });

await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'issue-276-final-runtime-acceptance-v1',
  issue: 276,
  parentIssue: 273,
  expectedCanonicalMain: EXPECTED_MAIN_SHA,
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  requestBoundary: {
    amazonApiAllowed: false,
    optimizationActionExecutionAllowed: false,
    syncAllowed: false,
  },
  amazonRequests: [],
  blockers: [],
  dev: null,
  production: null,
  result: 'FAIL',
};

let fatal = null;
try {
  receipt.dev = await runDevelopmentGate();
  assert.equal(receipt.dev.result, 'PASS', 'development_gate_not_pass');

  receipt.production = await runProductionGate();
  assert.equal(receipt.production.result, 'PASS', 'production_gate_not_pass');

  assert.equal(receipt.amazonRequests.length, 0, 'amazon_request_observed');
  receipt.result = 'PASS';
} catch (error) {
  fatal = error;
  receipt.blockers.push(scrub(error?.message || String(error)));
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(redactReceipt(receipt), null, 2));
}
if (fatal) throw fatal;

async function runDevelopmentGate() {
  const evidence = baseEnvironmentEvidence(DEV);
  let tempVersion = null;
  let auth = null;
  let restoreVerified = false;
  let failure = null;

  try {
    const original = await activeDeployment(DEV.worker);
    evidence.originalDeployment = original;
    assert.equal(original.versionId, DEV.expectedOriginalVersion, `dev_original_version_drift:${original.versionId}`);

    const settings = await workerSettings(DEV.worker);
    assertHardOffBindings(settings.bindings, { accessMode: 'off' });
    evidence.originalBindings = summarizeSafetyBindings(settings.bindings);

    const beforeVersions = await workerVersions(DEV.worker);
    tempVersion = await createTemporaryAccessModeVersion(DEV.worker, beforeVersions, settings.bindings, 'enforce');
    evidence.temporaryVersion = tempVersion;
    await deployVersion(DEV.worker, tempVersion.versionId, '#276 temporary Dev ACCESS_MODE=enforce acceptance');
    await waitForActiveVersion(DEV.worker, tempVersion.versionId);
    evidence.checks.temporaryExactCodeVersionActivated = true;

    const temporarySettings = await workerSettings(DEV.worker);
    assertHardOffBindings(temporarySettings.bindings, { accessMode: 'enforce' });
    evidence.temporaryBindings = summarizeSafetyBindings(temporarySettings.bindings);
    evidence.checks.amazonHardOffDuringTemporaryVersion = true;

    auth = await createAcceptanceIdentity(DEV, 'dev');
    evidence.identity = auth.public;
    evidence.checks.leastPrivilegeIdentityCreated = true;

    evidence.semanticAcceptance = await runRationaleSemantics({ config: DEV, auth });
    assert.equal(evidence.semanticAcceptance.result, 'PASS');
    evidence.result = 'PASS';
  } catch (error) {
    failure = error;
    evidence.error = scrub(error?.message || String(error));
  } finally {
    try {
      if (DEV.expectedOriginalVersion) {
        await deployVersion(DEV.worker, DEV.expectedOriginalVersion, '#276 restore Dev exact-main read-only runtime');
        await waitForActiveVersion(DEV.worker, DEV.expectedOriginalVersion);
        const restored = await activeDeployment(DEV.worker);
        assert.equal(restored.versionId, DEV.expectedOriginalVersion);
        restoreVerified = true;
        evidence.cleanup = { ...(evidence.cleanup || {}), originalVersionRestored: true, restoredDeployment: restored };
      }
    } catch (error) {
      failure ||= error;
      evidence.cleanup = { ...(evidence.cleanup || {}), originalVersionRestored: false, restoreError: scrub(error?.message || String(error)) };
    }

    if (auth) {
      const cleanup = await cleanupAcceptanceIdentity(auth).catch((error) => ({ refsZero: false, error: scrub(error?.message || String(error)) }));
      evidence.cleanup = { ...(evidence.cleanup || {}), identity: cleanup };
      if (!cleanup.refsZero) failure ||= new Error('dev_temporary_identity_cleanup_incomplete');
    }

    try {
      const finalSettings = await workerSettings(DEV.worker);
      assertHardOffBindings(finalSettings.bindings, { accessMode: 'off' });
      evidence.cleanup = { ...(evidence.cleanup || {}), finalBindings: summarizeSafetyBindings(finalSettings.bindings) };
    } catch (error) {
      failure ||= error;
      evidence.cleanup = { ...(evidence.cleanup || {}), finalBindingError: scrub(error?.message || String(error)) };
    }
  }

  if (!restoreVerified) evidence.result = 'FAIL';
  if (failure) throw Object.assign(new Error(`development_gate_failed:${scrub(failure.message)}`), { evidence });
  return evidence;
}

async function runProductionGate() {
  const evidence = baseEnvironmentEvidence(PROD);
  let auth = null;
  let failure = null;
  const syncBefore = await productionSyncSnapshot();
  evidence.productionSyncBefore = syncBefore;

  try {
    const before = await activeDeployment(PROD.worker);
    evidence.priorProductionDeployment = before;

    const build = await triggerAndWaitExactMainBuild();
    evidence.exactMainBuild = build;
    evidence.checks.exactMainBuildSuccess = true;

    const promoted = await waitForNewActiveVersion(PROD.worker, before.versionId);
    evidence.productionDeployment = promoted;
    evidence.checks.productionRuntimeAdvanced = true;

    const webSettings = await workerSettings(PROD.worker);
    assertHardOffBindings(webSettings.bindings, { accessMode: 'enforce' });
    evidence.webSafetyBindings = summarizeSafetyBindings(webSettings.bindings);
    evidence.checks.webHardOff = true;

    const webSchedules = await workerSchedules(PROD.worker);
    assert.deepEqual(webSchedules, [], 'production_web_schedules_not_empty');
    evidence.webSchedules = webSchedules;

    auth = await createAcceptanceIdentity(PROD, 'prod');
    evidence.identity = auth.public;
    evidence.checks.leastPrivilegeIdentityCreated = true;

    const health = await appJson(`${PROD.baseUrl}/api/health`, { headers: auth.headers });
    assert.equal(health.status, 200, `production_health_authenticated_status:${health.status}`);
    assert.equal(health.body?.environment, 'production');
    assert.equal(health.body?.syncTriggerEnabled, false);
    assert.equal(health.body?.deployment?.versionId, promoted.versionId, 'production_health_version_mismatch');
    evidence.health = health.body;

    evidence.semanticAcceptance = await runRationaleSemantics({ config: PROD, auth });
    assert.equal(evidence.semanticAcceptance.result, 'PASS');

    const syncAfter = await productionSyncSnapshot();
    evidence.productionSyncAfter = syncAfter;
    assert.deepEqual(syncAfter, syncBefore, 'production_sync_changed_during_276_gate');
    evidence.checks.productionSyncUnchanged = true;

    assert.equal(receipt.amazonRequests.length, 0);
    evidence.result = 'PASS';
  } catch (error) {
    failure = error;
    evidence.error = scrub(error?.message || String(error));
  } finally {
    if (auth) {
      const cleanup = await cleanupAcceptanceIdentity(auth).catch((error) => ({ refsZero: false, error: scrub(error?.message || String(error)) }));
      evidence.cleanup = { identity: cleanup };
      if (!cleanup.refsZero) failure ||= new Error('production_temporary_identity_cleanup_incomplete');
    }
    try {
      const syncFinal = await productionSyncSnapshot();
      evidence.productionSyncFinal = syncFinal;
      assert.deepEqual(syncFinal, syncBefore, 'production_sync_final_snapshot_changed');
    } catch (error) {
      failure ||= error;
      evidence.syncFinalError = scrub(error?.message || String(error));
    }
  }

  if (failure) throw Object.assign(new Error(`production_gate_failed:${scrub(failure.message)}`), { evidence });
  return evidence;
}

async function runRationaleSemantics({ config, auth }) {
  const controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: config.controlDbId, apiToken: API_TOKEN });
  const store01Db = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: config.store01DbId, apiToken: API_TOKEN });
  const evidence = { result: 'FAIL', checks: {}, requests: [], cleanup: {} };
  let createdReviewId = null;
  let candidate = null;
  let store01 = null;
  let failure = null;

  try {
    store01 = await controlDb.prepare("SELECT store_id,store_code,d1_binding_key,status FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();
    assert(store01?.store_id, `${config.key}_store01_missing`);
    evidence.store01 = store01.store_id;

    const ui = await appText(`${config.baseUrl}/assets/cloudflare-native-csv-recommendation-human-review-v1.js`, { headers: auth.headers });
    assert.equal(ui.status, 200, `${config.key}_ui_status:${ui.status}`);
    assert(ui.body.includes("const VERSION = '1.7.0';"), `${config.key}_ui_1_7_0_missing`);
    evidence.checks.ui170 = true;

    const reviewUrl = makeReviewUrl(config.baseUrl, store01.store_id);
    const initial = await retryAppJson(reviewUrl, { headers: auth.headers }, 12, 2500);
    evidence.requests.push({ method: 'GET', path: new URL(reviewUrl).pathname });
    assert.equal(initial.status, 200, `${config.key}_initial_review_get:${initial.status}:${JSON.stringify(initial.body).slice(0,250)}`);
    assert.equal(initial.body?.authority?.executionAuthorized, false);
    assert.equal(initial.body?.authority?.amazonMutationAuthorized, false);
    assert.equal(initial.body?.analysisScope?.candidateEmissionAuthorized, true);
    candidate = (initial.body?.items || []).find((item) => item?.persistenceAuthorized === true && item?.review?.persisted !== true);
    assert(candidate?.inboxItemId, `${config.key}_unreviewed_current_candidate_missing`);
    evidence.candidate = {
      inboxItemId: candidate.inboxItemId,
      recommendationFingerprint: candidate.recommendationFingerprint,
      sourceEvidenceSha256: candidate.sourceEvidenceSha256,
      originalState: 'unreviewed',
      originalNote: null,
    };
    evidence.checks.currentUnreviewedCandidateResolved = true;
    evidence.checks.executionAuthorityFalse = true;
    evidence.checks.amazonMutationAuthorityFalse = true;

    const preexisting = await store01Db.prepare('SELECT review_id FROM advisory_review_records WHERE recommendation_fingerprint=?1 LIMIT 1').bind(candidate.recommendationFingerprint).first();
    assert.equal(preexisting, null, `${config.key}_candidate_unreviewed_but_row_exists`);

    const optimizationBefore = await safeCount(store01Db, 'optimization_actions');
    evidence.optimizationActionsBefore = optimizationBefore;

    const expectedRationale = `issue-276-${config.key}-${RUN_ID}-rationale`;
    const create = await appJson(reviewUrl, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: { inboxItemId: candidate.inboxItemId, state: 'needs_review', note: `  ${expectedRationale}  ` },
    });
    evidence.requests.push({ method: 'POST', path: new URL(reviewUrl).pathname, semantics: 'explicit_note' });
    assert.equal(create.status, 201, `${config.key}_create_review_status:${create.status}:${JSON.stringify(create.body).slice(0,250)}`);
    assert.equal(create.body?.review?.state, 'needs_review');
    assert.equal(create.body?.review?.note, expectedRationale);
    assert.equal(create.body?.authority?.executionAuthorized, false);
    assert.equal(create.body?.authority?.amazonMutationAuthorized, false);
    createdReviewId = create.body?.review?.reviewId || null;
    assert(createdReviewId, `${config.key}_created_review_id_missing`);
    evidence.createdReviewId = createdReviewId;
    evidence.checks.explicitRationaleNormalizedAndPersisted = true;

    const afterExplicit = await appJson(reviewUrl, { headers: auth.headers });
    evidence.requests.push({ method: 'GET', path: new URL(reviewUrl).pathname, semantics: 'fresh_read_after_explicit_note' });
    const storedExplicit = findReview(afterExplicit.body, candidate.inboxItemId);
    assert.equal(afterExplicit.status, 200);
    assert.equal(storedExplicit?.review?.persisted, true);
    assert.equal(storedExplicit?.review?.state, 'needs_review');
    assert.equal(storedExplicit?.review?.note, expectedRationale);
    evidence.checks.readAfterWriteStateAndNote = true;

    const stateOnly = await appJson(reviewUrl, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: { inboxItemId: candidate.inboxItemId, state: 'acknowledged' },
    });
    evidence.requests.push({ method: 'POST', path: new URL(reviewUrl).pathname, semantics: 'omitted_note_preserve' });
    assert.equal(stateOnly.status, 200, `${config.key}_state_only_status:${stateOnly.status}`);
    assert.equal(stateOnly.body?.review?.state, 'acknowledged');
    assert.equal(stateOnly.body?.review?.note, expectedRationale);

    const afterStateOnly = await appJson(reviewUrl, { headers: auth.headers });
    const storedStateOnly = findReview(afterStateOnly.body, candidate.inboxItemId);
    assert.equal(storedStateOnly?.review?.state, 'acknowledged');
    assert.equal(storedStateOnly?.review?.note, expectedRationale);
    evidence.checks.omittedNotePreserved = true;

    const explicitClear = await appJson(reviewUrl, {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: { inboxItemId: candidate.inboxItemId, state: 'needs_review', note: '   ' },
    });
    evidence.requests.push({ method: 'POST', path: new URL(reviewUrl).pathname, semantics: 'explicit_blank_clear' });
    assert.equal(explicitClear.status, 200, `${config.key}_clear_status:${explicitClear.status}`);
    assert.equal(explicitClear.body?.review?.state, 'needs_review');
    assert.equal(explicitClear.body?.review?.note, null);

    const afterClear = await appJson(reviewUrl, { headers: auth.headers });
    const storedClear = findReview(afterClear.body, candidate.inboxItemId);
    assert.equal(storedClear?.review?.state, 'needs_review');
    assert.equal(storedClear?.review?.note, null);
    evidence.checks.explicitBlankCleared = true;
    evidence.checks.noOptimisticDurableState = true;

    const isolationStoreId = config.key === 'production'
      ? await productionIsolationStore(controlDb)
      : config.isolationStoreId;
    const isolation = await appJson(makeReviewUrl(config.baseUrl, isolationStoreId), { headers: auth.headers });
    evidence.requests.push({ method: 'GET', path: `/api/v1/stores/${isolationStoreId}/advisory-reviews`, semantics: 'isolation' });
    assert.equal(isolation.status, 403, `${config.key}_isolation_status:${isolation.status}`);
    assert.equal(isolation.body?.error, 'forbidden');
    evidence.checks.storeIsolationFailClosed = true;

    const optimizationAfter = await safeCount(store01Db, 'optimization_actions');
    evidence.optimizationActionsAfter = optimizationAfter;
    if (optimizationBefore !== null && optimizationAfter !== null) assert.equal(optimizationAfter, optimizationBefore, `${config.key}_optimization_actions_changed`);
    evidence.checks.optimizationActionsUnchanged = optimizationBefore === null || optimizationAfter === null ? 'count_unavailable_authority_false' : true;

    // Cleanup only: remove the review created by this acceptance. No D1 write above this line is used as acceptance evidence.
    await store01Db.prepare('DELETE FROM advisory_review_records WHERE review_id=?1 AND reviewer_user_id=?2').bind(createdReviewId, auth.principalUserId).run();
    evidence.cleanup.createdReviewDeleted = true;
    const afterCleanup = await appJson(reviewUrl, { headers: auth.headers });
    const restored = findReview(afterCleanup.body, candidate.inboxItemId);
    assert.equal(restored?.review?.persisted, false, `${config.key}_review_not_restored_to_unreviewed`);
    assert.equal(restored?.review?.state, 'unreviewed');
    assert.equal(restored?.review?.note ?? null, null);
    evidence.cleanup.originalUnreviewedStateRestored = true;
    createdReviewId = null;

    evidence.result = 'PASS';
  } catch (error) {
    failure = error;
    evidence.error = scrub(error?.message || String(error));
  } finally {
    if (createdReviewId) {
      try {
        await store01Db.prepare('DELETE FROM advisory_review_records WHERE review_id=?1 AND reviewer_user_id=?2').bind(createdReviewId, auth.principalUserId).run();
        evidence.cleanup.emergencyReviewDelete = true;
      } catch (error) {
        failure ||= error;
        evidence.cleanup.emergencyReviewDeleteError = scrub(error?.message || String(error));
      }
    }
    try {
      const optimizationFinal = await safeCount(store01Db, 'optimization_actions');
      evidence.optimizationActionsFinal = optimizationFinal;
      if (evidence.optimizationActionsBefore !== null && optimizationFinal !== null) assert.equal(optimizationFinal, evidence.optimizationActionsBefore);
    } catch (error) {
      failure ||= error;
    }
  }

  if (failure) throw Object.assign(new Error(`${config.key}_rationale_semantics_failed:${scrub(failure.message)}`), { evidence });
  return evidence;
}

async function createAcceptanceIdentity(config, suffix) {
  const controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: config.controlDbId, apiToken: API_TOKEN });
  const host = new URL(config.baseUrl).hostname.toLowerCase();
  const apps = await cfJson('/access/apps');
  const app = (apps.result || []).find((candidate) => String(candidate?.domain || '').toLowerCase() === host);
  assert(app?.id, `${config.key}_access_app_not_found:${host}`);

  const serviceToken = (await cfJson('/access/service_tokens', {
    method: 'POST',
    body: { name: `issue-276-${suffix}-${RUN_ID}`, duration: '2h', enabled: true },
  })).result;
  assert(serviceToken?.id && serviceToken?.client_id && serviceToken?.client_secret, `${config.key}_service_token_create_incomplete`);

  const policy = (await cfJson(`/access/apps/${encodeURIComponent(app.id)}/policies`, {
    method: 'POST',
    body: {
      name: `Issue 276 ${suffix} rationale acceptance ${RUN_ID}`,
      decision: 'non_identity',
      include: [{ service_token: { token_id: serviceToken.id } }],
    },
  })).result;
  assert(policy?.id && policy?.decision === 'non_identity', `${config.key}_service_policy_invalid`);

  const principalUserId = `svc-276-${suffix}-${RUN_ID}`;
  const roleKey = `hr276_${suffix}_${RUN_ID}`;
  const email = `svc-276-${suffix}-${RUN_ID}@machine.invalid`;
  const store01 = await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(store01?.store_id, `${config.key}_store01_registry_missing`);

  await controlDb.prepare("INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)").bind(roleKey, `Issue 276 ${suffix} acceptance`).run();
  await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')").bind(roleKey).run();
  await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'ads.write')").bind(roleKey).run();
  await controlDb.prepare("INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at) VALUES(?1,?2,?3,lower(?3),'Issue 276 Acceptance Service','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(principalUserId, serviceToken.client_id, email).run();
  await controlDb.prepare('INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)').bind(store01.store_id, principalUserId, roleKey).run();

  const permissions = await controlDb.prepare('SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key').bind(roleKey).all();
  assert.deepEqual((permissions.results || []).map((row) => row.permission_key), ['ads.write', 'analytics.read']);
  const memberships = await controlDb.prepare('SELECT store_id FROM store_members WHERE user_id=?1 ORDER BY store_id').bind(principalUserId).all();
  assert.deepEqual((memberships.results || []).map((row) => row.store_id), [store01.store_id]);

  return {
    config,
    controlDb,
    app,
    serviceToken,
    policy,
    principalUserId,
    roleKey,
    headers: {
      'CF-Access-Client-Id': serviceToken.client_id,
      'CF-Access-Client-Secret': serviceToken.client_secret,
      accept: 'application/json',
    },
    public: {
      accessAppId: app.id,
      accessAppDomain: app.domain || null,
      policyId: policy.id,
      policyDecision: policy.decision,
      serviceTokenId: serviceToken.id,
      principalUserId,
      roleKey,
      storeId: store01.store_id,
      permissions: ['ads.write', 'analytics.read'],
    },
  };
}

async function cleanupAcceptanceIdentity(auth) {
  const out = {};
  const { controlDb, principalUserId, roleKey, app, policy, serviceToken } = auth;
  try { await controlDb.prepare('DELETE FROM store_members WHERE user_id=?1').bind(principalUserId).run(); out.storeMembershipRemoved = true; } catch (error) { out.storeMembershipError = scrub(error.message); }
  try { await controlDb.prepare('DELETE FROM role_permissions WHERE role_key=?1').bind(roleKey).run(); out.rolePermissionsRemoved = true; } catch (error) { out.rolePermissionsError = scrub(error.message); }
  try { await controlDb.prepare('DELETE FROM app_roles WHERE role_key=?1 AND is_system=0').bind(roleKey).run(); out.roleRemoved = true; } catch (error) { out.roleError = scrub(error.message); }
  try { await controlDb.prepare('DELETE FROM users WHERE user_id=?1').bind(principalUserId).run(); out.principalDeleted = true; } catch (error) {
    out.principalDeleteError = scrub(error.message);
    try { await controlDb.prepare("UPDATE users SET status='disabled',updated_at=CURRENT_TIMESTAMP WHERE user_id=?1").bind(principalUserId).run(); out.principalDisabledFallback = true; } catch (inner) { out.principalDisableError = scrub(inner.message); }
  }
  try { await cfJson(`/access/apps/${encodeURIComponent(app.id)}/policies/${encodeURIComponent(policy.id)}`, { method: 'DELETE' }); out.policyDeleted = true; } catch (error) { out.policyDeleteError = scrub(error.message); }
  try { await cfJson(`/access/service_tokens/${encodeURIComponent(serviceToken.id)}`, { method: 'DELETE' }); out.serviceTokenDeleted = true; } catch (error) { out.serviceTokenDeleteError = scrub(error.message); }

  const refs = {};
  refs.memberships = Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM store_members WHERE user_id=?1').bind(principalUserId).first())?.n || 0);
  refs.roles = Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM app_roles WHERE role_key=?1').bind(roleKey).first())?.n || 0);
  refs.permissions = Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM role_permissions WHERE role_key=?1').bind(roleKey).first())?.n || 0);
  refs.activePrincipals = Number((await controlDb.prepare("SELECT COUNT(*) AS n FROM users WHERE user_id=?1 AND status='active'").bind(principalUserId).first())?.n || 0);
  const policies = await cfJson(`/access/apps/${encodeURIComponent(app.id)}/policies`);
  refs.policies = (policies.result || []).filter((row) => row?.id === policy.id || String(row?.name || '').includes(`Issue 276`)).length;
  const tokens = await cfJson('/access/service_tokens');
  refs.serviceTokens = (tokens.result || []).filter((row) => row?.id === serviceToken.id || String(row?.name || '').startsWith('issue-276-')).length;
  out.refs = refs;
  out.refsZero = Object.values(refs).every((value) => value === 0);
  return out;
}

async function createTemporaryAccessModeVersion(worker, beforeVersions, bindings, value) {
  const access = bindings.find((binding) => binding?.name === 'ACCESS_MODE' && binding?.type === 'plain_text');
  assert(access, 'dev_access_mode_binding_missing');
  assert.equal(access.text, 'off', `dev_access_mode_before_not_off:${access.text}`);
  const patched = bindings.map((binding) => binding?.name === 'ACCESS_MODE' ? { ...binding, text: value } : binding);
  const form = new FormData();
  form.set('settings', JSON.stringify({
    bindings: patched,
    annotations: { 'workers/message': '#276 temporary Dev ACCESS_MODE=enforce rationale acceptance', 'workers/tag': `issue-276-${RUN_ID}` },
  }));
  await cfForm(`/workers/scripts/${encodeURIComponent(worker)}/settings`, { method: 'PATCH', form });
  const prior = new Set(beforeVersions.map((version) => version.id));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const after = await workerVersions(worker);
    const created = after.find((version) => version?.id && !prior.has(version.id));
    if (created) return { versionId: created.id, number: created.number ?? null, createdOn: created.metadata?.created_on || created.created_on || null };
    await sleep(1000);
  }
  throw new Error('temporary_dev_version_not_observed');
}

async function triggerAndWaitExactMainBuild() {
  const created = await cfJson(`/builds/triggers/${encodeURIComponent(PROD.buildTrigger)}/builds`, {
    method: 'POST',
    body: { branch: 'main', commit_hash: EXPECTED_MAIN_SHA },
  });
  const buildUuid = created.result?.build_uuid;
  assert(buildUuid, 'production_build_uuid_missing');
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const current = (await cfJson(`/builds/builds/${encodeURIComponent(buildUuid)}`)).result || {};
    if (current.status === 'stopped') {
      assert.equal(current.build_outcome, 'success', `production_build_outcome:${current.build_outcome}`);
      assert.equal(current.build_trigger_metadata?.branch, 'main');
      assert.equal(current.build_trigger_metadata?.commit_hash, EXPECTED_MAIN_SHA, 'production_build_sha_mismatch');
      return {
        buildUuid,
        status: current.status,
        outcome: current.build_outcome,
        branch: current.build_trigger_metadata?.branch || null,
        commitHash: current.build_trigger_metadata?.commit_hash || null,
      };
    }
    await sleep(5000);
  }
  throw new Error(`production_build_timeout:${buildUuid}`);
}

async function productionSyncSnapshot() {
  const deployment = await activeDeployment(PROD_SYNC.worker);
  const schedules = await workerSchedules(PROD_SYNC.worker);
  const settings = await workerSettings(PROD_SYNC.worker);
  const amazon = bindingValue(settings.bindings, 'AMAZON_ADS_ENABLED');
  assert.equal(amazon, 'false', `production_sync_amazon_ads_enabled:${amazon}`);
  assert.deepEqual(schedules, [], 'production_sync_schedules_not_empty');
  return { deploymentId: deployment.deploymentId, versionId: deployment.versionId, schedules, amazonAdsEnabled: amazon };
}

async function productionIsolationStore(controlDb) {
  const row = await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_02_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(row?.store_id, 'production_store02_registry_missing');
  return row.store_id;
}

async function workerSettings(worker) {
  return (await cfJson(`/workers/scripts/${encodeURIComponent(worker)}/settings`)).result || {};
}

async function workerVersions(worker) {
  const payload = await cfJson(`/workers/scripts/${encodeURIComponent(worker)}/versions?per_page=50`);
  return Array.isArray(payload.result) ? payload.result : [];
}

async function workerSchedules(worker) {
  const payload = await cfJson(`/workers/scripts/${encodeURIComponent(worker)}/schedules`);
  const result = payload.result?.schedules ?? payload.result ?? [];
  return Array.isArray(result) ? result : [];
}

async function activeDeployment(worker) {
  const payload = await cfJson(`/workers/scripts/${encodeURIComponent(worker)}/deployments`);
  const deployment = payload.result?.deployments?.[0] || payload.result?.[0] || null;
  assert(deployment?.id, `${worker}_active_deployment_missing`);
  const version = (deployment.versions || []).find((entry) => Number(entry?.percentage) === 100) || deployment.versions?.[0];
  assert(version?.version_id, `${worker}_active_version_missing`);
  return { deploymentId: deployment.id, versionId: version.version_id, percentage: Number(version.percentage), createdOn: deployment.created_on || null, source: deployment.source || null };
}

async function deployVersion(worker, versionId, message) {
  const payload = await cfJson(`/workers/scripts/${encodeURIComponent(worker)}/deployments`, {
    method: 'POST',
    body: {
      strategy: 'percentage',
      versions: [{ percentage: 100, version_id: versionId }],
      annotations: { 'workers/message': message },
    },
  });
  assert(payload.result?.id, `${worker}_deployment_create_failed`);
  return payload.result;
}

async function waitForActiveVersion(worker, versionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await activeDeployment(worker);
    if (current.versionId === versionId && current.percentage === 100) return current;
    await sleep(1500);
  }
  throw new Error(`${worker}_version_not_active:${versionId}`);
}

async function waitForNewActiveVersion(worker, previousVersionId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = await activeDeployment(worker);
    if (current.versionId && current.versionId !== previousVersionId && current.percentage === 100) return current;
    await sleep(3000);
  }
  throw new Error(`${worker}_new_active_version_not_observed`);
}

function assertHardOffBindings(bindings = [], { accessMode }) {
  assert.equal(bindingValue(bindings, 'ACCESS_MODE'), accessMode, `access_mode_mismatch:${bindingValue(bindings, 'ACCESS_MODE')}`);
  assert.equal(bindingValue(bindings, 'SYNC_TRIGGER_ENABLED'), 'false', 'sync_trigger_enabled');
  assert.equal(bindingValue(bindings, 'PHASE5_SINGLE_RUN_PERMIT_ID') ?? '', '', 'phase5_permit_not_empty');
  assert.equal(bindingValue(bindings, 'PHASE5_SINGLE_RUN_REPORT_DATE') ?? '', '', 'phase5_report_date_not_empty');
}

function summarizeSafetyBindings(bindings = []) {
  return {
    accessMode: bindingValue(bindings, 'ACCESS_MODE'),
    syncTriggerEnabled: bindingValue(bindings, 'SYNC_TRIGGER_ENABLED'),
    phase5SingleRunPermitId: bindingValue(bindings, 'PHASE5_SINGLE_RUN_PERMIT_ID') ?? '',
    phase5SingleRunReportDate: bindingValue(bindings, 'PHASE5_SINGLE_RUN_REPORT_DATE') ?? '',
  };
}

function bindingValue(bindings = [], name) {
  return bindings.find((binding) => binding?.name === name && binding?.type === 'plain_text')?.text ?? null;
}

function makeReviewUrl(baseUrl, storeId) {
  const params = new URLSearchParams({ reviewContract: REVIEW_CONTRACT, ...SCOPE });
  return `${baseUrl}/api/v1/stores/${encodeURIComponent(storeId)}/advisory-reviews?${params}`;
}

async function retryAppJson(url, options, attempts, delayMs) {
  let last = null;
  for (let index = 0; index < attempts; index += 1) {
    last = await appJson(url, options);
    if (last.status === 200) return last;
    if (![302, 401, 403].includes(last.status)) return last;
    await sleep(delayMs);
  }
  return last;
}

async function appJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  blockAmazonUrl(url, method);
  const response = await fetch(url, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    redirect: 'manual',
    cache: 'no-store',
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { nonJson: text.slice(0, 500) }; }
  return { status: response.status, body: parsed, location: response.headers.get('location') };
}

async function appText(url, { headers = {} } = {}) {
  blockAmazonUrl(url, 'GET');
  const response = await fetch(url, { headers, redirect: 'manual', cache: 'no-store' });
  return { status: response.status, body: await response.text() };
}

function blockAmazonUrl(url, method) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (/(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(hostname)) {
    receipt.amazonRequests.push({ method, url });
    throw new Error(`amazon_request_blocked:${url}`);
  }
}

async function cfJson(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      accept: 'application/json',
      ...(body !== null ? { 'content-type': 'application/json' } : {}),
    },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const code = payload?.errors?.[0]?.code || response.status;
    const message = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`cloudflare_api_failed:${path}:${code}:${scrub(message)}`);
  }
  return payload;
}

async function cfForm(path, { method = 'PATCH', form }) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`, {
    method,
    headers: { authorization: `Bearer ${API_TOKEN}`, accept: 'application/json' },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const code = payload?.errors?.[0]?.code || response.status;
    const message = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`cloudflare_form_api_failed:${path}:${code}:${scrub(message)}`);
  }
  return payload;
}

function findReview(body, inboxItemId) {
  return (body?.items || []).find((item) => item?.inboxItemId === inboxItemId) || null;
}

async function safeCount(db, table) {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
    return Number(row?.count ?? null);
  } catch {
    return null;
  }
}

function baseEnvironmentEvidence(config) {
  return { environment: config.key, target: config.baseUrl, checks: {}, result: 'FAIL' };
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function scrub(value) {
  return String(value || '').split(API_TOKEN).join('[REDACTED_API_TOKEN]').replace(/[\r\n\t]+/g, ' ').trim();
}

function redactReceipt(value) {
  return JSON.parse(JSON.stringify(value, (key, current) => /secret|apiToken|clientSecret/i.test(key) ? '[REDACTED]' : current));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
