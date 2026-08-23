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
const INBOX_ITEM_ID = 'csv-inbox:keyword.review_harvest:exact_review:ytdbns reading glasses for women';
const FINGERPRINT = '6598e5cfb4fb610c77f0d53847660cadf79cde0b16f232fbec3c0fde6c6a3bf0';
const REVIEW_CONTRACT = 'csv-recommendation-human-review-v1';
const SCOPE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01', limit: '50', sort: 'cost' });
const OUT = 'artifacts/issue-276-dev-rationale-acceptance-v4';

await mkdir(OUT, { recursive: true });
const controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: CONTROL_DB_ID, apiToken: API_TOKEN });
const storeDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: STORE_DB_ID, apiToken: API_TOKEN });
const receipt = { schemaVersion:'issue-276-dev-rationale-acceptance-v4', issue:276, parentIssue:273, expectedCanonicalMain:EXPECTED_MAIN_SHA, runId:RUN_ID, startedAt:new Date().toISOString(), amazonRequests:[], checks:{}, cleanup:{}, blockers:[], result:'FAIL' };
let auth = null;
let originalRow = null;
let reviewUrl = null;
let optimizationBefore = null;
let fatal = null;

try {
  const activeBefore = await activeDeployment();
  receipt.activeBefore = activeBefore;
  assert.equal(activeBefore.versionId, BASELINE_VERSION, `dev_active_version_drift:${activeBefore.versionId}`);
  assert.equal(activeBefore.percentage, 100);
  const baseline = await versionDetail(BASELINE_VERSION);
  const temporary = await versionDetail(TEMP_ENFORCE_VERSION);
  assertVersionSafety(baseline, 'off');
  assertVersionSafety(temporary, 'enforce');
  receipt.checks.baselineExactMainReadOnly = true;
  receipt.checks.temporaryEnforceVersionSafetyLocked = true;
  assert.deepEqual(await schedules(), [], 'dev_web_schedules_not_empty');

  originalRow = await storeDb.prepare('SELECT * FROM advisory_review_records WHERE recommendation_fingerprint=?1 LIMIT 1').bind(FINGERPRINT).first();
  assert(originalRow?.review_id, 'append_only_fixture_missing');
  assert.equal(originalRow.state, 'open');
  assert.equal(originalRow.reviewer_note, null);
  receipt.fixture = { reviewId:originalRow.review_id, fingerprint:FINGERPRINT, originalState:originalRow.state, originalNote:originalRow.reviewer_note, originalReviewerUserId:originalRow.reviewer_user_id, originalReviewedAt:originalRow.reviewed_at, originalUpdatedAt:originalRow.updated_at, createdBy:originalRow.created_by };
  receipt.checks.appendOnlyFixtureCaptured = true;

  optimizationBefore = await countTable('optimization_actions');
  receipt.optimizationActionsBefore = optimizationBefore;
  assert.equal(optimizationBefore, 4, `dev_optimization_action_baseline_drift:${optimizationBefore}`);

  await deployVersion(TEMP_ENFORCE_VERSION, '#276 Dev append-only rationale acceptance v4');
  receipt.activeTemporary = await waitForVersion(TEMP_ENFORCE_VERSION);
  receipt.checks.temporaryEnforceVersionActive = true;

  auth = await createIdentity();
  receipt.identity = auth.public;
  receipt.checks.leastPrivilegeIdentityCreated = true;

  const store = await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(store?.store_id, 'dev_store01_registry_missing');
  reviewUrl = makeReviewUrl(store.store_id);

  const initial = await waitForAuthenticatedReview(reviewUrl, auth.headers);
  assert.equal(initial.status, 200, `dev_initial_review_status:${initial.status}:${JSON.stringify(initial.body).slice(0,300)}`);
  assert.equal(initial.body?.authority?.executionAuthorized, false);
  assert.equal(initial.body?.authority?.amazonMutationAuthorized, false);
  const item = findReview(initial.body, INBOX_ITEM_ID);
  assert(item, 'append_only_fixture_not_current_candidate');
  assert.equal(item.persistenceAuthorized, true);
  assert.equal(item.review?.persisted, true);
  assert.equal(item.review?.state, 'needs_review');
  assert.equal(item.review?.note ?? null, null);
  receipt.checks.currentPersistedFixtureResolved = true;
  receipt.checks.executionAuthorityFalse = true;
  receipt.checks.amazonMutationAuthorityFalse = true;

  const rationale = `issue-276-dev-v4-${RUN_ID}-rationale`;
  const explicit = await postReview(reviewUrl, auth.headers, { inboxItemId:INBOX_ITEM_ID, state:'needs_review', note:`  ${rationale}  ` });
  assert.equal(explicit.status, 200, `dev_explicit_rationale_post:${explicit.status}:${JSON.stringify(explicit.body).slice(0,300)}`);
  assert.equal(explicit.body?.review?.note, rationale);
  assert.equal(explicit.body?.review?.state, 'needs_review');
  const fresh1 = await appJson(reviewUrl,{headers:auth.headers});
  const item1 = findReview(fresh1.body, INBOX_ITEM_ID);
  assert.equal(item1?.review?.state, 'needs_review');
  assert.equal(item1?.review?.note, rationale);
  receipt.checks.explicitRationaleNormalizedAndReadBack = true;

  const omitted = await postReview(reviewUrl, auth.headers, { inboxItemId:INBOX_ITEM_ID, state:'acknowledged' });
  assert.equal(omitted.status, 200, `dev_omitted_note_post:${omitted.status}`);
  assert.equal(omitted.body?.review?.state, 'acknowledged');
  assert.equal(omitted.body?.review?.note, rationale);
  const fresh2 = await appJson(reviewUrl,{headers:auth.headers});
  const item2 = findReview(fresh2.body, INBOX_ITEM_ID);
  assert.equal(item2?.review?.state, 'acknowledged');
  assert.equal(item2?.review?.note, rationale);
  receipt.checks.omittedNotePreservedAndReadBack = true;

  const cleared = await postReview(reviewUrl, auth.headers, { inboxItemId:INBOX_ITEM_ID, state:'needs_review', note:'   ' });
  assert.equal(cleared.status, 200, `dev_blank_clear_post:${cleared.status}`);
  assert.equal(cleared.body?.review?.state, 'needs_review');
  assert.equal(cleared.body?.review?.note, null);
  const fresh3 = await appJson(reviewUrl,{headers:auth.headers});
  const item3 = findReview(fresh3.body, INBOX_ITEM_ID);
  assert.equal(item3?.review?.state, 'needs_review');
  assert.equal(item3?.review?.note, null);
  receipt.checks.explicitBlankClearedAndReadBack = true;
  receipt.checks.noOptimisticDurableTruth = true;

  const restoreApi = await postReview(reviewUrl, auth.headers, { inboxItemId:INBOX_ITEM_ID, state:'needs_review', note:null });
  assert.equal(restoreApi.status, 200, `dev_api_restore_status:${restoreApi.status}`);
  const freshRestore = await appJson(reviewUrl,{headers:auth.headers});
  const restoredApiItem = findReview(freshRestore.body, INBOX_ITEM_ID);
  assert.equal(restoredApiItem?.review?.state, 'needs_review');
  assert.equal(restoredApiItem?.review?.note, null);
  receipt.checks.apiStateAndNoteRestored = true;

  const isolation = await appJson(makeReviewUrl('store-dev-02'),{headers:auth.headers});
  assert.equal(isolation.status,403,`dev_store02_isolation_status:${isolation.status}`);
  assert.equal(isolation.body?.error,'forbidden');
  receipt.checks.storeIsolationFailClosed = true;

  const optimizationAfter = await countTable('optimization_actions');
  receipt.optimizationActionsAfter = optimizationAfter;
  assert.equal(optimizationAfter, optimizationBefore, 'dev_optimization_actions_changed');
  assert.equal(receipt.amazonRequests.length,0);
  receipt.checks.optimizationActionsUnchanged = true;
  receipt.checks.amazonClientRequestsZero = true;

  // Cleanup-only metadata restoration. Acceptance truth above comes only from Human Review POST -> fresh GET.
  await restoreMutableMetadata(originalRow);
  const rowAfterCleanup = await storeDb.prepare('SELECT * FROM advisory_review_records WHERE review_id=?1').bind(originalRow.review_id).first();
  assert.deepEqual(rowAfterCleanup, originalRow, 'dev_append_only_fixture_not_exactly_restored');
  receipt.cleanup.fixtureExactRowRestored = true;
  receipt.result = 'PASS';
} catch (error) {
  fatal = error;
  receipt.blockers.push(scrub(error?.message || String(error)));
} finally {
  if (originalRow) {
    try {
      await restoreMutableMetadata(originalRow);
      const finalRow = await storeDb.prepare('SELECT * FROM advisory_review_records WHERE review_id=?1').bind(originalRow.review_id).first();
      assert.deepEqual(finalRow, originalRow, 'dev_fixture_final_row_mismatch');
      receipt.cleanup.fixtureFinalExactRowVerified = true;
    } catch (error) { fatal ||= error; receipt.cleanup.fixtureRestoreError = scrub(error?.message || String(error)); }
  }
  if (auth) {
    const identityCleanup = await cleanupIdentity(auth).catch((error)=>({refsZero:false,error:scrub(error.message)}));
    receipt.cleanup.identity = identityCleanup;
    if (!identityCleanup.refsZero) fatal ||= new Error('dev_v4_identity_cleanup_incomplete');
  }
  try {
    await deployVersion(BASELINE_VERSION,'#276 restore Dev exact-main read-only baseline after v4');
    const finalActive=await waitForVersion(BASELINE_VERSION);
    receipt.activeFinal=finalActive;
    assertVersionSafety(await versionDetail(BASELINE_VERSION),'off');
    assert.deepEqual(await schedules(),[]);
    receipt.cleanup.baselineVersionRestored100 = true;
  } catch (error) { fatal ||= error; receipt.cleanup.baselineRestoreError=scrub(error?.message||String(error)); }
  try {
    const finalOptimization=await countTable('optimization_actions');
    receipt.optimizationActionsFinal=finalOptimization;
    if(optimizationBefore!==null) assert.equal(finalOptimization,optimizationBefore,'dev_optimization_actions_final_changed');
  } catch(error){fatal ||= error; receipt.cleanup.optimizationFinalError=scrub(error?.message||String(error));}
  assert.equal(receipt.amazonRequests.length,0);
  if(fatal) receipt.result='FAIL';
  receipt.finishedAt=new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`,JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(redact(receipt),null,2));
}
if(fatal) throw fatal;

async function restoreMutableMetadata(row){
  await storeDb.prepare(`UPDATE advisory_review_records SET state=?1, reviewer_user_id=?2, reviewer_note=?3, reviewed_at=?4, snoozed_until=?5, updated_at=?6 WHERE review_id=?7 AND recommendation_fingerprint=?8`)
    .bind(row.state,row.reviewer_user_id,row.reviewer_note,row.reviewed_at,row.snoozed_until,row.updated_at,row.review_id,row.recommendation_fingerprint).run();
}

async function createIdentity(){
  const host=new URL(BASE_URL).hostname.toLowerCase();
  const apps=await cf('/access/apps');
  const app=(apps.result||[]).find((row)=>String(row?.domain||'').toLowerCase()===host);
  assert(app?.id,'dev_access_app_not_found');
  const token=(await cf('/access/service_tokens',{method:'POST',body:{name:`issue-276-dev-v4-${RUN_ID}`,duration:'2h',enabled:true}})).result;
  assert(token?.id&&token?.client_id&&token?.client_secret,'dev_service_token_incomplete');
  const policy=(await cf(`/access/apps/${encodeURIComponent(app.id)}/policies`,{method:'POST',body:{name:`Issue 276 Dev v4 ${RUN_ID}`,decision:'non_identity',include:[{service_token:{token_id:token.id}}]}})).result;
  assert(policy?.id&&policy?.decision==='non_identity','dev_non_identity_policy_invalid');
  const principalUserId=`svc-276-dev-v4-${RUN_ID}`;
  const roleKey=`hr276_dev_v4_${RUN_ID}`;
  const email=`svc-276-dev-v4-${RUN_ID}@machine.invalid`;
  const store=await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(store?.store_id,'dev_store01_registry_missing_for_identity');
  await controlDb.prepare("INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)").bind(roleKey,`Issue 276 Dev v4 ${RUN_ID}`).run();
  await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')").bind(roleKey).run();
  await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'ads.write')").bind(roleKey).run();
  await controlDb.prepare("INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at) VALUES(?1,?2,?3,lower(?3),'Issue 276 Dev v4 Acceptance','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(principalUserId,token.client_id,email).run();
  await controlDb.prepare('INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)').bind(store.store_id,principalUserId,roleKey).run();
  const perms=await controlDb.prepare('SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key').bind(roleKey).all();
  assert.deepEqual((perms.results||[]).map(r=>r.permission_key),['ads.write','analytics.read']);
  return {app,token,policy,principalUserId,roleKey,headers:{'CF-Access-Client-Id':token.client_id,'CF-Access-Client-Secret':token.client_secret,accept:'application/json'},public:{accessAppId:app.id,serviceTokenId:token.id,policyId:policy.id,policyDecision:policy.decision,principalUserId,roleKey,storeId:store.store_id,permissions:['ads.write','analytics.read']}};
}

async function cleanupIdentity(auth){
  const out={};
  try{await controlDb.prepare('DELETE FROM store_members WHERE user_id=?1').bind(auth.principalUserId).run();out.membershipDeleted=true;}catch(e){out.membershipDeleteError=scrub(e.message);}
  try{await controlDb.prepare('DELETE FROM role_permissions WHERE role_key=?1').bind(auth.roleKey).run();out.permissionsDeleted=true;}catch(e){out.permissionsDeleteError=scrub(e.message);}
  try{await controlDb.prepare('DELETE FROM app_roles WHERE role_key=?1 AND is_system=0').bind(auth.roleKey).run();out.roleDeleted=true;}catch(e){out.roleDeleteError=scrub(e.message);}
  try{await controlDb.prepare('DELETE FROM users WHERE user_id=?1').bind(auth.principalUserId).run();out.principalDeleted=true;}catch(e){out.principalDeleteError=scrub(e.message);}
  try{await cf(`/access/apps/${encodeURIComponent(auth.app.id)}/policies/${encodeURIComponent(auth.policy.id)}`,{method:'DELETE'});out.policyDeleted=true;}catch(e){out.policyDeleteError=scrub(e.message);}
  try{await cf(`/access/service_tokens/${encodeURIComponent(auth.token.id)}`,{method:'DELETE'});out.serviceTokenDeleted=true;}catch(e){out.serviceTokenDeleteError=scrub(e.message);}
  const refs={memberships:Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM store_members WHERE user_id=?1').bind(auth.principalUserId).first())?.n||0),roles:Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM app_roles WHERE role_key=?1').bind(auth.roleKey).first())?.n||0),permissions:Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM role_permissions WHERE role_key=?1').bind(auth.roleKey).first())?.n||0),principals:Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM users WHERE user_id=?1').bind(auth.principalUserId).first())?.n||0)};
  const policies=await cf(`/access/apps/${encodeURIComponent(auth.app.id)}/policies`);refs.policies=(policies.result||[]).filter(r=>r?.id===auth.policy.id).length;
  const tokens=await cf('/access/service_tokens');refs.serviceTokens=(tokens.result||[]).filter(r=>r?.id===auth.token.id).length;
  out.refs=refs;out.refsZero=Object.values(refs).every(v=>v===0);return out;
}

async function postReview(url,headers,body){return appJson(url,{method:'POST',headers:{...headers,'content-type':'application/json'},body});}
async function waitForAuthenticatedReview(url,headers){let last;for(let i=0;i<20;i+=1){last=await appJson(url,{headers});if(last.status===200)return last;if(![302,401,403].includes(last.status))return last;await sleep(2000);}return last;}
async function versionDetail(id){return (await cf(`/workers/scripts/${encodeURIComponent(WORKER)}/versions/${encodeURIComponent(id)}`)).result||{};}
function assertVersionSafety(detail,accessMode){assert.equal(bindingValue(detail,'ACCESS_MODE'),accessMode);assert.equal(bindingValue(detail,'SYNC_TRIGGER_ENABLED'),'false');assert.equal(bindingValue(detail,'PHASE5_SINGLE_RUN_PERMIT_ID')??'','');assert.equal(bindingValue(detail,'PHASE5_SINGLE_RUN_REPORT_DATE')??'','');}
function bindingValue(value,name){const found=findBinding(value,name);return found?(found.text??found.value??null):null;}
function findBinding(value,name){if(!value||typeof value!=='object')return null;if(Array.isArray(value)){for(const item of value){if(item&&typeof item==='object'&&item.name===name)return item;const n=findBinding(item,name);if(n)return n;}return null;}for(const child of Object.values(value)){const n=findBinding(child,name);if(n)return n;}return null;}
async function activeDeployment(){const result=(await cf(`/workers/scripts/${encodeURIComponent(WORKER)}/deployments`)).result||{};const d=result?.deployments?.[0]||(Array.isArray(result)?result[0]:null);assert(d?.id,'dev_active_deployment_missing');const v=(d.versions||[]).find(r=>Number(r?.percentage)===100)||d.versions?.[0];assert(v?.version_id,'dev_active_version_missing');return{deploymentId:d.id,versionId:v.version_id,percentage:Number(v.percentage),createdOn:d.created_on||null,source:d.source||null};}
async function deployVersion(versionId,message){const payload=await cf(`/workers/scripts/${encodeURIComponent(WORKER)}/deployments`,{method:'POST',body:{strategy:'percentage',versions:[{percentage:100,version_id:versionId}],annotations:{'workers/message':message}}});assert(payload.result?.id,`dev_deployment_create_failed:${versionId}`);return payload.result;}
async function waitForVersion(versionId){for(let i=0;i<30;i+=1){const active=await activeDeployment();if(active.versionId===versionId&&active.percentage===100)return active;await sleep(1500);}throw new Error(`dev_version_not_active:${versionId}`);}
async function schedules(){const payload=await cf(`/workers/scripts/${encodeURIComponent(WORKER)}/schedules`);const r=payload.result?.schedules??payload.result??[];return Array.isArray(r)?r:[];}
function makeReviewUrl(storeId){const p=new URLSearchParams({reviewContract:REVIEW_CONTRACT,...SCOPE});return `${BASE_URL}/api/v1/stores/${encodeURIComponent(storeId)}/advisory-reviews?${p}`;}
async function appJson(url,{method='GET',headers={},body=null}={}){blockAmazon(url,method);const r=await fetch(url,{method,headers,body:body===null?undefined:JSON.stringify(body),redirect:'manual',cache:'no-store'});const t=await r.text();let parsed;try{parsed=JSON.parse(t);}catch{parsed={nonJson:t.slice(0,500)}}return{status:r.status,body:parsed};}
function blockAmazon(url,method){const h=new URL(url).hostname.toLowerCase();if(/(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(h)){receipt.amazonRequests.push({method,url});throw new Error(`amazon_request_blocked:${url}`);}}
function findReview(body,id){return(body?.items||[]).find(item=>item?.inboxItemId===id)||null;}
async function countTable(table){const row=await storeDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();return Number(row?.count??0);}
async function cf(path,{method='GET',body=null}={}){const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`,{method,headers:{authorization:`Bearer ${API_TOKEN}`,accept:'application/json',...(body!==null?{'content-type':'application/json'}:{})},body:body===null?undefined:JSON.stringify(body)});const payload=await r.json().catch(()=>({}));if(!r.ok||payload?.success===false)throw new Error(`cloudflare_api_failed:${path}:${payload?.errors?.[0]?.code||r.status}:${scrub(payload?.errors?.[0]?.message||'')}`);return payload;}
function required(name){const v=String(process.env[name]||'').trim();if(!v)throw new Error(`${name}_required`);return v;}
function scrub(v){return String(v||'').split(API_TOKEN).join('[REDACTED_API_TOKEN]').replace(/[\r\n\t]+/g,' ').trim();}
function redact(v){return JSON.parse(JSON.stringify(v,(k,x)=>/secret|apiToken|clientSecret/i.test(k)?'[REDACTED]':x));}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
