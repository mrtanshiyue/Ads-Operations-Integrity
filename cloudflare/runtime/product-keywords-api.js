const READ_BODY_LIMIT = 64 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PRIORITY = 1000;

export async function handleProductKeywordsApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/products\/([^/]+)\/keywords(?:\/([^/]+))?$/);
  if (!match) return null;

  const method = request.method.toUpperCase();
  const productId = safeDecode(match[1]);
  const keywordId = match[2] ? safeDecode(match[2]) : null;
  if (!productId) return json(request, { error: 'invalid_product_id' }, 400);
  if (match[2] && !keywordId) return json(request, { error: 'invalid_keyword_id' }, 400);

  const db = env.CONTROL_DB;
  if (!keywordId) {
    if (method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405);
    return listProductKeywords(request, db, actor, url, productId);
  }

  if (method === 'PUT') return putProductKeyword(request, db, actor, productId, keywordId);
  if (method === 'DELETE') return deleteProductKeyword(request, db, actor, productId, keywordId);
  return json(request, { error: 'method_not_allowed' }, 405);
}

async function listProductKeywords(request, db, actor, url, productId) {
  if (!await hasAssignedPermission(db, actor.user_id, 'products.read')) {
    return json(request, { error: 'forbidden', permission: 'products.read' }, 403);
  }
  if (!await hasAssignedPermission(db, actor.user_id, 'keywords.read')) {
    return json(request, { error: 'forbidden', permission: 'keywords.read' }, 403);
  }

  const product = await productById(db, productId);
  if (!product) return json(request, { error: 'product_not_found' }, 404);

  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const lifecycleStatus = optionalEnum(url.searchParams.get('lifecycleStatus'), ['active', 'watch', 'retired']);
  if (lifecycleStatus.error) return json(request, { error: 'invalid_keyword_status' }, 400);
  const isPrimary = optionalBoolean(url.searchParams.get('isPrimary'));
  if (isPrimary.error) return json(request, { error: 'invalid_is_primary' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const cursor = decodeCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);

  const result = await db.prepare(`
    SELECT
      k.keyword_id,
      k.keyword_text,
      k.normalized_term,
      k.language_code,
      k.intent_class,
      k.semantic_cluster,
      k.lifecycle_status,
      k.source_type,
      k.notes AS keyword_notes,
      m.relevance_score,
      m.priority,
      m.is_primary,
      m.notes AS mapping_notes,
      m.created_at AS mapped_at,
      m.updated_at AS mapping_updated_at
    FROM keyword_product_map m
    JOIN keyword_library k ON k.keyword_id = m.keyword_id
    WHERE m.product_id = ?1
      AND (?2 IS NULL OR k.lifecycle_status = ?2)
      AND (?3 IS NULL OR m.is_primary = ?3)
      AND (?4 IS NULL OR k.keyword_text LIKE ?4 ESCAPE '\\' OR k.normalized_term LIKE ?4 ESCAPE '\\' OR k.semantic_cluster LIKE ?4 ESCAPE '\\')
      AND (?5 IS NULL OR m.updated_at < ?5 OR (m.updated_at = ?5 AND m.keyword_id < ?6))
    ORDER BY m.updated_at DESC, m.keyword_id DESC
    LIMIT ?7
  `).bind(
    productId,
    lifecycleStatus.value,
    isPrimary.value,
    q ? `%${escapeLike(q)}%` : null,
    cursor.value?.updatedAt || null,
    cursor.value?.keywordId || null,
    paging.limit + 1,
  ).all();

  const rows = (result.results || []).map(publicMapping);
  const hasMore = rows.length > paging.limit;
  const items = hasMore ? rows.slice(0, paging.limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last
    ? encodeCursor({ updatedAt: last.updatedAt, keywordId: last.keywordId })
    : null;

  return json(request, {
    product: publicProduct(product),
    items,
    nextCursor,
  }, 200);
}

async function putProductKeyword(request, db, actor, productId, keywordId) {
  const permission = await requireGlobalGovernancePermission(db, actor.user_id);
  if (permission) return json(request, { error: 'forbidden', permission }, 403);

  const product = await productById(db, productId);
  if (!product) return json(request, { error: 'product_not_found' }, 404);
  const keyword = await keywordById(db, keywordId);
  if (!keyword) return json(request, { error: 'keyword_not_found' }, 404);

  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateMapping(body.value);
  if (value.error) return json(request, { error: value.error }, 400);

  const existing = await mappingByIds(db, productId, keywordId);
  await db.prepare(`
    INSERT INTO keyword_product_map(
      keyword_id, product_id, relevance_score, priority, is_primary, notes, created_at, updated_at
    ) VALUES(?1,?2,?3,?4,?5,?6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(keyword_id, product_id) DO UPDATE SET
      relevance_score=excluded.relevance_score,
      priority=excluded.priority,
      is_primary=excluded.is_primary,
      notes=excluded.notes,
      updated_at=CURRENT_TIMESTAMP
  `).bind(keywordId, productId, value.relevanceScore, value.priority, value.isPrimary ? 1 : 0, value.notes).run();

  await audit(db, request, actor.user_id, 'product_keyword.upsert', 'keyword_product_map', `${productId}:${keywordId}`, {
    productId,
    keywordId,
    relevanceScore: value.relevanceScore,
    priority: value.priority,
    isPrimary: value.isPrimary,
  });

  const mapping = await mappingDetailByIds(db, productId, keywordId);
  return json(request, {
    product: publicProduct(product),
    mapping: publicMapping(mapping),
  }, existing ? 200 : 201);
}

async function deleteProductKeyword(request, db, actor, productId, keywordId) {
  const permission = await requireGlobalGovernancePermission(db, actor.user_id);
  if (permission) return json(request, { error: 'forbidden', permission }, 403);

  const product = await productById(db, productId);
  if (!product) return json(request, { error: 'product_not_found' }, 404);
  const keyword = await keywordById(db, keywordId);
  if (!keyword) return json(request, { error: 'keyword_not_found' }, 404);
  const existing = await mappingByIds(db, productId, keywordId);
  if (!existing) return json(request, { error: 'product_keyword_mapping_not_found' }, 404);

  await db.prepare(`
    DELETE FROM keyword_product_map
    WHERE product_id=?1 AND keyword_id=?2
  `).bind(productId, keywordId).run();

  await audit(db, request, actor.user_id, 'product_keyword.delete', 'keyword_product_map', `${productId}:${keywordId}`, {
    productId,
    keywordId,
  });

  return json(request, { deleted: true, productId, keywordId }, 200);
}

async function requireGlobalGovernancePermission(db, userId) {
  if (!await hasGlobalPermission(db, userId, 'products.manage')) return 'products.manage';
  if (!await hasGlobalPermission(db, userId, 'keywords.manage')) return 'keywords.manage';
  return null;
}

async function hasGlobalPermission(db, userId, permission) {
  return Boolean(await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN app_roles ar ON ar.role_key = ugr.role_key AND ar.role_scope = 'global'
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2
    LIMIT 1
  `).bind(userId, permission).first());
}

async function hasAssignedPermission(db, userId, permission) {
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM role_permissions rp
    JOIN (
      SELECT role_key FROM user_global_roles WHERE user_id=?1
      UNION
      SELECT role_key FROM store_members WHERE user_id=?1
    ) assigned ON assigned.role_key=rp.role_key
    WHERE rp.permission_key=?2 LIMIT 1
  `).bind(userId, permission).first());
}

async function productById(db, productId) {
  return db.prepare(`
    SELECT product_id, model_code, model_name, brand, status, created_at, updated_at
    FROM products
    WHERE product_id=?1
    LIMIT 1
  `).bind(productId).first();
}

async function keywordById(db, keywordId) {
  return db.prepare(`
    SELECT keyword_id
    FROM keyword_library
    WHERE keyword_id=?1
    LIMIT 1
  `).bind(keywordId).first();
}

async function mappingByIds(db, productId, keywordId) {
  return db.prepare(`
    SELECT keyword_id, product_id
    FROM keyword_product_map
    WHERE product_id=?1 AND keyword_id=?2
    LIMIT 1
  `).bind(productId, keywordId).first();
}

async function mappingDetailByIds(db, productId, keywordId) {
  return db.prepare(`
    SELECT
      k.keyword_id,
      k.keyword_text,
      k.normalized_term,
      k.language_code,
      k.intent_class,
      k.semantic_cluster,
      k.lifecycle_status,
      k.source_type,
      k.notes AS keyword_notes,
      m.relevance_score,
      m.priority,
      m.is_primary,
      m.notes AS mapping_notes,
      m.created_at AS mapped_at,
      m.updated_at AS mapping_updated_at
    FROM keyword_product_map m
    JOIN keyword_library k ON k.keyword_id = m.keyword_id
    WHERE m.product_id=?1 AND m.keyword_id=?2
    LIMIT 1
  `).bind(productId, keywordId).first();
}

async function audit(db, request, actorUserId, action, entityType, entityId, details) {
  await db.prepare(`
    INSERT INTO audit_log(event_id, actor_user_id, action, entity_type, entity_id, request_id, cf_ray, details_json)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
  `).bind(
    crypto.randomUUID(),
    actorUserId,
    action,
    entityType,
    entityId,
    request.headers.get('cf-ray') || crypto.randomUUID(),
    request.headers.get('cf-ray'),
    JSON.stringify(details || {}),
  ).run();
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > READ_BODY_LIMIT) return { error: 'request_body_too_large' };
  const text = await request.text();
  if (text.length > READ_BODY_LIMIT) return { error: 'request_body_too_large' };
  try {
    return { value: JSON.parse(text || '{}') };
  } catch {
    return { error: 'invalid_json' };
  }
}

