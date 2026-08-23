import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA = required('EXPECTED_MAIN_SHA');
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const WORKER = 'ads-operations-web-dev';
const BASE_URL = 'https://ads-operations-web-dev.tanshiyuesir.workers.dev';
const CONTROL_DB_ID = '2093b94f-27d5-4a4c-ada1-ff14af5c8de2';
const STORE_DB_ID = '123b2a32-d78b-4de9-8318-08e35cefb008';
const BASELINE_VERSION = 'bd3fcb2d-f4a7-4f04-afb3-b6287c17d32a';
const TEMP_ENFORCE_VERSION = 'b14f180a-e782-47eb-a817-891a355a8921';
const REVIEW_CONTRACT = 'csv-recommendation-human-review-v1';
const SCOPE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01', limit: '50', sort: 'cost' });
const OUT = 'artifacts/issue-276-dev-rationale-acceptance-v3';

await mkdir(OUT, { recursive: true });
const controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: CONTROL_DB_ID, apiToken: API_TOKEN });
const storeDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: STORE_DB_ID, apiToken: API_TOKEN });
const receipt = {
  schemaVersion: 'issue-276-dev-rationale-acceptance-v3',
  issue: 276,
  parentIssue: 273,
  expectedCanonicalMain: EXPECTED_MAIN_SHA,
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  authorityBoundary: { executionAuthorized: false, amazonMutationAuthorized: false },
  amazonRequests: [],
  checks: {},
  cleanup: {},
  blockers: [],
  result: 'FAIL',
};

let auth = null;
let createdReviewId = null;
let candidate = null;
let storeId = null;
let optimizationBefore = null;
let fatal = null;

