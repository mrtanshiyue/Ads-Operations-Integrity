import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECOMMENDATION_QUALITY_POLICY_SCHEMA_VERSION,
  RECOMMENDATION_SUPPRESSION_PRECEDENCE,
  applyRecommendationQualityPolicy,
} from '../cloudflare/runtime/recommendation-quality-policy.js';
import { evaluateSearchTermDecision } from '../cloudflare/runtime/decision-intelligence.js';
import { recordGovernanceObservabilityEvent } from '../cloudflare/runtime/governance-observability.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const searchTermApiSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/search-term-intelligence-api.js'), 'utf8');

assert.equal(RECOMMENDATION_QUALITY_POLICY_SCHEMA_VERSION, 'recommendation-quality-governance-v1');
assert.deepEqual(RECOMMENDATION_SUPPRESSION_PRECEDENCE, [
  'profile_store_integrity',
  'source_data_quality',
  'existing_entity_collision',
  'semantic_recommendation_collision',
  'exact_fingerprint_duplicate',
  'open_governance_collision',
  'semantic_governance_collision',
  'analysis_window_cooldown',
  'recommendation_candidate',
]);

for (const token of [
  'negative_keywords nk',
  'nk.profile_id=st.profile_id',
  'nk.campaign_id=st.campaign_id',
  '(nk.ad_group_id IS NULL OR nk.ad_group_id=st.ad_group_id)',
  'nk.normalized_keyword=st.normalized_search_term',
  'keywords hk',
  'hk.profile_id=st.profile_id',
  'hk.normalized_keyword=st.normalized_search_term',
  'existing_negative_collision',
  'existing_keyword_collision',
]) {
  assert.match(searchTermApiSource, new RegExp(escapeRegExp(token)));
}

const range = { startDate: '2026-08-10', endDate: '2026-08-17', days: 8 };
const basePayload = {
  storeId: 'store-dev-01',
  profile: { profileId: 'profile-synth-dev-01' },
  range,
  items: [],
};

function candidate({
  entityId = 'st-1',
  normalizedSearchTerm = 'reading glasses',
  actionType = 'negative_keyword.create',
  fingerprint = 'a'.repeat(64),
} = {}) {
  return {
    entity: { entityId, normalizedSearchTerm, searchTerm: normalizedSearchTerm },
    recommendation: {
      entityId,
      actionType,
      proposed: { keywordText: normalizedSearchTerm, matchType: 'EXACT' },
      executionAuthorized: false,
    },
    fingerprint,
    authority: { authoritative: false, amazonMutationAuthorized: false },
    observation: { code: 'candidate_ready' },
    suppression: null,
  };
}

function history({
  actionId = 'act-1',
  profileId = 'profile-synth-dev-01',
  entityId = 'st-1',
  actionType = 'negative_keyword.create',
  status = 'proposed',
  fingerprint = 'a'.repeat(64),
  keywordText = 'reading glasses',
  createdAt = '2026-08-16 00:00:00',
  updatedAt = '2026-08-16 00:00:00',
  appliedAt = null,
} = {}) {
  return {
    actionId,
    profileId,
    entityId,
    actionType,
    status,
    recommendationFingerprint: fingerprint,
    proposed: { keywordText, matchType: 'EXACT' },
    createdAt,
    updatedAt,
    appliedAt,
  };
}

function run(items, rows = [], payloadPatch = {}) {
  return applyRecommendationQualityPolicy({
    payload: { ...basePayload, ...payloadPatch, items },
    history: rows,
    storeId: 'store-dev-01',
  });
}

const semanticPair = run([
  candidate({ entityId: 'st-neg', fingerprint: '1'.repeat(64), actionType: 'negative_keyword.create' }),
  candidate({ entityId: 'st-key', fingerprint: '2'.repeat(64), actionType: 'keyword.create' }),
]);
assert.equal(semanticPair.items[0].suppression.code, 'semantic_recommendation_conflict');
assert.equal(semanticPair.items[1].suppression.code, 'semantic_recommendation_conflict');
assert.equal(semanticPair.counts.semanticConflictCount, 2);
assert.equal(semanticPair.items[0].recommendation, null);

