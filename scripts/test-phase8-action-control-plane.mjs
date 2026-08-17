import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRecommendationPreview,
  evaluateSearchTermDecision,
} from '../cloudflare/runtime/decision-intelligence.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [actionsSource, intelligenceApiSource, webEntrySource, uiSource] = await Promise.all([
  readFile(path.join(repoRoot, 'cloudflare/runtime/optimization-actions-api.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/search-term-intelligence-api.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8'),
  readFile(path.join(repoRoot, 'assets/cloudflare-native-decision-intelligence-v1.js'), 'utf8'),
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
assert.doesNotMatch(combinedMigrations, /CREATE TABLE\s+(?:recommendations|recommendation_actions)\b/i);

console.log(JSON.stringify({
  ok: true,
  contract: 'phase8-operational-recommendation-control-plane-v1',
  proposedPersistence: true,
  deterministicIdempotency: true,
  rejectLifecycle: true,
  approvalGovernance: true,
  conditionalMutation: true,
  evidenceDrilldown: true,
  comparableTrend: true,
  freshnessAwareConfidence: true,
  amazonExecution: 'disabled',
  productionMutation: false,
}, null, 2));

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
