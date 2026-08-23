import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ACCOUNT_ID=required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN=required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA=required('EXPECTED_MAIN_SHA');
const RUN_ID=String(process.env.GITHUB_RUN_ID||Date.now());
const WEB='ads-operations-web-prod';
const SYNC='ads-operations-sync-prod';
const BASE_URL='https://ads-operations-web-prod.tanshiyuesir.workers.dev';
const CONTROL_DB_ID='2122248c-1fd4-4ccd-b611-9f9d2f3decbf';
const STORE01_DB_ID='2e53bbad-5680-431c-bcf7-68e89b231ea1';
const BUILD_TRIGGER='fa90d482-de7b-466b-9ada-04404569ede9';
const REVIEW_CONTRACT='csv-recommendation-human-review-v1';
const SCOPE=Object.freeze({startDate:'2026-06-01',endDate:'2026-06-01',limit:'50',sort:'cost'});
const OUT='artifacts/issue-276-production-rationale-acceptance';
await mkdir(OUT,{recursive:true});

const controlDb=createD1RestDatabase({accountId:ACCOUNT_ID,databaseId:CONTROL_DB_ID,apiToken:API_TOKEN});
const storeDb=createD1RestDatabase({accountId:ACCOUNT_ID,databaseId:STORE01_DB_ID,apiToken:API_TOKEN});
const receipt={schemaVersion:'issue-276-production-rationale-acceptance-v1',issue:276,parentIssue:273,expectedCanonicalMain:EXPECTED_MAIN_SHA,runId:RUN_ID,startedAt:new Date().toISOString(),amazonRequests:[],checks:{},cleanup:{},blockers:[],result:'FAIL'};
let syncBefore=null, auth=null, originalRow=null, optimizationBefore=null, fatal=null;

