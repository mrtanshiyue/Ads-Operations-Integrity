import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEARCH_TERM_MODEL_VERSION,
  SEARCH_TERM_RULE_VERSION,
  buildRecommendationPreview,
  evaluateSearchTermDecision,
} from '../cloudflare/runtime/decision-intelligence.js';
import { enrichRecommendationGovernanceResponse } from '../cloudflare/runtime/recommendation-governance-layer.js';
import { handleGovernanceHealthApiRoute } from '../cloudflare/runtime/governance-health-api.js';
import { observeOptimizationActionResponse } from '../cloudflare/runtime/governance-observability.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const validEvidence = {
  lineageValid: true,
  factRowCount: 2,
  invalidLineageCount: 0,
  sourceReportJobIds: ['job-phase9'],
  amazonReportIds: ['amazon-report-phase9'],
  r2ObjectKeys: ['amazon/store-01/search-term-phase9.json'],
  contentSha256s: ['b'.repeat(64)],
};
const wasteMetrics = {
  impressions: 500,
  clicks: 12,
  purchases: 0,
  costMicros: 2_000_000,
  salesMicros: 0,
};
const fresh = { state: 'fresh', latestReportDate: '2026-08-17', ageDays: 0, confidenceFactor: 1 };

assert.equal(SEARCH_TERM_MODEL_VERSION, 'search-term-preview-model-v3');
assert.equal(SEARCH_TERM_RULE_VERSION, 'search-term-rules-v2');

const ready = evaluateSearchTermDecision({ metrics: wasteMetrics, evidence: validEvidence, freshness: fresh });
assert.equal(ready.recommendation?.actionType, 'negative_keyword.create');
assert.equal(ready.quality.eligibleForGovernance, true);
assert.equal(ready.suppression, null);
assert.equal(ready.observation.code, 'candidate_ready');

const stale = evaluateSearchTermDecision({
  metrics: wasteMetrics,
  evidence: validEvidence,
  freshness: { state: 'stale', ageDays: 12, confidenceFactor: 0.5 },
});
assert.equal(stale.recommendation, null);
assert.equal(stale.suppression?.code, 'stale_data');
assert.equal(stale.quality.eligibleForGovernance, false);

const lowConfidence = evaluateSearchTermDecision({
  metrics: { impressions: 50, clicks: 8, purchases: 0, costMicros: 1_000_000, salesMicros: 0 },
  evidence: validEvidence,
  freshness: fresh,
});
assert.equal(lowConfidence.recommendation, null);
assert.equal(lowConfidence.suppression?.code, 'low_confidence');

const insufficientSample = evaluateSearchTermDecision({
  metrics: { impressions: 10, clicks: 3, purchases: 2, costMicros: 500_000, salesMicros: 5_000_000 },
  evidence: validEvidence,
  freshness: fresh,
});
assert.equal(insufficientSample.recommendation, null);
assert.equal(insufficientSample.suppression?.code, 'insufficient_sample');

const invalidLineage = evaluateSearchTermDecision({
  metrics: wasteMetrics,
  evidence: { ...validEvidence, lineageValid: false },
  freshness: fresh,
});
assert.equal(invalidLineage.recommendation, null);
assert.equal(invalidLineage.suppression?.code, 'invalid_lineage');

const deterioratingHarvest = evaluateSearchTermDecision({
  metrics: { impressions: 800, clicks: 20, purchases: 4, costMicros: 3_000_000, salesMicros: 15_000_000 },
  evidence: validEvidence,
  freshness: fresh,
  trend: { delta: { ordersPct: -0.6, acosPp: 15, cvrPp: -3 } },
});
assert.equal(deterioratingHarvest.recommendation, null);
assert.equal(deterioratingHarvest.suppression?.code, 'trend_deterioration');
assert.equal(deterioratingHarvest.quality.trendSignal, 'deteriorating');

