const READ_BODY_LIMIT = 64 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SELLER_SKU_LENGTH = 128;
const MAX_IDENTITY_TEXT_LENGTH = 128;

export async function handleStoreProductsApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/products(?:\/([^/]+)\/([^/]+))?$/);
  if (!match) return null;
  if (!env.CONTROL_DB) return json(request, { error: 'control_db_not_bound' }, 503);

  const method = request.method.toUpperCase();
  const storeId = safeDecode(match[1]);
  const productId = match[2] ? safeDecode(match[2]) : null;
  const sellerSku = match[3] ? safeDecode(match[3]) : null;

  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  if (match[2] && !productId) return json(request, { error: 'invalid_product_id' }, 400);
  if (match[3] && !sellerSku) return json(request, { error: 'invalid_seller_sku' }, 400);

  if (!productId && !sellerSku) {
    if (method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405);
    return listStoreProducts(request, env.CONTROL_DB, actor, url, storeId);
  }

  if (!productId || !sellerSku || !validSellerSku(sellerSku)) {
    return json(request, { error: 'invalid_seller_sku' }, 400);
  }
  if (method === 'PUT') return putStoreProduct(request, env.CONTROL_DB, actor, storeId, productId, sellerSku);
  if (method === 'DELETE') return deleteStoreProduct(request, env.CONTROL_DB, actor, storeId, productId, sellerSku);
  return json(request, { error: 'method_not_allowed' }, 405);
}

