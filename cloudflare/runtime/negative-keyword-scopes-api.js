const READ_BODY_LIMIT = 32 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function handleNegativeKeywordScopesApiRoute({ request, env, actor, url }) {
  const productMatch = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/products\/([^/]+)\/negative-keywords(?:\/([^/]+))?$/);
  if (productMatch) {
    const storeId = safeDecode(productMatch[1]);
    const productId = safeDecode(productMatch[2]);
    const negativeKeywordId = productMatch[3] ? safeDecode(productMatch[3]) : null;
    if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
    if (!productId) return json(request, { error: 'invalid_product_id' }, 400);
    if (productMatch[3] && !negativeKeywordId) return json(request, { error: 'invalid_negative_keyword_id' }, 400);
    return handleProductScope({ request, db: env.CONTROL_DB, actor, url, storeId, productId, negativeKeywordId });
  }

  const storeMatch = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/negative-keywords(?:\/([^/]+))?$/);
  if (storeMatch) {
    const storeId = safeDecode(storeMatch[1]);
    const negativeKeywordId = storeMatch[2] ? safeDecode(storeMatch[2]) : null;
    if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
    if (storeMatch[2] && !negativeKeywordId) return json(request, { error: 'invalid_negative_keyword_id' }, 400);
    return handleStoreScope({ request, db: env.CONTROL_DB, actor, url, storeId, negativeKeywordId });
  }

  return null;
}

async function handleStoreScope({ request, db, actor, url, storeId, negativeKeywordId }) {
  const method = request.method.toUpperCase();
  if (!negativeKeywordId) {
    if (method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405);
    return listStoreScopes(request, db, actor, url, storeId);
  }
  if (method === 'PUT') return putStoreScope(request, db, actor, storeId, negativeKeywordId);
  if (method === 'DELETE') return deleteStoreScope(request, db, actor, storeId, negativeKeywordId);
  return json(request, { error: 'method_not_allowed' }, 405);
}

async function handleProductScope({ request, db, actor, url, storeId, productId, negativeKeywordId }) {
  const method = request.method.toUpperCase();
  if (!negativeKeywordId) {
    if (method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405);
    return listProductScopes(request, db, actor, url, storeId, productId);
  }
  if (method === 'PUT') return putProductScope(request, db, actor, storeId, productId, negativeKeywordId);
  if (method === 'DELETE') return deleteProductScope(request, db, actor, storeId, productId, negativeKeywordId);
  return json(request, { error: 'method_not_allowed' }, 405);
}

async function listStoreScopes(request, db, actor, url, storeId) {
  if (!await hasStorePermission(db, actor.user_id, storeId, 'negatives.read')) {
    return json(request, { error: 'forbidden', permission: 'negatives.read' }, 403);
  }
  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);

  const filters = parseListFilters(url);
  if (filters.error) return json(request, { error: filters.error }, 400);

  const result = await db.prepare(`
    SELECT
      n.negative_keyword_id,
      n.keyword_text,
      n.normalized_term,
      n.match_type,
      n.reason_code,
      n.status AS keyword_status,
      n.notes,
      s.status AS scope_status,
      s.created_at AS scope_created_at
    FROM negative_store_scope s
    JOIN negative_keyword_library n ON n.negative_keyword_id = s.negative_keyword_id
    WHERE s.store_id = ?1
      AND (?2 IS NULL OR s.status = ?2)
      AND (?3 IS NULL OR n.status = ?3)
      AND (?4 IS NULL OR n.match_type = ?4)
      AND (?5 IS NULL OR n.keyword_text LIKE ?5 ESCAPE '\\' OR n.normalized_term LIKE ?5 ESCAPE '\\')
      AND (?6 IS NULL OR s.created_at < ?6 OR (s.created_at = ?6 AND n.negative_keyword_id < ?7))
    ORDER BY s.created_at DESC, n.negative_keyword_id DESC
    LIMIT ?8
  `).bind(
    storeId,
    filters.scopeStatus,
    filters.keywordStatus,
    filters.matchType,
    filters.like,
    filters.cursor?.createdAt || null,
    filters.cursor?.negativeKeywordId || null,
    filters.limit + 1,
  ).all();

  return scopedPage(request, store, null, result.results || [], filters.limit);
}

