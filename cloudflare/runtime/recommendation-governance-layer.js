import { bestEffortGovernanceObservability } from './governance-observability.js';
import { applyRecommendationQualityPolicy } from './recommendation-quality-policy.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const QUALITY_SUPPRESSION_CODES = new Set([
  'invalid_lineage',
  'stale_data',
  'insufficient_sample',
  'low_confidence',
  'trend_deterioration',
]);
const ENTITY_COLLISION_CODES = new Set(['existing_negative_collision', 'existing_keyword_collision']);
const QUALITY_GOVERNANCE_CODES = new Set([
  'profile_store_integrity_mismatch',
  'semantic_recommendation_conflict',
  'proposed_action_conflict',
  'approved_not_executed',
  'semantic_governance_conflict',
  'recent_rejection_cooldown',
  'repeated_suggestion_cooldown',
]);

export async function enrichRecommendationGovernanceResponse({ request, response, env, actor, url, ctx }) {
  if (!response || request.method !== 'GET' || !response.ok) return response;
  if (!url.pathname.includes('/search-term-intelligence')) return response;

  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/search-term-intelligence(?:\/recommendation-preview)?$/);
  if (!match) return response;
  const storeId = safeDecode(match[1]);
  if (!storeId || !env.CONTROL_DB) return response;

  const payload = await response.clone().json().catch(() => null);
  if (!payload || !Array.isArray(payload.items) || !payload.profile?.profileId) return response;

  try {
    const storeDb = await resolveStoreDb(env, storeId);
    if (!storeDb) return response;

    const actionHistory = await storeDb.prepare(`
      SELECT action_id, profile_id, entity_id, action_type, status, created_at, updated_at,
             applied_at, external_request_id, proposed_json,
             json_extract(rationale_json, '$.governance.recommendationFingerprint') AS recommendation_fingerprint
      FROM optimization_actions
      WHERE profile_id=?1
      ORDER BY created_at DESC
      LIMIT 1000
    `).bind(payload.profile.profileId).all();

    const policy = applyRecommendationQualityPolicy({
      payload: payload.storeId ? payload : { ...payload, storeId },
      history: (actionHistory.results || []).map(historyRecord),
      storeId,
    });
    const items = policy.items;
    const counts = policy.counts;

    const qualitySuppressedCount = items.filter((item) => QUALITY_SUPPRESSION_CODES.has(item?.suppression?.code)).length;
    const collisionSuppressedCount = items.filter((item) => ENTITY_COLLISION_CODES.has(item?.suppression?.code)).length;
    const governanceQualitySuppressionCount = items.filter((item) => QUALITY_GOVERNANCE_CODES.has(item?.suppression?.code)).length;
    const suppressedCount = items.filter((item) => item?.suppression).length;
    const recommendationCandidateCount = items.filter((item) => item?.recommendation).length;
    const authoritativeRecommendationCount = items.filter((item) => item?.recommendation && item?.authority?.authoritative).length;
    const observationCount = items.filter((item) => item?.observation && item.observation.code !== 'candidate_ready').length;

    payload.items = items;
    payload.summary = {
      ...(payload.summary || {}),
      recommendationCandidateCount,
      authoritativeRecommendationCount,
      suppressedCount,
      qualitySuppressedCount,
      collisionSuppressedCount,
      governanceQualitySuppressionCount,
      duplicateSuppressionCount: counts.duplicateSuppressionCount,
      alreadyGovernedSuppressionCount: counts.alreadyGovernedSuppressionCount,
      proposedActionConflictCount: counts.proposedActionConflictCount,
      approvedNotExecutedCount: counts.approvedNotExecutedCount,
      semanticConflictCount: counts.semanticConflictCount,
      recentRejectionCooldownCount: counts.recentRejectionCooldownCount,
      repeatedSuggestionCooldownCount: counts.repeatedSuggestionCooldownCount,
      profileStoreIntegrityMismatchCount: counts.profileStoreIntegrityMismatchCount,
      observationCount,
    };
    payload.governanceSuppressionContract = {
      schemaVersion: 'recommendation-governance-suppression-v3',
      exactFingerprintDuplicate: true,
      openEntityActionSuppression: true,
      semanticConflictSuppression: true,
      approvedNotExecutedSuppression: true,
      analysisWindowCooldown: true,
      profileStoreIntegrity: true,
      durableObservability: true,
      failureMode: 'fail_open_to_core_intelligence',
      qualityPolicy: policy.contract,
      amazonMutationAuthorized: false,
    };

    const writes = [];
    if (counts.duplicateSuppressionCount > 0) {
      writes.push(bestEffortGovernanceObservability({
        env,
        request,
        actorUserId: actor?.user_id || null,
        storeId,
        eventType: 'duplicate_suppression',
        count: counts.duplicateSuppressionCount,
        entityId: payload.profile.profileId,
        details: {
          profileId: payload.profile.profileId,
          suppressionCode: 'duplicate_recommendation',
          requestPath: url.pathname,
        },
      }));
    }
    if (counts.alreadyGovernedSuppressionCount > 0) {
      writes.push(bestEffortGovernanceObservability({
        env,
        request,
        actorUserId: actor?.user_id || null,
        storeId,
        eventType: 'already_governed_suppression',
        count: counts.alreadyGovernedSuppressionCount,
        entityId: payload.profile.profileId,
        details: {
          profileId: payload.profile.profileId,
          suppressionCode: 'already_governed_action',
          requestPath: url.pathname,
        },
      }));
    }
    if (governanceQualitySuppressionCount > 0) {
      writes.push(bestEffortGovernanceObservability({
        env,
        request,
        actorUserId: actor?.user_id || null,
        storeId,
        eventType: 'recommendation_quality_suppression',
        count: governanceQualitySuppressionCount,
        entityId: payload.profile.profileId,
        details: {
          profileId: payload.profile.profileId,
          requestPath: url.pathname,
          counts: {
            proposedActionConflictCount: counts.proposedActionConflictCount,
            approvedNotExecutedCount: counts.approvedNotExecutedCount,
            semanticConflictCount: counts.semanticConflictCount,
            recentRejectionCooldownCount: counts.recentRejectionCooldownCount,
            repeatedSuggestionCooldownCount: counts.repeatedSuggestionCooldownCount,
            profileStoreIntegrityMismatchCount: counts.profileStoreIntegrityMismatchCount,
          },
          suppressionPrecedence: policy.contract.suppressionPrecedence,
          cooldownBasis: policy.contract.cooldown.basis,
        },
      }));
    }
    if (writes.length) {
      const task = Promise.all(writes);
      if (ctx?.waitUntil) ctx.waitUntil(task);
      else await task;
    }

    return replaceJsonResponse(response, payload);
  } catch (error) {
    console.error('recommendation_governance_enrichment_error', {
      storeId,
      profileId: payload.profile?.profileId || null,
      message: error?.message || String(error),
    });
    const write = bestEffortGovernanceObservability({
      env,
      request,
      actorUserId: actor?.user_id || null,
      storeId,
      eventType: 'governance_error',
      entityId: payload.profile?.profileId || null,
      details: {
        profileId: payload.profile?.profileId || null,
        errorClass: 'recommendation_governance_enrichment_error',
        message: String(error?.message || error || '').slice(0, 500),
        requestPath: url.pathname,
      },
    });
    if (ctx?.waitUntil) ctx.waitUntil(write);
    else await write;
    return response;
  }
}

async function resolveStoreDb(env, storeId) {
  const store = await env.CONTROL_DB.prepare(`
    SELECT d1_binding_key
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
  if (!store || !STORE_BINDINGS.has(store.d1_binding_key)) return null;
  return env[store.d1_binding_key] || null;
}

function historyRecord(row) {
  return {
    actionId: row.action_id,
    profileId: row.profile_id,
    entityId: row.entity_id,
    actionType: row.action_type,
    status: row.status,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    appliedAt: row.applied_at || null,
    externalRequestId: row.external_request_id || null,
    proposedJson: row.proposed_json || null,
    recommendationFingerprint: row.recommendation_fingerprint || null,
  };
}

function replaceJsonResponse(response, payload) {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-aoi-recommendation-governance-layer', 'v3');
  headers.delete('content-length');
  return new Response(JSON.stringify(payload), { status: response.status, headers });
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}
