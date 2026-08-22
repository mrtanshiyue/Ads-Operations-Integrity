import {
  CSV_RECOMMENDATION_HUMAN_REVIEW_CONTRACT_VERSION,
  RECOMMENDATION_REVIEW_SOURCE_KIND,
  buildRecommendationReviewBinding,
  evaluateRecommendationReviewRequest,
} from './csv-recommendation-human-review-contract.js';
import { handleCsvSearchTermIntelligenceApiRoute } from './csv-search-term-intelligence-api.js';
import { buildRecommendationDecisionPacket } from './recommendation-decision-packet.js';
import { buildGovernedKeywordNegativeCandidateLibrary } from './governed-keyword-negative-candidate-library.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_REVIEW_ROWS = 1000;
const ALLOWED_REQUEST_STATES = new Set(['acknowledged', 'needs_review']);

export async function handleCsvRecommendationHumanReviewPersistenceRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/advisory-reviews$/);
  if (!match) return null;
  if (url.searchParams.get('reviewContract') !== CSV_RECOMMENDATION_HUMAN_REVIEW_CONTRACT_VERSION) return null;

  const storeId = safeDecode(match[1]);
  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  const method = request.method.toUpperCase();
  if (!['GET', 'POST'].includes(method)) return json(request, { error: 'method_not_allowed' }, 405);

  const range = reviewRange(url);
  if (range.error) return json(request, { error: range.error }, 400);

  const permission = method === 'POST' ? 'ads.write' : 'analytics.read';
  const route = await authorizedStoreDb(env, actor?.user_id, storeId, permission);
  if (route.error) return json(request, { error: route.error, permission }, route.status);

  const snapshot = await currentRecommendationSnapshot({ request, env, actor, storeId, url, range });
  if (snapshot.error) return json(request, snapshot.error, snapshot.status);

  if (method === 'GET') {
    return readCurrentReviewState({ request, db: route.storeDb, storeId, snapshot });
  }
  return persistCurrentReview({ request, env, actor, db: route.storeDb, storeId, snapshot });
}

export function authorizeReviewCandidateForPersistence(item, analysisScope) {
  const eligible = Boolean(
    item?.itemClass === 'recommendation_candidate'
    && item?.matchScope !== 'phrase_review'
    && item?.evidenceSummary?.recommendationGoverned === true
    && analysisScope?.candidateEmissionAuthorized === true
  );
  if (!eligible) return item;
  return Object.freeze({
    ...item,
    review: Object.freeze({
      ...(item.review || {}),
      persistenceAuthorized: true,
    }),
    authority: Object.freeze({
      ...(item.authority || {}),
      governancePersistenceAllowed: true,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
      canonicalAmazonIdentityResolved: false,
    }),
  });
}

export function persistedStateToUiState(value) {
  if (value === 'acknowledged') return 'acknowledged';
  if (value === 'open') return 'needs_review';
  return null;
}

export function reviewContextKeyFromEvidenceJson(value) {
  const parsed = parseJson(value);
  const descriptor = parsed?.descriptor;
  if (!descriptor || typeof descriptor !== 'object') return null;
  const parts = [
    descriptor.sourceKind,
    descriptor.inboxItemId,
    descriptor.candidateType,
    descriptor.actionType,
    descriptor.matchScope,
    descriptor.value,
  ].map(clean);
  return parts.every(Boolean) ? parts.join('\u001f') : null;
}

async function currentRecommendationSnapshot({ request, env, actor, storeId, url, range }) {
  const intelligenceUrl = new URL(`/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence`, request.url);
  intelligenceUrl.searchParams.set('source', 'csv');
  intelligenceUrl.searchParams.set('startDate', range.startDate);
  intelligenceUrl.searchParams.set('endDate', range.endDate);
  intelligenceUrl.searchParams.set('limit', normalizeLimit(url.searchParams.get('limit')));
  intelligenceUrl.searchParams.set('sort', normalizeSort(url.searchParams.get('sort')));
  for (const key of ['profileId', 'q', 'campaignName', 'adGroupName']) {
    const value = clean(url.searchParams.get(key));
    if (value) intelligenceUrl.searchParams.set(key, value);
  }

  const headers = new Headers({ accept: 'application/json' });
  const cfRay = request.headers.get('cf-ray');
  if (cfRay) headers.set('cf-ray', cfRay);
  const intelligenceRequest = new Request(intelligenceUrl.toString(), { method: 'GET', headers });
  const response = await handleCsvSearchTermIntelligenceApiRoute({
    request: intelligenceRequest,
    env,
    actor,
    url: intelligenceUrl,
  });
  if (!response) return { error: { error: 'recommendation_snapshot_unavailable' }, status: 503 };
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      error: {
        error: payload?.error || 'recommendation_snapshot_failed',
        detail: payload?.detail || null,
      },
      status: response.status,
    };
  }
  const productization = payload?.productization || {};
  const inbox = productization?.recommendationInbox || {};
  return {
    payload,
    analysisScope: productization?.analysisScope || {},
    inbox,
    items: Array.isArray(inbox?.items) ? inbox.items : [],
  };
}