async function listProductScopes(request, db, actor, url, storeId, productId) {
  if (!await hasStorePermission(db, actor.user_id, storeId, 'negatives.read')) {
    return json(request, { error: 'forbidden', permission: 'negatives.read' }, 403);
  }
  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);
  const product = await productById(db, productId);
  if (!product) return json(request, { error: 'product_not_found' }, 404);
  if (!await productInStore(db, storeId, productId)) {
    return json(request, { error: 'product_not_in_store', storeId, productId }, 409);
  }

  const filters = parseListFilters(url);
  if (filters.error) return json(request, { error: filters.error }, 400);

  const result = await db.prepare(`
    SELECT
      n.negative_keyword_id,
      n.keyword_text,
      n.normalized_term,
      n.match_type,
      n.reason_code,
      n.status AS keyword_status,
      n.notes,
      s.status AS scope_status,
      s.created_at AS scope_created_at
    FROM negative_product_scope s
    JOIN negative_keyword_library n ON n.negative_keyword_id = s.negative_keyword_id
    WHERE s.store_id = ?1
      AND s.product_id = ?2
      AND (?3 IS NULL OR s.status = ?3)
      AND (?4 IS NULL OR n.status = ?4)
      AND (?5 IS NULL OR n.match_type = ?5)
      AND (?6 IS NULL OR n.keyword_text LIKE ?6 ESCAPE '\\' OR n.normalized_term LIKE ?6 ESCAPE '\\')
      AND (?7 IS NULL OR s.created_at < ?7 OR (s.created_at = ?7 AND n.negative_keyword_id < ?8))
    ORDER BY s.created_at DESC, n.negative_keyword_id DESC
    LIMIT ?9
  `).bind(
    storeId,
    productId,
    filters.scopeStatus,
    filters.keywordStatus,
    filters.matchType,
    filters.like,
    filters.cursor?.createdAt || null,
    filters.cursor?.negativeKeywordId || null,
    filters.limit + 1,
  ).all();

  return scopedPage(request, store, product, result.results || [], filters.limit);
}

async function putStoreScope(request, db, actor, storeId, negativeKeywordId) {
  if (!await hasStorePermission(db, actor.user_id, storeId, 'negatives.manage')) {
    return json(request, { error: 'forbidden', permission: 'negatives.manage' }, 403);
  }
  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);
  const negative = await negativeKeywordById(db, negativeKeywordId);
  if (!negative) return json(request, { error: 'negative_keyword_not_found' }, 404);

  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateScopeBody(body.value);
  if (value.error) return json(request, { error: value.error }, 400);
  if (value.status === 'active' && negative.status !== 'active') {
    return json(request, { error: 'negative_keyword_retired' }, 409);
  }

  const existing = await storeScopeByIds(db, storeId, negativeKeywordId);
  await db.prepare(`
    INSERT INTO negative_store_scope(store_id, negative_keyword_id, status, created_at)
    VALUES(?1,?2,?3,CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, negative_keyword_id) DO UPDATE SET
      status=excluded.status
  `).bind(storeId, negativeKeywordId, value.status).run();

  await audit(db, request, actor.user_id, storeId, 'negative_store_scope.upsert', 'negative_store_scope',
    `${storeId}:${negativeKeywordId}`, { storeId, negativeKeywordId, status: value.status });

  const scope = await storeScopeDetailByIds(db, storeId, negativeKeywordId);
  return json(request, { store: publicStore(store), scope: publicScope(scope) }, existing ? 200 : 201);
}

async function deleteStoreScope(request, db, actor, storeId, negativeKeywordId) {
  if (!await hasStorePermission(db, actor.user_id, storeId, 'negatives.manage')) {
    return json(request, { error: 'forbidden', permission: 'negatives.manage' }, 403);
  }
  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);
  const existing = await storeScopeByIds(db, storeId, negativeKeywordId);
  if (!existing) return json(request, { error: 'negative_store_scope_not_found' }, 404);

  await db.prepare(`
    DELETE FROM negative_store_scope
    WHERE store_id=?1 AND negative_keyword_id=?2
  `).bind(storeId, negativeKeywordId).run();

  await audit(db, request, actor.user_id, storeId, 'negative_store_scope.delete', 'negative_store_scope',
    `${storeId}:${negativeKeywordId}`, { storeId, negativeKeywordId });

  return json(request, { deleted: true, storeId, negativeKeywordId }, 200);
}

