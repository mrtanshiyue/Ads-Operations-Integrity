import { handleCsvImportsApiRoute } from './csv-imports-api.js';
import { handleCsvSearchTermIntelligenceApiRoute } from './csv-search-term-intelligence-api.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const ADVISORY_STATES = new Set(['open', 'acknowledged', 'dismissed', 'snoozed']);
const DATA_CLASSES = new Set(['unclassified', 'business', 'acceptance']);
const PROVENANCE_CLASSES = new Set(['legacy_batch_only', 'exact_source_object', 'reconciled_exact_source']);
const GOVERNED_PROVENANCE = new Set(['exact_source_object', 'reconciled_exact_source']);
const SOURCE_KIND = 'csv_import';
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const HEX64 = /^[a-f0-9]{64}$/u;
const SAFE_SOURCE = /^[A-Za-z0-9._:-]{1,64}$/u;

export async function handleCsvProductizationApiRoute({ request, env, actor, url, ctx }) {
  const advisoryMatch = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/advisory-reviews(?:\/([^/]+))?$/);
  if (advisoryMatch) {
    return handleAdvisoryReviewRoute({ request, env, actor, url, match: advisoryMatch });
  }

  const authorityMatch = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/imports\/([^/]+)$/);
  if (authorityMatch && request.method.toUpperCase() === 'PATCH') {
    return handleImportAuthorityMutation({ request, env, actor, match: authorityMatch });
  }

  if (request.method.toUpperCase() === 'GET'
      && /^\/api\/v1\/stores\/[^/]+\/imports(?:\/[^/]+(?:\/errors)?)?$/.test(url.pathname)) {
    const response = await handleCsvImportsApiRoute({ request, env, actor, url, ctx });
    if (!response || !response.ok || url.pathname.endsWith('/errors')) return response;
    return enrichImportsResponse({ request, response, env, actor, url });
  }

  if (request.method.toUpperCase() === 'GET'
      && url.searchParams.get('source') === 'csv'
      && /^\/api\/v1\/stores\/[^/]+\/search-term-intelligence$/.test(url.pathname)) {
    const response = await handleCsvSearchTermIntelligenceApiRoute({ request, env, actor, url, ctx });
    if (!response || !response.ok) return response;
    return enrichCsvIntelligenceResponse({ request, response, env, actor, url });
  }

  return null;
}

