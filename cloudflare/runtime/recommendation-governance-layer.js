const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const OPEN_GOVERNANCE_STATUSES = new Set(['proposed', 'approved', 'applying', 'applied']);
const QUALITY_SUPPRESSION_CODES = new Set([
  'invalid_lineage',
  'stale_data',
  'insufficient_sample',
  'low_confidence',
  'trend_deterioration',
]);

export async function enrichRecommendationGovernanceResponse({ request, response, env, url }) {
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

    const openActions = await storeDb.prepare(`
      SELECT action_id, profile_id, entity_id, action_type, status, created_at,
             json_extract(rationale_json, '$.governance.recommendationFingerprint') AS recommendation_fingerprint
      FROM optimization_actions
      WHERE profile_id=?1
        AND status IN ('proposed','approved','applying','applied')
      ORDER BY created_at DESC
      LIMIT 500
    `).bind(payload.profile.profileId).all();

    const byFingerprint = new Map();
    const byEntityAction = new Map();
    for (const row of openActions.results || []) {
      if (!OPEN_GOVERNANCE_STATUSES.has(String(row.status || ''))) continue;
      const record = publicGovernanceRecord(row);
      if (record.recommendationFingerprint && !byFingerprint.has(record.recommendationFingerprint)) {
        byFingerprint.set(record.recommendationFingerprint, record);
      }
      const entityKey = governanceEntityKey(row.entity_id, row.action_type);
      if (entityKey && !byEntityAction.has(entityKey)) byEntityAction.set(entityKey, record);
    }

    let duplicateSuppressionCount = 0;
    let alreadyGovernedSuppressionCount = 0;
    const items = payload.items.map((item) => {
      if (!item?.recommendation || !item.fingerprint) return item;
      const exact = byFingerprint.get(item.fingerprint);
      const entityKey = governanceEntityKey(item.recommendation.entityId, item.recommendation.actionType);
      const governed = exact || (entityKey ? byEntityAction.get(entityKey) : null);
      if (!governed) return item;

      const code = exact ? 'duplicate_recommendation' : 'already_governed_action';
      if (exact) duplicateSuppressionCount += 1;
      else alreadyGovernedSuppressionCount += 1;
      return {
        ...item,
        recommendation: null,
        fingerprint: null,
        suppression: {
          code,
          reason: exact
            ? 'The same deterministic recommendation is already present in the governance queue.'
            : 'An open governance action already exists for this entity and action type.',
          governanceAction: governed,
          governancePersistenceAllowed: false,
        },
      };
    });

    const qualitySuppressedCount = items.filter((item) => QUALITY_SUPPRESSION_CODES.has(item?.suppression?.code)).length;
    const collisionSuppressedCount = items.filter((item) => ['existing_negative_collision', 'existing_keyword_collision'].includes(item?.suppression?.code)).length;
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
      duplicateSuppressionCount,
      alreadyGovernedSuppressionCount,
      observationCount,
    };
    payload.governanceSuppressionContract = {
      schemaVersion: 'recommendation-governance-suppression-v1',
      exactFingerprintDuplicate: true,
      openEntityActionSuppression: true,
      failureMode: 'fail_open_to_core_intelligence',
      openStatuses: [...OPEN_GOVERNANCE_STATUSES],
      amazonMutationAuthorized: false,
    };

    return replaceJsonResponse(response, payload);
  } catch (error) {
    console.error('recommendation_governance_enrichment_error', {
      storeId,
      profileId: payload.profile?.profileId || null,
      message: error?.message || String(error),
    });
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

function publicGovernanceRecord(row) {
  return {
    actionId: row.action_id,
    status: row.status,
    entityId: row.entity_id,
    actionType: row.action_type,
    recommendationFingerprint: row.recommendation_fingerprint || null,
    createdAt: row.created_at || null,
  };
}

function governanceEntityKey(entityId, actionType) {
  const entity = String(entityId || '').trim();
  const action = String(actionType || '').trim();
  return entity && action ? `${entity}\u0000${action}` : null;
}

function replaceJsonResponse(response, payload) {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-aoi-recommendation-governance-layer', 'v1');
  headers.delete('content-length');
  return new Response(JSON.stringify(payload), { status: response.status, headers });
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}