async function listStoreProducts(request, db, actor, url, storeId) {
  if (!await hasStorePermission(db, actor.user_id, storeId, 'ads.read')) {
    return json(request, { error: 'forbidden', permission: 'ads.read' }, 403);
  }

  const store = await storeById(db, storeId);
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

  const result = await db.prepare(`
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
    store: publicStore(store),
    items,
    nextCursor: hasMore && last
      ? encodeCursor({ updatedAt: last.updatedAt, productId: last.productId, sellerSku: last.sellerSku })
      : null,
  }, 200);
}

async function putStoreProduct(request, db, actor, storeId, productId, sellerSku) {
  requireAtomicBatch(db);
  if (!await hasStorePermission(db, actor.user_id, storeId, 'products.manage')) {
    return json(request, { error: 'forbidden', permission: 'products.manage' }, 403);
  }

  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);
  const product = await productById(db, productId);
  if (!product) return json(request, { error: 'product_not_found' }, 404);

  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateStoreProduct(body.value);
  if (value.error) return json(request, { error: value.error }, 400);

  const skuOwner = await mappingByStoreSku(db, storeId, sellerSku);
  if (skuOwner && skuOwner.product_id !== productId) {
    return json(request, { error: 'seller_sku_product_conflict' }, 409);
  }

  const mutation = db.prepare(`
    INSERT INTO product_store_map(
      store_id, product_id, seller_sku, asin, parent_asin, listing_status, created_at, updated_at
    )
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    WHERE EXISTS (
      SELECT 1 FROM stores target_store
      WHERE target_store.store_id=?1 AND target_store.status<>'disabled'
    )
      AND EXISTS (
        SELECT 1 FROM products target_product
        WHERE target_product.product_id=?2
      )
      AND (
        EXISTS (
          SELECT 1
          FROM user_global_roles actor_global_role
          JOIN app_roles actor_global_app_role
            ON actor_global_app_role.role_key=actor_global_role.role_key
           AND actor_global_app_role.role_scope='global'
          JOIN role_permissions actor_global_permission
            ON actor_global_permission.role_key=actor_global_role.role_key
          WHERE actor_global_role.user_id=?7
            AND actor_global_permission.permission_key='products.manage'
        )
        OR EXISTS (
          SELECT 1
          FROM store_members actor_store_member
          JOIN app_roles actor_store_app_role
            ON actor_store_app_role.role_key=actor_store_member.role_key
           AND actor_store_app_role.role_scope='store'
          JOIN role_permissions actor_store_permission
            ON actor_store_permission.role_key=actor_store_member.role_key
          WHERE actor_store_member.user_id=?7
            AND actor_store_member.store_id=?1
            AND actor_store_permission.permission_key='products.manage'
        )
      )
    ON CONFLICT(store_id, product_id, seller_sku) DO UPDATE SET
      asin=excluded.asin,
      parent_asin=excluded.parent_asin,
      listing_status=excluded.listing_status,
      updated_at=CURRENT_TIMESTAMP
  `).bind(storeId, productId, sellerSku, value.asin, value.parentAsin, value.listingStatus, actor.user_id);
  const auditStatement = auditedMutationStatement(
    db,
    request,
    actor.user_id,
    storeId,
    'store_product.upsert',
    'product_store_map',
    `${storeId}:${productId}:${sellerSku}`,
    {
      storeId,
      productId,
      sellerSku,
      asin: value.asin,
      parentAsin: value.parentAsin,
      listingStatus: value.listingStatus,
    },
  );

  let mutationChanges;
  try {
    mutationChanges = await executeAuditedMutation(db, mutation, auditStatement, 'store_product_upsert_audit_atomicity_violation');
  } catch (error) {
    if (isUniqueError(error)) return json(request, { error: 'seller_sku_product_conflict' }, 409);
    throw error;
  }

  if (mutationChanges !== 1) {
    if (!await hasStorePermission(db, actor.user_id, storeId, 'products.manage')) {
      return json(request, { error: 'forbidden', permission: 'products.manage' }, 403);
    }
    if (!await storeById(db, storeId)) return json(request, { error: 'store_not_found' }, 404);
    if (!await productById(db, productId)) return json(request, { error: 'product_not_found' }, 404);
    const currentSkuOwner = await mappingByStoreSku(db, storeId, sellerSku);
    if (currentSkuOwner && currentSkuOwner.product_id !== productId) {
      return json(request, { error: 'seller_sku_product_conflict' }, 409);
    }
    return json(request, { error: 'store_product_conflict' }, 409);
  }

  const mapping = await mappingDetailByIds(db, storeId, productId, sellerSku);
  if (!mapping) throw new Error('store_product_upsert_readback_missing');
  return json(request, { store: publicStore(store), mapping: publicStoreProduct(mapping) }, skuOwner ? 200 : 201);
}

async function deleteStoreProduct(request, db, actor, storeId, productId, sellerSku) {
  requireAtomicBatch(db);
  if (!await hasStorePermission(db, actor.user_id, storeId, 'products.manage')) {
    return json(request, { error: 'forbidden', permission: 'products.manage' }, 403);
  }

  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);
  const product = await productById(db, productId);
  if (!product) return json(request, { error: 'product_not_found' }, 404);
  const existing = await mappingByIds(db, storeId, productId, sellerSku);
  if (!existing) return json(request, { error: 'store_product_mapping_not_found' }, 404);

  const mutation = db.prepare(`
    DELETE FROM product_store_map
    WHERE store_id=?1
      AND product_id=?2
      AND seller_sku=?3
      AND EXISTS (
        SELECT 1 FROM stores target_store
        WHERE target_store.store_id=?1 AND target_store.status<>'disabled'
      )
      AND EXISTS (
        SELECT 1 FROM products target_product
        WHERE target_product.product_id=?2
      )
      AND (
        EXISTS (
          SELECT 1
          FROM user_global_roles actor_global_role
          JOIN app_roles actor_global_app_role
            ON actor_global_app_role.role_key=actor_global_role.role_key
           AND actor_global_app_role.role_scope='global'
          JOIN role_permissions actor_global_permission
            ON actor_global_permission.role_key=actor_global_role.role_key
          WHERE actor_global_role.user_id=?4
            AND actor_global_permission.permission_key='products.manage'
        )
        OR EXISTS (
          SELECT 1
          FROM store_members actor_store_member
          JOIN app_roles actor_store_app_role
            ON actor_store_app_role.role_key=actor_store_member.role_key
           AND actor_store_app_role.role_scope='store'
          JOIN role_permissions actor_store_permission
            ON actor_store_permission.role_key=actor_store_member.role_key
          WHERE actor_store_member.user_id=?4
            AND actor_store_member.store_id=?1
            AND actor_store_permission.permission_key='products.manage'
        )
      )
  `).bind(storeId, productId, sellerSku, actor.user_id);
  const auditStatement = auditedMutationStatement(
    db,
    request,
    actor.user_id,
    storeId,
    'store_product.delete',
    'product_store_map',
    `${storeId}:${productId}:${sellerSku}`,
    { storeId, productId, sellerSku },
  );

  const mutationChanges = await executeAuditedMutation(db, mutation, auditStatement, 'store_product_delete_audit_atomicity_violation');
  if (mutationChanges !== 1) {
    if (!await hasStorePermission(db, actor.user_id, storeId, 'products.manage')) {
      return json(request, { error: 'forbidden', permission: 'products.manage' }, 403);
    }
    if (!await storeById(db, storeId)) return json(request, { error: 'store_not_found' }, 404);
    if (!await productById(db, productId)) return json(request, { error: 'product_not_found' }, 404);
    if (!await mappingByIds(db, storeId, productId, sellerSku)) {
      return json(request, { error: 'store_product_mapping_not_found' }, 404);
    }
    return json(request, { error: 'store_product_conflict' }, 409);
  }

  return json(request, { deleted: true, storeId, productId, sellerSku }, 200);
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
    SELECT product_id
    FROM products
    WHERE product_id=?1
    LIMIT 1
  `).bind(productId).first();
}