try {
  const activeBefore = await activeDeployment();
  receipt.activeBefore = activeBefore;
  assert.equal(activeBefore.versionId, BASELINE_VERSION, `dev_active_version_drift:${activeBefore.versionId}`);
  assert.equal(activeBefore.percentage, 100);

  const baseline = await versionDetail(BASELINE_VERSION);
  const temporary = await versionDetail(TEMP_ENFORCE_VERSION);
  receipt.baselineVersion = versionSafetySummary(baseline);
  receipt.temporaryVersion = versionSafetySummary(temporary);
  assertVersionSafety(baseline, 'off');
  assertVersionSafety(temporary, 'enforce');
  assert.equal(temporary?.annotations?.['workers/tag'], 'issue-276-32619364790', 'temporary_version_tag_mismatch');
  receipt.checks.baselineExactMainReadOnly = true;
  receipt.checks.temporaryVersionSafetyLocked = true;

  const webSchedules = await schedules(WORKER);
  assert.deepEqual(webSchedules, [], 'dev_web_schedules_not_empty');
  receipt.webSchedulesBefore = webSchedules;

  await deployVersion(TEMP_ENFORCE_VERSION, '#276 Dev authenticated rationale acceptance');
  const activeTemp = await waitForVersion(TEMP_ENFORCE_VERSION);
  receipt.activeTemporary = activeTemp;
  assert.equal(activeTemp.percentage, 100);
  receipt.checks.temporaryEnforceVersionActive = true;

  auth = await createIdentity();
  receipt.identity = auth.public;
  receipt.checks.leastPrivilegeIdentityCreated = true;

  const store = await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(store?.store_id, 'dev_store01_registry_missing');
  storeId = store.store_id;
  const reviewUrl = makeReviewUrl(storeId);

  const initial = await waitForAuthenticatedReview(reviewUrl, auth.headers);
  assert.equal(initial.status, 200, `dev_initial_review_status:${initial.status}:${JSON.stringify(initial.body).slice(0,300)}`);
  assert.equal(initial.body?.authority?.executionAuthorized, false);
  assert.equal(initial.body?.authority?.amazonMutationAuthorized, false);
  assert.equal(initial.body?.analysisScope?.candidateEmissionAuthorized, true);
  receipt.checks.authorityBoundaryFalse = true;

  const ui = await appText(`${BASE_URL}/assets/cloudflare-native-csv-recommendation-human-review-v1.js`, auth.headers);
  assert.equal(ui.status, 200, `dev_ui_status:${ui.status}`);
  assert(ui.body.includes("const VERSION = '1.7.0';"), 'dev_ui_1_7_0_missing');
  assert(ui.body.includes('Human Review rationale (optional)'), 'dev_rationale_editor_missing');
  receipt.checks.ui170RationaleAuthoringLive = true;

  candidate = (initial.body?.items || []).find((item) => item?.persistenceAuthorized === true && item?.review?.persisted !== true);
  assert(candidate?.inboxItemId, 'dev_current_unreviewed_candidate_missing');
  const preexisting = await storeDb.prepare('SELECT review_id FROM advisory_review_records WHERE recommendation_fingerprint=?1 LIMIT 1')
    .bind(candidate.recommendationFingerprint).first();
  assert.equal(preexisting, null, 'dev_unreviewed_candidate_has_storage_row');
  receipt.candidate = {
    inboxItemId: candidate.inboxItemId,
    recommendationFingerprint: candidate.recommendationFingerprint,
    sourceEvidenceSha256: candidate.sourceEvidenceSha256,
    originalState: 'unreviewed',
    originalNote: null,
  };
  receipt.checks.realGovernedUnreviewedCandidateResolved = true;

  optimizationBefore = await countTable('optimization_actions');
  receipt.optimizationActionsBefore = optimizationBefore;
  const rationale = `issue-276-dev-${RUN_ID}-rationale`;

  const explicit = await appJson(reviewUrl, {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: { inboxItemId: candidate.inboxItemId, state: 'needs_review', note: `  ${rationale}  ` },
  });
  assert.equal(explicit.status, 201, `dev_explicit_note_post:${explicit.status}:${JSON.stringify(explicit.body).slice(0,300)}`);
  assert.equal(explicit.body?.review?.state, 'needs_review');
  assert.equal(explicit.body?.review?.note, rationale);
  assert.equal(explicit.body?.authority?.executionAuthorized, false);
  assert.equal(explicit.body?.authority?.amazonMutationAuthorized, false);
  createdReviewId = explicit.body?.review?.reviewId || null;
  assert(createdReviewId, 'dev_created_review_id_missing');
  receipt.createdReviewId = createdReviewId;
  receipt.checks.explicitRationaleTrimmedAndPersisted = true;

  const freshExplicit = await appJson(reviewUrl, { headers: auth.headers });
  const storedExplicit = findReview(freshExplicit.body, candidate.inboxItemId);
  assert.equal(freshExplicit.status, 200);
  assert.equal(storedExplicit?.review?.persisted, true);
  assert.equal(storedExplicit?.review?.state, 'needs_review');
  assert.equal(storedExplicit?.review?.note, rationale);
  receipt.checks.freshGetVerifiedStateAndNote = true;

  const stateOnly = await appJson(reviewUrl, {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: { inboxItemId: candidate.inboxItemId, state: 'acknowledged' },
  });
  assert.equal(stateOnly.status, 200, `dev_state_only_post:${stateOnly.status}:${JSON.stringify(stateOnly.body).slice(0,250)}`);
  assert.equal(stateOnly.body?.review?.state, 'acknowledged');
  assert.equal(stateOnly.body?.review?.note, rationale);
  const freshOmitted = await appJson(reviewUrl, { headers: auth.headers });
  const storedOmitted = findReview(freshOmitted.body, candidate.inboxItemId);
  assert.equal(storedOmitted?.review?.state, 'acknowledged');
  assert.equal(storedOmitted?.review?.note, rationale);
  receipt.checks.omittedNotePreservedAcrossStateChange = true;

  const explicitClear = await appJson(reviewUrl, {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: { inboxItemId: candidate.inboxItemId, state: 'needs_review', note: '   ' },
  });
  assert.equal(explicitClear.status, 200, `dev_explicit_clear_post:${explicitClear.status}`);
  assert.equal(explicitClear.body?.review?.state, 'needs_review');
  assert.equal(explicitClear.body?.review?.note, null);
  const freshClear = await appJson(reviewUrl, { headers: auth.headers });
  const storedClear = findReview(freshClear.body, candidate.inboxItemId);
  assert.equal(storedClear?.review?.state, 'needs_review');
  assert.equal(storedClear?.review?.note, null);
  receipt.checks.explicitBlankCleared = true;
  receipt.checks.readAfterWriteNoOptimisticDurableTruth = true;

  const isolation = await appJson(makeReviewUrl('store-dev-02'), { headers: auth.headers });
  assert.equal(isolation.status, 403, `dev_store02_isolation_status:${isolation.status}`);
  assert.equal(isolation.body?.error, 'forbidden');
  receipt.checks.storeIsolationFailClosed = true;

  const optimizationAfter = await countTable('optimization_actions');
  receipt.optimizationActionsAfter = optimizationAfter;
  assert.equal(optimizationAfter, optimizationBefore, 'dev_optimization_actions_changed');
  receipt.checks.optimizationActionsUnchanged = true;
  assert.equal(receipt.amazonRequests.length, 0);
  receipt.checks.amazonClientRequestsZero = true;

  // Cleanup only. This D1 delete is not acceptance evidence; all persistence semantics above were proven through the Human Review API.
  await storeDb.prepare('DELETE FROM advisory_review_records WHERE review_id=?1 AND reviewer_user_id=?2')
    .bind(createdReviewId, auth.principalUserId).run();
  receipt.cleanup.acceptanceReviewDeleted = true;
  createdReviewId = null;
  const restoredReview = await appJson(reviewUrl, { headers: auth.headers });
  const restoredItem = findReview(restoredReview.body, candidate.inboxItemId);
  assert.equal(restoredItem?.review?.persisted, false);
  assert.equal(restoredItem?.review?.state, 'unreviewed');
  assert.equal(restoredItem?.review?.note ?? null, null);
  receipt.cleanup.originalReviewStateAndNoteRestored = true;

  receipt.result = 'PASS';
} catch (error) {
  fatal = error;
  receipt.blockers.push(scrub(error?.message || String(error)));
} finally {
  if (createdReviewId && auth) {
    try {
      await storeDb.prepare('DELETE FROM advisory_review_records WHERE review_id=?1 AND reviewer_user_id=?2')
        .bind(createdReviewId, auth.principalUserId).run();
      receipt.cleanup.emergencyAcceptanceReviewDelete = true;
      createdReviewId = null;
    } catch (error) {
      fatal ||= error;
      receipt.cleanup.emergencyReviewDeleteError = scrub(error?.message || String(error));
    }
  }

  if (auth) {
    const identityCleanup = await cleanupIdentity(auth).catch((error) => ({ refsZero: false, error: scrub(error?.message || String(error)) }));
    receipt.cleanup.identity = identityCleanup;
    if (!identityCleanup.refsZero) fatal ||= new Error('dev_temporary_identity_cleanup_incomplete');
  }

  try {
    await deployVersion(BASELINE_VERSION, '#276 restore Dev exact-main read-only baseline');
    const activeFinal = await waitForVersion(BASELINE_VERSION);
    receipt.activeFinal = activeFinal;
    const finalBaseline = await versionDetail(BASELINE_VERSION);
    assertVersionSafety(finalBaseline, 'off');
    receipt.cleanup.baselineVersionRestored100 = true;
    receipt.cleanup.baselineBindingsVerified = versionSafetySummary(finalBaseline);
  } catch (error) {
    fatal ||= error;
    receipt.cleanup.baselineRestoreError = scrub(error?.message || String(error));
  }

  try {
    const schedulesFinal = await schedules(WORKER);
    assert.deepEqual(schedulesFinal, [], 'dev_web_schedules_changed');
    receipt.cleanup.webSchedulesFinal = schedulesFinal;
  } catch (error) {
    fatal ||= error;
    receipt.cleanup.scheduleVerificationError = scrub(error?.message || String(error));
  }

  try {
    const optimizationFinal = await countTable('optimization_actions');
    receipt.optimizationActionsFinal = optimizationFinal;
    if (optimizationBefore !== null) assert.equal(optimizationFinal, optimizationBefore, 'dev_optimization_actions_final_changed');
  } catch (error) {
    fatal ||= error;
    receipt.cleanup.optimizationFinalError = scrub(error?.message || String(error));
  }

  assert.equal(receipt.amazonRequests.length, 0);
  if (fatal) receipt.result = 'FAIL';
  receipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(redact(receipt), null, 2));
}