const highAcosObservation = evaluateSearchTermDecision({
  metrics: { impressions: 800, clicks: 20, purchases: 2, costMicros: 10_000_000, salesMicros: 10_000_000 },
  evidence: validEvidence,
  freshness: fresh,
});
assert.equal(highAcosObservation.recommendation, null);
assert.equal(highAcosObservation.observation.code, 'high_acos_observe');

const preview = await buildRecommendationPreview({
  storeId: 'store-dev-01',
  profileId: 'profile-synth-dev-01',
  analysisWindow: { startDate: '2026-08-01', endDate: '2026-08-17' },
  entity: { entityId: 'search-term-row-phase9', searchTerm: 'reading glasses' },
  metrics: wasteMetrics,
  evidence: validEvidence,
  freshness: fresh,
  trend: { delta: { spendPct: 0.25, ordersPct: null, acosPp: null } },
  env: { APP_ENV: 'development', RECOMMENDATION_AUTHORITY_ENABLED: 'false' },
});
assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
assert.equal(preview.recommendation?.governancePersistenceAllowed, true);
assert.equal(preview.recommendation?.executionAuthorized, false);
assert.equal(preview.authority.amazonMutationAuthorized, false);
assert.equal(preview.decision.quality.eligibleForGovernance, true);

const auditWrites = [];
const mockControlDbForLayer = {
  prepare(sql) {
    if (sql.includes('FROM stores')) {
      return {
        bind() {
          return { async first() { return { d1_binding_key: 'STORE_01_DB' }; } };
        },
      };
    }
    if (sql.includes('INSERT INTO audit_log')) {
      return {
        bind(...args) {
          return {
            async run() {
              auditWrites.push({
                actor: args[1],
                storeId: args[2],
                action: args[3],
                entityId: args[4],
                requestId: args[5],
                details: JSON.parse(args[7]),
              });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    }
    throw new Error(`unexpected layer control SQL: ${sql}`);
  },
};
const mockStoreDb = {
  prepare(sql) {
    assert.match(sql, /optimization_actions/);
    return {
      bind() {
        return {
          async all() {
            return {
              results: [{
                action_id: 'act_existing',
                profile_id: 'profile-synth-dev-01',
                entity_id: preview.recommendation.entityId,
                action_type: preview.recommendation.actionType,
                status: 'proposed',
                created_at: '2026-08-17 00:00:00',
                recommendation_fingerprint: preview.fingerprint,
              }],
            };
          },
        };
      },
    };
  },
};
const intelligencePayload = {
  profile: { profileId: 'profile-synth-dev-01' },
  summary: { recommendationCandidateCount: 1, authoritativeRecommendationCount: 0 },
  items: [{
    entity: { entityId: preview.recommendation.entityId },
    recommendation: preview.recommendation,
    fingerprint: preview.fingerprint,
    authority: preview.authority,
    observation: preview.observation,
    suppression: null,
  }],
};
const intelligenceUrl = 'https://example.test/api/v1/stores/store-dev-01/search-term-intelligence';
const layered = await enrichRecommendationGovernanceResponse({
  request: new Request(intelligenceUrl, { method: 'GET', headers: { 'cf-ray': 'ray-phase9-duplicate' } }),
  response: new Response(JSON.stringify(intelligencePayload), { status: 200, headers: { 'content-type': 'application/json' } }),
  env: { CONTROL_DB: mockControlDbForLayer, STORE_01_DB: mockStoreDb },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(intelligenceUrl),
});
const layeredPayload = await layered.json();
assert.equal(layeredPayload.summary.recommendationCandidateCount, 0);
assert.equal(layeredPayload.summary.duplicateSuppressionCount, 1);
assert.equal(layeredPayload.items[0].recommendation, null);
assert.equal(layeredPayload.items[0].suppression.code, 'duplicate_recommendation');
assert.equal(layeredPayload.governanceSuppressionContract.durableObservability, true);
assert.equal(layeredPayload.governanceSuppressionContract.amazonMutationAuthorized, false);
assert.equal(layeredPayload.governanceSuppressionContract.failureMode, 'fail_open_to_core_intelligence');
assert.equal(auditWrites.at(-1).action, 'optimization_action.observability.duplicate_suppression');
assert.equal(auditWrites.at(-1).details.count, 1);
assert.equal(auditWrites.at(-1).actor, 'user-dev-owner');

const failOpenResponse = new Response(JSON.stringify(intelligencePayload), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-core-intelligence': 'preserved' },
});
const originalConsoleError = console.error;
console.error = () => {};
let failOpenLayered;
try {
  failOpenLayered = await enrichRecommendationGovernanceResponse({
    request: new Request(intelligenceUrl, { method: 'GET', headers: { 'cf-ray': 'ray-phase9-error' } }),
    response: failOpenResponse,
    env: {
      CONTROL_DB: mockControlDbForLayer,
      STORE_01_DB: {
        prepare() { throw new Error('simulated_optional_enrichment_failure'); },
      },
    },
    actor: { user_id: 'user-dev-owner' },
    url: new URL(intelligenceUrl),
  });
} finally {
  console.error = originalConsoleError;
}
assert.equal(failOpenLayered.status, 200);
assert.equal(failOpenLayered.headers.get('x-core-intelligence'), 'preserved');
assert.equal(failOpenLayered.headers.get('x-aoi-recommendation-governance-layer'), null);
assert.deepEqual(await failOpenLayered.json(), intelligencePayload);
assert.equal(auditWrites.at(-1).action, 'optimization_action.observability.governance_error');
assert.equal(auditWrites.at(-1).details.errorClass, 'recommendation_governance_enrichment_error');

const conflictUrl = 'https://example.test/api/v1/stores/store-dev-01/optimization-actions';
const conflictResponse = new Response(JSON.stringify({
  error: 'idempotency_conflict',
  storeId: 'store-dev-01',
  idempotencyKey: 'phase9-conflict',
  existingActionId: 'act_existing',
  existingStatus: 'proposed',
  requestFingerprint: 'new-fingerprint',
  existingRequestFingerprint: 'old-fingerprint',
  amazonMutationAttempted: false,
}), { status: 409, headers: { 'content-type': 'application/json' } });
const observedConflict = await observeOptimizationActionResponse({
  request: new Request(conflictUrl, { method: 'POST', headers: { 'cf-ray': 'ray-phase9-conflict' } }),
  response: conflictResponse,
  env: { CONTROL_DB: mockControlDbForLayer },
  actor: { user_id: 'user-dev-owner' },
  url: new URL(conflictUrl),
});
assert.equal(observedConflict, conflictResponse);
assert.equal(auditWrites.at(-1).action, 'optimization_action.observability.fingerprint_conflict');
assert.equal(auditWrites.at(-1).details.conflictType, 'idempotency_conflict');
assert.equal(auditWrites.at(-1).details.amazonMutationAttempted, false);

const mockControlDbForHealth = {
  prepare(sql) {
    if (sql.includes('user_global_roles')) {
      return { bind() { return { async first() { return { ok: 1 }; } }; } };
    }
    if (sql.includes('FROM stores')) {
      return { bind() { return { async first() { return { store_id: 'store-dev-01', d1_binding_key: 'STORE_01_DB', status: 'active' }; } }; } };
    }
    if (sql.includes('FROM audit_log')) {
      return { bind() { return { async all() { return { results: [
        { action: 'optimization_action.proposed', event_count: 4, observed_count: 4 },
        { action: 'optimization_action.approved', event_count: 2, observed_count: 2 },
        { action: 'optimization_action.observability.duplicate_suppression', event_count: 2, observed_count: 5 },
        { action: 'optimization_action.observability.already_governed_suppression', event_count: 1, observed_count: 3 },
        { action: 'optimization_action.observability.recommendation_quality_suppression', event_count: 1, observed_count: 4 },
        { action: 'optimization_action.observability.fingerprint_conflict', event_count: 2, observed_count: 2 },
        { action: 'optimization_action.observability.governance_error', event_count: 1, observed_count: 1 },
      ] }; } }; } };
    }
    throw new Error(`unexpected control SQL: ${sql}`);
  },
};
const healthRationale = JSON.stringify({
  recommendation: { reason: 'Synthetic governance rationale' },
  governance: {
    recommendationFingerprint: 'f'.repeat(64),
    analysisWindow: { startDate: '2026-08-10', endDate: '2026-08-17', days: 8 },
    evidence: {
      ...validEvidence,
      sourceFactIdentity: {
        sourceReportJobIds: validEvidence.sourceReportJobIds,
        amazonReportIds: validEvidence.amazonReportIds,
        r2ObjectKeys: validEvidence.r2ObjectKeys,
        contentSha256s: validEvidence.contentSha256s,
      },
    },
    confidence: { band: 'high', score: 0.91 },
    freshness: { state: 'fresh' },
    scores: { waste: { score: 82 }, harvest: { score: 10 } },
  },
});
const mockStoreDbForHealth = {
  prepare(sql) {
    if (sql.includes('COUNT(*) AS recommendation_count')) {
      return { async first() { return {
        recommendation_count: 10,
        proposed_count: 4,
        approved_count: 3,
        rejected_count: 3,
        failed_status_count: 0,
        proposed_older_24h: 2,
        proposed_older_72h: 1,
        oldest_proposed_at: '2026-08-14 00:00:00',
        fresh_count: 6,
        aging_count: 3,
        stale_count: 1,
        unknown_freshness_count: 0,
        high_confidence_count: 4,
        medium_confidence_count: 5,
        low_confidence_count: 1,
        high_risk_count: 2,
      }; } };
    }
    if (sql.includes('FROM optimization_actions oa')) {
      return { async all() { return { results: [{
        action_id: 'act_recent',
        profile_id: 'profile-synth-dev-01',
        entity_type: 'search_term',
        entity_id: 'search-term-row-phase9',
        action_type: 'negative_keyword.create',
        status: 'rejected',
        created_by: 'user-dev-owner',
        approved_by: null,
        rationale_json: healthRationale,
        created_at: '2026-08-17 00:00:00',
        updated_at: '2026-08-17 01:00:00',
        reviewer_id: 'user-reviewer',
        rejection_reason: 'Existing negative already covers this intent.',
        proposed_at: '2026-08-17 00:00:00',
        approved_at: null,
        rejected_at: '2026-08-17 01:00:00',
      }] }; } };
    }
    throw new Error(`unexpected store SQL: ${sql}`);
  },
};
const healthResponse = await handleGovernanceHealthApiRoute({
  request: new Request('https://example.test/api/v1/stores/store-dev-01/governance-health'),
  env: { CONTROL_DB: mockControlDbForHealth, STORE_01_DB: mockStoreDbForHealth },
  actor: { user_id: 'user-dev-owner' },
  url: new URL('https://example.test/api/v1/stores/store-dev-01/governance-health'),
});
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.schemaVersion, 'governance-health-v3');
assert.equal(health.metrics.actionsAwaitingReview, 4);
assert.equal(health.metrics.approvedCount, 3);
assert.equal(health.metrics.rejectedCount, 3);
assert.equal(health.metrics.approvalRate, 0.5);
assert.equal(health.metrics.rejectionRate, 0.5);
assert.equal(health.metrics.staleRecommendationRate, 0.1);
assert.equal(health.metrics.confidence.high, 4);
assert.equal(health.metrics.confidence.medium, 5);
assert.equal(health.metrics.confidence.low, 1);
assert.equal(health.metrics.actionAging.proposedOlder72h, 1);
assert.equal(health.metrics.actionAging.oldestProposedAt, '2026-08-14 00:00:00');
assert.equal(health.metrics.observability7d.duplicateSuppressions, 5);
assert.equal(health.metrics.observability7d.alreadyGovernedSuppressions, 3);
assert.equal(health.metrics.observability7d.recommendationQualitySuppressions, 4);
assert.equal(health.metrics.observability7d.fingerprintConflicts, 2);
assert.equal(health.metrics.observability7d.governanceErrors, 1);
assert.equal(health.recentActions[0].reviewer, 'user-reviewer');
assert.equal(health.recentActions[0].rejectionReason, 'Existing negative already covers this intent.');
assert.equal(health.recentActions[0].evidenceCompleteness.complete, true);
assert.equal(health.recentActions[0].evidenceCompleteness.checksPassed, 5);
assert.equal(health.recentActions[0].riskScore, 82);
assert.equal(health.recentActions[0].freshness, 'fresh');
assert.deepEqual(health.recentActions[0].lineage.sourceReportIdentity.amazonReportIds, ['amazon-report-phase9']);
assert.equal(health.recentActions[0].lifecycle.rejectedAt, '2026-08-17 01:00:00');
assert.equal(health.execution.amazonMutationAuthorized, false);
assert.equal(health.coverage.duplicateSuppressionCount.durable, true);
assert.equal(health.coverage.recommendationQualitySuppressionCount.durable, true);
assert.equal(health.coverage.recommendationQualitySuppressionCount.cooldownBasis, 'current_recommendation_analysis_window');
assert.equal(health.coverage.fingerprintConflictCount.durable, true);
assert.equal(health.coverage.governanceErrors.durable, true);

const [webEntrySource, layerSource, healthSource, observabilitySource, actionsSource] = await Promise.all([
  readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/recommendation-governance-layer.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/governance-health-api.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/governance-observability.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/optimization-actions-api.js'), 'utf8'),
]);
for (const token of ['GOVERNANCE_HEALTH_ROUTE_PATTERN', 'enrichRecommendationGovernanceResponse', 'observeOptimizationActionResponse', 'handleGovernanceHealthApiRoute']) {
  assert.match(webEntrySource, new RegExp(token));
}
for (const token of ['duplicate_recommendation', 'already_governed_action', 'recommendation_quality_suppression', 'durableObservability', 'fail_open_to_core_intelligence', 'amazonMutationAuthorized: false']) {
  assert.match(layerSource, new RegExp(token));
}
for (const token of ['governance-health-v3', 'observability7d', 'recommendationQualitySuppressions', 'evidenceCompleteness', 'rejectionReason', 'sourceReportIdentity', 'current_recommendation_analysis_window', 'durable: true']) {
  assert.match(healthSource, new RegExp(token));
}
for (const token of ['governance-observability-event-v1', 'fingerprint_conflict', 'governance_error', 'INSERT INTO audit_log', 'amazonMutationAuthorized: false']) {
  assert.match(observabilitySource, new RegExp(token));
}
assert.doesNotMatch(healthSource, /durable:\s*false/);
assert.match(actionsSource, /action_execution_disabled/);
for (const source of [layerSource, healthSource, observabilitySource]) {
  assert.doesNotMatch(source, /advertising-api\.amazon\.com/);
}

console.log(JSON.stringify({
  ok: true,
  contract: 'phase9-operational-productization-v3',
  recommendationQualityGate: true,
  staleSuppression: true,
  lowConfidenceSuppression: true,
  minimumSampleAndSpend: true,
  highAcosObservationOnly: true,
  trendDeteriorationSuppression: true,
  duplicateGovernanceSuppression: true,
  governanceEnrichmentFailureMode: 'fail-open',
  durableSuppressionTelemetry: true,
  durableRecommendationQualitySuppressionTelemetry: true,
  durableFingerprintConflictTelemetry: true,
  durableGovernanceErrorTelemetry: true,
  operatorContext: true,
  governanceHealthReadPath: true,
  governanceStatusCounts: true,
  confidenceDistribution: true,
  amazonExecution: 'disabled',
}, null, 2));