async function mappingByStoreSku(db, storeId, sellerSku) {
  return db.prepare(`
    SELECT store_id, product_id, seller_sku
    FROM product_store_map
    WHERE store_id=?1 AND seller_sku=?2
    LIMIT 1
  `).bind(storeId, sellerSku).first();
}

async function mappingByIds(db, storeId, productId, sellerSku) {
  return db.prepare(`
    SELECT store_id, product_id, seller_sku
    FROM product_store_map
    WHERE store_id=?1 AND product_id=?2 AND seller_sku=?3
    LIMIT 1
  `).bind(storeId, productId, sellerSku).first();
}

async function mappingDetailByIds(db, storeId, productId, sellerSku) {
  return db.prepare(`
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
    WHERE psm.store_id=?1 AND psm.product_id=?2 AND psm.seller_sku=?3
    LIMIT 1
  `).bind(storeId, productId, sellerSku).first();
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

function auditedMutationStatement(db, request, actorUserId, storeId, action, entityType, entityId, details) {
  const context = buildAuditContext(request);
  return db.prepare(`
    INSERT INTO audit_log(
      event_id, actor_user_id, store_id, action, entity_type, entity_id,
      request_id, cf_ray, details_json
    )
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
    WHERE changes()=1
  `).bind(
    context.eventId,
    actorUserId,
    storeId,
    action,
    entityType,
    entityId,
    context.requestId,
    context.cfRay,
    JSON.stringify(details || {}),
  );
}

async function executeAuditedMutation(db, mutation, auditStatement, violationError) {
  const [mutationResult, auditResult] = await db.batch([mutation, auditStatement]);
  const mutationChanges = changedRows(mutationResult);
  const auditChanges = changedRows(auditResult);
  if (mutationChanges === 1 && auditChanges !== 1) throw new Error(violationError);
  if (mutationChanges !== 1 && auditChanges !== 0) throw new Error(violationError);
  return mutationChanges;
}

function buildAuditContext(request) {
  const cfRay = request.headers.get('cf-ray');
  return {
    eventId: crypto.randomUUID(),
    requestId: cfRay || crypto.randomUUID(),
    cfRay,
  };
}

function requireAtomicBatch(db) {
  if (!db || typeof db.batch !== 'function') {
    throw new Error('control_d1_atomic_batch_required');
  }
}

function changedRows(result) {
  const value = result?.meta?.changes ?? result?.changes ?? 0;
  return Number(value || 0);
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

function validateStoreProduct(input) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  const allowed = new Set(['asin', 'parentAsin', 'listingStatus']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { error: 'unsupported_store_product_field' };

  const asin = optionalBoundedBodyText(input.asin, MAX_IDENTITY_TEXT_LENGTH);
  if (asin.error) return { error: 'invalid_asin' };
  const parentAsin = optionalBoundedBodyText(input.parentAsin, MAX_IDENTITY_TEXT_LENGTH);
  if (parentAsin.error) return { error: 'invalid_parent_asin' };
  const listingStatus = optionalBoundedBodyText(input.listingStatus, 80);
  if (listingStatus.error) return { error: 'invalid_listing_status' };

  return { asin: asin.value, parentAsin: parentAsin.value, listingStatus: listingStatus.value };
}

function optionalBoundedBodyText(value, max) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { error: true };
  const text = value.trim();
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return { error: true };
  return { value: text || null };
}

function validSellerSku(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_SELLER_SKU_LENGTH
    && value.trim().length >= 1
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function publicStore(store) {
  return {
    storeId: store.store_id,
    storeCode: store.store_code,
    displayName: store.display_name,
    marketplaceCode: store.marketplace_code,
    amazonRegion: store.amazon_region,
    status: store.status,
  };
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

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function isUniqueError(error) {
  return /unique|constraint/i.test(String(error?.message || error));
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