async function readCurrentReviewState({ request, db, storeId, snapshot }) {
  const bindings = await Promise.all(snapshot.items.map(async (item) => {
    const authorizedItem = authorizeReviewCandidateForPersistence(item, snapshot.analysisScope);
    const binding = await buildRecommendationReviewBinding(authorizedItem);
    return { item: authorizedItem, binding };
  }));
  const stored = await readStoredRecommendationReviews(db);
  const byFingerprint = new Map(stored.map((row) => [row.recommendation_fingerprint, row]));
  const staleByContext = groupStaleRowsByContext(stored);

  const items = bindings.map(({ item, binding }) => {
    const row = byFingerprint.get(binding.recommendationFingerprint) || null;
    const contextKey = reviewContextKeyFromEvidenceJson(binding.sourceEvidenceJson);
    const staleRows = (staleByContext.get(contextKey) || [])
      .filter((candidate) => candidate.recommendation_fingerprint !== binding.recommendationFingerprint);
    const currentReview = row ? publicReview(row) : null;
    const staleEvidence = staleRows.map(publicDecisionReviewEvidence);
    return {
      inboxItemId: item.inboxItemId,
      persistenceAuthorized: item?.review?.persistenceAuthorized === true,
      recommendationFingerprint: binding.recommendationFingerprint,
      sourceEvidenceSha256: binding.sourceEvidenceSha256,
      review: currentReview || {
        state: 'unreviewed',
        persisted: false,
        reviewerUserId: null,
        reviewedAt: null,
        updatedAt: null,
      },
      staleReviewIds: staleRows.map((candidate) => candidate.review_id),
      decisionPacket: buildRecommendationDecisionPacket({
        item,
        binding,
        currentReview,
        staleReviews: staleEvidence,
        analysisScope: snapshot.analysisScope,
      }),
    };
  });

  const candidateLibrary = buildGovernedKeywordNegativeCandidateLibrary({
    storeId,
    analysisScope: snapshot.analysisScope,
    items,
  });

  return json(request, {
    schemaVersion: CSV_RECOMMENDATION_HUMAN_REVIEW_CONTRACT_VERSION,
    storeId,
    authority: reviewAuthority(),
    analysisScope: compactScope(snapshot.analysisScope),
    candidateLibrary,
    items,
  }, 200);
}

