const READ_BODY_LIMIT = 256 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function handleControlApiRoute({ request, env, actor, url }) {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (path === '/api/v1/products' && method === 'GET') {
    return listProducts(request, env.CONTROL_DB, actor, url);
  }
  if (path === '/api/v1/products' && method === 'POST') {
    return createProduct(request, env.CONTROL_DB, actor);
  }
  const productMatch = path.match(/^\/api\/v1\/products\/([^/]+)$/);
  if (productMatch && method === 'PATCH') {
    return updateProduct(request, env.CONTROL_DB, actor, decodeURIComponent(productMatch[1]));
  }

  if (path === '/api/v1/keywords' && method === 'GET') {
    return listKeywords(request, env.CONTROL_DB, actor, url);
  }
  if (path === '/api/v1/keywords' && method === 'POST') {
    return createKeyword(request, env.CONTROL_DB, actor);
  }
  const keywordMatch = path.match(/^\/api\/v1\/keywords\/([^/]+)$/);
  if (keywordMatch && method === 'PATCH') {
    return updateKeyword(request, env.CONTROL_DB, actor, decodeURIComponent(keywordMatch[1]));
  }

  if (path === '/api/v1/negative-keywords' && method === 'GET') {
    return listNegativeKeywords(request, env.CONTROL_DB, actor, url);
  }
  if (path === '/api/v1/negative-keywords' && method === 'POST') {
    return createNegativeKeyword(request, env.CONTROL_DB, actor);
  }
  const negativeMatch = path.match(/^\/api\/v1\/negative-keywords\/([^/]+)$/);
  if (negativeMatch && method === 'PATCH') {
    return updateNegativeKeyword(request, env.CONTROL_DB, actor, decodeURIComponent(negativeMatch[1]));
  }

  return null;
}

