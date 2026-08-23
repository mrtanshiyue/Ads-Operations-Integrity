import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA = required('EXPECTED_MAIN_SHA');
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/issue-276-dev-rationale-acceptance-v2';
const WORKER = 'ads-operations-web-dev';
const BASE_URL = 'https://ads-operations-web-dev.tanshiyuesir.workers.dev';
const CONTROL_DB_ID = '2093b94f-27d5-4a4c-ada1-ff14af5c8de2';
const STORE01_DB_ID = '123b2a32-d78b-4de9-8318-08e35cefb008';
const EXPECTED_VERSION = 'bd3fcb2d-f4a7-4f04-afb3-b6287c17d32a';
const REVIEW_CONTRACT = 'csv-recommendation-human-review-v1';
const SCOPE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01', limit: '50', sort: 'cost' });

await mkdir(OUT, { recursive: true });
const controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: CONTROL_DB_ID, apiToken: API_TOKEN });
const storeDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: STORE01_DB_ID, apiToken: API_TOKEN });
const receipt = {
  schemaVersion: 'issue-276-dev-rationale-acceptance-v2',
  expectedCanonicalMain: EXPECTED_MAIN_SHA,
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  checks: {}, cleanup: {}, amazonRequests: [], blockers: [], result: 'FAIL',
};
let auth = null;
let createdReviewId = null;
let fatal = null;
let originalDeployment = null;