if (fatal) throw fatal;

async function createIdentity() {
  const host = new URL(BASE_URL).hostname.toLowerCase();
  const apps = await cf('/access/apps');
  const app = (apps.result || []).find((row) => String(row?.domain || '').toLowerCase() === host);
  assert(app?.id, 'dev_access_app_not_found');

  const token = (await cf('/access/service_tokens', {
    method: 'POST',
    body: { name: `issue-276-dev-v3-${RUN_ID}`, duration: '2h', enabled: true },
  })).result;
  assert(token?.id && token?.client_id && token?.client_secret, 'dev_service_token_create_incomplete');

  const policy = (await cf(`/access/apps/${encodeURIComponent(app.id)}/policies`, {
    method: 'POST',
    body: {
      name: `Issue 276 Dev v3 ${RUN_ID}`,
      decision: 'non_identity',
      include: [{ service_token: { token_id: token.id } }],
    },
  })).result;
  assert(policy?.id && policy?.decision === 'non_identity', 'dev_non_identity_policy_invalid');

  const principalUserId = `svc-276-dev-v3-${RUN_ID}`;
  const roleKey = `hr276_dev_v3_${RUN_ID}`;
  const email = `svc-276-dev-v3-${RUN_ID}@machine.invalid`;
  const store = await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(store?.store_id, 'dev_store01_registry_missing_for_identity');

  await controlDb.prepare("INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)")
    .bind(roleKey, `Issue 276 Dev v3 ${RUN_ID}`).run();
  await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')").bind(roleKey).run();
  await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'ads.write')").bind(roleKey).run();
  await controlDb.prepare("INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at) VALUES(?1,?2,?3,lower(?3),'Issue 276 Dev Acceptance','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
    .bind(principalUserId, token.client_id, email).run();
  await controlDb.prepare('INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)')
    .bind(store.store_id, principalUserId, roleKey).run();

  const permissions = await controlDb.prepare('SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key').bind(roleKey).all();
  assert.deepEqual((permissions.results || []).map((row) => row.permission_key), ['ads.write', 'analytics.read']);
  const memberships = await controlDb.prepare('SELECT store_id FROM store_members WHERE user_id=?1 ORDER BY store_id').bind(principalUserId).all();
  assert.deepEqual((memberships.results || []).map((row) => row.store_id), [store.store_id]);

  return {
    app, token, policy, principalUserId, roleKey,
    headers: {
      'CF-Access-Client-Id': token.client_id,
      'CF-Access-Client-Secret': token.client_secret,
      accept: 'application/json',
    },
    public: {
      accessAppId: app.id,
      accessAppDomain: app.domain || null,
      serviceTokenId: token.id,
      policyId: policy.id,
      policyDecision: policy.decision,
      principalUserId,
      roleKey,
      storeId: store.store_id,
      permissions: ['ads.write', 'analytics.read'],
    },
  };
}

