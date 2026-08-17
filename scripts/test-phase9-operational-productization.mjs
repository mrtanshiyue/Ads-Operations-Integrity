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
const mockControlDbForLayer = {
  prepare(sql) {
    assert.match(sql, /FROM stores/);
    return {
      bind() {
        return { async first() { return { d1_binding_key: 'STORE_01_DB' }; } };
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
const layered = await enrichRecommendationGovernanceResponse({
  request: new Request('https://example.test/api/v1/stores/store-dev-01/search-term-intelligence', { method: 'GET' }),
  response: new Response(JSON.stringify(intelligencePayload), { status: 200, headers: { 'content-type': 'application/json' } }),
  env: { CONTROL_DB: mockControlDbForLayer, STORE_01_DB: mockStoreDb },
  url: new URL('https://example.test/api/v1/stores/store-dev-01/search-term-intelligence'),
});
const layeredPayload = await layered.json();
assert.equal(layeredPayload.summary.recommendationCandidateCount, 0);
assert.equal(layeredPayload.summary.duplicateSuppressionCount, 1);
assert.equal(layeredPayload.items[0].recommendation, null);
assert.equal(layeredPayload.items[0].suppression.code, 'duplicate_recommendation');
assert.equal(layeredPayload.governanceSuppressionContract.amazonMutationAuthorized, false);

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
        { action: 'optimization_action.proposed', event_count: 4 },
        { action: 'optimization_action.approved', event_count: 2 },
      ] }; } }; } };
    }
    throw new Error(`unexpected control SQL: ${sql}`);
  },
};
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
    if (sql.includes('ORDER BY created_at DESC')) {
      return { async all() { return { results: [] }; } };
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
assert.equal(health.metrics.actionsAwaitingReview, 4);
assert.equal(health.metrics.approvalRate, 0.5);
assert.equal(health.metrics.rejectionRate, 0.5);
assert.equal(health.metrics.staleRecommendationRate, 0.1);
assert.equal(health.metrics.actionAging.proposedOlder72h, 1);
assert.equal(health.execution.amazonMutationAuthorized, false);
assert.equal(health.coverage.fingerprintConflictCount.durable, false);

const [webEntrySource, layerSource, healthSource, actionsSource] = await Promise.all([
  readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/recommendation-governance-layer.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/governance-health-api.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/optimization-actions-api.js'), 'utf8'),
]);
for (const token of ['GOVERNANCE_HEALTH_ROUTE_PATTERN', 'enrichRecommendationGovernanceResponse', 'handleGovernanceHealthApiRoute']) {
  assert.match(webEntrySource, new RegExp(token));
}
for (const token of ['duplicate_recommendation', 'already_governed_action', 'qualitySuppressedCount', 'amazonMutationAuthorized: false']) {
  assert.match(layerSource, new RegExp(token));
}
for (const token of ['approvalRate', 'rejectionRate', 'staleRecommendationRate', 'actionsAwaitingReview', 'actionAging', 'durable: false']) {
  assert.match(healthSource, new RegExp(token));
}
assert.match(actionsSource, /action_execution_disabled/);
assert.doesNotMatch(layerSource, /advertising-api\.amazon\.com/);
assert.doesNotMatch(healthSource, /advertising-api\.amazon\.com/);

console.log(JSON.stringify({
  ok: true,
  contract: 'phase9-operational-productization-v1',
  recommendationQualityGate: true,
  staleSuppression: true,
  lowConfidenceSuppression: true,
  minimumSampleAndSpend: true,
  highAcosObservationOnly: true,
  trendDeteriorationSuppression: true,
  duplicateGovernanceSuppression: true,
  governanceHealthReadPath: true,
  observabilityCoverageExplicit: true,
  amazonExecution: 'disabled',
}, null, 2));
