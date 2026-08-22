import { handleCsvSearchTermIntelligenceApiRoute } from './csv-search-term-intelligence-api.js';
import {
  authorizeReviewCandidateForPersistence,
  persistedStateToUiState,
  reviewContextKeyFromEvidenceJson,
} from './csv-recommendation-human-review-api.js';
import {
  RECOMMENDATION_REVIEW_SOURCE_KIND,
  buildRecommendationReviewBinding,
} from './csv-recommendation-human-review-contract.js';

export const FOUR_STORE_DECISION_QUEUE_SUMMARY_SCHEMA_VERSION = 'four-store-decision-queue-summary-v1';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const DECISION_QUEUE_AUTHORITY = Object.freeze({
  readOnly: true,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export async function handleDataHealthApiRoute({ request, env, actor, url }) {
  if (request.method !== 'GET' || url.pathname !== '/api/v1/analytics/data-health') return null;

  const includeDecisionQueue = url.searchParams.get('includeDecisionQueue') === 'true';
  const decisionRange = includeDecisionQueue ? explicitDecisionQueueRange(url) : null;
  if (decisionRange?.error) {
    return json(request, { error: decisionRange.error }, 400);
  }

  const storeIds = await accessibleStoreIds(env.CONTROL_DB, actor.user_id);
  if (!storeIds.length) return json(request, { error: 'forbidden', permission: 'analytics.read' }, 403);

  const requestedStoreId = optionalText(url.searchParams.get('storeId'), 200);
  const scopedStoreIds = requestedStoreId
    ? (storeIds.includes(requestedStoreId) ? [requestedStoreId] : [])
    : storeIds;
  if (!scopedStoreIds.length) return json(request, { error: 'store_scope_forbidden' }, 403);

  const placeholders = scopedStoreIds.map((_, index) => `?${index + 1}`).join(',');
  const [stores, watermarks, failures] = await Promise.all([
    env.CONTROL_DB.prepare(`
      SELECT s.store_id, s.store_code, s.display_name, s.status, s.d1_binding_key,
             ss.sync_status, ss.active_run_id, ss.last_success_at, ss.last_error_at,
             ss.last_error_code, ss.lag_minutes, ss.updated_at AS sync_updated_at
      FROM stores s
      LEFT JOIN store_sync_status ss ON ss.store_id = s.store_id
      WHERE s.store_id IN (${placeholders})
      ORDER BY s.sort_order, s.store_code
    `).bind(...scopedStoreIds).all(),
    env.CONTROL_DB.prepare(`
      SELECT store_id, rollup_type, partition_key,
             last_success_date, last_success_as_of_date, last_success_run_id,
             summary_rows, unmapped_rows, ambiguous_rows, updated_at
      FROM rollup_watermarks
      WHERE store_id IN (${placeholders})
      ORDER BY store_id, rollup_type, partition_key
    `).bind(...scopedStoreIds).all(),
    env.CONTROL_DB.prepare(`
      SELECT store_id, rollup_type, partition_key, error_code, started_at, completed_at
      FROM rollup_runs
      WHERE store_id IN (${placeholders}) AND status = 'failed'
      ORDER BY started_at DESC
      LIMIT 50
    `).bind(...scopedStoreIds).all(),
  ]);

  const watermarkByStore = {};
  for (const row of watermarks.results || []) {
    if (!watermarkByStore[row.store_id]) watermarkByStore[row.store_id] = [];
    watermarkByStore[row.store_id].push({
      rollupType: row.rollup_type,
      partitionKey: row.partition_key || '',
      lastSuccessDate: row.last_success_date || null,
      lastSuccessAsOfDate: row.last_success_as_of_date || null,
      lastSuccessRunId: row.last_success_run_id || null,
      summaryRows: nullableNumber(row.summary_rows),
      unmappedRows: number(row.unmapped_rows),
      ambiguousRows: number(row.ambiguous_rows),
      updatedAt: row.updated_at || null,
    });
  }

  const generatedAt = new Date().toISOString();
  const response = {
    generatedAt,
    stores: (stores.results || []).map((row) => ({
      storeId: row.store_id,
      storeCode: row.store_code,
      displayName: row.display_name,
      storeStatus: row.status,
      sync: {
        status: row.sync_status || 'never',
        activeRunId: row.active_run_id || null,
        lastSuccessAt: row.last_success_at || null,
        lastErrorAt: row.last_error_at || null,
        lastErrorCode: row.last_error_code || null,
        lagMinutes: nullableNumber(row.lag_minutes),
        updatedAt: row.sync_updated_at || null,
      },
      rollups: watermarkByStore[row.store_id] || [],
    })),
    recentRollupFailures: (failures.results || []).map((row) => ({
      storeId: row.store_id,
      rollupType: row.rollup_type,
      partitionKey: row.partition_key || '',
      errorCode: row.error_code || null,
      startedAt: row.started_at,
      completedAt: row.completed_at || null,
    })),
  };

  if (includeDecisionQueue) {
    const sourceRows = stores.results || [];
    const decisionStores = await Promise.all(sourceRows.map((row) => buildDecisionQueueStoreSummary({
      request,
      env,
      actor,
      row,
      range: decisionRange,
      generatedAt,
    })));
    response.decisionQueue = {
      schemaVersion: FOUR_STORE_DECISION_QUEUE_SUMMARY_SCHEMA_VERSION,
      generatedAt,
      dateRange: { startDate: decisionRange.startDate, endDate: decisionRange.endDate },
      authority: DECISION_QUEUE_AUTHORITY,
      stores: decisionStores,
    };
  }

  return json(request, response, 200);
}

async function buildDecisionQueueStoreSummary({ request, env, actor, row, range, generatedAt }) {
  const identity = {
    storeId: row.store_id,
    storeCode: row.store_code,
    displayName: row.display_name,
  };
  const dateRange = { startDate: range.startDate, endDate: range.endDate };

  try {
    if (!STORE_BINDINGS.has(row.d1_binding_key) || !env[row.d1_binding_key]) {
      throw decisionQueueError('store_db_unavailable');
    }

    const intelligenceUrl = new URL(`/api/v1/stores/${encodeURIComponent(row.store_id)}/search-term-intelligence`, request.url);
    intelligenceUrl.searchParams.set('source', 'csv');
    intelligenceUrl.searchParams.set('startDate', range.startDate);
    intelligenceUrl.searchParams.set('endDate', range.endDate);
    intelligenceUrl.searchParams.set('limit', '100');
    intelligenceUrl.searchParams.set('sort', 'cost');

    const headers = new Headers({ accept: 'application/json' });
    const cfRay = request.headers.get('cf-ray');
    if (cfRay) headers.set('cf-ray', cfRay);
    const intelligenceRequest = new Request(intelligenceUrl.toString(), { method: 'GET', headers });
    const intelligenceResponse = await handleCsvSearchTermIntelligenceApiRoute({
      request: intelligenceRequest,
      env,
      actor,
      url: intelligenceUrl,
    });
    if (!intelligenceResponse) throw decisionQueueError('recommendation_snapshot_unavailable');

    const payload = await intelligenceResponse.json().catch(() => ({}));
    if (!intelligenceResponse.ok) {
      throw decisionQueueError(payload?.error || 'recommendation_snapshot_failed');
    }
    const productization = payload?.productization || {};
    const inbox = productization?.recommendationInbox;
    if (!inbox || inbox.schemaVersion !== 'csv-recommendation-inbox-v1') {
      throw decisionQueueError('recommendation_inbox_contract_unavailable');
    }

    const stored = await env[row.d1_binding_key].prepare(`
      SELECT
        review_id,
        recommendation_fingerprint,
        state,
        source_evidence_json
      FROM advisory_review_records
      WHERE source_kind = ?1
    `).bind(RECOMMENDATION_REVIEW_SOURCE_KIND).all();

    const summary = await summarizeDecisionQueueReviewState({
      inbox,
      analysisScope: productization?.analysisScope || inbox?.analysisScope || {},
      storedReviews: stored.results || [],
    });

    return {
      ...identity,
      generatedAt,
      dateRange,
      evidenceState: 'available',
      unavailable: false,
      ...summary,
      authority: DECISION_QUEUE_AUTHORITY,
    };
  } catch (error) {
    return {
      ...identity,
      generatedAt,
      dateRange,
      evidenceState: 'unavailable',
      unavailable: true,
      recommendationCandidateCount: null,
      criticalHighCandidateCount: null,
      governanceBlockedCount: null,
      scopeBlockedCount: null,
      unreviewedCount: null,
      needsReviewCount: null,
      acknowledgedCount: null,
      staleReviewEvidenceCount: null,
      highUnreviewedCount: null,
      analysisScopeComplete: null,
      financiallyComparable: null,
      candidateEmissionAuthorized: null,
      error: { code: error?.code || cleanErrorCode(error?.message) || 'decision_queue_summary_failed' },
      authority: DECISION_QUEUE_AUTHORITY,
    };
  }
}

export async function summarizeDecisionQueueReviewState({ inbox, analysisScope, storedReviews } = {}) {
  const sourceItems = Array.isArray(inbox?.items) ? inbox.items : [];
  const candidates = sourceItems.filter((item) => item?.itemClass === 'recommendation_candidate');
  const stored = Array.isArray(storedReviews) ? storedReviews : [];
  const byFingerprint = new Map();
  const staleByContext = new Map();

  for (const row of stored) {
    const fingerprint = clean(row?.recommendation_fingerprint);
    if (fingerprint && !byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, row);
    const contextKey = reviewContextKeyFromEvidenceJson(row?.source_evidence_json);
    if (!contextKey) continue;
    const rows = staleByContext.get(contextKey) || [];
    rows.push(row);
    staleByContext.set(contextKey, rows);
  }

  let unreviewedCount = 0;
  let needsReviewCount = 0;
  let acknowledgedCount = 0;
  let highUnreviewedCount = 0;
  const staleReviewIds = new Set();

  for (const item of candidates) {
    const authorizedItem = authorizeReviewCandidateForPersistence(item, analysisScope);
    const binding = await buildRecommendationReviewBinding(authorizedItem);
    const row = byFingerprint.get(binding.recommendationFingerprint) || null;
    const state = row ? persistedStateToUiState(row.state) : 'unreviewed';
    if (row && !state) throw decisionQueueError('unsupported_durable_review_state');

    if (state === 'unreviewed') {
      unreviewedCount += 1;
      if (item?.priority === 'critical' || item?.priority === 'high') highUnreviewedCount += 1;
    } else if (state === 'needs_review') {
      needsReviewCount += 1;
    } else if (state === 'acknowledged') {
      acknowledgedCount += 1;
    }

    const contextKey = reviewContextKeyFromEvidenceJson(binding.sourceEvidenceJson);
    for (const stale of staleByContext.get(contextKey) || []) {
      if (stale?.recommendation_fingerprint !== binding.recommendationFingerprint && stale?.review_id) {
        staleReviewIds.add(stale.review_id);
      }
    }
  }

  const inboxSummary = inbox?.summary || {};
  return {
    recommendationCandidateCount: candidates.length,
    criticalHighCandidateCount: candidates.filter((item) => item?.priority === 'critical' || item?.priority === 'high').length,
    governanceBlockedCount: number(inboxSummary.blockedByGovernanceCount),
    scopeBlockedCount: number(inboxSummary.blockedByScopeCount),
    unreviewedCount,
    needsReviewCount,
    acknowledgedCount,
    staleReviewEvidenceCount: staleReviewIds.size,
    highUnreviewedCount,
    analysisScopeComplete: analysisScope?.complete === true,
    financiallyComparable: analysisScope?.financiallyComparable === true,
    candidateEmissionAuthorized: analysisScope?.candidateEmissionAuthorized === true,
  };
}

function explicitDecisionQueueRange(url) {
  const startDate = clean(url.searchParams.get('startDate'));
  const endDate = clean(url.searchParams.get('endDate'));
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    return { error: 'decision_queue_date_range_required' };
  }
  return { startDate, endDate };
}

async function accessibleStoreIds(db, userId) {
  const global = await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id = ?1 AND rp.permission_key = 'analytics.read'
    LIMIT 1
  `).bind(userId).first();
  if (global) {
    const result = await db.prepare(`
      SELECT store_id FROM stores WHERE status = 'active' ORDER BY sort_order, store_id
    `).all();
    return (result.results || []).map((row) => row.store_id);
  }

  const result = await db.prepare(`
    SELECT DISTINCT sm.store_id
    FROM store_members sm
    JOIN role_permissions rp ON rp.role_key = sm.role_key
    JOIN stores s ON s.store_id = sm.store_id
    WHERE sm.user_id = ?1 AND rp.permission_key = 'analytics.read' AND s.status = 'active'
    ORDER BY sm.store_id
  `).bind(userId).all();
  return (result.results || []).map((row) => row.store_id);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}
function optionalText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length <= maxLength ? text : null;
}
function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
function cleanErrorCode(value) {
  const text = clean(value);
  return text && /^[a-z0-9_:-]+$/iu.test(text) ? text : null;
}
function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function decisionQueueError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
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