try{
  syncBefore=await syncSnapshot();
  receipt.productionSyncBefore=syncBefore;
  assert.equal(syncBefore.amazonAdsEnabled,'false');
  assert.deepEqual(syncBefore.schedules,[]);
  receipt.checks.productionSyncFrozenBefore=true;

  const webBefore=await activeDeployment(WEB);
  receipt.productionWebBefore=webBefore;
  const build=await triggerAndWaitBuild();
  receipt.exactMainBuild=build;
  assert.equal(build.branch,'main');
  assert.equal(build.commitHash,EXPECTED_MAIN_SHA);
  assert.equal(build.outcome,'success');
  receipt.checks.exactMainBuildSuccess=true;

  const promoted=await waitForNewActiveVersion(WEB,webBefore.versionId);
  receipt.productionWebPromoted=promoted;
  const promotedDetail=await versionDetail(WEB,promoted.versionId);
  assertWebSafety(promotedDetail);
  assert.deepEqual(await schedules(WEB),[],'production_web_schedules_not_empty');
  receipt.promotedWebBindings=safetySummary(promotedDetail);
  receipt.checks.productionExactMainRuntimePromoted=true;
  receipt.checks.productionWebHardOff=true;

  auth=await createIdentity();
  receipt.identity=auth.public;
  receipt.checks.leastPrivilegeIdentityCreated=true;

  const health=await retryJson(`${BASE_URL}/api/health`,{headers:auth.headers});
  assert.equal(health.status,200,`production_health_status:${health.status}:${JSON.stringify(health.body).slice(0,250)}`);
  assert.equal(health.body?.environment,'production');
  assert.equal(health.body?.syncTriggerEnabled,false);
  if(health.body?.deployment?.versionId) assert.equal(health.body.deployment.versionId,promoted.versionId,'production_health_version_mismatch');
  receipt.health=health.body;
  receipt.checks.authenticatedHealthPass=true;

  const ui=await appText(`${BASE_URL}/assets/cloudflare-native-csv-recommendation-human-review-v1.js`,auth.headers);
  assert.equal(ui.status,200,`production_ui_status:${ui.status}`);
  assert(ui.body.includes("const VERSION = '1.7.0';"),'production_ui_1_7_0_missing');
  assert(ui.body.includes('Human Review rationale (optional)'),'production_rationale_editor_missing');
  receipt.checks.ui170RationaleAuthoringLive=true;

  const store=await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(store?.store_id,'production_store01_registry_missing');
  const store02=await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_02_DB' AND status <> 'disabled' LIMIT 1").first();
  assert(store02?.store_id,'production_store02_registry_missing');
  const reviewUrl=makeReviewUrl(store.store_id);
  const initial=await retryJson(reviewUrl,{headers:auth.headers});
  assert.equal(initial.status,200,`production_review_get:${initial.status}:${JSON.stringify(initial.body).slice(0,300)}`);
  assert.equal(initial.body?.authority?.executionAuthorized,false);
  assert.equal(initial.body?.authority?.amazonMutationAuthorized,false);
  assert.equal(initial.body?.analysisScope?.candidateEmissionAuthorized,true);
  receipt.checks.executionAuthorityFalse=true;
  receipt.checks.amazonMutationAuthorityFalse=true;

  const candidates=(initial.body?.items||[]).filter(item=>item?.persistenceAuthorized===true&&item?.review?.persisted===true&&['needs_review','acknowledged','approved','rejected'].includes(item?.review?.state));
  assert(candidates.length>0,'production_current_persisted_restorable_fixture_missing');
  const item=candidates[0];
  originalRow=await storeDb.prepare('SELECT * FROM advisory_review_records WHERE recommendation_fingerprint=?1 LIMIT 1').bind(item.recommendationFingerprint).first();
  assert(originalRow?.review_id,'production_fixture_storage_row_missing');
  const originalApiState=item.review.state;
  const originalApiNote=item.review.note??null;
  receipt.fixture={reviewId:originalRow.review_id,inboxItemId:item.inboxItemId,fingerprint:item.recommendationFingerprint,originalApiState,originalApiNote,originalDbState:originalRow.state,originalReviewerUserId:originalRow.reviewer_user_id,originalReviewedAt:originalRow.reviewed_at,originalUpdatedAt:originalRow.updated_at};
  receipt.checks.currentPersistedRestorableFixtureResolved=true;

  optimizationBefore=await countTable('optimization_actions');
  receipt.optimizationActionsBefore=optimizationBefore;
  const rationale=`issue-276-production-${RUN_ID}-rationale`;
  const explicit=await postReview(reviewUrl,auth.headers,{inboxItemId:item.inboxItemId,state:originalApiState,note:`  ${rationale}  `});
  assert.equal(explicit.status,200,`production_explicit_note_post:${explicit.status}:${JSON.stringify(explicit.body).slice(0,300)}`);
  assert.equal(explicit.body?.review?.note,rationale);
  const fresh1=findReview((await appJson(reviewUrl,{headers:auth.headers})).body,item.inboxItemId);
  assert.equal(fresh1?.review?.state,originalApiState);
  assert.equal(fresh1?.review?.note,rationale);
  receipt.checks.explicitRationaleNormalizedAndReadBack=true;

  const transientState=originalApiState==='acknowledged'?'needs_review':'acknowledged';
  const omitted=await postReview(reviewUrl,auth.headers,{inboxItemId:item.inboxItemId,state:transientState});
  assert.equal(omitted.status,200,`production_omitted_note_post:${omitted.status}`);
  assert.equal(omitted.body?.review?.state,transientState);
  assert.equal(omitted.body?.review?.note,rationale);
  const fresh2=findReview((await appJson(reviewUrl,{headers:auth.headers})).body,item.inboxItemId);
  assert.equal(fresh2?.review?.state,transientState);
  assert.equal(fresh2?.review?.note,rationale);
  receipt.checks.omittedNotePreservedAndReadBack=true;

  const cleared=await postReview(reviewUrl,auth.headers,{inboxItemId:item.inboxItemId,state:originalApiState,note:'   '});
  assert.equal(cleared.status,200,`production_blank_clear_post:${cleared.status}`);
  assert.equal(cleared.body?.review?.note,null);
  const fresh3=findReview((await appJson(reviewUrl,{headers:auth.headers})).body,item.inboxItemId);
  assert.equal(fresh3?.review?.state,originalApiState);
  assert.equal(fresh3?.review?.note,null);
  receipt.checks.explicitBlankClearedAndReadBack=true;
  receipt.checks.noOptimisticDurableTruth=true;

  const restore=await postReview(reviewUrl,auth.headers,{inboxItemId:item.inboxItemId,state:originalApiState,note:originalApiNote});
  assert.equal(restore.status,200,`production_api_restore_status:${restore.status}`);
  const freshRestore=findReview((await appJson(reviewUrl,{headers:auth.headers})).body,item.inboxItemId);
  assert.equal(freshRestore?.review?.state,originalApiState);
  assert.equal(freshRestore?.review?.note??null,originalApiNote);
  receipt.checks.apiStateAndNoteRestored=true;

  const isolation=await appJson(makeReviewUrl(store02.store_id),{headers:auth.headers});
  assert.equal(isolation.status,403,`production_store02_isolation:${isolation.status}`);
  assert.equal(isolation.body?.error,'forbidden');
  receipt.checks.storeIsolationFailClosed=true;

  const optimizationAfter=await countTable('optimization_actions');
  receipt.optimizationActionsAfter=optimizationAfter;
  assert.equal(optimizationAfter,optimizationBefore,'production_optimization_actions_changed');
  receipt.checks.optimizationActionsUnchanged=true;
  assert.equal(receipt.amazonRequests.length,0);
  receipt.checks.amazonClientRequestsZero=true;

  // Cleanup-only restoration of mutable audit metadata. Acceptance evidence above is API POST -> fresh GET only.
  await restoreMutableMetadata(originalRow);
  const exactRow=await storeDb.prepare('SELECT * FROM advisory_review_records WHERE review_id=?1').bind(originalRow.review_id).first();
  assert.deepEqual(exactRow,originalRow,'production_fixture_not_exactly_restored');
  receipt.cleanup.fixtureExactRowRestored=true;

  const syncAfter=await syncSnapshot();
  receipt.productionSyncAfter=syncAfter;
  assert.deepEqual(syncAfter,syncBefore,'production_sync_changed_during_acceptance');
  receipt.checks.productionSyncUnchanged=true;
  receipt.result='PASS';
}catch(error){fatal=error;receipt.blockers.push(scrub(error?.message||String(error)));}
finally{
  if(originalRow){try{await restoreMutableMetadata(originalRow);const finalRow=await storeDb.prepare('SELECT * FROM advisory_review_records WHERE review_id=?1').bind(originalRow.review_id).first();assert.deepEqual(finalRow,originalRow,'production_fixture_final_row_mismatch');receipt.cleanup.fixtureFinalExactRowVerified=true;}catch(error){fatal ||= error;receipt.cleanup.fixtureRestoreError=scrub(error?.message||String(error));}}
  if(auth){const clean=await cleanupIdentity(auth).catch(error=>({refsZero:false,error:scrub(error.message)}));receipt.cleanup.identity=clean;if(!clean.refsZero)fatal ||= new Error('production_identity_cleanup_incomplete');}
  try{const syncFinal=await syncSnapshot();receipt.productionSyncFinal=syncFinal;if(syncBefore)assert.deepEqual(syncFinal,syncBefore,'production_sync_final_snapshot_changed');receipt.cleanup.productionSyncFinalExact=true;}catch(error){fatal ||= error;receipt.cleanup.syncFinalError=scrub(error?.message||String(error));}
  try{const webFinal=await activeDeployment(WEB);receipt.productionWebFinal=webFinal;assertWebSafety(await versionDetail(WEB,webFinal.versionId));assert.deepEqual(await schedules(WEB),[]);receipt.cleanup.productionWebFinalHardOff=true;}catch(error){fatal ||= error;receipt.cleanup.webFinalError=scrub(error?.message||String(error));}
  try{const opt=await countTable('optimization_actions');receipt.optimizationActionsFinal=opt;if(optimizationBefore!==null)assert.equal(opt,optimizationBefore,'production_optimization_actions_final_changed');}catch(error){fatal ||= error;receipt.cleanup.optimizationFinalError=scrub(error?.message||String(error));}
  assert.equal(receipt.amazonRequests.length,0);
  if(fatal)receipt.result='FAIL';
  receipt.finishedAt=new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`,JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(redact(receipt),null,2));
}
if(fatal)throw fatal;

async function triggerAndWaitBuild(){
  const created=await cf(`/builds/triggers/${encodeURIComponent(BUILD_TRIGGER)}/builds`,{method:'POST',body:{branch:'main',commit_hash:EXPECTED_MAIN_SHA}});
  const buildUuid=created.result?.build_uuid;assert(buildUuid,'production_build_uuid_missing');
  for(let i=0;i<90;i+=1){const current=(await cf(`/builds/builds/${encodeURIComponent(buildUuid)}`)).result||{};if(current.status==='stopped'){assert.equal(current.build_outcome,'success',`production_build_outcome:${current.build_outcome}`);assert.equal(current.build_trigger_metadata?.branch,'main');assert.equal(current.build_trigger_metadata?.commit_hash,EXPECTED_MAIN_SHA);return{buildUuid,status:current.status,outcome:current.build_outcome,branch:current.build_trigger_metadata?.branch||null,commitHash:current.build_trigger_metadata?.commit_hash||null};}await sleep(5000);}throw new Error(`production_build_timeout:${buildUuid}`);
}
async function syncSnapshot(){const d=await activeDeployment(SYNC);const detail=await versionDetail(SYNC,d.versionId);const s=await schedules(SYNC);return{deploymentId:d.deploymentId,versionId:d.versionId,percentage:d.percentage,schedules:s,amazonAdsEnabled:bindingValue(detail,'AMAZON_ADS_ENABLED')};}
function assertWebSafety(detail){assert.equal(bindingValue(detail,'ACCESS_MODE'),'enforce','production_access_mode_not_enforce');assert.equal(bindingValue(detail,'SYNC_TRIGGER_ENABLED'),'false','production_sync_trigger_enabled');assert.equal(bindingValue(detail,'PHASE5_SINGLE_RUN_PERMIT_ID')??'','','production_phase5_permit_not_empty');assert.equal(bindingValue(detail,'PHASE5_SINGLE_RUN_REPORT_DATE')??'','','production_phase5_report_not_empty');}
function safetySummary(detail){return{accessMode:bindingValue(detail,'ACCESS_MODE'),syncTriggerEnabled:bindingValue(detail,'SYNC_TRIGGER_ENABLED'),phase5SingleRunPermitId:bindingValue(detail,'PHASE5_SINGLE_RUN_PERMIT_ID')??'',phase5SingleRunReportDate:bindingValue(detail,'PHASE5_SINGLE_RUN_REPORT_DATE')??''};}
async function restoreMutableMetadata(row){await storeDb.prepare('UPDATE advisory_review_records SET state=?1, reviewer_user_id=?2, reviewer_note=?3, reviewed_at=?4, snoozed_until=?5, updated_at=?6 WHERE review_id=?7 AND recommendation_fingerprint=?8').bind(row.state,row.reviewer_user_id,row.reviewer_note,row.reviewed_at,row.snoozed_until,row.updated_at,row.review_id,row.recommendation_fingerprint).run();}
async function createIdentity(){const host=new URL(BASE_URL).hostname.toLowerCase();const apps=await cf('/access/apps');const app=(apps.result||[]).find(row=>String(row?.domain||'').toLowerCase()===host);assert(app?.id,'production_access_app_not_found');const token=(await cf('/access/service_tokens',{method:'POST',body:{name:`issue-276-prod-${RUN_ID}`,duration:'2h',enabled:true}})).result;assert(token?.id&&token?.client_id&&token?.client_secret,'production_service_token_incomplete');const policy=(await cf(`/access/apps/${encodeURIComponent(app.id)}/policies`,{method:'POST',body:{name:`Issue 276 Production ${RUN_ID}`,decision:'non_identity',include:[{service_token:{token_id:token.id}}]}})).result;assert(policy?.id&&policy?.decision==='non_identity','production_non_identity_policy_invalid');const principalUserId=`svc-276-prod-${RUN_ID}`;const roleKey=`hr276_prod_${RUN_ID}`;const email=`svc-276-prod-${RUN_ID}@machine.invalid`;const store=await controlDb.prepare("SELECT store_id FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1").first();assert(store?.store_id,'production_store01_identity_registry_missing');await controlDb.prepare("INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)").bind(roleKey,`Issue 276 Production ${RUN_ID}`).run();await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')").bind(roleKey).run();await controlDb.prepare("INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'ads.write')").bind(roleKey).run();await controlDb.prepare("INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at) VALUES(?1,?2,?3,lower(?3),'Issue 276 Production Acceptance','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(principalUserId,token.client_id,email).run();await controlDb.prepare('INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)').bind(store.store_id,principalUserId,roleKey).run();const perms=await controlDb.prepare('SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key').bind(roleKey).all();assert.deepEqual((perms.results||[]).map(r=>r.permission_key),['ads.write','analytics.read']);return{app,token,policy,principalUserId,roleKey,headers:{'CF-Access-Client-Id':token.client_id,'CF-Access-Client-Secret':token.client_secret,accept:'application/json'},public:{accessAppId:app.id,serviceTokenId:token.id,policyId:policy.id,policyDecision:policy.decision,principalUserId,roleKey,storeId:store.store_id,permissions:['ads.write','analytics.read']}};}
async function cleanupIdentity(a){const out={};try{await controlDb.prepare('DELETE FROM store_members WHERE user_id=?1').bind(a.principalUserId).run();out.membershipDeleted=true;}catch(e){out.membershipDeleteError=scrub(e.message);}try{await controlDb.prepare('DELETE FROM role_permissions WHERE role_key=?1').bind(a.roleKey).run();out.permissionsDeleted=true;}catch(e){out.permissionsDeleteError=scrub(e.message);}try{await controlDb.prepare('DELETE FROM app_roles WHERE role_key=?1 AND is_system=0').bind(a.roleKey).run();out.roleDeleted=true;}catch(e){out.roleDeleteError=scrub(e.message);}try{await controlDb.prepare('DELETE FROM users WHERE user_id=?1').bind(a.principalUserId).run();out.principalDeleted=true;}catch(e){out.principalDeleteError=scrub(e.message);}try{await cf(`/access/apps/${encodeURIComponent(a.app.id)}/policies/${encodeURIComponent(a.policy.id)}`,{method:'DELETE'});out.policyDeleted=true;}catch(e){out.policyDeleteError=scrub(e.message);}try{await cf(`/access/service_tokens/${encodeURIComponent(a.token.id)}`,{method:'DELETE'});out.serviceTokenDeleted=true;}catch(e){out.serviceTokenDeleteError=scrub(e.message);}const refs={memberships:Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM store_members WHERE user_id=?1').bind(a.principalUserId).first())?.n||0),roles:Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM app_roles WHERE role_key=?1').bind(a.roleKey).first())?.n||0),permissions:Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM role_permissions WHERE role_key=?1').bind(a.roleKey).first())?.n||0),principals:Number((await controlDb.prepare('SELECT COUNT(*) AS n FROM users WHERE user_id=?1').bind(a.principalUserId).first())?.n||0)};const policies=await cf(`/access/apps/${encodeURIComponent(a.app.id)}/policies`);refs.policies=(policies.result||[]).filter(r=>r?.id===a.policy.id).length;const tokens=await cf('/access/service_tokens');refs.serviceTokens=(tokens.result||[]).filter(r=>r?.id===a.token.id).length;out.refs=refs;out.refsZero=Object.values(refs).every(v=>v===0);return out;}
async function postReview(url,headers,body){return appJson(url,{method:'POST',headers:{...headers,'content-type':'application/json'},body});}
async function retryJson(url,options){let last;for(let i=0;i<20;i+=1){last=await appJson(url,options);if(last.status===200)return last;if(![302,401,403].includes(last.status))return last;await sleep(2000);}return last;}
function makeReviewUrl(storeId){const p=new URLSearchParams({reviewContract:REVIEW_CONTRACT,...SCOPE});return `${BASE_URL}/api/v1/stores/${encodeURIComponent(storeId)}/advisory-reviews?${p}`;}
async function appJson(url,{method='GET',headers={},body=null}={}){blockAmazon(url,method);const r=await fetch(url,{method,headers,body:body===null?undefined:JSON.stringify(body),redirect:'manual',cache:'no-store'});const t=await r.text();let b;try{b=JSON.parse(t);}catch{b={nonJson:t.slice(0,500)}}return{status:r.status,body:b};}
async function appText(url,headers={}){blockAmazon(url,'GET');const r=await fetch(url,{headers,redirect:'manual',cache:'no-store'});return{status:r.status,body:await r.text()};}
function blockAmazon(url,method){const h=new URL(url).hostname.toLowerCase();if(/(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(h)){receipt.amazonRequests.push({method,url});throw new Error(`amazon_request_blocked:${url}`);}}
function findReview(body,id){return(body?.items||[]).find(item=>item?.inboxItemId===id)||null;}
async function countTable(table){const row=await storeDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();return Number(row?.count??0);}
async function activeDeployment(worker){const result=(await cf(`/workers/scripts/${encodeURIComponent(worker)}/deployments`)).result||{};const d=result?.deployments?.[0]||(Array.isArray(result)?result[0]:null);assert(d?.id,`${worker}_active_deployment_missing`);const v=(d.versions||[]).find(r=>Number(r?.percentage)===100)||d.versions?.[0];assert(v?.version_id,`${worker}_active_version_missing`);return{deploymentId:d.id,versionId:v.version_id,percentage:Number(v.percentage),createdOn:d.created_on||null,source:d.source||null};}
async function waitForNewActiveVersion(worker,oldVersion){for(let i=0;i<90;i+=1){const d=await activeDeployment(worker);if(d.versionId!==oldVersion&&d.percentage===100)return d;await sleep(3000);}throw new Error(`${worker}_new_active_version_not_observed`);}
async function versionDetail(worker,id){return(await cf(`/workers/scripts/${encodeURIComponent(worker)}/versions/${encodeURIComponent(id)}`)).result||{};}
async function schedules(worker){const p=await cf(`/workers/scripts/${encodeURIComponent(worker)}/schedules`);const r=p.result?.schedules??p.result??[];return Array.isArray(r)?r:[];}
function bindingValue(v,name){const f=findBinding(v,name);return f?(f.text??f.value??null):null;}
function findBinding(v,name){if(!v||typeof v!=='object')return null;if(Array.isArray(v)){for(const x of v){if(x&&typeof x==='object'&&x.name===name)return x;const n=findBinding(x,name);if(n)return n;}return null;}for(const x of Object.values(v)){const n=findBinding(x,name);if(n)return n;}return null;}
async function cf(path,{method='GET',body=null}={}){const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`,{method,headers:{authorization:`Bearer ${API_TOKEN}`,accept:'application/json',...(body!==null?{'content-type':'application/json'}:{})},body:body===null?undefined:JSON.stringify(body)});const p=await r.json().catch(()=>({}));if(!r.ok||p?.success===false)throw new Error(`cloudflare_api_failed:${path}:${p?.errors?.[0]?.code||r.status}:${scrub(p?.errors?.[0]?.message||'')}`);return p;}
function required(n){const v=String(process.env[n]||'').trim();if(!v)throw new Error(`${n}_required`);return v;}
function scrub(v){return String(v||'').split(API_TOKEN).join('[REDACTED_API_TOKEN]').replace(/[\r\n\t]+/g,' ').trim();}
function redact(v){return JSON.parse(JSON.stringify(v,(k,x)=>/secret|apiToken|clientSecret/i.test(k)?'[REDACTED]':x));}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
