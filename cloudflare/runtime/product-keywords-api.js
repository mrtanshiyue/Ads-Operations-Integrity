const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function handleProductKeywordsApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/products\/([^/]+)\/keywords$/);
  if (!match) return null;
  if (request.method.toUpperCase() !== 'GET') {
    return json(request, { error: 'method_not_allowed' }, 405);
  }

  const productId = safeDecode(match[1]);
  if (!productId) return json(request, { error: 'invalid_product_id' }, 400);
  const db = env.CONTROL_DB;

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