const duplicate = run([candidate()], [history()]);
assert.equal(duplicate.items[0].suppression.code, 'duplicate_recommendation');
assert.equal(duplicate.counts.duplicateSuppressionCount, 1);

const proposed = run(
  [candidate({ fingerprint: 'b'.repeat(64) })],
  [history({ fingerprint: 'c'.repeat(64), status: 'proposed' })],
);
assert.equal(proposed.items[0].suppression.code, 'proposed_action_conflict');
assert.equal(proposed.counts.proposedActionConflictCount, 1);

const approved = run(
  [candidate({ fingerprint: 'd'.repeat(64) })],
  [history({ fingerprint: 'e'.repeat(64), status: 'approved', appliedAt: null })],
);
assert.equal(approved.items[0].suppression.code, 'approved_not_executed');
assert.equal(approved.counts.approvedNotExecutedCount, 1);
assert.equal(approved.items[0].suppression.amazonMutationAuthorized, false);
assert.equal(approved.contract.approvedMeansExecuted, false);
assert.equal(approved.contract.amazonMutationAuthorized, false);

const semanticGovernance = run(
  [candidate({ entityId: 'st-new', fingerprint: 'f'.repeat(64), actionType: 'keyword.create' })],
  [history({
    entityId: 'st-old',
    fingerprint: '0'.repeat(64),
    actionType: 'negative_keyword.create',
    status: 'approved',
    appliedAt: null,
  })],
);
assert.equal(semanticGovernance.items[0].suppression.code, 'semantic_governance_conflict');
assert.equal(semanticGovernance.counts.semanticConflictCount, 1);

const rejected = run(
  [candidate({ fingerprint: '3'.repeat(64) })],
  [history({ fingerprint: '4'.repeat(64), status: 'rejected', updatedAt: '2026-08-16 12:00:00' })],
);
assert.equal(rejected.items[0].suppression.code, 'recent_rejection_cooldown');
assert.equal(rejected.counts.recentRejectionCooldownCount, 1);
assert.deepEqual(rejected.items[0].suppression.cooldownWindow, {
  startDate: '2026-08-10',
  endDate: '2026-08-17',
});
assert.equal(rejected.contract.cooldown.basis, 'current_recommendation_analysis_window');
assert.equal(rejected.contract.cooldown.arbitraryDayCount, false);

const terminalRepeat = run(
  [candidate({ fingerprint: '5'.repeat(64) })],
  [history({ fingerprint: '6'.repeat(64), status: 'failed', updatedAt: '2026-08-15 04:00:00' })],
);
assert.equal(terminalRepeat.items[0].suppression.code, 'repeated_suggestion_cooldown');
assert.equal(terminalRepeat.counts.repeatedSuggestionCooldownCount, 1);

const outsideWindow = run(
  [candidate({ fingerprint: '7'.repeat(64) })],
  [history({ fingerprint: '8'.repeat(64), status: 'rejected', updatedAt: '2026-08-01 00:00:00' })],
);
assert.equal(outsideWindow.items[0].suppression, null);
assert.ok(outsideWindow.items[0].recommendation);

const wrongStore = applyRecommendationQualityPolicy({
  payload: { ...basePayload, storeId: 'store-dev-02', items: [candidate()] },
  history: [],
  storeId: 'store-dev-01',
});
assert.equal(wrongStore.items[0].suppression.code, 'profile_store_integrity_mismatch');
assert.equal(wrongStore.counts.profileStoreIntegrityMismatchCount, 1);

const crossProfile = run(
  [candidate({ fingerprint: '9'.repeat(64) })],
  [history({ profileId: 'profile-other', fingerprint: '9'.repeat(64) })],
);
assert.equal(crossProfile.items[0].suppression, null);
assert.ok(crossProfile.items[0].recommendation);

