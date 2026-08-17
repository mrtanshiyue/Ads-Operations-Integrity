import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRecommendationPreview,
  evaluateSearchTermDecision,
} from '../cloudflare/runtime/decision-intelligence.js';
import {
  AMAZON_ACTION_EXECUTION_SAFETY_SCHEMA_VERSION,
  COMPENSATING_ACTION_POLICY,
  LOGICAL_MUTATION_ALLOWLIST,
  buildExecutionPlan,
  canMarkActionApplied,
  classifyMutationTransportOutcome,
  validatePermitBinding,
} from '../cloudflare/runtime/amazon-action-execution-safety.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [actionsSource, intelligenceApiSource, webEntrySource, uiSource, executionSafetySource] = await Promise.all([
  readFile(path.join(repoRoot, 'cloudflare/runtime/optimization-actions-api.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/search-term-intelligence-api.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8'),
  readFile(path.join(repoRoot, 'assets/cloudflare-native-decision-intelligence-v1.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/amazon-action-execution-safety.js'), 'utf8'),
]);

const evidence = {
  lineageValid: true,
  factRowCount: 1,
  invalidLineageCount: 0,
  sourceReportJobIds: ['job-phase8'],
  amazonReportIds: ['amazon-report-phase8'],
  r2ObjectKeys: ['amazon/store-01/search-term.json'],
  contentSha256s: ['a'.repeat(64)],
};
const metrics = {
  impressions: 1000,
  clicks: 20,
  purchases: 0,
  costMicros: 4_000_000,
  salesMicros: 0,
};

const freshDecision = evaluateSearchTermDecision({
  metrics,
  evidence,
  freshness: { state: 'fresh', confidenceFactor: 1 },
});
const staleDecision = evaluateSearchTermDecision({
  metrics,
  evidence,
  freshness: { state: 'stale', confidenceFactor: 0.5 },
});
assert.ok(freshDecision.confidence.score > staleDecision.confidence.score);
assert.equal(freshDecision.confidence.freshnessFactor, 1);
assert.equal(staleDecision.confidence.freshnessFactor, 0.5);

const preview = await buildRecommendationPreview({
  storeId: 'store-dev-01',
  profileId: 'profile-synth-dev-01',
  analysisWindow: { startDate: '2026-08-01', endDate: '2026-08-17' },
  entity: { entityId: 'search-term-row-01', searchTerm: 'reading glasses' },
  metrics,
  evidence,
  freshness: { state: 'aging', latestReportDate: '2026-08-12', ageDays: 5, confidenceFactor: 0.8 },
  trend: { delta: { spendPct: 0.22, ordersPct: -0.08, acosPp: 13 } },
  env: { APP_ENV: 'development', RECOMMENDATION_AUTHORITY_ENABLED: 'false' },
});
assert.equal(preview.recommendation.actionType, 'negative_keyword.create');
assert.equal(preview.recommendation.executionAuthorized, false);
assert.equal(preview.recommendation.governancePersistenceAllowed, true);
assert.equal(preview.authority.authoritative, false);
assert.equal(preview.authority.amazonMutationAuthorized, false);
assert.equal(preview.decision.freshness.state, 'aging');
assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);

