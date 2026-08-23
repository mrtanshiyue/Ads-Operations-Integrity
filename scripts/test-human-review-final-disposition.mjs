import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { authorizeReviewCandidateForPersistence, persistedStateToUiState } from '../cloudflare/runtime/csv-recommendation-human-review-api.js';
import { buildRecommendationReviewBinding } from '../cloudflare/runtime/csv-recommendation-human-review-contract.js';
import { summarizeDecisionQueueReviewState } from '../cloudflare/runtime/data-health-api.js';

const migration0019 = readFileSync(new URL('../cloudflare/foundation/migrations/store/0019_store_advisory_review_workflow.sql', import.meta.url), 'utf8');
const migration0025 = readFileSync(new URL('../cloudflare/foundation/migrations/store/0025_store_advisory_review_final_disposition.sql', import.meta.url), 'utf8');
const db = new DatabaseSync(':memory:');
db.exec(migration0019);
const insert = db.prepare(`INSERT INTO advisory_review_records(
 review_id,source_kind,recommendation_fingerprint,entity_type,entity_id,recommendation_family,recommendation_action_type,state,
 reviewer_user_id,reviewer_note,reviewed_at,snoozed_until,source_evidence_json,source_evidence_sha256,created_by,created_at,updated_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
function row(id,state,hex,snoozedUntil=null){
 insert.run(id,'csv_recommendation_inbox_v1',hex.repeat(64),'search_term',id,'waste_term','negative_keyword',state,
   'user',null,'2026-06-01T00:00:00.000Z',snoozedUntil,JSON.stringify({descriptor:{sourceKind:'csv_recommendation_inbox_v1',inboxItemId:id,candidateType:'waste_term',actionType:'negative_keyword',matchScope:'exact',value:id}}),
   hex.repeat(64),'user','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');
}
row('open','open','1'); row('ack','acknowledged','2'); row('dismissed','dismissed','3'); row('snoozed','snoozed','4','2026-07-01T00:00:00.000Z');
db.exec(migration0025);
assert.deepEqual(db.prepare('SELECT review_id,state FROM advisory_review_records ORDER BY review_id').all().map((row) => ({ ...row })), [
 {review_id:'ack',state:'acknowledged'}, {review_id:'dismissed',state:'dismissed'}, {review_id:'open',state:'open'}, {review_id:'snoozed',state:'snoozed'}
]);
row('approved','approved','5'); row('rejected','rejected','6');
assert.throws(() => row('bad-snooze','snoozed','7',null));
assert.throws(() => db.prepare("UPDATE advisory_review_records SET entity_id='changed' WHERE review_id='approved'").run(), /ADVISORY_REVIEW_BINDING_IMMUTABLE/);
assert.throws(() => db.prepare("DELETE FROM advisory_review_records WHERE review_id='approved'").run(), /ADVISORY_REVIEW_DELETE_FORBIDDEN/);
const schemaObjects = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger')").all().map((x)=>x.name));
for (const name of ['uq_advisory_review_source_recommendation','idx_advisory_review_state_updated','idx_advisory_review_entity','trg_advisory_review_binding_immutable','trg_advisory_review_no_delete']) assert.ok(schemaObjects.has(name), name);
assert.equal(persistedStateToUiState('dismissed'),'rejected');
assert.equal(persistedStateToUiState('snoozed'),null);

function candidate(clicks=44){ return authorizeReviewCandidateForPersistence({
 inboxItemId:'csv-inbox:negative_keyword:exact:bad term', itemClass:'recommendation_candidate', candidateType:'waste_term', actionType:'negative_keyword', matchScope:'exact', value:'bad term', priority:'high',
 evidenceSummary:{spendMicros:1,salesMicros:0,orders:0,clicks,acos:null,cvr:0,analysisWindow:{startDate:'2026-06-01',endDate:'2026-06-30'},sourceImportIds:['i1'],rootStates:['toxic'],recommendationGoverned:true,provenanceGate:'exact_source_object',identityConfidence:{state:'observed_only'}},
 review:{persistenceAuthorized:false}, authority:{governancePersistenceAllowed:false,executionAuthorized:false,amazonMutationAuthorized:false}
 }, {candidateEmissionAuthorized:true}); }
const current = candidate(44); const old = candidate(43);
const currentBinding = await buildRecommendationReviewBinding(current); const oldBinding = await buildRecommendationReviewBinding(old);
const evidence = JSON.parse(oldBinding.sourceEvidenceJson);
const storedOldApproved = {review_id:'old-approved',recommendation_fingerprint:oldBinding.recommendationFingerprint,state:'approved',source_evidence_json:JSON.stringify(evidence)};
const inbox = {items:[current],summary:{blockedByGovernanceCount:0,blockedByScopeCount:0}};
const staleSummary = await summarizeDecisionQueueReviewState({inbox,analysisScope:{complete:true,financiallyComparable:true,candidateEmissionAuthorized:true},storedReviews:[storedOldApproved]});
assert.equal(staleSummary.unreviewedCount,1);
assert.equal(staleSummary.approvedCount,0);
assert.equal(staleSummary.resolvedCount,0);
assert.equal(staleSummary.staleReviewEvidenceCount,1);
const storedCurrentApproved = {...storedOldApproved,review_id:'current-approved',recommendation_fingerprint:currentBinding.recommendationFingerprint,source_evidence_json:currentBinding.sourceEvidenceJson};
const exactSummary = await summarizeDecisionQueueReviewState({inbox,analysisScope:{complete:true,financiallyComparable:true,candidateEmissionAuthorized:true},storedReviews:[storedCurrentApproved]});
assert.equal(exactSummary.unreviewedCount,0);
assert.equal(exactSummary.approvedCount,1);
assert.equal(exactSummary.resolvedCount,1);
assert.equal(exactSummary.staleReviewEvidenceCount,0);

const packetSource = readFileSync(new URL('../cloudflare/runtime/recommendation-decision-packet.js', import.meta.url), 'utf8');
const librarySource = readFileSync(new URL('../cloudflare/runtime/governed-keyword-negative-candidate-library.js', import.meta.url), 'utf8');
assert.match(packetSource,/priorReviewState/);
assert.match(librarySource,/currentReviewState/);
for (const source of [packetSource,librarySource]) {
 assert.doesNotMatch(source,/optimizationActionApprovalAllowed:\s*true|executionAuthorized:\s*true|amazonMutationAuthorized:\s*true/);
}
console.log('human review final disposition: PASS');