const semanticBeforeDuplicate = run(
  [
    candidate({ entityId: 'st-a', actionType: 'negative_keyword.create', fingerprint: 'a1'.padEnd(64, '1') }),
    candidate({ entityId: 'st-b', actionType: 'keyword.create', fingerprint: 'b2'.padEnd(64, '2') }),
  ],
  [history({ entityId: 'st-a', fingerprint: 'a1'.padEnd(64, '1') })],
);
assert.equal(semanticBeforeDuplicate.items[0].suppression.code, 'semantic_recommendation_conflict');
assert.equal(semanticBeforeDuplicate.counts.duplicateSuppressionCount, 0);

const integrityBeforeEverything = applyRecommendationQualityPolicy({
  payload: {
    ...basePayload,
    storeId: 'store-dev-02',
    items: [
      candidate({ entityId: 'st-a', actionType: 'negative_keyword.create' }),
      candidate({ entityId: 'st-b', actionType: 'keyword.create', fingerprint: 'b'.repeat(64) }),
    ],
  },
  history: [history()],
  storeId: 'store-dev-01',
});
assert.equal(integrityBeforeEverything.items[0].suppression.code, 'profile_store_integrity_mismatch');
assert.equal(integrityBeforeEverything.items[1].suppression.code, 'profile_store_integrity_mismatch');

const validEvidence = {
  lineageValid: true,
  factRowCount: 1,
  invalidLineageCount: 0,
  sourceReportJobIds: ['job-quality'],
  amazonReportIds: ['report-quality'],
  r2ObjectKeys: ['amazon/store-01/quality.json'],
  contentSha256s: ['c'.repeat(64)],
};
const wasteMetrics = { impressions: 500, clicks: 12, purchases: 0, costMicros: 2_000_000, salesMicros: 0 };
const fresh = { state: 'fresh', latestReportDate: '2026-08-17', ageDays: 0, confidenceFactor: 1 };

const invalidLineage = evaluateSearchTermDecision({
  metrics: wasteMetrics,
  evidence: { ...validEvidence, lineageValid: false },
  freshness: fresh,
});
assert.equal(invalidLineage.suppression.code, 'invalid_lineage');

const stale = evaluateSearchTermDecision({
  metrics: wasteMetrics,
  evidence: validEvidence,
  freshness: { state: 'stale', ageDays: 10, confidenceFactor: 0.5 },
});
assert.equal(stale.suppression.code, 'stale_data');

const auditWrites = [];
const mockControlDb = {
  prepare(sql) {
    assert.match(sql, /INSERT INTO audit_log/);
    return {
      bind(...args) {
        return {
          async run() {
            auditWrites.push({ action: args[3], details: JSON.parse(args[7]) });
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  },
};
await recordGovernanceObservabilityEvent({
  env: { CONTROL_DB: mockControlDb },
  request: new Request('https://example.test/api/v1/stores/store-dev-01/search-term-intelligence', {
    headers: { 'cf-ray': 'ray-quality-policy' },
  }),
  actorUserId: 'user-dev-owner',
  storeId: 'store-dev-01',
  eventType: 'recommendation_quality_suppression',
  count: 3,
  entityId: 'profile-synth-dev-01',
  details: { cooldownBasis: 'current_recommendation_analysis_window' },
});
assert.equal(auditWrites.length, 1);
assert.equal(auditWrites[0].action, 'optimization_action.observability.recommendation_quality_suppression');
assert.equal(auditWrites[0].details.count, 3);
assert.equal(auditWrites[0].details.amazonMutationAttempted, false);
assert.equal(auditWrites[0].details.amazonMutationAuthorized, false);
assert.equal(auditWrites[0].details.cooldownBasis, 'current_recommendation_analysis_window');

console.log(JSON.stringify({
  pass: true,
  schemaVersion: RECOMMENDATION_QUALITY_POLICY_SCHEMA_VERSION,
  suppressionPrecedence: RECOMMENDATION_SUPPRESSION_PRECEDENCE,
  amazonMutationAuthorized: false,
}));

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