for (const token of [
  'dryRun',
  'idempotency_conflict',
  'recommendation_fingerprint_mismatch',
  "status='proposed'",
  "status='rejected'",
  "status='approved'",
  'action.proposed',
  'action.rejected',
  'action.approved',
  'action_transition_conflict',
  'rejection_reason_required',
  'ads.write',
  'audit_log',
  'amazonMutationAttempted: false',
  'amazonMutationAuthorized: false',
  'action_execution_disabled',
]) {
  assert.match(actionsSource, new RegExp(escapeRegex(token)), `missing action control token: ${token}`);
}
assert.match(actionsSource, /WHERE action_id=\?1 AND status='proposed'/);
assert.match(actionsSource, /optimization_action_events/);
assert.match(actionsSource, /requestFingerprint/);
assert.match(actionsSource, /recommendationFingerprint/);
assert.doesNotMatch(actionsSource, /advertising-api\.amazon\.com/);
assert.doesNotMatch(actionsSource, /fetch\s*\(/);

for (const token of [
  'previousStartDate',
  'previousEndDate',
  'previousMetrics',
  'comparisonRange',
  'freshnessContract',
  "fresh: 'latest report date age <= 2 days'",
  'confidenceFactor',
  'latest_report_date',
  'fact_updated_at',
  'acosPp',
  'cvrPp',
]) {
  assert.match(intelligenceApiSource, new RegExp(escapeRegex(token)), `missing intelligence context token: ${token}`);
}
assert.doesNotMatch(intelligenceApiSource, /advertising-api\.amazon\.com/);

assert.match(webEntrySource, /reject\|approve\|apply\|revert/);
assert.match(webEntrySource, /handleOptimizationActionsApiRoute/);

for (const token of [
  'Evidence Drilldown',
  'Dry-run validation',
  'Persist proposed action',
  'Optimization Action Inbox',
  'Approve governance',
  'Rejection reason',
  'Execution Disabled',
  'Freshness',
  'Authority',
  'Comparable trend',
  'Source provenance',
  'Development preview / non-authoritative',
]) {
  assert.match(uiSource, new RegExp(escapeRegex(token)), `missing Phase 8 UI token: ${token}`);
}
assert.doesNotMatch(uiSource, /\/apply['"`]/);
assert.doesNotMatch(uiSource, /\/revert['"`]/);

const storeMigrationDir = path.join(repoRoot, 'cloudflare/foundation/migrations/store');
const storeMigrationNames = (await readdir(storeMigrationDir)).filter((name) => name.endsWith('.sql')).sort();
const storeMigrationSources = await Promise.all(storeMigrationNames.map((name) => readFile(path.join(storeMigrationDir, name), 'utf8')));
const combinedMigrations = storeMigrationSources.join('\n');
assert.match(combinedMigrations, /CREATE TABLE optimization_actions/);
assert.match(combinedMigrations, /CREATE TABLE optimization_action_events/);
assert.match(combinedMigrations, /CREATE TABLE optimization_execution_permits/);
assert.match(combinedMigrations, /CREATE TABLE optimization_execution_receipts/);
assert.match(combinedMigrations, /CREATE TABLE optimization_execution_verifications/);
assert.match(combinedMigrations, /idx_execution_permits_one_issued_per_action_transition/);
assert.match(combinedMigrations, /execution_permit_binding_immutable/);
assert.match(combinedMigrations, /execution_receipt_immutable/);
assert.match(combinedMigrations, /execution_verification_immutable/);
assert.doesNotMatch(combinedMigrations, /CREATE TABLE\s+(?:recommendations|recommendation_actions)\b/i);

assert.equal(AMAZON_ACTION_EXECUTION_SAFETY_SCHEMA_VERSION, 'amazon-action-execution-safety-v1');
assert.deepEqual(Object.keys(LOGICAL_MUTATION_ALLOWLIST).sort(), ['keyword.create', 'negative_keyword.create']);
assert.equal(LOGICAL_MUTATION_ALLOWLIST['negative_keyword.create'].endpointMappingVerified, false);
assert.equal(LOGICAL_MUTATION_ALLOWLIST['keyword.create'].endpointMappingVerified, false);
assert.equal(COMPENSATING_ACTION_POLICY.automaticRollbackAuthorized, false);

const requestFingerprint = '1'.repeat(64);
const targetReadyAction = {
  action_id: 'act_execution_ready_shape',
  profile_id: 'profile-real-01',
  entity_type: 'search_term',
  entity_id: 'row-real-01',
  action_type: 'negative_keyword.create',
  status: 'approved',
  proposed_json: JSON.stringify({
    scope: 'ad_group',
    campaignId: 'campaign-01',
    adGroupId: 'adgroup-01',
    keywordText: 'free reading glasses',
    matchType: 'EXACT',
  }),
  rationale_json: JSON.stringify({ governance: { requestFingerprint } }),
  external_request_id: null,
  applied_at: null,
};
const targetReadyPlan = await buildExecutionPlan({ storeId: 'store-01', action: targetReadyAction });
assert.equal(targetReadyPlan.valid, true);
assert.equal(targetReadyPlan.dryRunReady, true);
assert.equal(targetReadyPlan.permitIssuanceReady, false);
assert.equal(targetReadyPlan.networkDispatchAuthorized, false);
assert.equal(targetReadyPlan.mutation.endpointMappingVerified, false);
assert.match(targetReadyPlan.targetFingerprint, /^[a-f0-9]{64}$/);
assert.match(targetReadyPlan.executionFingerprint, /^[a-f0-9]{64}$/);

const legacyMissingScopePlan = await buildExecutionPlan({
  storeId: 'store-01',
  action: {
    ...targetReadyAction,
    action_id: 'act_legacy_missing_scope',
    proposed_json: JSON.stringify({ keywordText: 'free reading glasses', matchType: 'EXACT' }),
  },
});
assert.equal(legacyMissingScopePlan.valid, false);
assert.ok(legacyMissingScopePlan.errors.includes('destination_scope_not_frozen'));

const unapprovedPlan = await buildExecutionPlan({ storeId: 'store-01', action: { ...targetReadyAction, status: 'proposed' } });
assert.equal(unapprovedPlan.valid, false);
assert.ok(unapprovedPlan.errors.includes('approved_action_required'));

const permitCheck = validatePermitBinding({
  permit: {
    state: 'issued',
    transition: 'apply',
    actionId: targetReadyPlan.action.actionId,
    profileId: targetReadyPlan.action.profileId,
    entityId: targetReadyPlan.action.entityId,
    actionType: targetReadyPlan.action.actionType,
    requestFingerprint: targetReadyPlan.requestFingerprint,
    targetFingerprint: targetReadyPlan.targetFingerprint,
    executionFingerprint: targetReadyPlan.executionFingerprint,
    expiresAt: '2026-08-17T17:00:00Z',
  },
  plan: targetReadyPlan,
  now: new Date('2026-08-17T16:00:00Z'),
});
assert.equal(permitCheck.valid, false);
assert.ok(permitCheck.errors.includes('amazon_endpoint_mapping_unverified'));
assert.equal(permitCheck.networkDispatchAuthorized, false);

assert.deepEqual(classifyMutationTransportOutcome({ dispatched: false }), {
  transportOutcome: 'unknown',
  retryDisposition: 'retry_before_dispatch',
  readbackRequired: false,
  reason: 'request_not_dispatched',
});
const acceptedTransport = classifyMutationTransportOutcome({ dispatched: true, httpStatus: 202, amazonRequestId: 'req-01' });
assert.equal(acceptedTransport.retryDisposition, 'readback_required');
assert.equal(acceptedTransport.readbackRequired, true);
const unknownTransport = classifyMutationTransportOutcome({ dispatched: true, networkError: new Error('socket closed') });
assert.equal(unknownTransport.retryDisposition, 'readback_required');
assert.equal(unknownTransport.reason, 'dispatched_outcome_unknown');

const finalization = canMarkActionApplied({
  plan: targetReadyPlan,
  receipt: { transportOutcome: 'accepted', executionFingerprint: targetReadyPlan.executionFingerprint },
  verification: {
    result: 'confirmed',
    expectedFingerprint: targetReadyPlan.executionFingerprint,
    observedFingerprint: targetReadyPlan.executionFingerprint,
  },
});
assert.equal(finalization.allowed, true);
assert.equal(finalization.readbackConfirmed, true);
assert.equal(finalization.fingerprintsMatch, true);
assert.equal(finalization.networkDispatchAuthorized, false);

for (const token of [
  'networkDispatchAuthorized: false',
  'no_blind_retry_after_dispatch',
  'amazon_readback_confirmation_required',
  'destination_scope_not_frozen',
  'amazon_endpoint_mapping_unverified',
  'create_separately_governed_compensating_action',
]) {
  assert.match(executionSafetySource, new RegExp(escapeRegex(token)), `missing execution safety token: ${token}`);
}
assert.doesNotMatch(executionSafetySource, /fetch\s*\(/);
assert.doesNotMatch(executionSafetySource, /advertising-api\.amazon\.com/);

console.log(JSON.stringify({
  ok: true,
  contract: 'operational-recommendation-and-execution-safety-v2',
  proposedPersistence: true,
  deterministicIdempotency: true,
  rejectLifecycle: true,
  approvalGovernance: true,
  conditionalMutation: true,
  evidenceDrilldown: true,
  comparableTrend: true,
  freshnessAwareConfidence: true,
  executionPermitSchema: true,
  immutableExecutionReceiptSchema: true,
  readbackVerificationSchema: true,
  singleUsePermitContract: true,
  legacyMissingTargetFailsClosed: true,
  endpointMapping: 'unverified-and-blocking',
  unknownOutcomeRetry: 'readback-required-no-blind-retry',
  amazonExecution: 'disabled',
  productionMutation: false,
}, null, 2));

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