async function handleImportAuthorityMutation({ request, env, actor, match }) {
  const storeId = safeDecode(match[1]);
  const importId = safeDecode(match[2]);
  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  if (!importId) return json(request, { error: 'invalid_import_id' }, 400);

  const route = await authorizedStoreDb(env, actor.user_id, storeId, 'ads.write');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const keys = Object.keys(body.value);
  if (keys.some((key) => !['dataClass', 'provenanceClass', 'reason', 'evidence'].includes(key))) {
    return json(request, { error: 'unsupported_import_authority_field' }, 400);
  }

  const reason = text(body.value.reason);
  if (!reason || reason.length > 1000) return json(request, { error: 'import_authority_reason_required' }, 400);
  if (body.value.evidence != null && !plainObject(body.value.evidence)) {
    return json(request, { error: 'invalid_import_authority_evidence' }, 400);
  }
  const requestedDataClass = body.value.dataClass == null ? null : text(body.value.dataClass);
  const requestedProvenanceClass = body.value.provenanceClass == null ? null : text(body.value.provenanceClass);
  if (requestedDataClass != null && !DATA_CLASSES.has(requestedDataClass)) {
    return json(request, { error: 'invalid_data_class' }, 400);
  }
  if (requestedProvenanceClass != null && !PROVENANCE_CLASSES.has(requestedProvenanceClass)) {
    return json(request, { error: 'invalid_provenance_class' }, 400);
  }

  const row = await route.storeDb.prepare(`
    SELECT b.import_id, b.source_file_name, b.content_sha256, b.status,
           a.data_class, a.provenance_class, a.authority_version,
           a.actor_user_id, a.reason, a.evidence_json, a.created_at AS authority_created_at,
           a.updated_at AS authority_updated_at
    FROM csv_import_batches b
    LEFT JOIN csv_import_authority a ON a.import_id=b.import_id
    WHERE b.import_id=?1
    LIMIT 1
  `).bind(importId).first();
  if (!row) return json(request, { error: 'import_not_found' }, 404);

  const exists = row.authority_version != null;
  if (!exists && (!requestedDataClass || !requestedProvenanceClass)) {
    return json(request, { error: 'initial_import_authority_requires_both_classes' }, 400);
  }
  const dataClass = requestedDataClass || row.data_class;
  const provenanceClass = requestedProvenanceClass || row.provenance_class;
  if (!dataClass || !provenanceClass) return json(request, { error: 'import_authority_class_required' }, 400);
  if (exists && dataClass === row.data_class && provenanceClass === row.provenance_class) {
    return json(request, { error: 'import_authority_no_change' }, 409);
  }

  const now = new Date().toISOString();
  const evidenceJson = JSON.stringify(body.value.evidence || {});
  const nextVersion = exists ? Number(row.authority_version) + 1 : 1;
  try {
    if (exists) {
      await route.storeDb.prepare(`
        UPDATE csv_import_authority
        SET data_class=?2, provenance_class=?3, authority_version=?4,
            actor_user_id=?5, reason=?6, evidence_json=?7, updated_at=?8
        WHERE import_id=?1
      `).bind(importId, dataClass, provenanceClass, nextVersion, actor.user_id, reason, evidenceJson, now).run();
    } else {
      await route.storeDb.prepare(`
        INSERT INTO csv_import_authority(
          import_id,data_class,provenance_class,authority_version,
          actor_user_id,reason,evidence_json,created_at,updated_at
        ) VALUES(?1,?2,?3,1,?4,?5,?6,?7,?7)
      `).bind(importId, dataClass, provenanceClass, actor.user_id, reason, evidenceJson, now).run();
    }
  } catch (error) {
    const message = error?.message || String(error);
    if (message.includes('CSV_IMPORT_AUTHORITY_') || message.includes('CSV_IMPORT_PROVENANCE_')) {
      return json(request, { error: 'import_authority_conflict', detail: authorityConflictDetail(message) }, 409);
    }
    throw error;
  }

  const updated = await route.storeDb.prepare(`
    SELECT import_id,data_class,provenance_class,authority_version,
           actor_user_id,reason,evidence_json,created_at,updated_at
    FROM csv_import_authority WHERE import_id=?1
  `).bind(importId).first();
  await audit(env.CONTROL_DB, request, actor.user_id, storeId, 'csv_import.authority_changed', importId, {
    previous: exists ? { dataClass: row.data_class, provenanceClass: row.provenance_class, authorityVersion: Number(row.authority_version) } : null,
    current: { dataClass, provenanceClass, authorityVersion: nextVersion },
    reason,
  }, 'csv_import');

  return json(request, {
    schemaVersion: 'csv-import-authority-v1',
    storeId,
    importId,
    authority: publicImportAuthority(updated),
  }, exists ? 200 : 201);
}

