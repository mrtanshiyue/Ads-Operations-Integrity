const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);

export async function handleGovernanceHealthApiRoute({ request, env, actor, url }) {
  if (request.method !== 'GET') return null;
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/governance-health$/);
  if (!match) return null;

  const storeId = safeDecode(match[1]);
  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, 'ads.read');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  const [aggregate, recentActions, audit] = await Promise.all([
    route.storeDb.prepare(`
      SELECT
        COUNT(*) AS recommendation_count,
        SUM(CASE WHEN status='proposed' THEN 1 ELSE 0 END) AS proposed_count,
        SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved_count,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected_count,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_status_count,
        SUM(CASE WHEN status='proposed' AND created_at <= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS proposed_older_24h,
        SUM(CASE WHEN status='proposed' AND created_at <= datetime('now','-72 hours') THEN 1 ELSE 0 END) AS proposed_older_72h,
        MIN(CASE WHEN status='proposed' THEN created_at END) AS oldest_proposed_at,
        SUM(CASE WHEN json_extract(rationale_json,'$.governance.freshness.state')='fresh' THEN 1 ELSE 0 END) AS fresh_count,
        SUM(CASE WHEN json_extract(rationale_json,'$.governance.freshness.state')='aging' THEN 1 ELSE 0 END) AS aging_count,
        SUM(CASE WHEN json_extract(rationale_json,'$.governance.freshness.state')='stale' THEN 1 ELSE 0 END) AS stale_count,
        SUM(CASE WHEN json_extract(rationale_json,'$.governance.freshness.state')='unknown' THEN 1 ELSE 0 END) AS unknown_freshness_count,
        SUM(CASE WHEN json_extract(rationale_json,'$.governance.confidence.band')='high' THEN 1 ELSE 0 END) AS high_confidence_count,
        SUM(CASE WHEN json_extract(rationale_json,'$.governance.confidence.band')='medium' THEN 1 ELSE 0 END) AS medium_confidence_count,
        SUM(CASE WHEN json_extract(rationale_json,'$.governance.confidence.band')='low' THEN 1 ELSE 0 END) AS low_confidence_count,
        SUM(CASE WHEN MAX(
          COALESCE(json_extract(rationale_json,'$.governance.scores.waste.score'),0),
          COALESCE(json_extract(rationale_json,'$.governance.scores.harvest.score'),0)
        ) >= 75 THEN 1 ELSE 0 END) AS high_risk_count
      FROM optimization_actions
    `).first(),
    route.storeDb.prepare(`
      SELECT action_id, profile_id, entity_type, entity_id, action_type, status,
             created_by, approved_by, created_at, updated_at,
             json_extract(rationale_json,'$.governance.confidence.band') AS confidence_band,
             json_extract(rationale_json,'$.governance.freshness.state') AS freshness_state
      FROM optimization_actions
      ORDER BY created_at DESC
      LIMIT 10
    `).all(),
    env.CONTROL_DB.prepare(`
      SELECT action, COUNT(*) AS event_count
      FROM audit_log
      WHERE store_id=?1
        AND action LIKE 'optimization_action.%'
        AND occurred_at >= datetime('now','-7 days')
      GROUP BY action
      ORDER BY action
    `).bind(storeId).all(),
  ]);

  const total = number(aggregate?.recommendation_count);
  const proposed = number(aggregate?.proposed_count);
  const approved = number(aggregate?.approved_count);
  const rejected = number(aggregate?.rejected_count);
  const decided = approved + rejected;
  const stale = number(aggregate?.stale_count);

  return json(request, {
    schemaVersion: 'governance-health-v1',
    generatedAt: new Date().toISOString(),
    storeId,
    execution: {
      mode: 'governance_only',
      amazonMutationAuthorized: false,
    },
    metrics: {
      recommendationCount: total,
      proposedCount: proposed,
      approvedCount: approved,
      rejectedCount: rejected,
      actionsAwaitingReview: proposed,
      approvalRate: decided > 0 ? round4(approved / decided) : null,
      rejectionRate: decided > 0 ? round4(rejected / decided) : null,
      staleRecommendationRate: total > 0 ? round4(stale / total) : null,
      failedStatusCount: number(aggregate?.failed_status_count),
      highRiskCount: number(aggregate?.high_risk_count),
      confidence: {
        high: number(aggregate?.high_confidence_count),
        medium: number(aggregate?.medium_confidence_count),
        low: number(aggregate?.low_confidence_count),
      },
      freshness: {
        fresh: number(aggregate?.fresh_count),
        aging: number(aggregate?.aging_count),
        stale,
        unknown: number(aggregate?.unknown_freshness_count),
      },
      actionAging: {
        proposedOlder24h: number(aggregate?.proposed_older_24h),
        proposedOlder72h: number(aggregate?.proposed_older_72h),
        oldestProposedAt: aggregate?.oldest_proposed_at || null,
      },
    },
    recentActions: (recentActions.results || []).map((row) => ({
      actionId: row.action_id,
      profileId: row.profile_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      actionType: row.action_type,
      status: row.status,
      createdBy: row.created_by || null,
      reviewer: row.approved_by || null,
      confidence: row.confidence_band || null,
      freshness: row.freshness_state || 'unknown',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    audit7d: Object.fromEntries((audit.results || []).map((row) => [row.action, number(row.event_count)])),
    coverage: {
      durableActionLifecycle: true,
      durableApprovalRejectionAudit: true,
      duplicateSuppressionCount: {
        durable: false,
        source: 'search-term-intelligence response summary',
      },
      fingerprintConflictCount: {
        durable: false,
        source: 'request-time optimization action response',
      },
      governanceErrors: {
        durable: false,
        source: 'request/runtime logging; failedStatusCount is exposed separately and is not treated as equivalent',
      },
    },
  }, 200);
}

async function authorizedStoreRoute(env, userId, storeId, permission) {
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error: 'forbidden', permission, status: 403 };
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, d1_binding_key, status
    FROM stores WHERE store_id=?1 AND status <> 'disabled' LIMIT 1
  `).bind(storeId).first();
  if (!store) return { error: 'store_not_found', status: 404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error: 'store_db_unavailable', status: 503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { store, storeDb };
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`
    SELECT 1 AS ok FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key=ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2 LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM store_members sm
    JOIN role_permissions rp ON rp.role_key=sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3 LIMIT 1
  `).bind(userId, storeId, permission).first());
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function round4(value) { return Math.round(value * 10000) / 10000; }
function safeDecode(value) { try { return decodeURIComponent(value); } catch { return null; } }
function json(request, payload, status) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const ray = request.headers.get('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status, headers });
}