try {
  originalDeployment = await activeDeployment();
  receipt.originalDeployment = originalDeployment;
  assert.equal(originalDeployment.versionId, EXPECTED_VERSION, `dev_exact_main_version_drift:${originalDeployment.versionId}`);
  receipt.checks.exactMainVersionActive = true;

  let initialSettings = await settings();
  receipt.initialSafetyBindings = safety(initialSettings.bindings);
  if (binding(initialSettings.bindings, 'ACCESS_MODE') !== 'off') {
    await patchAccessMode('off');
    receipt.checks.recoveredPriorAcceptanceAccessModeDrift = true;
    initialSettings = await settings();
  }
  assertSafety(initialSettings.bindings, 'off');
  receipt.checks.baselineReadOnlyModeRestored = true;

  await patchAccessMode('enforce');
  const enforceSettings = await settings();
  assertSafety(enforceSettings.bindings, 'enforce');
  receipt.temporarySafetyBindings = safety(enforceSettings.bindings);
  receipt.checks.temporaryAccessEnforceActivated = true;

  const afterPatchDeployment = await activeDeployment();
  assert.equal(afterPatchDeployment.versionId, EXPECTED_VERSION);
  assert.equal(afterPatchDeployment.deploymentId, originalDeployment.deploymentId, 'settings_patch_created_unexpected_deployment');
  receipt.checks.codeAndDeploymentIdentityUnchangedBySettingsPatch = true;

  auth = await createIdentity();
  receipt.identity = auth.public;
  receipt.checks.leastPrivilegeIdentityCreated = true;

  const store = await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(store?.store_id, 'dev_store01_missing');
  const reviewUrl = makeReviewUrl(store.store_id);

  const ui = await appText(`${BASE_URL}/assets/cloudflare-native-csv-recommendation-human-review-v1.js`, auth.headers);
  assert.equal(ui.status, 200, `dev_ui_status:${ui.status}`);
  assert(ui.body.includes("const VERSION = '1.7.0';"), 'dev_ui_1_7_0_missing');
  receipt.checks.ui170Live = true;

  const initial = await retryJson(reviewUrl, { headers: auth.headers });
  assert.equal(initial.status, 200, `dev_review_get:${initial.status}:${JSON.stringify(initial.body).slice(0,240)}`);
  assert.equal(initial.body?.authority?.executionAuthorized, false);
  assert.equal(initial.body?.authority?.amazonMutationAuthorized, false);
  assert.equal(initial.body?.analysisScope?.candidateEmissionAuthorized, true);
  const candidate = (initial.body?.items || []).find((item) => item?.persistenceAuthorized === true && item?.review?.persisted !== true);
  assert(candidate?.inboxItemId, 'dev_unreviewed_current_candidate_missing');
  receipt.candidate = {
    inboxItemId: candidate.inboxItemId,
    fingerprint: candidate.recommendationFingerprint,
    sourceEvidenceSha256: candidate.sourceEvidenceSha256,
    originalState: 'unreviewed', originalNote: null,
  };
  const existing = await storeDb.prepare('SELECT review_id FROM advisory_review_records WHERE recommendation_fingerprint=?1 LIMIT 1').bind(candidate.recommendationFingerprint).first();
  assert.equal(existing, null, 'dev_candidate_has_unexpected_current_review_row');
  receipt.checks.realGovernedUnreviewedCandidateResolved = true;

  const optimizationBefore = await count('optimization_actions');
  receipt.optimizationActionsBefore = optimizationBefore;
  const rationale = `issue-276-development-${RUN_ID}-rationale`;

  const explicit = await appJson(reviewUrl, {
    method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' },
    body: { inboxItemId: candidate.inboxItemId, state: 'needs_review', note: `  ${rationale}  ` },
  });
  assert.equal(explicit.status, 201, `dev_explicit_post:${explicit.status}:${JSON.stringify(explicit.body).slice(0,240)}`);
  assert.equal(explicit.body?.review?.state, 'needs_review');
  assert.equal(explicit.body?.review?.note, rationale);
  assert.equal(explicit.body?.authority?.executionAuthorized, false);
  assert.equal(explicit.body?.authority?.amazonMutationAuthorized, false);
  createdReviewId = explicit.body?.review?.reviewId;
  assert(createdReviewId, 'dev_created_review_id_missing');
  receipt.checks.explicitRationaleNormalized = true;

  const fresh1 = await appJson(reviewUrl, { headers: auth.headers });
  const review1 = findReview(fresh1.body, candidate.inboxItemId);
  assert.equal(fresh1.status, 200);
  assert.equal(review1?.review?.persisted, true);
  assert.equal(review1?.review?.state, 'needs_review');
  assert.equal(review1?.review?.note, rationale);
  receipt.checks.freshGetVerifiedStateAndNote = true;

  const omitted = await appJson(reviewUrl, {
    method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' },
    body: { inboxItemId: candidate.inboxItemId, state: 'acknowledged' },
  });
  assert.equal(omitted.status, 200, `dev_omitted_note_post:${omitted.status}`);
  assert.equal(omitted.body?.review?.state, 'acknowledged');
  assert.equal(omitted.body?.review?.note, rationale);
  const fresh2 = await appJson(reviewUrl, { headers: auth.headers });
  const review2 = findReview(fresh2.body, candidate.inboxItemId);
  assert.equal(review2?.review?.state, 'acknowledged');
  assert.equal(review2?.review?.note, rationale);
  receipt.checks.omittedNotePreserved = true;

  const cleared = await appJson(reviewUrl, {
    method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' },
    body: { inboxItemId: candidate.inboxItemId, state: 'needs_review', note: '   ' },
  });
  assert.equal(cleared.status, 200, `dev_clear_post:${cleared.status}`);
  assert.equal(cleared.body?.review?.state, 'needs_review');
  assert.equal(cleared.body?.review?.note, null);
  const fresh3 = await appJson(reviewUrl, { headers: auth.headers });
  const review3 = findReview(fresh3.body, candidate.inboxItemId);
  assert.equal(review3?.review?.state, 'needs_review');
  assert.equal(review3?.review?.note, null);
  receipt.checks.explicitBlankCleared = true;
  receipt.checks.readAfterWriteOnlyNoOptimisticDurableTruth = true;

  const isolation = await appJson(makeReviewUrl('store-dev-02'), { headers: auth.headers });
  assert.equal(isolation.status, 403, `dev_isolation:${isolation.status}`);
  assert.equal(isolation.body?.error, 'forbidden');
  receipt.checks.store02IsolationFailClosed = true;

  const optimizationAfter = await count('optimization_actions');
  receipt.optimizationActionsAfter = optimizationAfter;
  assert.equal(optimizationAfter, optimizationBefore, 'dev_optimization_actions_changed');
  receipt.checks.optimizationActionsUnchanged = true;
  assert.equal(receipt.amazonRequests.length, 0);
  receipt.checks.amazonClientRequestsZero = true;

  // Cleanup-only D1 mutation: remove the review created by this acceptance, then verify the original unreviewed/null state through the API.
  await storeDb.prepare('DELETE FROM advisory_review_records WHERE review_id=?1 AND reviewer_user_id=?2').bind(createdReviewId, auth.principalUserId).run();
  createdReviewId = null;
  receipt.cleanup.acceptanceReviewDeleted = true;
  const restored = await appJson(reviewUrl, { headers: auth.headers });
  const restoredItem = findReview(restored.body, candidate.inboxItemId);
  assert.equal(restoredItem?.review?.persisted, false);
  assert.equal(restoredItem?.review?.state, 'unreviewed');
  assert.equal(restoredItem?.review?.note ?? null, null);
  receipt.cleanup.originalReviewStateRestored = true;

  receipt.result = 'PASS';
} catch (error) {
  fatal = error;
  receipt.blockers.push(scrub(error?.message || String(error)));
} finally {
  if (createdReviewId && auth) {
    try {
      await storeDb.prepare('DELETE FROM advisory_review_records WHERE review_id=?1 AND reviewer_user_id=?2').bind(createdReviewId, auth.principalUserId).run();
      receipt.cleanup.emergencyAcceptanceReviewDelete = true;
    } catch (error) { fatal ||= error; receipt.cleanup.emergencyReviewDeleteError = scrub(error.message); }
  }
  if (auth) {
    const cleanup = await cleanupIdentity(auth).catch((error) => ({ refsZero: false, error: scrub(error.message) }));
    receipt.cleanup.identity = cleanup;
    if (!cleanup.refsZero) fatal ||= new Error('dev_temporary_identity_cleanup_incomplete');
  }
  try {
    await patchAccessMode('off');
    const finalSettings = await settings();
    assertSafety(finalSettings.bindings, 'off');
    receipt.cleanup.finalSafetyBindings = safety(finalSettings.bindings);
    receipt.cleanup.accessModeRestoredOff = true;
  } catch (error) { fatal ||= error; receipt.cleanup.accessModeRestoreError = scrub(error.message); }
  try {
    const finalDeployment = await activeDeployment();
    receipt.finalDeployment = finalDeployment;
    assert.equal(finalDeployment.versionId, EXPECTED_VERSION);
    assert.equal(finalDeployment.deploymentId, originalDeployment?.deploymentId, 'dev_deployment_changed_during_v2_gate');
    receipt.cleanup.exactMainVersionAndDeploymentUnchanged = true;
  } catch (error) { fatal ||= error; receipt.cleanup.deploymentVerificationError = scrub(error.message); }
  try {
    const optimizationFinal = await count('optimization_actions');
    receipt.optimizationActionsFinal = optimizationFinal;
    if (receipt.optimizationActionsBefore !== undefined) assert.equal(optimizationFinal, receipt.optimizationActionsBefore);
  } catch (error) { fatal ||= error; }
  receipt.finishedAt = new Date().toISOString();
  if (fatal) receipt.result = 'FAIL';
  await writeFile(`${OUT}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(redact(receipt), null, 2));
}
if (fatal) throw fatal;

async function createIdentity() {
  const apps = await cf('/access/apps');
  const host = new URL(BASE_URL).hostname.toLowerCase();
  const app = (apps.result || []).find((row) => String(row?.domain || '').toLowerCase() === host);
  assert(app?.id, 'dev_access_app_not_found');
  const token = (await cf('/access/service_tokens', { method: 'POST', body: { name: `issue-276-dev-v2-${RUN_ID}`, duration: '2h', enabled: true } })).result;
  assert(token?.id && token?.client_id && token?.client_secret, 'dev_service_token_incomplete');
  const policy = (await cf(`/access/apps/${encodeURIComponent(app.id)}/policies`, {
    method: 'POST', body: { name: `Issue 276 Dev v2 ${RUN_ID}`, decision: 'non_identity', include: [{ service_token: { token_id: token.id } }] },
  })).result;
  assert(policy?.id && policy?.decision === 'non_identity', 'dev_non_identity_policy_invalid');
  const principalUserId = `svc-276-dev-v2-${RUN_ID}`;
  const roleKey = `hr276_dev_v2_${RUN_ID}`;
  const email = `svc-276-dev-v2-${RUN_ID}@machine.invalid`;
  const store = await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(store?.store_id, 'dev_store_registry_missing');
  await controlDb.prepare("INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)").bind(roleKey, `Issue 276 Dev v2 ${RUN_ID}`).run();
  await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')").bind(roleKey).run();
  await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'ads.write')").bind(roleKey).run();
  await controlDb.prepare("INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at) VALUES(?1,?2,?3,lower(?3),'Issue 276 Dev Acceptance','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(principalUserId, token.client_id, email).run();
  await controlDb.prepare('INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)').bind(store.store_id, principalUserId, roleKey).run();
  const perms = await controlDb.prepare('SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key').bind(roleKey).all();
  assert.deepEqual((perms.results || []).map((row) => row.permission_key), ['ads.write','analytics.read']);
  return {
    app, token, policy, principalUserId, roleKey,
    headers: { 'CF-Access-Client-Id': token.client_id, 'CF-Access-Client-Secret': token.client_secret, accept: 'application/json' },
    public: { appId: app.id, policyId: policy.id, policyDecision: policy.decision, serviceTokenId: token.id, principalUserId, roleKey, storeId: store.store_id, permissions: ['ads.write','analytics.read'] },
  };
}

async function cleanupIdentity(auth) {
  const out = {};
  try { await controlDb.prepare('DELETE FROM store_members WHERE user_id=?1').bind(auth.principalUserId).run(); out.membershipDeleted = true; } catch (e) { out.membershipError = scrub(e.message); }
  try { await controlDb.prepare('DELETE FROM role_permissions WHERE role_key=?1').bind(auth.roleKey).run(); out.permissionsDeleted = true; } catch (e) { out.permissionsError = scrub(e.message); }
  try { await controlDb.prepare('DELETE FROM app_roles WHERE role_key=?1 AND is_system=0').bind(auth.roleKey).run(); out.roleDeleted = true; } catch (e) { out.roleError = scrub(e.message); }
  try { await controlDb.prepare('DELETE FROM users WHERE user_id=?1').bind(auth.principalUserId).run(); out.principalDeleted = true; } catch (e) { out.principalError = scrub(e.message); }
  try { await cf(`/access/apps/${encodeURIComponent(auth.app.id)}/policies/${encodeURIComponent(auth.policy.id)}`, { method: 'DELETE' }); out.policyDeleted = true; } catch (e) { out.policyError = scrub(e.message); }
  try { await cf(`/access/service_tokens/${encodeURIComponent(auth.token.id)}`, { method: 'DELETE' }); out.tokenDeleted = true; } catch (e) { out.tokenError = scrub(e.message); }
  const refs = {
    membership: Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM store_members WHERE user_id=?1').bind(auth.principalUserId).first())?.n || 0),
    role: Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM app_roles WHERE role_key=?1').bind(auth.roleKey).first())?.n || 0),
    permissions: Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM role_permissions WHERE role_key=?1').bind(auth.roleKey).first())?.n || 0),
    principal: Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM users WHERE user_id=?1').bind(auth.principalUserId).first())?.n || 0),
  };
  const policies = await cf(`/access/apps/${encodeURIComponent(auth.app.id)}/policies`);
  refs.policy = (policies.result || []).filter((row) => row?.id === auth.policy.id).length;
  const tokens = await cf('/access/service_tokens');
  refs.token = (tokens.result || []).filter((row) => row?.id === auth.token.id).length;
  out.refs = refs;
  out.refsZero = Object.values(refs).every((v) => v === 0);
  return out;
}

async function patchAccessMode(value) {
  const current = await settings();
  if (binding(current.bindings, 'ACCESS_MODE') === value) return;
  const next = (current.bindings || []).map((row) => row?.name === 'ACCESS_MODE' ? { ...row, text: value } : row);
  const form = new FormData();
  form.set('settings', JSON.stringify({ bindings: next, annotations: { 'workers/message': `#276 Dev ACCESS_MODE=${value} acceptance control`, 'workers/tag': `issue-276-dev-v2-${RUN_ID}` } }));
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${encodeURIComponent(WORKER)}/settings`, {
    method: 'PATCH', headers: { authorization: `Bearer ${API_TOKEN}`, accept: 'application/json' }, body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) throw new Error(`dev_settings_patch_failed:${response.status}:${payload?.errors?.[0]?.message || ''}`);
  for (let i = 0; i < 15; i += 1) {
    const observed = await settings();
    if (binding(observed.bindings, 'ACCESS_MODE') === value) return;
    await sleep(1000);
  }
  throw new Error(`dev_access_mode_patch_not_observed:${value}`);
}

async function settings() { return (await cf(`/workers/scripts/${encodeURIComponent(WORKER)}/settings`)).result || {}; }
async function activeDeployment() {
  const payload = await cf(`/workers/scripts/${encodeURIComponent(WORKER)}/deployments`);
  const d = payload.result?.deployments?.[0];
  assert(d?.id, 'dev_active_deployment_missing');
  const v = (d.versions || []).find((row) => Number(row?.percentage) === 100) || d.versions?.[0];
  assert(v?.version_id, 'dev_active_version_missing');
  return { deploymentId: d.id, versionId: v.version_id, percentage: Number(v.percentage), createdOn: d.created_on || null, source: d.source || null };
}
function assertSafety(bindings, accessMode) {
  assert.equal(binding(bindings,'ACCESS_MODE'), accessMode);
  assert.equal(binding(bindings,'SYNC_TRIGGER_ENABLED'), 'false');
  assert.equal(binding(bindings,'PHASE5_SINGLE_RUN_PERMIT_ID') ?? '', '');
  assert.equal(binding(bindings,'PHASE5_SINGLE_RUN_REPORT_DATE') ?? '', '');
}
function safety(bindings) { return { accessMode: binding(bindings,'ACCESS_MODE'), syncTriggerEnabled: binding(bindings,'SYNC_TRIGGER_ENABLED'), phase5SingleRunPermitId: binding(bindings,'PHASE5_SINGLE_RUN_PERMIT_ID') ?? '', phase5SingleRunReportDate: binding(bindings,'PHASE5_SINGLE_RUN_REPORT_DATE') ?? '' }; }
function binding(bindings,name) { return (bindings || []).find((row) => row?.name === name && row?.type === 'plain_text')?.text ?? null; }
function makeReviewUrl(storeId) { const p = new URLSearchParams({ reviewContract: REVIEW_CONTRACT, ...SCOPE }); return `${BASE_URL}/api/v1/stores/${encodeURIComponent(storeId)}/advisory-reviews?${p}`; }
async function retryJson(url, options) { let last; for (let i=0;i<15;i+=1) { last=await appJson(url,options); if(last.status===200)return last; if(![302,401,403].includes(last.status))return last; await sleep(2000); } return last; }
async function appJson(url,{method='GET',headers={},body=null}={}) { blockAmazon(url,method); const r=await fetch(url,{method,headers,body:body===null?undefined:JSON.stringify(body),redirect:'manual',cache:'no-store'}); const t=await r.text(); let b; try{b=JSON.parse(t);}catch{b={nonJson:t.slice(0,400)}} return {status:r.status,body:b}; }
async function appText(url,headers={}) { blockAmazon(url,'GET'); const r=await fetch(url,{headers,redirect:'manual',cache:'no-store'}); return {status:r.status,body:await r.text()}; }
function blockAmazon(url,method){const h=new URL(url).hostname.toLowerCase(); if(/(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(h)){receipt.amazonRequests.push({method,url});throw new Error(`amazon_request_blocked:${url}`)}}
async function count(table){const row=await storeDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();return Number(row?.n||0)}
function findReview(body,id){return (body?.items||[]).find((item)=>item?.inboxItemId===id)||null}
async function cf(path,{method='GET',body=null}={}){const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}`,{method,headers:{authorization:`Bearer ${API_TOKEN}`,accept:'application/json',...(body!==null?{'content-type':'application/json'}:{})},body:body===null?undefined:JSON.stringify(body)});const p=await r.json().catch(()=>({}));if(!r.ok||p?.success===false)throw new Error(`cloudflare_api_failed:${path}:${p?.errors?.[0]?.code||r.status}:${p?.errors?.[0]?.message||''}`);return p}
function required(name){const v=String(process.env[name]||'').trim();if(!v)throw new Error(`${name}_required`);return v}
function scrub(v){return String(v||'').split(API_TOKEN).join('[REDACTED_API_TOKEN]').replace(/[\r\n\t]+/g,' ').trim()}
function redact(v){return JSON.parse(JSON.stringify(v,(k,x)=>/secret|apiToken|clientSecret/i.test(k)?'[REDACTED]':x))}
function sleep(ms){return new Promise((resolve)=>setTimeout(resolve,ms))}