async function cleanupIdentity(auth) {
  const out = {};
  try { await controlDb.prepare('DELETE FROM store_members WHERE user_id=?1').bind(auth.principalUserId).run(); out.membershipDeleted = true; } catch (error) { out.membershipDeleteError = scrub(error.message); }
  try { await controlDb.prepare('DELETE FROM role_permissions WHERE role_key=?1').bind(auth.roleKey).run(); out.permissionsDeleted = true; } catch (error) { out.permissionsDeleteError = scrub(error.message); }
  try { await controlDb.prepare('DELETE FROM app_roles WHERE role_key=?1 AND is_system=0').bind(auth.roleKey).run(); out.roleDeleted = true; } catch (error) { out.roleDeleteError = scrub(error.message); }
  try {
    await controlDb.prepare('DELETE FROM users WHERE user_id=?1').bind(auth.principalUserId).run();
    out.principalDeleted = true;
  } catch (error) {
    out.principalDeleteError = scrub(error.message);
    try {
      await controlDb.prepare("UPDATE users SET status='disabled',updated_at=CURRENT_TIMESTAMP WHERE user_id=?1").bind(auth.principalUserId).run();
      out.principalDisabledFallback = true;
    } catch (inner) { out.principalDisableError = scrub(inner.message); }
  }
  try { await cf(`/access/apps/${encodeURIComponent(auth.app.id)}/policies/${encodeURIComponent(auth.policy.id)}`, { method: 'DELETE' }); out.policyDeleted = true; } catch (error) { out.policyDeleteError = scrub(error.message); }
  try { await cf(`/access/service_tokens/${encodeURIComponent(auth.token.id)}`, { method: 'DELETE' }); out.serviceTokenDeleted = true; } catch (error) { out.serviceTokenDeleteError = scrub(error.message); }

  const refs = {
    memberships: Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM store_members WHERE user_id=?1').bind(auth.principalUserId).first())?.n || 0),
    roles: Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM app_roles WHERE role_key=?1').bind(auth.roleKey).first())?.n || 0),
    permissions: Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM role_permissions WHERE role_key=?1').bind(auth.roleKey).first())?.n || 0),
    activePrincipals: Number((await controlDb.prepare("SELECT COUNT(*) AS n FROM users WHERE user_id=?1 AND status='active'").bind(auth.principalUserId).first())?.n || 0),
  };
  const policies = await cf(`/access/apps/${encodeURIComponent(auth.app.id)}/policies`);
  refs.policies = (policies.result || []).filter((row) => row?.id === auth.policy.id).length;
  const tokens = await cf('/access/service_tokens');
  refs.serviceTokens = (tokens.result || []).filter((row) => row?.id === auth.token.id).length;
  out.refs = refs;
  out.refsZero = Object.values(refs).every((value) => value === 0);
  return out;
}

