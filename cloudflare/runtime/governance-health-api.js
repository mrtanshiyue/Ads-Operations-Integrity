const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const OBSERVABILITY_ACTIONS = Object.freeze({
  duplicateSuppression: 'optimization_action.observability.duplicate_suppression',
  alreadyGovernedSuppression: 'optimization_action.observability.already_governed_suppression',
  fingerprintConflict: 'optimization_action.observability.fingerprint_conflict',
  governanceError: 'optimization_action.observability.governance_error',
});

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
      SELECT oa.action_id, oa.profile_id, oa.entity_type, oa.entity_id, oa.action_type, oa.status,
             oa.created_by, oa.approved_by, oa.rationale_json, oa.created_at, oa.updated_at,
             (SELECT e.actor_id FROM optimization_action_events e
              WHERE e.action_id=oa.action_id
                AND e.event_type IN ('action.approved','approved','action.rejected','rejected')
              ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1) AS reviewer_id,
             (SELECT json_extract(e.details_json,'$.reason') FROM optimization_action_events e
              WHERE e.action_id=oa.action_id AND e.event_type IN ('action.rejected','rejected')
              ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1) AS rejection_reason,
             (SELECT e.occurred_at FROM optimization_action_events e
              WHERE e.action_id=oa.action_id AND e.event_type IN ('action.proposed','proposed')
              ORDER BY e.occurred_at ASC, e.event_id ASC LIMIT 1) AS proposed_at,
             (SELECT e.occurred_at FROM optimization_action_events e
              WHERE e.action_id=oa.action_id AND e.event_type IN ('action.approved','approved')
              ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1) AS approved_at,
             (SELECT e.occurred_at FROM optimization_action_events e
              WHERE e.action_id=oa.action_id AND e.event_type IN ('action.rejected','rejected')
              ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT 1) AS rejected_at
      FROM optimization_actions oa
      ORDER BY oa.created_at DESC
      LIMIT 10
    `).all(),
    env.CONTROL_DB.prepare(`
      SELECT action,
             COUNT(*) AS event_count,
             SUM(COALESCE(CAST(json_extract(details_json,'$.count') AS INTEGER),1)) AS observed_count
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
  const auditRows = audit.results || [];
  const audit7d = Object.fromEntries(auditRows.map((row) => [row.action, number(row.event_count)]));
  const observed7d = Object.fromEntries(auditRows.map((row) => [row.action, number(row.observed_count)]));

  return json(request, {
    schemaVersion: 'governance-health-v2',
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
      observability7d: {
        duplicateSuppressions: observed(observed7d, OBSERVABILITY_ACTIONS.duplicateSuppression),
        alreadyGovernedSuppressions: observed(observed7d, OBSERVABILITY_ACTIONS.alreadyGovernedSuppression),
        fingerprintConflicts: observed(observed7d, OBSERVABILITY_ACTIONS.fingerprintConflict),
        governanceErrors: observed(observed7d, OBSERVABILITY_ACTIONS.governanceError),
      },
    },
    recentActions: (recentActions.results || []).map(operatorAction),
    audit7d,
    coverage: {
      durableActionLifecycle: true,
      durableApprovalRejectionAudit: true,
      actionEventVocabulary: {
        canonical: 'action.<transition>',
        legacyUnprefixedReadCompatibility: true,
        acceptedTransitions: ['proposed', 'approved', 'rejected'],
      },
      duplicateSuppressionCount: {
        durable: true,
        source: 'control audit_log / optimization_action.observability.duplicate_suppression',
        window: '7d',
      },
      alreadyGovernedSuppressionCount: {
        durable: true,
        source: 'control audit_log / optimization_action.observability.already_governed_suppression',
        window: '7d',
      },
      fingerprintConflictCount: {
        durable: true,
        source: 'control audit_log / optimization_action.observability.fingerprint_conflict',
        window: '7d',
      },
      governanceErrors: {
        durable: true,
        source: 'control audit_log / optimization_action.observability.governance_error',
        window: '7d',
      },
    },
  }, 200);
}

function operatorAction(row) {
  const envelope = parseJson(row.rationale_json);
  const governance = plainObject(envelope?.governance) ? envelope.governance : {};
  const evidence = plainObject(governance.evidence) ? governance.evidence : {};
  const source = plainObject(evidence.sourceFactIdentity) ? evidence.sourceFactIdentity : evidence;
  const sourceReportJobIds = texts(source.sourceReportJobIds || evidence.sourceReportJobIds);
  const amazonReportIds = texts(source.amazonReportIds || evidence.amazonReportIds);
  const r2ObjectKeys = texts(source.r2ObjectKeys || evidence.r2ObjectKeys);
  const contentSha256s = texts(source.contentSha256s || evidence.contentSha256s);
  const checks = [
    Boolean(evidence.lineageValid),
    number(evidence.factRowCount) > 0,
    sourceReportJobIds.length > 0,
    r2ObjectKeys.length > 0,
    contentSha256s.length > 0,
  ];
  const passed = checks.filter(Boolean).length;
  const riskScore = Math.max(
    number(governance?.scores?.waste?.score),
    number(governance?.scores?.harvest?.score),
  );

  return {
    actionId: row.action_id,
    profileId: row.profile_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actionType: row.action_type,
    status: row.status,
    createdBy: row.created_by || null,
    reviewer: row.reviewer_id || row.approved_by || null,
    rejectionReason: row.rejection_reason || null,
    rationale: Object.prototype.hasOwnProperty.call(envelope || {}, 'recommendation') ? envelope.recommendation : envelope,
    confidence: governance?.confidence?.band || null,
    freshness: governance?.freshness?.state || 'unknown',
    riskScore,
    queueAgeHours: ageHours(row.created_at),
    evidenceCompleteness: {
      complete: passed === checks.length,
      checksPassed: passed,
      checksTotal: checks.length,
      lineageValid: Boolean(evidence.lineageValid),
      factRowCount: number(evidence.factRowCount),
    },
    lineage: {
      recommendationFingerprint: governance.recommendationFingerprint || null,
      analysisWindow: governance.analysisWindow || null,
      sourceReportIdentity: {
        sourceReportJobIds,
        amazonReportIds,
        r2ObjectKeys,
        contentSha256s,
      },
    },
    lifecycle: {
      proposedAt: row.proposed_at || row.created_at || null,
      approvedAt: row.approved_at || null,
      rejectedAt: row.rejected_at || null,
      updatedAt: row.updated_at || null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

function observed(map, action) { return number(map[action]); }
function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function ageHours(value) {
  const timestamp = Date.parse(String(value || '').replace(' ', 'T') + (String(value || '').includes('Z') ? '' : 'Z'));
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round(((Date.now() - timestamp) / 3600000) * 10) / 10);
}
function texts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}
function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
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
