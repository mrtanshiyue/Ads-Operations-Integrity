const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function handleStoreProductsApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/products$/);
  if (!match || request.method.toUpperCase() !== 'GET') return null;
  if (!env.CONTROL_DB) return json(request, { error: 'control_db_not_bound' }, 503);

  const storeId = decodeURIComponent(match[1]);
  if (!await hasStorePermission(env.CONTROL_DB, actor.user_id, storeId, 'ads.read')) {
    return json(request, { error: 'forbidden', permission: 'ads.read' }, 403);
  }

  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, store_code, display_name, marketplace_code, amazon_region, status
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
  if (!store) return json(request, { error: 'store_not_found' }, 404);

  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const cursor = decodeCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);

  const productStatus = optionalEnum(url.searchParams.get('productStatus'), ['active', 'inactive', 'archived']);
  if (productStatus.error) return json(request, { error: 'invalid_product_status' }, 400);
  const listingStatus = optionalText(url.searchParams.get('listingStatus'), 80);
  const q = normalizeSearch(url.searchParams.get('q'));
  const like = q ? `%${escapeLike(q)}%` : null;

  const result = await env.CONTROL_DB.prepare(`
    SELECT
      p.product_id,
      p.model_code,
      p.model_name,
      p.brand,
      p.status AS product_status,
      p.attributes_json,
      psm.seller_sku,
      psm.asin,
      psm.parent_asin,
      psm.listing_status,
      psm.created_at AS mapped_at,
      psm.updated_at
    FROM product_store_map psm
    JOIN products p ON p.product_id = psm.product_id
    WHERE psm.store_id = ?1
      AND (?2 IS NULL OR p.status = ?2)
      AND (?3 IS NULL OR psm.listing_status = ?3)
      AND (
        ?4 IS NULL
        OR p.model_code LIKE ?4 ESCAPE '\\'
        OR p.model_name LIKE ?4 ESCAPE '\\'
        OR p.brand LIKE ?4 ESCAPE '\\'
        OR psm.seller_sku LIKE ?4 ESCAPE '\\'
        OR psm.asin LIKE ?4 ESCAPE '\\'
        OR psm.parent_asin LIKE ?4 ESCAPE '\\'
      )
      AND (
        ?5 IS NULL
        OR psm.updated_at < ?5
        OR (psm.updated_at = ?5 AND p.product_id < ?6)
        OR (psm.updated_at = ?5 AND p.product_id = ?6 AND psm.seller_sku < ?7)
      )
    ORDER BY psm.updated_at DESC, p.product_id DESC, psm.seller_sku DESC
    LIMIT ?8
  `).bind(
    storeId,
    productStatus.value,
    listingStatus,
    like,
    cursor.value?.updatedAt || null,
    cursor.value?.productId || null,
    cursor.value?.sellerSku || null,
    paging.limit + 1,
  ).all();

  const rows = (result.results || []).map(publicStoreProduct);
  const hasMore = rows.length > paging.limit;
  const items = hasMore ? rows.slice(0, paging.limit) : rows;
  const last = items.at(-1);

  return json(request, {
    store: {
      storeId: store.store_id,
      storeCode: store.store_code,
      displayName: store.display_name,
      marketplaceCode: store.marketplace_code,
      amazonRegion: store.amazon_region,
      status: store.status,
    },
    items,
    nextCursor: hasMore && last
      ? encodeCursor({ updatedAt: last.updatedAt, productId: last.productId, sellerSku: last.sellerSku })
      : null,
  }, 200);
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2
    LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;

  return Boolean(await db.prepare(`
    SELECT 1 AS ok
    FROM store_members sm
    JOIN role_permissions rp ON rp.role_key = sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3
    LIMIT 1
  `).bind(userId, storeId, permission).first());
}

function publicStoreProduct(row) {
  return {
    productId: row.product_id,
    modelCode: row.model_code,
    modelName: row.model_name,
    brand: row.brand,
    productStatus: row.product_status,
    attributes: parseJsonObject(row.attributes_json),
    sellerSku: row.seller_sku,
    asin: row.asin,
    parentAsin: row.parent_asin,
    listingStatus: row.listing_status,
    mappedAt: row.mapped_at,
    updatedAt: row.updated_at,
  };
}

function parsePaging(url) {
  const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: 'invalid_limit' };
  return { limit, cursor: url.searchParams.get('cursor') };
}

function optionalEnum(value, allowed) {
  if (value === null || value === undefined || value === '') return { value: null };
  return allowed.includes(value) ? { value } : { error: true };
}

function optionalText(value, max) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeSearch(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 200) : null;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function encodeCursor(value) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeCursor(value) {
  if (!value) return { value: null };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    if (
      !parsed
      || typeof parsed.updatedAt !== 'string'
      || typeof parsed.productId !== 'string'
      || typeof parsed.sellerSku !== 'string'
    ) throw new Error('bad_cursor');
    return { value: parsed };
  } catch {
    return { error: true };
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

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
