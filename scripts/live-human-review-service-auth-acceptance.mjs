import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA = required('EXPECTED_MAIN_SHA');
const PROD_TRIGGER_UUID = required('PROD_TRIGGER_UUID');
const PROD_BASE_URL = (process.env.PROD_BASE_URL || 'https://ads-operations-web-prod.tanshiyuesir.workers.dev').replace(/\/$/, '');
const PROD_ACCESS_DOMAIN = new URL(PROD_BASE_URL).hostname;
const CONTROL_DB_ID = process.env.PROD_CONTROL_DB_ID || '2122248c-1fd4-4ccd-b611-9f9d2f3decbf';
const STORE01_DB_ID = process.env.PROD_STORE01_DB_ID || '2e53bbad-5680-431c-bcf7-68e89b231ea1';
const OLD_PROD_VERSION = process.env.OLD_PROD_VERSION || '7fd1413e-ff8d-4870-a5af-de44f6940210';
const REVIEW_CONTRACT = 'csv-recommendation-human-review-v1';
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/live-human-review-service-auth-acceptance';
const PRINCIPAL_USER_ID = `svc-hr-acceptance-${RUN_ID}`;
const ROLE_KEY = `hr_acceptance_${RUN_ID}`;
const PRINCIPAL_EMAIL = `svc-hr-acceptance-${RUN_ID}@machine.invalid`;
const SCOPE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01', limit: '50', sort: 'cost' });

await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'live-human-review-service-auth-acceptance-v1',
  runId: RUN_ID,
  target: PROD_BASE_URL,
  expectedCanonicalMain: EXPECTED_MAIN_SHA,
  productionTriggerUuid: PROD_TRIGGER_UUID,
  principalUserId: PRINCIPAL_USER_ID,
  scope: SCOPE,
  startedAt: new Date().toISOString(),
  checks: {},
  cleanup: {},
  amazonRequests: [],
  result: 'FAIL',
};

let serviceToken = null;
let accessPolicy = null;
let targetApp = null;
let store01 = null;
let store02 = null;
let createdReviewId = null;
let createdReviewWasNew = false;
const controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: CONTROL_DB_ID, apiToken: API_TOKEN });
const store01Db = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: STORE01_DB_ID, apiToken: API_TOKEN });