async function listProducts(request, db, actor, url) {
  if (!await hasAssignedPermission(db, actor.user_id, 'products.read')) {
    return json(request, { error: 'forbidden', permission: 'products.read' }, 403);
  }
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const status = optionalEnum(url.searchParams.get('status'), ['active','inactive','archived']);
  if (status.error) return json(request, { error: 'invalid_product_status' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const cursor = decodeCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);

  const result = await db.prepare(`
    SELECT product_id, model_code, model_name, brand, status, attributes_json, created_at, updated_at
    FROM products
    WHERE (?1 IS NULL OR status = ?1)
      AND (?2 IS NULL OR model_code LIKE ?2 ESCAPE '\\' OR model_name LIKE ?2 ESCAPE '\\' OR brand LIKE ?2 ESCAPE '\\')
      AND (?3 IS NULL OR created_at < ?3 OR (created_at = ?3 AND product_id < ?4))
    ORDER BY created_at DESC, product_id DESC
    LIMIT ?5
  `).bind(status.value, q ? `%${escapeLike(q)}%` : null, cursor.value?.createdAt || null, cursor.value?.id || null, paging.limit + 1).all();

  const rows = (result.results || []).map(publicProduct);
  return pageResponse(request, rows, paging.limit, (row) => ({ createdAt: row.createdAt, id: row.productId }));
}

async function createProduct(request, db, actor) {
  requireAtomicBatch(db);
  if (!await hasGlobalPermission(db, actor.user_id, 'products.manage')) {
    return json(request, { error: 'forbidden', permission: 'products.manage' }, 403);
  }
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateProductCreate(body.value);
  if (value.error) return json(request, { error: value.error }, 400);

  const productId = crypto.randomUUID();
  const mutation = db.prepare(`
    INSERT INTO products(product_id, model_code, model_name, brand, status, attributes_json, created_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    WHERE EXISTS (
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
  `).bind(productId, value.modelCode, value.modelName, value.brand, value.status, value.attributesJson, actor.user_id);
  const auditStatement = auditedMutationStatement(
    db, request, actor.user_id, 'product.create', 'product', productId, value.audit,
  );

  let mutationChanges;
  try {
    mutationChanges = await executeAuditedMutation(db, mutation, auditStatement, 'product_create_audit_atomicity_violation');
  } catch (error) {
    if (isUniqueError(error)) return json(request, { error: 'product_model_code_conflict' }, 409);
    throw error;
  }
  if (mutationChanges !== 1) {
    if (!await hasGlobalPermission(db, actor.user_id, 'products.manage')) {
      return json(request, { error: 'forbidden', permission: 'products.manage' }, 403);
    }
    return json(request, { error: 'product_model_code_conflict' }, 409);
  }

  const row = await productById(db, productId);
  if (!row) throw new Error('product_create_readback_missing');
  return json(request, { product: publicProduct(row) }, 201);
}

async function updateProduct(request, db, actor, productId) {
  requireAtomicBatch(db);
  if (!await hasGlobalPermission(db, actor.user_id, 'products.manage')) {
    return json(request, { error: 'forbidden', permission: 'products.manage' }, 403);
  }
  const existing = await productById(db, productId);
  if (!existing) return json(request, { error: 'product_not_found' }, 404);
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateProductPatch(body.value, existing);
  if (value.error) return json(request, { error: value.error }, 400);

  const mutation = db.prepare(`
    UPDATE products
    SET model_code = ?1, model_name = ?2, brand = ?3, status = ?4, attributes_json = ?5,
        updated_at = CURRENT_TIMESTAMP
    WHERE product_id = ?6
      AND EXISTS (
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
  `).bind(value.modelCode, value.modelName, value.brand, value.status, value.attributesJson, productId, actor.user_id);
  const auditStatement = auditedMutationStatement(
    db, request, actor.user_id, 'product.update', 'product', productId, value.audit,
  );

  let mutationChanges;
  try {
    mutationChanges = await executeAuditedMutation(db, mutation, auditStatement, 'product_update_audit_atomicity_violation');
  } catch (error) {
    if (isUniqueError(error)) return json(request, { error: 'product_model_code_conflict' }, 409);
    throw error;
  }
  if (mutationChanges !== 1) {
    if (!await hasGlobalPermission(db, actor.user_id, 'products.manage')) {
      return json(request, { error: 'forbidden', permission: 'products.manage' }, 403);
    }
    if (!await productById(db, productId)) return json(request, { error: 'product_not_found' }, 404);
    return json(request, { error: 'product_model_code_conflict' }, 409);
  }

  const row = await productById(db, productId);
  if (!row) throw new Error('product_update_readback_missing');
  return json(request, { product: publicProduct(row) }, 200);
}

async function listKeywords(request, db, actor, url) {
  if (!await hasAssignedPermission(db, actor.user_id, 'keywords.read')) {
    return json(request, { error: 'forbidden', permission: 'keywords.read' }, 403);
  }
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const status = optionalEnum(url.searchParams.get('status'), ['active','watch','retired']);
  if (status.error) return json(request, { error: 'invalid_keyword_status' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const cursor = decodeCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);

  const result = await db.prepare(`
    SELECT keyword_id, keyword_text, normalized_term, language_code, intent_class, semantic_cluster,
           lifecycle_status, source_type, notes, created_at, updated_at
    FROM keyword_library
    WHERE (?1 IS NULL OR lifecycle_status = ?1)
      AND (?2 IS NULL OR keyword_text LIKE ?2 ESCAPE '\\' OR normalized_term LIKE ?2 ESCAPE '\\' OR semantic_cluster LIKE ?2 ESCAPE '\\')
      AND (?3 IS NULL OR created_at < ?3 OR (created_at = ?3 AND keyword_id < ?4))
    ORDER BY created_at DESC, keyword_id DESC
    LIMIT ?5
  `).bind(status.value, q ? `%${escapeLike(q)}%` : null, cursor.value?.createdAt || null, cursor.value?.id || null, paging.limit + 1).all();

  const rows = (result.results || []).map(publicKeyword);
  return pageResponse(request, rows, paging.limit, (row) => ({ createdAt: row.createdAt, id: row.keywordId }));
}

async function createKeyword(request, db, actor) {
  requireAtomicBatch(db);
  if (!await hasGlobalPermission(db, actor.user_id, 'keywords.manage')) {
    return json(request, { error: 'forbidden', permission: 'keywords.manage' }, 403);
  }
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateKeywordCreate(body.value);
  if (value.error) return json(request, { error: value.error }, 400);

  const keywordId = crypto.randomUUID();
  const mutation = db.prepare(`
    INSERT INTO keyword_library(
      keyword_id, keyword_text, normalized_term, language_code, intent_class, semantic_cluster,
      lifecycle_status, source_type, notes, created_by, created_at, updated_at
    )
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    WHERE EXISTS (
      SELECT 1
      FROM user_global_roles actor_global_role
      JOIN app_roles actor_global_app_role
        ON actor_global_app_role.role_key=actor_global_role.role_key
       AND actor_global_app_role.role_scope='global'
      JOIN role_permissions actor_global_permission
        ON actor_global_permission.role_key=actor_global_role.role_key
      WHERE actor_global_role.user_id=?11
        AND actor_global_permission.permission_key='keywords.manage'
    )
  `).bind(keywordId, value.keywordText, value.normalizedTerm, value.languageCode, value.intentClass,
    value.semanticCluster, value.lifecycleStatus, value.sourceType, value.notes, actor.user_id, actor.user_id);
  const auditStatement = auditedMutationStatement(
    db, request, actor.user_id, 'keyword.create', 'keyword', keywordId, value.audit,
  );

  let mutationChanges;
  try {
    mutationChanges = await executeAuditedMutation(db, mutation, auditStatement, 'keyword_create_audit_atomicity_violation');
  } catch (error) {
    if (isUniqueError(error)) return json(request, { error: 'keyword_conflict' }, 409);
    throw error;
  }
  if (mutationChanges !== 1) {
    if (!await hasGlobalPermission(db, actor.user_id, 'keywords.manage')) {
      return json(request, { error: 'forbidden', permission: 'keywords.manage' }, 403);
    }
    return json(request, { error: 'keyword_conflict' }, 409);
  }

  const row = await keywordById(db, keywordId);
  if (!row) throw new Error('keyword_create_readback_missing');
  return json(request, { keyword: publicKeyword(row) }, 201);
}

async function updateKeyword(request, db, actor, keywordId) {
  requireAtomicBatch(db);
  if (!await hasGlobalPermission(db, actor.user_id, 'keywords.manage')) {
    return json(request, { error: 'forbidden', permission: 'keywords.manage' }, 403);
  }
  const existing = await keywordById(db, keywordId);
  if (!existing) return json(request, { error: 'keyword_not_found' }, 404);
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateKeywordPatch(body.value, existing);
  if (value.error) return json(request, { error: value.error }, 400);

  const mutation = db.prepare(`
    UPDATE keyword_library
    SET keyword_text=?1, normalized_term=?2, language_code=?3, intent_class=?4, semantic_cluster=?5,
        lifecycle_status=?6, source_type=?7, notes=?8, updated_at=CURRENT_TIMESTAMP
    WHERE keyword_id=?9
      AND EXISTS (
        SELECT 1
        FROM user_global_roles actor_global_role
        JOIN app_roles actor_global_app_role
          ON actor_global_app_role.role_key=actor_global_role.role_key
         AND actor_global_app_role.role_scope='global'
        JOIN role_permissions actor_global_permission
          ON actor_global_permission.role_key=actor_global_role.role_key
        WHERE actor_global_role.user_id=?10
          AND actor_global_permission.permission_key='keywords.manage'
      )
  `).bind(value.keywordText, value.normalizedTerm, value.languageCode, value.intentClass, value.semanticCluster,
    value.lifecycleStatus, value.sourceType, value.notes, keywordId, actor.user_id);
  const auditStatement = auditedMutationStatement(
    db, request, actor.user_id, 'keyword.update', 'keyword', keywordId, value.audit,
  );

  let mutationChanges;
  try {
    mutationChanges = await executeAuditedMutation(db, mutation, auditStatement, 'keyword_update_audit_atomicity_violation');
  } catch (error) {
    if (isUniqueError(error)) return json(request, { error: 'keyword_conflict' }, 409);
    throw error;
  }
  if (mutationChanges !== 1) {
    if (!await hasGlobalPermission(db, actor.user_id, 'keywords.manage')) {
      return json(request, { error: 'forbidden', permission: 'keywords.manage' }, 403);
    }
    if (!await keywordById(db, keywordId)) return json(request, { error: 'keyword_not_found' }, 404);
    return json(request, { error: 'keyword_conflict' }, 409);
  }

  const row = await keywordById(db, keywordId);
  if (!row) throw new Error('keyword_update_readback_missing');
  return json(request, { keyword: publicKeyword(row) }, 200);
}

async function listNegativeKeywords(request, db, actor, url) {
  if (!await hasAssignedPermission(db, actor.user_id, 'negatives.read')) {
    return json(request, { error: 'forbidden', permission: 'negatives.read' }, 403);
  }
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const status = optionalEnum(url.searchParams.get('status'), ['active','retired']);
  if (status.error) return json(request, { error: 'invalid_negative_status' }, 400);
  const matchType = optionalEnum(url.searchParams.get('matchType'), ['EXACT','PHRASE']);
  if (matchType.error) return json(request, { error: 'invalid_negative_match_type' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const cursor = decodeCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);

  const result = await db.prepare(`
    SELECT negative_keyword_id, keyword_text, normalized_term, match_type, reason_code, status, notes,
           created_at, updated_at
    FROM negative_keyword_library
    WHERE (?1 IS NULL OR status = ?1)
      AND (?2 IS NULL OR match_type = ?2)
      AND (?3 IS NULL OR keyword_text LIKE ?3 ESCAPE '\\' OR normalized_term LIKE ?3 ESCAPE '\\')
      AND (?4 IS NULL OR created_at < ?4 OR (created_at = ?4 AND negative_keyword_id < ?5))
    ORDER BY created_at DESC, negative_keyword_id DESC
    LIMIT ?6
  `).bind(status.value, matchType.value, q ? `%${escapeLike(q)}%` : null,
    cursor.value?.createdAt || null, cursor.value?.id || null, paging.limit + 1).all();

  const rows = (result.results || []).map(publicNegativeKeyword);
  return pageResponse(request, rows, paging.limit, (row) => ({ createdAt: row.createdAt, id: row.negativeKeywordId }));
}

async function createNegativeKeyword(request, db, actor) {
  requireAtomicBatch(db);
  if (!await hasGlobalPermission(db, actor.user_id, 'negatives.manage')) {
    return json(request, { error: 'forbidden', permission: 'negatives.manage' }, 403);
  }
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateNegativeCreate(body.value);
  if (value.error) return json(request, { error: value.error }, 400);

  const id = crypto.randomUUID();
  const mutation = db.prepare(`
    INSERT INTO negative_keyword_library(
      negative_keyword_id, keyword_text, normalized_term, match_type, reason_code, status,
      notes, created_by, created_at, updated_at
    )
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    WHERE EXISTS (
      SELECT 1
      FROM user_global_roles actor_global_role
      JOIN app_roles actor_global_app_role
        ON actor_global_app_role.role_key=actor_global_role.role_key
       AND actor_global_app_role.role_scope='global'
      JOIN role_permissions actor_global_permission
        ON actor_global_permission.role_key=actor_global_role.role_key
      WHERE actor_global_role.user_id=?9
        AND actor_global_permission.permission_key='negatives.manage'
    )
  `).bind(id, value.keywordText, value.normalizedTerm, value.matchType, value.reasonCode,
    value.status, value.notes, actor.user_id, actor.user_id);
  const auditStatement = auditedMutationStatement(
    db, request, actor.user_id, 'negative_keyword.create', 'negative_keyword', id, value.audit,
  );

  let mutationChanges;
  try {
    mutationChanges = await executeAuditedMutation(db, mutation, auditStatement, 'negative_keyword_create_audit_atomicity_violation');
  } catch (error) {
    if (isUniqueError(error)) return json(request, { error: 'negative_keyword_conflict' }, 409);
    throw error;
  }
  if (mutationChanges !== 1) {
    if (!await hasGlobalPermission(db, actor.user_id, 'negatives.manage')) {
      return json(request, { error: 'forbidden', permission: 'negatives.manage' }, 403);
    }
    return json(request, { error: 'negative_keyword_conflict' }, 409);
  }

  const row = await negativeKeywordById(db, id);
  if (!row) throw new Error('negative_keyword_create_readback_missing');
  return json(request, { negativeKeyword: publicNegativeKeyword(row) }, 201);
}

async function updateNegativeKeyword(request, db, actor, id) {
  requireAtomicBatch(db);
  if (!await hasGlobalPermission(db, actor.user_id, 'negatives.manage')) {
    return json(request, { error: 'forbidden', permission: 'negatives.manage' }, 403);
  }
  const existing = await negativeKeywordById(db, id);
  if (!existing) return json(request, { error: 'negative_keyword_not_found' }, 404);
  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateNegativePatch(body.value, existing);
  if (value.error) return json(request, { error: value.error }, 400);

  const mutation = db.prepare(`
    UPDATE negative_keyword_library
    SET keyword_text=?1, normalized_term=?2, match_type=?3, reason_code=?4, status=?5, notes=?6,
        updated_at=CURRENT_TIMESTAMP
    WHERE negative_keyword_id=?7
      AND EXISTS (
        SELECT 1
        FROM user_global_roles actor_global_role
        JOIN app_roles actor_global_app_role
          ON actor_global_app_role.role_key=actor_global_role.role_key
         AND actor_global_app_role.role_scope='global'
        JOIN role_permissions actor_global_permission
          ON actor_global_permission.role_key=actor_global_role.role_key
        WHERE actor_global_role.user_id=?8
          AND actor_global_permission.permission_key='negatives.manage'
      )
  `).bind(value.keywordText, value.normalizedTerm, value.matchType, value.reasonCode,
    value.status, value.notes, id, actor.user_id);
  const auditStatement = auditedMutationStatement(
    db, request, actor.user_id, 'negative_keyword.update', 'negative_keyword', id, value.audit,
  );

  let mutationChanges;
  try {
    mutationChanges = await executeAuditedMutation(db, mutation, auditStatement, 'negative_keyword_update_audit_atomicity_violation');
  } catch (error) {
    if (isUniqueError(error)) return json(request, { error: 'negative_keyword_conflict' }, 409);
    throw error;
  }
  if (mutationChanges !== 1) {
    if (!await hasGlobalPermission(db, actor.user_id, 'negatives.manage')) {
      return json(request, { error: 'forbidden', permission: 'negatives.manage' }, 403);
    }
    if (!await negativeKeywordById(db, id)) return json(request, { error: 'negative_keyword_not_found' }, 404);
    return json(request, { error: 'negative_keyword_conflict' }, 409);
  }

  const row = await negativeKeywordById(db, id);
  if (!row) throw new Error('negative_keyword_update_readback_missing');
  return json(request, { negativeKeyword: publicNegativeKeyword(row) }, 200);
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

async function productById(db, id) {
  return db.prepare(`SELECT product_id, model_code, model_name, brand, status, attributes_json, created_at, updated_at FROM products WHERE product_id=?1 LIMIT 1`).bind(id).first();
}
async function keywordById(db, id) {
  return db.prepare(`SELECT keyword_id, keyword_text, normalized_term, language_code, intent_class, semantic_cluster, lifecycle_status, source_type, notes, created_at, updated_at FROM keyword_library WHERE keyword_id=?1 LIMIT 1`).bind(id).first();
}
async function negativeKeywordById(db, id) {
  return db.prepare(`SELECT negative_keyword_id, keyword_text, normalized_term, match_type, reason_code, status, notes, created_at, updated_at FROM negative_keyword_library WHERE negative_keyword_id=?1 LIMIT 1`).bind(id).first();
}

function validateProductCreate(input) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  const modelCode = requiredText(input.modelCode, 120, 'product_model_code_required');
  if (modelCode.error) return modelCode;
  const status = enumValue(input.status ?? 'active', ['active','inactive','archived'], 'invalid_product_status');
  if (status.error) return status;
  const attributes = jsonObjectOrNull(input.attributes, 'invalid_product_attributes');
  if (attributes.error) return attributes;
  return {
    modelCode: modelCode.value,
    modelName: optionalText(input.modelName, 240),
    brand: optionalText(input.brand, 120),
    status: status.value,
    attributesJson: attributes.value,
    audit: { modelCode: modelCode.value, status: status.value },
  };
}

function validateProductPatch(input, existing) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  const merged = {
    modelCode: own(input, 'modelCode') ? input.modelCode : existing.model_code,
    modelName: own(input, 'modelName') ? input.modelName : existing.model_name,
    brand: own(input, 'brand') ? input.brand : existing.brand,
    status: own(input, 'status') ? input.status : existing.status,
    attributes: own(input, 'attributes') ? input.attributes : parseJsonObject(existing.attributes_json),
  };
  return validateProductCreate(merged);
}

function validateKeywordCreate(input) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  const keywordText = requiredText(input.keywordText, 500, 'keyword_text_required');
  if (keywordText.error) return keywordText;
  const languageCode = requiredText(input.languageCode ?? 'en-US', 20, 'keyword_language_required');
  if (languageCode.error) return languageCode;
  const lifecycle = enumValue(input.lifecycleStatus ?? 'active', ['active','watch','retired'], 'invalid_keyword_status');
  if (lifecycle.error) return lifecycle;
  const sourceType = optionalText(input.sourceType ?? 'manual', 80) || 'manual';
  return {
    keywordText: keywordText.value,
    normalizedTerm: normalizeTerm(keywordText.value),
    languageCode: languageCode.value,
    intentClass: optionalText(input.intentClass, 120),
    semanticCluster: optionalText(input.semanticCluster, 240),
    lifecycleStatus: lifecycle.value,
    sourceType,
    notes: optionalText(input.notes, 4000),
    audit: { keywordText: keywordText.value, languageCode: languageCode.value, lifecycleStatus: lifecycle.value },
  };
}

function validateKeywordPatch(input, existing) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  return validateKeywordCreate({
    keywordText: own(input, 'keywordText') ? input.keywordText : existing.keyword_text,
    languageCode: own(input, 'languageCode') ? input.languageCode : existing.language_code,
    intentClass: own(input, 'intentClass') ? input.intentClass : existing.intent_class,
    semanticCluster: own(input, 'semanticCluster') ? input.semanticCluster : existing.semantic_cluster,
    lifecycleStatus: own(input, 'lifecycleStatus') ? input.lifecycleStatus : existing.lifecycle_status,
    sourceType: own(input, 'sourceType') ? input.sourceType : existing.source_type,
    notes: own(input, 'notes') ? input.notes : existing.notes,
  });
}