async function enrichImportsResponse({ request, response, env, actor, url }) {
  const storeId = pathStoreId(url.pathname);
  const route = await authorizedStoreDb(env, actor.user_id, storeId, 'ads.read');
  if (route.error) return response;
  const payload = await safeJson(response);
  if (!payload) return response;

  const importIds = [];
  if (Array.isArray(payload.items)) {
    for (const item of payload.items) if (text(item?.importId)) importIds.push(text(item.importId));
  }
  if (text(payload?.batch?.importId)) importIds.push(text(payload.batch.importId));
  const uniqueIds = [...new Set(importIds)].slice(0, MAX_LIMIT);
  if (!uniqueIds.length) return response;

  const rows = await selectByIds(route.storeDb, `
    SELECT b.import_id, b.advertiser_account_id,
           a.import_id AS authority_import_id, a.data_class, a.provenance_class,
           a.authority_version, a.actor_user_id, a.reason, a.evidence_json,
           a.created_at AS authority_created_at, a.updated_at AS authority_updated_at
    FROM csv_import_batches b
    LEFT JOIN csv_import_authority a ON a.import_id=b.import_id
    WHERE b.import_id IN (__PLACEHOLDERS__)
  `, uniqueIds);
  const rowByImport = new Map(rows.map((row) => [row.import_id, row]));

  if (Array.isArray(payload.items)) {
    payload.items = payload.items.map((item) => {
      const row = rowByImport.get(item.importId);
      return {
        ...item,
        advertiserAccountId: row?.advertiser_account_id || null,
        importAuthority: publicImportAuthority(row),
      };
    });
  }
  if (payload.batch) {
    const row = rowByImport.get(payload.batch.importId);
    payload.batch = {
      ...payload.batch,
      advertiserAccountId: row?.advertiser_account_id || null,
      importAuthority: publicImportAuthority(row),
    };
  }
  payload.authorityContract = {
    schemaVersion: 'csv-import-authority-v1',
    analyticsGate: "dataClass == 'business'",
    recommendationReviewGate: "dataClass == 'business' and provenanceClass in ['exact_source_object','reconciled_exact_source']",
    missingAuthority: 'fail_closed',
  };
  return jsonFromResponse(request, response, payload);
}

async function enrichCsvIntelligenceResponse({ request, response, env, actor, url }) {
  const storeId = pathStoreId(url.pathname);
  const route = await authorizedStoreDb(env, actor.user_id, storeId, 'analytics.read');
  if (route.error) return response;
  const payload = await safeJson(response);
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) return response;

  const ids = [...new Set(payload.items.map((item) => text(item?.entity?.entityId)).filter(Boolean))].slice(0, MAX_LIMIT);
  if (!ids.length) return response;
  const rows = await selectByIds(route.storeDb, `
    SELECT row_key, advertiser_account_id, campaign_id, ad_group_id, targeting_id, targeting_identity_state
    FROM csv_search_term_daily
    WHERE row_key IN (__PLACEHOLDERS__)
  `, ids);
  const identityByRow = new Map(rows.map((row) => [row.row_key, row]));
  let resolved = 0;
  let unresolved = 0;

  payload.items = payload.items.map((item) => {
    const row = identityByRow.get(text(item?.entity?.entityId));
    if (!row) return item;
    const identityState = row.targeting_identity_state || 'unresolved';
    if (identityState === 'resolved_id') resolved += 1;
    else if (identityState === 'unresolved') unresolved += 1;
    return {
      ...item,
      entity: {
        ...item.entity,
        campaignId: row.campaign_id || null,
        adGroupId: row.ad_group_id || null,
        targetId: row.targeting_id || null,
        targetingIdentityState: identityState,
        identityResolved: false,
      },
      evidence: {
        ...item.evidence,
        advertiserAccountId: row.advertiser_account_id || null,
        campaignId: row.campaign_id || null,
        adGroupId: row.ad_group_id || null,
        targetingId: row.targeting_id || null,
        targetingIdentityState: identityState,
        csvTargetingIdentityResolved: identityState === 'resolved_id',
        identityResolved: false,
      },
    };
  });

  payload.source = {
    ...(payload.source || {}),
    observedCsvEntityIdsIncluded: true,
    amazonEntityIdentityResolved: false,
    governancePersistenceAllowed: false,
    amazonMutationAuthorized: false,
  };
  payload.summary = {
    ...(payload.summary || {}),
    csvResolvedTargetingItemCount: resolved,
    csvUnresolvedTargetingItemCount: unresolved,
    authoritativeRecommendationCount: 0,
    governancePersistenceAllowed: false,
    amazonMutationAuthorized: false,
  };
  return jsonFromResponse(request, response, payload);
}