try {
  const apps = await cf('/access/apps');
  targetApp = (apps.result || []).find((app) => String(app?.domain || '').toLowerCase() === PROD_ACCESS_DOMAIN.toLowerCase());
  assert(targetApp?.id, `Production Access app not found for ${PROD_ACCESS_DOMAIN}`);
  receipt.accessApp = { id: targetApp.id, name: targetApp.name || null, domain: targetApp.domain || null, aud: targetApp.aud || null };
  receipt.checks.productionAccessAppResolved = true;

  serviceToken = (await cf('/access/service_tokens', {
    method: 'POST',
    body: {
      name: `ads-ops-human-review-acceptance-${RUN_ID}`,
      duration: '2h',
      enabled: true,
    },
  })).result;
  assert(serviceToken?.id && serviceToken?.client_id && serviceToken?.client_secret, 'Cloudflare service token create response incomplete');
  receipt.serviceToken = { id: serviceToken.id, clientId: serviceToken.client_id, expiresAt: serviceToken.expires_at || null, duration: serviceToken.duration || null };
  receipt.checks.ephemeralServiceTokenCreated = true;

  accessPolicy = (await cf(`/access/apps/${encodeURIComponent(targetApp.id)}/policies`, {
    method: 'POST',
    body: {
      name: `Human Review acceptance ${RUN_ID}`,
      decision: 'non_identity',
      include: [{ service_token: { token_id: serviceToken.id } }],
    },
  })).result;
  assert(accessPolicy?.id, 'Cloudflare Access service-auth policy create response incomplete');
  receipt.accessPolicy = { id: accessPolicy.id, name: accessPolicy.name || null, decision: accessPolicy.decision || null };
  receipt.checks.serviceAuthPolicyCreated = accessPolicy.decision === 'non_identity';
  assert.equal(receipt.checks.serviceAuthPolicyCreated, true, 'Service-auth policy is not non_identity');

  store01 = await controlDb.prepare(`SELECT store_id, store_code, d1_binding_key, status FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1`).first();
  store02 = await controlDb.prepare(`SELECT store_id, store_code, d1_binding_key, status FROM stores WHERE d1_binding_key='STORE_02_DB' AND status <> 'disabled' LIMIT 1`).first();
  assert(store01?.store_id, 'Production Store01 registry row not found');
  assert(store02?.store_id, 'Production Store02 registry row not found');
  receipt.stores = { store01: store01.store_id, store02: store02.store_id };

  await controlDb.prepare(`INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)`).bind(ROLE_KEY, `Human Review Acceptance ${RUN_ID}`).run();
  await controlDb.prepare(`INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')`).bind(ROLE_KEY).run();
  await controlDb.prepare(`INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'ads.write')`).bind(ROLE_KEY).run();
  await controlDb.prepare(`INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at) VALUES(?1,?2,?3,lower(?3),'Human Review Acceptance Service','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(PRINCIPAL_USER_ID, serviceToken.client_id, PRINCIPAL_EMAIL).run();
  await controlDb.prepare(`INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)`).bind(store01.store_id, PRINCIPAL_USER_ID, ROLE_KEY).run();
  receipt.checks.minimalServicePrincipalProvisioned = true;

  const permissions = await controlDb.prepare(`SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key`).bind(ROLE_KEY).all();
  assert.deepEqual(permissions.results.map((row) => row.permission_key), ['ads.write', 'analytics.read']);
  const memberships = await controlDb.prepare(`SELECT store_id FROM store_members WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).all();
  assert.deepEqual(memberships.results.map((row) => row.store_id), [store01.store_id]);
  receipt.checks.principalLeastPrivilegeVerified = true;

  const buildCreate = await cf(`/builds/triggers/${encodeURIComponent(PROD_TRIGGER_UUID)}/builds`, {
    method: 'POST',
    body: { branch: 'main', commit_hash: EXPECTED_MAIN_SHA },
  });
  const buildUuid = buildCreate?.result?.build_uuid;
  assert(buildUuid, 'Production exact-main build trigger returned no build_uuid');
  receipt.productionBuild = { buildUuid };
  receipt.checks.productionExactMainBuildTriggered = true;

  const build = await waitForBuild(buildUuid);
  receipt.productionBuild = {
    ...receipt.productionBuild,
    outcome: build.build_outcome || null,
    status: build.status || null,
    branch: build.build_trigger_metadata?.branch || null,
    commitHash: build.build_trigger_metadata?.commit_hash || null,
    triggerSource: build.build_trigger_metadata?.build_trigger_source || null,
    versionId: build.version_id || build.versionId || null,
  };
  assert.equal(build.build_outcome, 'success', `Production build outcome ${build.build_outcome}`);
  assert.equal(build.build_trigger_metadata?.branch, 'main', 'Production build did not use main');
  assert.equal(build.build_trigger_metadata?.commit_hash, EXPECTED_MAIN_SHA, 'Production build commit drifted');
  receipt.checks.productionExactMainBuildSuccess = true;

  const health = await waitForNewProductionVersion();
  receipt.productionHealth = health;
  assert.equal(health.ok, true);
  assert.equal(health.environment, 'production');
  assert.equal(health.syncTriggerEnabled, false, 'Production SYNC_TRIGGER_ENABLED must remain false');
  assert(health.deployment?.versionId, 'Production health did not expose version id');
  assert.notEqual(health.deployment.versionId, OLD_PROD_VERSION, 'Production remained on #229 version after exact-main build');
  receipt.checks.productionRuntimeAdvanced = true;
  receipt.checks.webAmazonSyncTriggerHardOff = true;

  const authHeaders = {
    'CF-Access-Client-Id': serviceToken.client_id,
    'CF-Access-Client-Secret': serviceToken.client_secret,
    accept: 'application/json',
  };

  const reviewUrl01 = reviewUrl(store01.store_id);
  const initial = await appJson(reviewUrl01, { headers: authHeaders });
  assert.equal(initial.status, 200, `Initial Human Review GET expected 200, got ${initial.status}`);
  assert.equal(initial.body?.authority?.executionAuthorized, false);
  assert.equal(initial.body?.authority?.amazonMutationAuthorized, false);
  assert.equal(initial.body?.analysisScope?.candidateEmissionAuthorized, true, 'Candidate emission is not authorized in live scope');
  const candidate = (initial.body?.items || []).find((item) => item?.persistenceAuthorized === true && item?.review?.persisted !== true);
  assert(candidate?.inboxItemId, 'No unreviewed persistence-authorized candidate available in live scope');
  receipt.candidate = {
    inboxItemId: candidate.inboxItemId,
    fingerprint: candidate.recommendationFingerprint,
    sourceEvidenceSha256: candidate.sourceEvidenceSha256,
  };
  receipt.checks.realGovernedCandidateResolved = true;
  receipt.checks.executionAuthorityFalse = true;
  receipt.checks.amazonMutationAuthorityFalse = true;

  const optimizationBefore = await safeCount(store01Db, 'optimization_actions');
  receipt.optimizationActionsBefore = optimizationBefore;

  const needsReview = await appJson(reviewUrl01, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: { inboxItemId: candidate.inboxItemId, state: 'needs_review', note: `live-acceptance:${RUN_ID}:needs_review` },
  });
  assert([200, 201].includes(needsReview.status), `needs_review POST expected 200/201, got ${needsReview.status}`);
  assert.equal(needsReview.body?.review?.state, 'needs_review');
  assert.equal(needsReview.body?.review?.reviewerUserId, PRINCIPAL_USER_ID);
  assert.equal(needsReview.body?.authority?.executionAuthorized, false);
  assert.equal(needsReview.body?.authority?.amazonMutationAuthorized, false);
  createdReviewId = needsReview.body?.review?.reviewId || null;
  createdReviewWasNew = needsReview.status === 201;
  receipt.createdReview = { reviewId: createdReviewId, createdNew: createdReviewWasNew };
  receipt.checks.needsReviewPersisted = true;

  const afterNeedsReview = await appJson(reviewUrl01, { headers: authHeaders });
  assert.equal(afterNeedsReview.status, 200);
  const storedNeedsReview = findReview(afterNeedsReview.body, candidate.inboxItemId);
  assert.equal(storedNeedsReview?.review?.persisted, true);
  assert.equal(storedNeedsReview?.review?.state, 'needs_review');
  assert.equal(storedNeedsReview?.review?.recommendationFingerprint, candidate.recommendationFingerprint);
  receipt.checks.readAfterWriteNeedsReview = true;

  const acknowledged = await appJson(reviewUrl01, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: { inboxItemId: candidate.inboxItemId, state: 'acknowledged', note: `live-acceptance:${RUN_ID}:acknowledged` },
  });
  assert.equal(acknowledged.status, 200, `acknowledged POST expected 200, got ${acknowledged.status}`);
  assert.equal(acknowledged.body?.review?.state, 'acknowledged');
  assert.equal(acknowledged.body?.review?.reviewerUserId, PRINCIPAL_USER_ID);
  receipt.checks.acknowledgedPersisted = true;

  await sleep(750);
  const reloadRead = await appJson(reviewUrl01, { headers: authHeaders, cache: 'no-store' });
  assert.equal(reloadRead.status, 200);
  const storedAcknowledged = findReview(reloadRead.body, candidate.inboxItemId);
  assert.equal(storedAcknowledged?.review?.persisted, true);
  assert.equal(storedAcknowledged?.review?.state, 'acknowledged');
  assert.equal(storedAcknowledged?.review?.reviewerUserId, PRINCIPAL_USER_ID);
  receipt.checks.freshRequestPersistence = true;

  const isolation = await appJson(reviewUrl(store02.store_id), { headers: authHeaders });
  assert.equal(isolation.status, 403, `Store02 isolation expected 403, got ${isolation.status}`);
  assert.equal(isolation.body?.error, 'forbidden');
  receipt.checks.storeIsolation = true;

  const unsupported = await appJson(reviewUrl01, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: { inboxItemId: candidate.inboxItemId, state: 'approved' },
  });
  assert.equal(unsupported.status, 400, `approved fail-close expected 400, got ${unsupported.status}`);
  assert.equal(unsupported.body?.error, 'recommendation_review_state_not_supported');
  receipt.checks.approvedRejectedFailClosed = true;

  const optimizationAfter = await safeCount(store01Db, 'optimization_actions');
  receipt.optimizationActionsAfter = optimizationAfter;
  if (optimizationBefore !== null && optimizationAfter !== null) {
    assert.equal(optimizationAfter, optimizationBefore, 'Optimization Action count changed during Human Review acceptance');
    receipt.checks.optimizationActionsUnchanged = true;
  } else {
    receipt.checks.optimizationActionsUnchanged = 'count_unavailable_authority_asserted_false';
  }

  assert.equal(receipt.amazonRequests.length, 0);
  receipt.checks.amazonClientRequestsZero = true;
  receipt.result = 'PASS';
} catch (error) {
  receipt.error = {
    message: scrub(error?.message || String(error)),
    stack: scrub(String(error?.stack || '')).slice(0, 8000),
  };
  throw error;
} finally {
  try {
    if (createdReviewId && createdReviewWasNew) {
      await store01Db.prepare(`DELETE FROM advisory_review_records WHERE review_id=?1 AND reviewer_user_id=?2`).bind(createdReviewId, PRINCIPAL_USER_ID).run();
      receipt.cleanup.testReviewDeleted = true;
    } else if (createdReviewId) {
      receipt.cleanup.testReviewDeleted = false;
      receipt.cleanup.testReviewReason = 'preexisting_review_not_deleted';
    }
  } catch (error) {
    receipt.cleanup.testReviewDeleteError = scrub(error?.message || String(error));
  }
  try {
    if (store01?.store_id) await controlDb.prepare(`DELETE FROM store_members WHERE store_id=?1 AND user_id=?2`).bind(store01.store_id, PRINCIPAL_USER_ID).run();
    receipt.cleanup.storeMembershipRemoved = true;
  } catch (error) { receipt.cleanup.storeMembershipRemoveError = scrub(error?.message || String(error)); }
  try {
    await controlDb.prepare(`DELETE FROM role_permissions WHERE role_key=?1`).bind(ROLE_KEY).run();
    await controlDb.prepare(`DELETE FROM app_roles WHERE role_key=?1 AND is_system=0`).bind(ROLE_KEY).run();
    receipt.cleanup.temporaryRoleRemoved = true;
  } catch (error) { receipt.cleanup.temporaryRoleRemoveError = scrub(error?.message || String(error)); }
  try {
    await controlDb.prepare(`UPDATE users SET status='disabled', updated_at=CURRENT_TIMESTAMP WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
    receipt.cleanup.servicePrincipalDisabled = true;
  } catch (error) { receipt.cleanup.servicePrincipalDisableError = scrub(error?.message || String(error)); }
  try {
    if (accessPolicy?.id && targetApp?.id) {
      await cf(`/access/apps/${encodeURIComponent(targetApp.id)}/policies/${encodeURIComponent(accessPolicy.id)}`, { method: 'DELETE' });
      receipt.cleanup.accessPolicyDeleted = true;
    }
  } catch (error) { receipt.cleanup.accessPolicyDeleteError = scrub(error?.message || String(error)); }
  try {
    if (serviceToken?.id) {
      await cf(`/access/service_tokens/${encodeURIComponent(serviceToken.id)}`, { method: 'DELETE' });
      receipt.cleanup.serviceTokenDeleted = true;
    }
  } catch (error) { receipt.cleanup.serviceTokenDeleteError = scrub(error?.message || String(error)); }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(redactReceipt(receipt), null, 2));
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

async function waitForBuild(buildUuid) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const payload = await cf(`/builds/builds/${encodeURIComponent(buildUuid)}`);
    const build = payload.result || {};
    if (build.status === 'stopped') return build;
    await sleep(10_000);
  }
  throw new Error(`production_build_timeout:${buildUuid}`);
}

async function waitForNewProductionVersion() {
  let last = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${PROD_BASE_URL}/api/health`, { headers: { accept: 'application/json' }, cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    last = body;
    if (response.ok && body?.environment === 'production' && body?.deployment?.versionId && body.deployment.versionId !== OLD_PROD_VERSION) return body;
    await sleep(5_000);
  }
  throw new Error(`production_runtime_not_advanced:${last?.deployment?.versionId || 'unknown'}`);
}

function reviewUrl(storeId) {
  const params = new URLSearchParams({ reviewContract: REVIEW_CONTRACT, ...SCOPE });
  return `${PROD_BASE_URL}/api/v1/stores/${encodeURIComponent(storeId)}/advisory-reviews?${params}`;
}

async function appJson(url, { method = 'GET', headers = {}, body = null, cache = 'no-store' } = {}) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (/(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(hostname)) {
    receipt.amazonRequests.push({ method, url });
    throw new Error(`amazon_request_blocked:${url}`);
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    cache,
  });
  const responseBody = await response.json().catch(async () => ({ nonJson: (await response.text().catch(() => '')).slice(0, 500) }));
  return { status: response.status, headers: Object.fromEntries(response.headers), body: responseBody };
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

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