async function persistCurrentReview({ request, env, actor, db, storeId, snapshot }) {
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const keys = Object.keys(body.value);
  if (keys.some((key) => !['inboxItemId', 'state', 'note'].includes(key))) {
    return json(request, { error: 'unsupported_recommendation_review_field' }, 400);
  }

  const inboxItemId = clean(body.value.inboxItemId);
  const requestedState = clean(body.value.state);
  if (!inboxItemId) return json(request, { error: 'inbox_item_id_required' }, 400);
  if (!ALLOWED_REQUEST_STATES.has(requestedState)) {
    return json(request, { error: 'recommendation_review_state_not_supported' }, 400);
  }
  const note = optionalNote(body.value.note);
  if (note.error) return json(request, { error: note.error }, 400);

  const emitted = snapshot.items.find((item) => clean(item?.inboxItemId) === inboxItemId);
  if (!emitted) {
    return json(request, {
      error: 'review_candidate_not_currently_emitted',
      analysisScope: compactScope(snapshot.analysisScope),
    }, 409);
  }

  const authorizedItem = authorizeReviewCandidateForPersistence(emitted, snapshot.analysisScope);
  const evaluation = await evaluateRecommendationReviewRequest({
    inboxItem: authorizedItem,
    requestedState,
    analysisScope: snapshot.analysisScope,
  });
  if (!evaluation.persistenceAuthorized || !evaluation.advisoryReviewRecord) {
    return json(request, {
      error: 'recommendation_review_persistence_not_authorized',
      reasons: evaluation.reasons,
      analysisScope: compactScope(snapshot.analysisScope),
      authority: reviewAuthority(),
    }, 409);
  }

  const record = evaluation.advisoryReviewRecord;
  const existing = await db.prepare(`
    SELECT * FROM advisory_review_records
    WHERE source_kind=?1 AND recommendation_fingerprint=?2
    LIMIT 1
  `).bind(record.sourceKind, record.recommendationFingerprint).first();

  if (existing && existing.source_evidence_sha256 !== record.sourceEvidenceSha256) {
    return json(request, { error: 'recommendation_review_evidence_conflict' }, 409);
  }

  const now = new Date().toISOString();
  let reviewId = existing?.review_id || `adv-${crypto.randomUUID()}`;
  let reused = false;
  let changed = false;

  if (existing) {
    const sameState = existing.state === record.state;
    const sameNote = clean(existing.reviewer_note) === clean(note.value);
    if (sameState && sameNote) {
      reused = true;
    } else {
      await db.prepare(`
        UPDATE advisory_review_records
        SET state=?2, reviewer_user_id=?3, reviewer_note=?4, reviewed_at=?5,
            snoozed_until=NULL, updated_at=?5
        WHERE review_id=?1
      `).bind(reviewId, record.state, actor.user_id, note.value, now).run();
      changed = true;
    }
  } else {
    try {
      await db.prepare(`
        INSERT INTO advisory_review_records(
          review_id, source_kind, recommendation_fingerprint, entity_type, entity_id,
          recommendation_family, recommendation_action_type, state,
          reviewer_user_id, reviewer_note, reviewed_at,
          source_evidence_json, source_evidence_sha256,
          created_by, created_at, updated_at
        ) VALUES(?1,?2,?3,'search_term',?4,?5,?6,?7,?8,?9,?10,?11,?12,?8,?10,?10)
      `).bind(
        reviewId,
        record.sourceKind,
        record.recommendationFingerprint,
        record.entityId,
        record.recommendationFamily,
        record.recommendationActionType,
        record.state,
        actor.user_id,
        note.value,
        now,
        record.sourceEvidenceJson,
        record.sourceEvidenceSha256,
      ).run();
      changed = true;
    } catch (error) {
      const raced = await db.prepare(`
        SELECT * FROM advisory_review_records
        WHERE source_kind=?1 AND recommendation_fingerprint=?2
        LIMIT 1
      `).bind(record.sourceKind, record.recommendationFingerprint).first();
      if (!raced) throw error;
      if (raced.source_evidence_sha256 !== record.sourceEvidenceSha256) {
        return json(request, { error: 'recommendation_review_evidence_conflict' }, 409);
      }
      reviewId = raced.review_id;
      reused = raced.state === record.state && clean(raced.reviewer_note) === clean(note.value);
      if (!reused) {
        await db.prepare(`
          UPDATE advisory_review_records
          SET state=?2, reviewer_user_id=?3, reviewer_note=?4, reviewed_at=?5,
              snoozed_until=NULL, updated_at=?5
          WHERE review_id=?1
        `).bind(reviewId, record.state, actor.user_id, note.value, now).run();
        changed = true;
      }
    }
  }

  const row = await db.prepare('SELECT * FROM advisory_review_records WHERE review_id=?1 LIMIT 1')
    .bind(reviewId).first();
  const stored = await readStoredRecommendationReviews(db);
  const currentContext = reviewContextKeyFromEvidenceJson(record.sourceEvidenceJson);
  const staleReviewIds = stored
    .filter((candidate) => reviewContextKeyFromEvidenceJson(candidate.source_evidence_json) === currentContext)
    .filter((candidate) => candidate.recommendation_fingerprint !== record.recommendationFingerprint)
    .map((candidate) => candidate.review_id);

  if (changed) {
    await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'recommendation_review.persisted', reviewId, {
      requestedState,
      advisoryState: record.state,
      inboxItemId,
      recommendationFingerprint: record.recommendationFingerprint,
      sourceEvidenceSha256: record.sourceEvidenceSha256,
      staleReviewIds,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    });
  }

  return json(request, {
    schemaVersion: CSV_RECOMMENDATION_HUMAN_REVIEW_CONTRACT_VERSION,
    storeId,
    reused,
    changed,
    authority: reviewAuthority(),
    review: publicReview(row),
    staleReviewIds,
  }, existing || reused ? 200 : 201);
}

async function readStoredRecommendationReviews(db) {
  const result = await db.prepare(`
    SELECT review_id, source_kind, recommendation_fingerprint, entity_type, entity_id,
           recommendation_family, recommendation_action_type, state, reviewer_user_id,
           reviewer_note, reviewed_at, snoozed_until, source_evidence_json,
           source_evidence_sha256, created_by, created_at, updated_at
    FROM advisory_review_records
    WHERE source_kind=?1
    ORDER BY updated_at DESC, review_id DESC
    LIMIT ?2
  `).bind(RECOMMENDATION_REVIEW_SOURCE_KIND, MAX_REVIEW_ROWS).all();
  return result.results || [];
}