async function handleAdvisoryReviewRoute({ request, env, actor, url, match }) {
  const storeId = safeDecode(match[1]);
  const reviewId = match[2] ? safeDecode(match[2]) : null;
  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  if (match[2] && !reviewId) return json(request, { error: 'invalid_review_id' }, 400);
  const method = request.method.toUpperCase();

  if (method === 'GET') {
    const route = await authorizedStoreDb(env, actor.user_id, storeId, 'analytics.read');
    if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);
    return reviewId
      ? advisoryReviewDetail(request, route.storeDb, storeId, reviewId)
      : listAdvisoryReviews(request, route.storeDb, storeId, url);
  }

  const route = await authorizedStoreDb(env, actor.user_id, storeId, 'ads.write');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);
  if (!reviewId && method === 'POST') {
    return createAdvisoryReview(request, env.CONTROL_DB, route.storeDb, actor, storeId);
  }
  if (reviewId && method === 'PATCH') {
    return transitionAdvisoryReview(request, env.CONTROL_DB, route.storeDb, actor, storeId, reviewId);
  }
  return json(request, { error: 'method_not_allowed' }, 405);
}

async function listAdvisoryReviews(request, db, storeId, url) {
  const sourceKind = optionalSourceKind(url.searchParams.get('sourceKind'));
  if (sourceKind.error) return json(request, { error: sourceKind.error }, 400);
  const state = optionalState(url.searchParams.get('state'));
  if (state.error) return json(request, { error: state.error }, 400);
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit.error) return json(request, { error: limit.error }, 400);

  const result = await db.prepare(`
    SELECT review_id, source_kind, recommendation_fingerprint, entity_type, entity_id,
           recommendation_family, recommendation_action_type, state, reviewer_user_id,
           reviewer_note, reviewed_at, snoozed_until, source_evidence_json,
           source_evidence_sha256, created_by, created_at, updated_at
    FROM advisory_review_records
    WHERE (?1 IS NULL OR source_kind=?1)
      AND (?2 IS NULL OR state=?2)
    ORDER BY updated_at DESC, review_id DESC
    LIMIT ?3
  `).bind(sourceKind.value, state.value, limit.value).all();
  return json(request, {
    schemaVersion: 'advisory-review-v1',
    storeId,
    authority: advisoryAuthority(),
    items: (result.results || []).map(publicReview),
  }, 200);
}

async function advisoryReviewDetail(request, db, storeId, reviewId) {
  const row = await db.prepare(`
    SELECT review_id, source_kind, recommendation_fingerprint, entity_type, entity_id,
           recommendation_family, recommendation_action_type, state, reviewer_user_id,
           reviewer_note, reviewed_at, snoozed_until, source_evidence_json,
           source_evidence_sha256, created_by, created_at, updated_at
    FROM advisory_review_records
    WHERE review_id=?1
    LIMIT 1
  `).bind(reviewId).first();
  if (!row) return json(request, { error: 'advisory_review_not_found' }, 404);
  return json(request, {
    schemaVersion: 'advisory-review-v1',
    storeId,
    authority: advisoryAuthority(),
    review: publicReview(row),
  }, 200);
}