async function putProductScope(request, db, actor, storeId, productId, negativeKeywordId) {
  if (!await hasStorePermission(db, actor.user_id, storeId, 'negatives.manage')) {
    return json(request, { error: 'forbidden', permission: 'negatives.manage' }, 403);
  }
  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);
  const product = await productById(db, productId);
  if (!product) return json(request, { error: 'product_not_found' }, 404);
  if (!await productInStore(db, storeId, productId)) {
    return json(request, { error: 'product_not_in_store', storeId, productId }, 409);
  }
  const negative = await negativeKeywordById(db, negativeKeywordId);
  if (!negative) return json(request, { error: 'negative_keyword_not_found' }, 404);

  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateScopeBody(body.value);
  if (value.error) return json(request, { error: value.error }, 400);
  if (value.status === 'active' && negative.status !== 'active') {
    return json(request, { error: 'negative_keyword_retired' }, 409);
  }

  const existing = await productScopeByIds(db, storeId, productId, negativeKeywordId);
  await db.prepare(`
    INSERT INTO negative_product_scope(store_id, product_id, negative_keyword_id, status, created_at)
    VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, product_id, negative_keyword_id) DO UPDATE SET
      status=excluded.status
  `).bind(storeId, productId, negativeKeywordId, value.status).run();

  await audit(db, request, actor.user_id, storeId, 'negative_product_scope.upsert', 'negative_product_scope',
    `${storeId}:${productId}:${negativeKeywordId}`, { storeId, productId, negativeKeywordId, status: value.status });

  const scope = await productScopeDetailByIds(db, storeId, productId, negativeKeywordId);
  return json(request, { store: publicStore(store), product: publicProduct(product), scope: publicScope(scope) }, existing ? 200 : 201);
}

async function deleteProductScope(request, db, actor, storeId, productId, negativeKeywordId) {
  if (!await hasStorePermission(db, actor.user_id, storeId, 'negatives.manage')) {
    return json(request, { error: 'forbidden', permission: 'negatives.manage' }, 403);
  }
  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);
  const product = await productById(db, productId);
  if (!product) return json(request, { error: 'product_not_found' }, 404);
  if (!await productInStore(db, storeId, productId)) {
    return json(request, { error: 'product_not_in_store', storeId, productId }, 409);
  }
  const existing = await productScopeByIds(db, storeId, productId, negativeKeywordId);
  if (!existing) return json(request, { error: 'negative_product_scope_not_found' }, 404);

  await db.prepare(`
    DELETE FROM negative_product_scope
    WHERE store_id=?1 AND product_id=?2 AND negative_keyword_id=?3
  `).bind(storeId, productId, negativeKeywordId).run();

  await audit(db, request, actor.user_id, storeId, 'negative_product_scope.delete', 'negative_product_scope',
    `${storeId}:${productId}:${negativeKeywordId}`, { storeId, productId, negativeKeywordId });

  return json(request, { deleted: true, storeId, productId, negativeKeywordId }, 200);
}

