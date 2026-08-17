import assert from 'node:assert/strict';
import { handleOptimizationActionsApiRoute } from '../cloudflare/runtime/optimization-actions-api.js';

await import('./test-phase8-action-control-plane-core.mjs');

const storeRow = {
  row_key: 'row-freeze-01',
  profile_id: 'profile-freeze-01',
  campaign_id: 'campaign-freeze-01',
  ad_group_id: 'adgroup-freeze-01',
};

const controlDb = {
  prepare(sql) {
    if (sql.includes('user_global_roles')) {
      return { bind() { return { async first() { return { ok: 1 }; } }; } };
    }
    if (sql.includes('FROM stores')) {
      return { bind() { return { async first() { return { store_id: 'store-dev-01', d1_binding_key: 'STORE_01_DB', status: 'active' }; } }; } };
    }
    throw new Error(`unexpected control SQL: ${sql}`);
  },
};

const storeDb = {
  prepare(sql) {
    if (sql.includes('FROM amazon_profiles')) {
      return { bind() { return { async first() { return { profile_id: storeRow.profile_id }; } }; } };
    }
    if (sql.includes('FROM search_term_daily')) {
      return { bind() { return { async first() { return { ...storeRow }; } }; } };
    }
    if (sql.includes('FROM optimization_actions') && sql.includes('idempotency_key')) {
      return { bind() { return { async first() { return null; } }; } };
    }
    throw new Error(`unexpected store SQL: ${sql}`);
  },
};

const env = {
  CONTROL_DB: controlDb,
  STORE_01_DB: storeDb,
  APP_ENV: 'development',
  RECOMMENDATION_AUTHORITY_ENABLED: 'false',
};
const actor = { user_id: 'user-dev-owner' };
const endpoint = 'https://example.test/api/v1/stores/store-dev-01/optimization-actions?dryRun=true';

const baseBody = {
  dryRun: true,
  idempotencyKey: 'legacy-preview-fingerprint',
  fingerprint: 'f'.repeat(64),
  profileId: storeRow.profile_id,
  entityType: 'search_term',
  entityId: storeRow.row_key,
  actionType: 'negative_keyword.create',
  sourceType: 'rule',
  before: { negativeKeywordExists: false },
  proposed: { keywordText: 'free reading glasses', matchType: 'EXACT' },
  rationale: 'Freeze execution destination before governance approval.',
  analysisWindow: { startDate: '2026-08-10', endDate: '2026-08-17' },
  evidence: {
    lineageValid: true,
    factRowCount: 1,
    invalidLineageCount: 0,
    sourceReportJobIds: ['job-freeze-01'],
    amazonReportIds: ['amazon-freeze-01'],
    r2ObjectKeys: ['amazon/store-dev-01/freeze.json'],
    contentSha256s: ['a'.repeat(64)],
  },
  confidence: { score: 0.91, band: 'high' },
  scores: { waste: { score: 82 } },
  freshness: { state: 'fresh', latestReportDate: '2026-08-17', ageDays: 0, confidenceFactor: 1 },
};

const freezeResponse = await handleOptimizationActionsApiRoute({
  request: new Request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-ray': 'ray-freeze-01' },
    body: JSON.stringify(baseBody),
  }),
  env,
  actor,
  url: new URL(endpoint),
});
assert.equal(freezeResponse.status, 200);
const frozen = await freezeResponse.json();
assert.equal(frozen.dryRun, true);
assert.equal(frozen.valid, true);
assert.equal(frozen.normalized.proposed.scope, 'ad_group');
assert.equal(frozen.normalized.proposed.campaignId, storeRow.campaign_id);
assert.equal(frozen.normalized.proposed.adGroupId, storeRow.ad_group_id);
assert.equal(frozen.normalized.idempotencyKey, 'legacy-preview-fingerprint');
assert.notEqual(frozen.normalized.recommendationFingerprint, baseBody.fingerprint);
assert.match(frozen.normalized.requestFingerprint, /^[a-f0-9]{64}$/);
assert.equal(frozen.execution.amazonMutationAuthorized, false);

const mismatchResponse = await handleOptimizationActionsApiRoute({
  request: new Request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...baseBody,
      proposed: {
        ...baseBody.proposed,
        scope: 'ad_group',
        campaignId: 'spoofed-campaign',
        adGroupId: storeRow.ad_group_id,
      },
    }),
  }),
  env,
  actor,
  url: new URL(endpoint),
});
assert.equal(mismatchResponse.status, 409);
const mismatch = await mismatchResponse.json();
assert.equal(mismatch.error, 'execution_destination_mismatch');
assert.equal(mismatch.field, 'campaignId');
assert.equal(mismatch.amazonMutationAttempted, false);
assert.equal(mismatch.amazonMutationAuthorized, false);

console.log(JSON.stringify({
  ok: true,
  contract: 'optimization-action-execution-target-freeze-v1',
  targetSource: 'server-authoritative search_term_daily row',
  scope: 'ad_group',
  fingerprintIncludesFrozenDestination: true,
  stalePreviewFingerprintAcceptedOnlyAfterServerRecompute: true,
  spoofedDestinationRejected: true,
  amazonExecution: 'disabled',
}, null, 2));