async function createAdvisoryReview(request, controlDb, db, actor, storeId) {
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  if (body.value.sourceKind !== SOURCE_KIND) return json(request, { error: 'unsupported_advisory_source' }, 400);
  const fingerprint = lowerHex64(body.value.recommendationFingerprint);
  if (!fingerprint) return json(request, { error: 'invalid_recommendation_fingerprint' }, 400);
  if (text(body.value.entityType) !== 'search_term') return json(request, { error: 'invalid_entity_type' }, 400);
  const entityId = text(body.value.entityId);
  const family = text(body.value.recommendationFamily);
  const actionType = text(body.value.recommendationActionType);
  if (!entityId || !family || !actionType) return json(request, { error: 'advisory_binding_required' }, 400);

  const evidenceInput = plainObject(body.value.evidence) ? body.value.evidence : null;
  if (!evidenceInput) return json(request, { error: 'advisory_evidence_required' }, 400);
  const importIds = uniqueTexts(evidenceInput.sourceImportIds);
  const hashes = uniqueTexts(evidenceInput.contentSha256s).map((value) => value.toLowerCase());
  if (!importIds.length || !hashes.length || hashes.some((value) => !HEX64.test(value))) {
    return json(request, { error: 'invalid_advisory_import_evidence' }, 400);
  }

  const batches = await selectByIds(db, `
    SELECT b.import_id, b.content_sha256, b.status, b.advertiser_account_id,
           a.data_class, a.provenance_class, a.authority_version
    FROM csv_import_batches b
    LEFT JOIN csv_import_authority a ON a.import_id=b.import_id
    WHERE b.import_id IN (__PLACEHOLDERS__)
  `, importIds);
  if (batches.length !== importIds.length || batches.some((row) => row.status !== 'published')) {
    return json(request, { error: 'advisory_import_evidence_not_published' }, 409);
  }
  const ungoverned = batches
    .filter((row) => row.data_class !== 'business' || !GOVERNED_PROVENANCE.has(row.provenance_class))
    .map((row) => row.import_id)
    .sort();
  if (ungoverned.length) {
    return json(request, { error: 'advisory_import_authority_not_governed', importIds: ungoverned }, 409);
  }
  const serverHashes = [...new Set(batches.map((row) => String(row.content_sha256 || '').toLowerCase()))].sort();
  if (!sameSet(serverHashes, [...new Set(hashes)].sort())) {
    return json(request, { error: 'advisory_content_hash_mismatch' }, 409);
  }

  const fact = await db.prepare(`
    SELECT row_key, source_import_id, advertiser_account_id, campaign_id, ad_group_id,
           targeting_id, targeting_identity_state, report_date
    FROM csv_search_term_daily
    WHERE row_key=?1
    LIMIT 1
  `).bind(entityId).first();
  if (!fact || !importIds.includes(fact.source_import_id)) {
    return json(request, { error: 'advisory_entity_evidence_mismatch' }, 409);
  }

  const sourceEvidence = {
    sourceKind: SOURCE_KIND,
    sourceImportIds: [...importIds].sort(),
    contentSha256s: serverHashes,
    importAuthority: batches.map((row) => ({
      importId: row.import_id,
      dataClass: row.data_class,
      provenanceClass: row.provenance_class,
      authorityVersion: Number(row.authority_version),
    })).sort((left, right) => left.importId.localeCompare(right.importId)),
    entityId,
    sourceImportId: fact.source_import_id,
    reportDate: fact.report_date,
    advertiserAccountId: fact.advertiser_account_id || null,
    campaignId: fact.campaign_id || null,
    adGroupId: fact.ad_group_id || null,
    targetingId: fact.targeting_id || null,
    targetingIdentityState: fact.targeting_identity_state || 'unresolved',
    amazonProfileId: null,
  };
  const sourceEvidenceJson = JSON.stringify(sourceEvidence);
  const sourceEvidenceSha256 = await sha256Hex(sourceEvidenceJson);

  const existing = await db.prepare(`
    SELECT * FROM advisory_review_records
    WHERE source_kind=?1 AND recommendation_fingerprint=?2
    LIMIT 1
  `).bind(SOURCE_KIND, fingerprint).first();
  if (existing) {
    if (existing.source_evidence_sha256 !== sourceEvidenceSha256) {
      return json(request, { error: 'advisory_review_evidence_conflict' }, 409);
    }
    return json(request, {
      schemaVersion: 'advisory-review-v1',
      storeId,
      reused: true,
      authority: advisoryAuthority(),
      review: publicReview(existing),
    }, 200);
  }

  const now = new Date().toISOString();
  const reviewId = `adv-${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO advisory_review_records(
      review_id, source_kind, recommendation_fingerprint, entity_type, entity_id,
      recommendation_family, recommendation_action_type, state, source_evidence_json,
      source_evidence_sha256, created_by, created_at, updated_at
    ) VALUES(?1,?2,?3,'search_term',?4,?5,?6,'open',?7,?8,?9,?10,?10)
  `).bind(
    reviewId, SOURCE_KIND, fingerprint, entityId, family, actionType,
    sourceEvidenceJson, sourceEvidenceSha256, actor.user_id, now,
  ).run();
  const row = await db.prepare('SELECT * FROM advisory_review_records WHERE review_id=?1').bind(reviewId).first();
  await audit(controlDb, request, actor.user_id, storeId, 'advisory_review.created', reviewId, {
    sourceKind: SOURCE_KIND,
    recommendationFingerprint: fingerprint,
    entityId,
    sourceEvidenceSha256,
  });
  return json(request, {
    schemaVersion: 'advisory-review-v1',
    storeId,
    reused: false,
    authority: advisoryAuthority(),
    review: publicReview(row),
  }, 201);
}