function validateNegativeCreate(input) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  const keywordText = requiredText(input.keywordText, 500, 'negative_keyword_text_required');
  if (keywordText.error) return keywordText;
  const match = enumValue(String(input.matchType || '').toUpperCase(), ['EXACT','PHRASE'], 'invalid_negative_match_type');
  if (match.error) return match;
  const status = enumValue(input.status ?? 'active', ['active','retired'], 'invalid_negative_status');
  if (status.error) return status;
  return {
    keywordText: keywordText.value,
    normalizedTerm: normalizeTerm(keywordText.value),
    matchType: match.value,
    reasonCode: optionalText(input.reasonCode, 120),
    status: status.value,
    notes: optionalText(input.notes, 4000),
    audit: { keywordText: keywordText.value, matchType: match.value, status: status.value },
  };
}

function validateNegativePatch(input, existing) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  return validateNegativeCreate({
    keywordText: own(input, 'keywordText') ? input.keywordText : existing.keyword_text,
    matchType: own(input, 'matchType') ? input.matchType : existing.match_type,
    reasonCode: own(input, 'reasonCode') ? input.reasonCode : existing.reason_code,
    status: own(input, 'status') ? input.status : existing.status,
    notes: own(input, 'notes') ? input.notes : existing.notes,
  });
}