async function waitForAuthenticatedReview(url, headers) {
  let last = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    last = await appJson(url, { headers });
    if (last.status === 200) return last;
    if (![302, 401, 403].includes(last.status)) return last;
    await sleep(2000);
  }
  return last;
}

async function versionDetail(versionId) {
  return (await cf(`/workers/scripts/${encodeURIComponent(WORKER)}/versions/${encodeURIComponent(versionId)}`)).result || {};
}

function versionSafetySummary(detail) {
  return {
    id: detail?.id || null,
    number: detail?.number ?? null,
    createdOn: detail?.metadata?.created_on || detail?.created_on || null,
    annotations: detail?.annotations || null,
    accessMode: bindingValue(detail, 'ACCESS_MODE'),
    syncTriggerEnabled: bindingValue(detail, 'SYNC_TRIGGER_ENABLED'),
    phase5SingleRunPermitId: bindingValue(detail, 'PHASE5_SINGLE_RUN_PERMIT_ID') ?? '',
    phase5SingleRunReportDate: bindingValue(detail, 'PHASE5_SINGLE_RUN_REPORT_DATE') ?? '',
  };
}

function assertVersionSafety(detail, accessMode) {
  assert.equal(bindingValue(detail, 'ACCESS_MODE'), accessMode, `version_access_mode_mismatch:${detail?.id}`);
  assert.equal(bindingValue(detail, 'SYNC_TRIGGER_ENABLED'), 'false', `version_sync_trigger_enabled:${detail?.id}`);
  assert.equal(bindingValue(detail, 'PHASE5_SINGLE_RUN_PERMIT_ID') ?? '', '', `version_phase5_permit_not_empty:${detail?.id}`);
  assert.equal(bindingValue(detail, 'PHASE5_SINGLE_RUN_REPORT_DATE') ?? '', '', `version_phase5_report_date_not_empty:${detail?.id}`);
}