async function transitionAdvisoryReview(request, controlDb, db, actor, storeId, reviewId) {
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const keys = Object.keys(body.value);
  if (keys.some((key) => !['state', 'note', 'snoozedUntil'].includes(key))) {
    return json(request, { error: 'unsupported_advisory_review_field' }, 400);
  }
  const state = text(body.value.state);
  if (!ADVISORY_STATES.has(state)) return json(request, { error: 'invalid_advisory_review_state' }, 400);
  const note = optionalText(body.value.note, 4000);
  if (note.error) return json(request, { error: note.error }, 400);
  let snoozedUntil = null;
  if (state === 'snoozed') {
    snoozedUntil = text(body.value.snoozedUntil);
    const parsed = new Date(snoozedUntil);
    if (!snoozedUntil || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return json(request, { error: 'invalid_snoozed_until' }, 400);
    }
    snoozedUntil = parsed.toISOString();
  } else if (body.value.snoozedUntil != null) {
    return json(request, { error: 'snoozed_until_requires_snoozed_state' }, 400);
  }

  const existing = await db.prepare('SELECT * FROM advisory_review_records WHERE review_id=?1 LIMIT 1').bind(reviewId).first();
  if (!existing) return json(request, { error: 'advisory_review_not_found' }, 404);
  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE advisory_review_records
    SET state=?2, reviewer_user_id=?3, reviewer_note=?4, reviewed_at=?5,
        snoozed_until=?6, updated_at=?5
    WHERE review_id=?1
  `).bind(reviewId, state, actor.user_id, note.value, now, snoozedUntil).run();
  const row = await db.prepare('SELECT * FROM advisory_review_records WHERE review_id=?1').bind(reviewId).first();
  await audit(controlDb, request, actor.user_id, storeId, 'advisory_review.state_changed', reviewId, {
    previousState: existing.state,
    state,
    snoozedUntil,
  });
  return json(request, {
    schemaVersion: 'advisory-review-v1',
    storeId,
    authority: advisoryAuthority(),
    review: publicReview(row),
  }, 200);
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
    state: row.state,
    reviewerUserId: row.reviewer_user_id || null,
    note: row.reviewer_note || null,
    reviewedAt: row.reviewed_at || null,
    snoozedUntil: row.snoozed_until || null,
    sourceEvidence: parseJson(row.source_evidence_json),
    sourceEvidenceSha256: row.source_evidence_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    authority: advisoryAuthority(),
  };
}

function publicImportAuthority(row) {
  const hasAuthority = Boolean(row?.authority_import_id || row?.import_id && row?.authority_version != null);
  const dataClass = hasAuthority ? row.data_class : 'unclassified';
  const provenanceClass = hasAuthority ? row.provenance_class : 'unknown';
  const analyticsAllowed = dataClass === 'business';
  const governed = analyticsAllowed && GOVERNED_PROVENANCE.has(provenanceClass);
  return {
    schemaVersion: 'csv-import-authority-v1',
    classified: hasAuthority,
    dataClass,
    provenanceClass,
    authorityVersion: hasAuthority ? Number(row.authority_version) : null,
    analyticsAllowed,
    recommendationAllowed: governed,
    reviewAllowed: governed,
    actorUserId: hasAuthority ? (row.actor_user_id || null) : null,
    reason: hasAuthority ? (row.reason || null) : null,
    evidence: hasAuthority ? parseJson(row.evidence_json) : {},
    createdAt: hasAuthority ? (row.authority_created_at || row.created_at || null) : null,
    updatedAt: hasAuthority ? (row.authority_updated_at || row.updated_at || null) : null,
  };
}

function advisoryAuthority() {
  return {
    authoritative: false,
    mode: 'advisory_review_only',
    amazonProfileIdentityResolved: false,
    optimizationActionPersistenceAuthorized: false,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
    executionPermitSupported: false,
  };
}

async function authorizedStoreDb(env, userId, storeId, permission) {
  if (!env.CONTROL_DB) return { error: 'control_db_not_bound', status: 503 };
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error: 'forbidden', permission, status: 403 };
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, store_code, display_name, marketplace_code, d1_binding_key, status
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
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

async function audit(db, request, actorUserId, storeId, action, entityId, details, entityType = 'advisory_review') {
  try {
    await db.prepare(`
      INSERT INTO audit_log(event_id, actor_user_id, store_id, action, entity_type, entity_id, request_id, cf_ray, details_json)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
    `).bind(
      crypto.randomUUID(), actorUserId, storeId, action, entityType, entityId,
      request.headers.get('cf-ray') || crypto.randomUUID(), request.headers.get('cf-ray'), JSON.stringify(details || {}),
    ).run();
  } catch (error) {
    console.error('productization_audit_failed', { action, entityType, message: error?.message || String(error) });
  }
}

async function selectByIds(db, sqlTemplate, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(',');
  const sql = sqlTemplate.replace('__PLACEHOLDERS__', placeholders);
  const result = await db.prepare(sql).bind(...ids).all();
  return result.results || [];
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { error: 'request_body_too_large' };
  let raw;
  try { raw = await request.text(); } catch { return { error: 'request_body_unreadable' }; }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return { error: 'request_body_too_large' };
  let value;
  try { value = JSON.parse(raw); } catch { return { error: 'invalid_json' }; }
  if (!plainObject(value)) return { error: 'invalid_json_object' };
  return { value };
}

function authorityConflictDetail(message) {
  for (const code of [
    'CSV_IMPORT_AUTHORITY_BATCH_REQUIRED',
    'CSV_IMPORT_AUTHORITY_SOURCE_OBJECT_REQUIRED',
    'CSV_IMPORT_AUTHORITY_VERSION_INVALID',
    'CSV_IMPORT_PROVENANCE_TRANSITION_INVALID',
    'CSV_IMPORT_AUTHORITY_IDENTITY_IMMUTABLE',
  ]) {
    if (message.includes(code)) return code;
  }
  return 'CSV_IMPORT_AUTHORITY_CONFLICT';
}
function pathStoreId(pathname) {
  const match = pathname.match(/^\/api\/v1\/stores\/([^/]+)\//);
  return match ? safeDecode(match[1]) : null;
}
function safeDecode(value) { try { return decodeURIComponent(value); } catch { return null; } }
function text(value) { return String(value ?? '').trim(); }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function parseJson(value) { try { return JSON.parse(value); } catch { return {}; } }
function uniqueTexts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))].slice(0, MAX_LIMIT);
}
function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function lowerHex64(value) {
  const normalized = text(value).toLowerCase();
  return HEX64.test(normalized) ? normalized : null;
}
function optionalSourceKind(value) {
  const normalized = text(value);
  if (!normalized) return { value: null };
  return SAFE_SOURCE.test(normalized) ? { value: normalized } : { error: 'invalid_source_kind' };
}
function optionalState(value) {
  const normalized = text(value);
  if (!normalized) return { value: null };
  return ADVISORY_STATES.has(normalized) ? { value: normalized } : { error: 'invalid_advisory_review_state' };
}
function parseLimit(value) {
  if (value == null || value === '') return { value: DEFAULT_LIMIT };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) return { error: 'invalid_limit' };
  return { value: parsed };
}
function optionalText(value, maxLength) {
  if (value == null) return { value: null };
  const normalized = String(value).trim();
  if (!normalized) return { value: null };
  if (normalized.length > maxLength) return { error: 'review_note_too_long' };
  return { value: normalized };
}
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function safeJson(response) {
  try { return await response.clone().json(); } catch { return null; }
}
function jsonFromResponse(request, response, payload) {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  const ray = request.headers.get('cf-ray');
  if (ray && !headers.has('x-request-id')) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status: response.status, headers });
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