function groupStaleRowsByContext(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = reviewContextKeyFromEvidenceJson(row.source_evidence_json);
    if (!key) continue;
    const current = groups.get(key) || [];
    current.push(row);
    groups.set(key, current);
  }
  return groups;
}

function publicReview(row) {
  return {
    reviewId: row.review_id,
    sourceKind: row.source_kind,
    recommendationFingerprint: row.recommendation_fingerprint,
    entityType: row.entity_type,
    entityId: row.entity_id,
    recommendationFamily: row.recommendation_family,
    recommendationActionType: row.recommendation_action_type,
    state: persistedStateToUiState(row.state) || 'unsupported',
    advisoryState: row.state,
    persisted: true,
    reviewerUserId: row.reviewer_user_id || null,
    note: row.reviewer_note || null,
    reviewedAt: row.reviewed_at || null,
    sourceEvidenceSha256: row.source_evidence_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicDecisionReviewEvidence(row) {
  return {
    ...publicReview(row),
    sourceEvidenceJson: row.source_evidence_json || null,
    sourceEvidence: parseJson(row.source_evidence_json),
  };
}

function reviewAuthority() {
  return {
    sourceKind: RECOMMENDATION_REVIEW_SOURCE_KIND,
    persistencePlane: 'advisory_review_records',
    reviewPersistenceSupported: true,
    durableStates: ['acknowledged', 'needs_review'],
    viewedPersistenceSupported: false,
    approvedRejectedPersistenceSupported: false,
    rootPersistenceSupported: false,
    optimizationActionPersistenceAuthorized: false,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
  };
}

function compactScope(scope) {
  return {
    complete: scope?.complete === true,
    financiallyComparable: scope?.financiallyComparable === true,
    candidateEmissionAuthorized: scope?.candidateEmissionAuthorized === true,
    overflowObserved: scope?.overflowObserved === true,
    hardCap: Number.isInteger(scope?.hardCap) ? scope.hardCap : null,
    observedTermCount: Number.isInteger(scope?.observedTermCount) ? scope.observedTermCount : null,
    reasons: Array.isArray(scope?.reasons) ? scope.reasons : [],
  };
}

async function authorizedStoreDb(env, userId, storeId, permission) {
  if (!env.CONTROL_DB) return { error: 'control_db_not_bound', status: 503 };
  if (!clean(userId)) return { error: 'authenticated_actor_required', status: 403 };
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error: 'forbidden', status: 403 };
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, d1_binding_key, status
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
  if (!store) return { error: 'store_not_found', status: 404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error: 'store_db_unavailable', status: 503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { storeDb };
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`
    SELECT 1 AS ok FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key=ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2
    LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM store_members sm
    JOIN role_permissions rp ON rp.role_key=sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3
    LIMIT 1
  `).bind(userId, storeId, permission).first());
}

async function audit(db, request, actorUserId, storeId, action, entityId, details) {
  if (!db) return;
  try {
    await db.prepare(`
      INSERT INTO audit_log(event_id, actor_user_id, store_id, action, entity_type, entity_id, request_id, cf_ray, details_json)
      VALUES(?1,?2,?3,?4,'advisory_review',?5,?6,?7,?8)
    `).bind(
      crypto.randomUUID(),
      actorUserId,
      storeId,
      action,
      entityId,
      request.headers.get('cf-ray') || crypto.randomUUID(),
      request.headers.get('cf-ray'),
      JSON.stringify(details || {}),
    ).run();
  } catch (error) {
    console.error('recommendation_review_audit_failed', { message: error?.message || String(error) });
  }
}

function reviewRange(url) {
  const startDate = clean(url.searchParams.get('startDate'));
  const endDate = clean(url.searchParams.get('endDate'));
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    return { error: 'recommendation_review_date_range_required' };
  }
  return { startDate, endDate };
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function normalizeLimit(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 100 ? String(number) : '50';
}

function normalizeSort(value) {
  const normalized = clean(value);
  return ['cost', 'sales', 'clicks', 'orders', 'impressions'].includes(normalized) ? normalized : 'cost';
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { error: 'request_body_too_large' };
  let raw;
  try { raw = await request.text(); } catch { return { error: 'request_body_unreadable' }; }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return { error: 'request_body_too_large' };
  let value;
  try { value = JSON.parse(raw); } catch { return { error: 'invalid_json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'invalid_json_object' };
  return { value };
}

function optionalNote(value) {
  if (value == null) return { value: null };
  const normalized = String(value).trim();
  if (!normalized) return { value: null };
  if (normalized.length > 4000) return { error: 'review_note_too_long' };
  return { value: normalized };
}

function parseJson(value) {
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
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