function publicProduct(row) {
  return {
    productId: row.product_id,
    modelCode: row.model_code,
    modelName: row.model_name,
    brand: row.brand,
    status: row.status,
    attributes: parseJsonObject(row.attributes_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function publicKeyword(row) {
  return {
    keywordId: row.keyword_id,
    keywordText: row.keyword_text,
    normalizedTerm: row.normalized_term,
    languageCode: row.language_code,
    intentClass: row.intent_class,
    semanticCluster: row.semantic_cluster,
    lifecycleStatus: row.lifecycle_status,
    sourceType: row.source_type,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function publicNegativeKeyword(row) {
  return {
    negativeKeywordId: row.negative_keyword_id,
    keywordText: row.keyword_text,
    normalizedTerm: row.normalized_term,
    matchType: row.match_type,
    reasonCode: row.reason_code,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditedMutationStatement(db, request, actorUserId, action, entityType, entityId, details) {
  const context = buildAuditContext(request);
  return db.prepare(`
    INSERT INTO audit_log(event_id, actor_user_id, action, entity_type, entity_id, request_id, cf_ray, details_json)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8
    WHERE changes()=1
  `).bind(
    context.eventId,
    actorUserId,
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

function parsePaging(url) {
  const raw = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_LIMIT) return { error: 'invalid_limit' };
  return { limit: raw, cursor: url.searchParams.get('cursor') };
}

function pageResponse(request, rows, limit, cursorFromRow) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return json(request, {
    items,
    nextCursor: hasMore && last ? encodeCursor(cursorFromRow(last)) : null,
  }, 200);
}

function encodeCursor(value) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}
function decodeCursor(value) {
  if (!value) return { value: null };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    if (!parsed || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error('bad');
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

function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function requiredText(value, max, error) {
  const text = String(value ?? '').trim();
  if (!text) return { error };
  if (text.length > max) return { error: `${error}_too_long` };
  return { value: text };
}
function optionalText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}
function enumValue(value, allowed, error) {
  const text = String(value ?? '').trim();
  return allowed.includes(text) ? { value: text } : { error };
}
function optionalEnum(value, allowed) {
  if (value === null || value === undefined || value === '') return { value: null };
  return allowed.includes(value) ? { value } : { error: true };
}
function jsonObjectOrNull(value, error) {
  if (value === null || value === undefined) return { value: null };
  if (!plainObject(value)) return { error };
  return { value: JSON.stringify(value) };
}
function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return plainObject(parsed) ? parsed : null;
  } catch { return null; }
}
function normalizeTerm(value) { return String(value).trim().toLowerCase().replace(/\s+/g, ' '); }
function normalizeSearch(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 200) : null;
}
function escapeLike(value) { return String(value).replace(/[\\%_]/g, (m) => `\\${m}`); }
function isUniqueError(error) { return /unique constraint|constraint failed/i.test(String(error?.message || error)); }

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