function validateMapping(input) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  const allowed = new Set(['relevanceScore', 'priority', 'isPrimary', 'notes']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { error: 'unsupported_product_keyword_field' };

  const relevanceScore = input.relevanceScore === undefined || input.relevanceScore === null
    ? null
    : Number(input.relevanceScore);
  if (relevanceScore !== null && (!Number.isInteger(relevanceScore) || relevanceScore < 0 || relevanceScore > 1000)) {
    return { error: 'invalid_relevance_score' };
  }

  const priority = input.priority === undefined ? 100 : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > MAX_PRIORITY) {
    return { error: 'invalid_priority' };
  }

  const isPrimary = input.isPrimary === undefined ? false : input.isPrimary;
  if (typeof isPrimary !== 'boolean') return { error: 'invalid_is_primary' };

  let notes = null;
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== 'string') return { error: 'invalid_mapping_notes' };
    notes = input.notes.trim();
    if (notes.length > 4000) return { error: 'mapping_notes_too_long' };
    if (!notes) notes = null;
  }

  return { relevanceScore, priority, isPrimary, notes };
}

function publicProduct(row) {
  return {
    productId: row.product_id,
    modelCode: row.model_code,
    modelName: row.model_name,
    brand: row.brand,
    productStatus: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicMapping(row) {
  return {
    keywordId: row.keyword_id,
    keywordText: row.keyword_text,
    normalizedTerm: row.normalized_term,
    languageCode: row.language_code,
    intentClass: row.intent_class,
    semanticCluster: row.semantic_cluster,
    lifecycleStatus: row.lifecycle_status,
    sourceType: row.source_type,
    keywordNotes: row.keyword_notes,
    relevanceScore: row.relevance_score,
    priority: row.priority,
    isPrimary: Boolean(row.is_primary),
    mappingNotes: row.mapping_notes,
    mappedAt: row.mapped_at,
    updatedAt: row.mapping_updated_at,
  };
}

function parsePaging(url) {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: 'invalid_limit' };
  return { limit, cursor: url.searchParams.get('cursor') };
}

function optionalEnum(value, allowed) {
  if (value === null || value === '') return { value: null };
  return allowed.includes(value) ? { value } : { error: true };
}

function optionalBoolean(value) {
  if (value === null || value === '') return { value: null };
  const normalized = String(value).toLowerCase();
  if (normalized === 'true' || normalized === '1') return { value: 1 };
  if (normalized === 'false' || normalized === '0') return { value: 0 };
  return { error: true };
}

function normalizeSearch(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 200) : null;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function encodeCursor(value) {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeCursor(value) {
  if (!value) return { value: null };
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    const parsed = JSON.parse(atob(padded));
    if (!parsed || typeof parsed.updatedAt !== 'string' || typeof parsed.keywordId !== 'string') return { error: true };
    return { value: parsed };
  } catch {
    return { error: true };
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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