async function storeById(db, storeId) {
  return db.prepare(`
    SELECT store_id, store_code, display_name, marketplace_code, amazon_region, status
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
}

async function productById(db, productId) {
  return db.prepare(`
    SELECT product_id, model_code, model_name, brand, status
    FROM products
    WHERE product_id=?1
    LIMIT 1
  `).bind(productId).first();
}

async function productInStore(db, storeId, productId) {
  return Boolean(await db.prepare(`
    SELECT 1 AS ok
    FROM product_store_map
    WHERE store_id=?1 AND product_id=?2
    LIMIT 1
  `).bind(storeId, productId).first());
}

async function negativeKeywordById(db, negativeKeywordId) {
  return db.prepare(`
    SELECT negative_keyword_id, keyword_text, normalized_term, match_type, reason_code, status, notes
    FROM negative_keyword_library
    WHERE negative_keyword_id=?1
    LIMIT 1
  `).bind(negativeKeywordId).first();
}

async function storeScopeByIds(db, storeId, negativeKeywordId) {
  return db.prepare(`
    SELECT store_id, negative_keyword_id, status, created_at
    FROM negative_store_scope
    WHERE store_id=?1 AND negative_keyword_id=?2
    LIMIT 1
  `).bind(storeId, negativeKeywordId).first();
}

async function storeScopeDetailByIds(db, storeId, negativeKeywordId) {
  return db.prepare(`
    SELECT
      n.negative_keyword_id,
      n.keyword_text,
      n.normalized_term,
      n.match_type,
      n.reason_code,
      n.status AS keyword_status,
      n.notes,
      s.status AS scope_status,
      s.created_at AS scope_created_at
    FROM negative_store_scope s
    JOIN negative_keyword_library n ON n.negative_keyword_id = s.negative_keyword_id
    WHERE s.store_id=?1 AND s.negative_keyword_id=?2
    LIMIT 1
  `).bind(storeId, negativeKeywordId).first();
}

async function productScopeByIds(db, storeId, productId, negativeKeywordId) {
  return db.prepare(`
    SELECT store_id, product_id, negative_keyword_id, status, created_at
    FROM negative_product_scope
    WHERE store_id=?1 AND product_id=?2 AND negative_keyword_id=?3
    LIMIT 1
  `).bind(storeId, productId, negativeKeywordId).first();
}

async function productScopeDetailByIds(db, storeId, productId, negativeKeywordId) {
  return db.prepare(`
    SELECT
      n.negative_keyword_id,
      n.keyword_text,
      n.normalized_term,
      n.match_type,
      n.reason_code,
      n.status AS keyword_status,
      n.notes,
      s.status AS scope_status,
      s.created_at AS scope_created_at
    FROM negative_product_scope s
    JOIN negative_keyword_library n ON n.negative_keyword_id = s.negative_keyword_id
    WHERE s.store_id=?1 AND s.product_id=?2 AND s.negative_keyword_id=?3
    LIMIT 1
  `).bind(storeId, productId, negativeKeywordId).first();
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN app_roles ar ON ar.role_key = ugr.role_key AND ar.role_scope = 'global'
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2
    LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;

  return Boolean(await db.prepare(`
    SELECT 1 AS ok
    FROM store_members sm
    JOIN app_roles ar ON ar.role_key = sm.role_key AND ar.role_scope = 'store'
    JOIN role_permissions rp ON rp.role_key = sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3
    LIMIT 1
  `).bind(userId, storeId, permission).first());
}

async function audit(db, request, actorUserId, storeId, action, entityType, entityId, details) {
  await db.prepare(`
    INSERT INTO audit_log(event_id, actor_user_id, store_id, action, entity_type, entity_id, request_id, cf_ray, details_json)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
  `).bind(
    crypto.randomUUID(),
    actorUserId,
    storeId,
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

function validateScopeBody(input) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  if (Object.keys(input).some((key) => key !== 'status')) return { error: 'unsupported_negative_scope_field' };
  const status = input.status === undefined ? 'active' : input.status;
  if (!['active', 'disabled'].includes(status)) return { error: 'invalid_negative_scope_status' };
  return { status };
}

function parseListFilters(url) {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: 'invalid_limit' };

  const scopeStatus = optionalEnum(url.searchParams.get('scopeStatus'), ['active', 'disabled']);
  if (scopeStatus.error) return { error: 'invalid_negative_scope_status' };
  const keywordStatus = optionalEnum(url.searchParams.get('keywordStatus'), ['active', 'retired']);
  if (keywordStatus.error) return { error: 'invalid_negative_status' };
  const matchType = optionalEnum(url.searchParams.get('matchType'), ['EXACT', 'PHRASE']);
  if (matchType.error) return { error: 'invalid_negative_match_type' };

  const cursor = decodeCursor(url.searchParams.get('cursor'));
  if (cursor.error) return { error: 'invalid_cursor' };
  const q = normalizeSearch(url.searchParams.get('q'));

  return {
    limit,
    scopeStatus: scopeStatus.value,
    keywordStatus: keywordStatus.value,
    matchType: matchType.value,
    like: q ? `%${escapeLike(q)}%` : null,
    cursor: cursor.value,
  };
}

function scopedPage(request, store, product, rows, limit) {
  const mapped = rows.map(publicScope);
  const hasMore = mapped.length > limit;
  const items = hasMore ? mapped.slice(0, limit) : mapped;
  const last = items.at(-1);
  const payload = {
    store: publicStore(store),
    items,
    nextCursor: hasMore && last
      ? encodeCursor({ createdAt: last.createdAt, negativeKeywordId: last.negativeKeywordId })
      : null,
  };
  if (product) payload.product = publicProduct(product);
  return json(request, payload, 200);
}

function publicStore(row) {
  return {
    storeId: row.store_id,
    storeCode: row.store_code,
    displayName: row.display_name,
    marketplaceCode: row.marketplace_code,
    amazonRegion: row.amazon_region,
    status: row.status,
  };
}

function publicProduct(row) {
  return {
    productId: row.product_id,
    modelCode: row.model_code,
    modelName: row.model_name,
    brand: row.brand,
    productStatus: row.status,
  };
}

function publicScope(row) {
  return {
    negativeKeywordId: row.negative_keyword_id,
    keywordText: row.keyword_text,
    normalizedTerm: row.normalized_term,
    matchType: row.match_type,
    reasonCode: row.reason_code,
    keywordStatus: row.keyword_status,
    scopeStatus: row.scope_status,
    notes: row.notes,
    createdAt: row.scope_created_at,
  };
}

function optionalEnum(value, allowed) {
  if (value === null || value === '') return { value: null };
  return allowed.includes(value) ? { value } : { error: true };
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
    if (!parsed || typeof parsed.createdAt !== 'string' || typeof parsed.negativeKeywordId !== 'string') return { error: true };
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