function bindingValue(value, name) {
  const found = findBinding(value, name);
  return found ? (found.text ?? found.value ?? null) : null;
}

function findBinding(value, name) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && item.name === name) return item;
      const nested = findBinding(item, name);
      if (nested) return nested;
    }
    return null;
  }
  for (const child of Object.values(value)) {
    const nested = findBinding(child, name);
    if (nested) return nested;
  }
  return null;
}

async function activeDeployment() {
  const result = (await cf(`/workers/scripts/${encodeURIComponent(WORKER)}/deployments`)).result || {};
  const deployment = result?.deployments?.[0] || (Array.isArray(result) ? result[0] : null);
  assert(deployment?.id, 'dev_active_deployment_missing');
  const version = (deployment.versions || []).find((row) => Number(row?.percentage) === 100) || deployment.versions?.[0];
  assert(version?.version_id, 'dev_active_version_missing');
  return {
    deploymentId: deployment.id,
    versionId: version.version_id,
    percentage: Number(version.percentage),
    createdOn: deployment.created_on || null,
    source: deployment.source || null,
  };
}

async function deployVersion(versionId, message) {
  const payload = await cf(`/workers/scripts/${encodeURIComponent(WORKER)}/deployments`, {
    method: 'POST',
    body: {
      strategy: 'percentage',
      versions: [{ percentage: 100, version_id: versionId }],
      annotations: { 'workers/message': message, 'workers/tag': `issue-276-dev-v3-${RUN_ID}` },
    },
  });
  assert(payload.result?.id, `dev_deployment_create_failed:${versionId}`);
  return payload.result;
}

async function waitForVersion(versionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const active = await activeDeployment();
    if (active.versionId === versionId && active.percentage === 100) return active;
    await sleep(1500);
  }
  throw new Error(`dev_version_not_active:${versionId}`);
}

async function schedules(worker) {
  const payload = await cf(`/workers/scripts/${encodeURIComponent(worker)}/schedules`);
  const result = payload.result?.schedules ?? payload.result ?? [];
  return Array.isArray(result) ? result : [];
}

function makeReviewUrl(id) {
  const params = new URLSearchParams({ reviewContract: REVIEW_CONTRACT, ...SCOPE });
  return `${BASE_URL}/api/v1/stores/${encodeURIComponent(id)}/advisory-reviews?${params}`;
}

async function appJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  blockAmazon(url, method);
  const response = await fetch(url, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    redirect: 'manual',
    cache: 'no-store',
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { nonJson: text.slice(0, 500) }; }
  return { status: response.status, body: parsed, location: response.headers.get('location') };
}

async function appText(url, headers = {}) {
  blockAmazon(url, 'GET');
  const response = await fetch(url, { headers, redirect: 'manual', cache: 'no-store' });
  return { status: response.status, body: await response.text() };
}

function blockAmazon(url, method) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (/(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(hostname)) {
    receipt.amazonRequests.push({ method, url });
    throw new Error(`amazon_request_blocked:${url}`);
  }
}

async function countTable(table) {
  const row = await storeDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
  return Number(row?.count ?? 0);
}

function findReview(body, inboxItemId) {
  return (body?.items || []).find((item) => item?.inboxItemId === inboxItemId) || null;
}

async function cf(path, { method = 'GET', body = null } = {}) {
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

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function scrub(value) {
  return String(value || '').split(API_TOKEN).join('[REDACTED_API_TOKEN]').replace(/[\r\n\t]+/g, ' ').trim();
}

function redact(value) {
  return JSON.parse(JSON.stringify(value, (key, current) => /secret|apiToken|clientSecret/i.test(key) ? '[REDACTED]' : current));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
