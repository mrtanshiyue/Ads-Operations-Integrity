const READ_BODY_LIMIT = 32 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_NAME_LENGTH = 200;

export async function handleAccessGovernanceApiRoute({ request, env, actor, url }) {
  const db = env.CONTROL_DB;
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (path === '/api/v1/access/roles') {
    if (method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405);
    return listRoles(request, db, actor, url);
  }
  if (path === '/api/v1/access/users') {
    if (method === 'GET') return listUsers(request, db, actor, url);
    if (method === 'POST') return provisionUser(request, db, actor);
    return json(request, { error: 'method_not_allowed' }, 405);
  }

  const memberMatch = path.match(/^\/api\/v1\/stores\/([^/]+)\/members(?:\/([^/]+))?$/);
  if (!memberMatch) return null;
  const storeId = safeDecode(memberMatch[1]);
  const userId = memberMatch[2] ? safeDecode(memberMatch[2]) : null;
  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  if (memberMatch[2] && !userId) return json(request, { error: 'invalid_user_id' }, 400);

  if (!userId) {
    if (method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405);
    return listStoreMembers(request, db, actor, url, storeId);
  }
  if (method === 'PUT') return putStoreMember(request, db, actor, storeId, userId);
  if (method === 'DELETE') return deleteStoreMember(request, db, actor, storeId, userId);
  return json(request, { error: 'method_not_allowed' }, 405);
}

async function listRoles(request, db, actor, url) {
  if (!await hasGlobalPermission(db, actor.user_id, 'users.manage')) {
    return json(request, { error: 'forbidden', permission: 'users.manage' }, 403);
  }
  const scope = optionalEnum(url.searchParams.get('scope'), ['global', 'store']);
  if (scope.error) return json(request, { error: 'invalid_role_scope' }, 400);

  const result = await db.prepare(`
    SELECT
      r.role_key,
      r.role_name,
      r.role_scope,
      r.priority,
      r.is_system,
      rp.permission_key
    FROM app_roles r
    LEFT JOIN role_permissions rp ON rp.role_key = r.role_key
    WHERE (?1 IS NULL OR r.role_scope = ?1)
    ORDER BY r.priority ASC, r.role_key ASC, rp.permission_key ASC
  `).bind(scope.value).all();

  const roles = [];
  const byKey = new Map();
  for (const row of result.results || []) {
    let role = byKey.get(row.role_key);
    if (!role) {
      role = {
        roleKey: row.role_key,
        roleName: row.role_name,
        roleScope: row.role_scope,
        priority: row.priority,
        isSystem: Boolean(row.is_system),
        permissions: [],
      };
      byKey.set(row.role_key, role);
      roles.push(role);
    }
    if (row.permission_key) role.permissions.push(row.permission_key);
  }
  return json(request, { roles }, 200);
}

async function listUsers(request, db, actor, url) {
  if (!await hasGlobalPermission(db, actor.user_id, 'users.manage')) {
    return json(request, { error: 'forbidden', permission: 'users.manage' }, 403);
  }
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const status = optionalEnum(url.searchParams.get('status'), ['active', 'disabled']);
  if (status.error) return json(request, { error: 'invalid_user_status' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const cursor = decodeCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);

  const result = await db.prepare(`
    SELECT
      u.user_id,
      u.cf_access_sub,
      u.email,
      u.display_name,
      u.status,
      u.last_seen_at,
      u.created_at,
      u.updated_at,
      (SELECT GROUP_CONCAT(ugr.role_key, ',') FROM user_global_roles ugr WHERE ugr.user_id = u.user_id) AS global_roles_csv
    FROM users u
    WHERE (?1 IS NULL OR u.status = ?1)
      AND (?2 IS NULL OR u.user_id LIKE ?2 ESCAPE '\\' OR u.email LIKE ?2 ESCAPE '\\' OR u.display_name LIKE ?2 ESCAPE '\\')
      AND (?3 IS NULL OR u.created_at < ?3 OR (u.created_at = ?3 AND u.user_id < ?4))
    ORDER BY u.created_at DESC, u.user_id DESC
    LIMIT ?5
  `).bind(
    status.value,
    q ? `%${escapeLike(q)}%` : null,
    cursor.value?.createdAt || null,
    cursor.value?.id || null,
    paging.limit + 1,
  ).all();

  const rows = (result.results || []).map(publicUser);
  return pageResponse(request, rows, paging.limit, (row) => ({ createdAt: row.createdAt, id: row.userId }));
}

async function provisionUser(request, db, actor) {
  requireAtomicBatch(db);
  if (!await hasGlobalPermission(db, actor.user_id, 'users.manage')) {
    return json(request, { error: 'forbidden', permission: 'users.manage' }, 403);
  }

  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateUserProvisionBody(body.value);
  if (value.error) return json(request, { error: value.error }, 400);

  const userId = crypto.randomUUID();
  const mutation = db.prepare(`
    INSERT INTO users(
      user_id, cf_access_sub, email, email_norm, display_name, status,
      last_seen_at, created_at, updated_at
    )
    SELECT ?1, NULL, ?2, ?3, ?4, 'active', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    WHERE EXISTS (
      SELECT 1
      FROM users actor_user
      WHERE actor_user.user_id=?5
        AND actor_user.status='active'
        AND EXISTS (
          SELECT 1
          FROM user_global_roles actor_role
          JOIN app_roles actor_app_role
            ON actor_app_role.role_key=actor_role.role_key
           AND actor_app_role.role_scope='global'
          JOIN role_permissions actor_permission
            ON actor_permission.role_key=actor_role.role_key
          WHERE actor_role.user_id=actor_user.user_id
            AND actor_permission.permission_key='users.manage'
        )
    )
  `).bind(userId, value.email, value.emailNorm, value.displayName, actor.user_id);
  const audit = auditedMutationStatement(db, request, actor.user_id, null, 'user.provision', 'user', userId, {
    userId,
    email: value.email,
    displayName: value.displayName,
    status: 'active',
    cfAccessBound: false,
  });

  let mutationChanges;
  try {
    mutationChanges = await executeAuditedMutation(db, mutation, audit, 'user_provision_audit_atomicity_violation');
  } catch (error) {
    if (isUniqueError(error)) return json(request, { error: 'user_email_conflict' }, 409);
    throw error;
  }

  if (mutationChanges !== 1) {
    if (!await hasGlobalPermission(db, actor.user_id, 'users.manage')) {
      return json(request, { error: 'forbidden', permission: 'users.manage' }, 403);
    }
    return json(request, { error: 'user_provision_conflict' }, 409);
  }

  const user = await userDetailById(db, userId);
  if (!user) throw new Error('user_provision_readback_missing');
  return json(request, { user: publicUser(user) }, 201);
}

async function listStoreMembers(request, db, actor, url, storeId) {
  if (!await hasGlobalPermission(db, actor.user_id, 'users.manage')) {
    return json(request, { error: 'forbidden', permission: 'users.manage' }, 403);
  }
  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);

  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const roleKey = normalizeSearch(url.searchParams.get('roleKey'));
  const q = normalizeSearch(url.searchParams.get('q'));
  const cursor = decodeCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);

  const result = await db.prepare(`
    SELECT
      sm.store_id,
      sm.user_id,
      sm.role_key,
      sm.created_at,
      u.email,
      u.display_name,
      u.status AS user_status,
      u.last_seen_at,
      ar.role_name,
      ar.role_scope
    FROM store_members sm
    JOIN users u ON u.user_id = sm.user_id
    JOIN app_roles ar ON ar.role_key = sm.role_key AND ar.role_scope = 'store'
    WHERE sm.store_id = ?1
      AND (?2 IS NULL OR sm.role_key = ?2)
      AND (?3 IS NULL OR u.user_id LIKE ?3 ESCAPE '\\' OR u.email LIKE ?3 ESCAPE '\\' OR u.display_name LIKE ?3 ESCAPE '\\')
      AND (?4 IS NULL OR sm.created_at < ?4 OR (sm.created_at = ?4 AND sm.user_id < ?5))
    ORDER BY sm.created_at DESC, sm.user_id DESC
    LIMIT ?6
  `).bind(
    storeId,
    roleKey,
    q ? `%${escapeLike(q)}%` : null,
    cursor.value?.createdAt || null,
    cursor.value?.id || null,
    paging.limit + 1,
  ).all();

  const rows = (result.results || []).map(publicMember);
  const page = pagePayload(rows, paging.limit, (row) => ({ createdAt: row.memberSince, id: row.userId }));
  return json(request, { store: publicStore(store), ...page }, 200);
}

async function putStoreMember(request, db, actor, storeId, userId) {
  requireAtomicBatch(db);
  const permission = await requireMembershipWritePermissions(db, actor.user_id);
  if (permission) return json(request, { error: 'forbidden', permission }, 403);

  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);
  const user = await userById(db, userId);
  if (!user) return json(request, { error: 'user_not_found' }, 404);
  if (user.status !== 'active') return json(request, { error: 'user_not_active' }, 409);
  if (Boolean(user.has_global_role)) return json(request, { error: 'global_role_conflict' }, 409);

  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateMemberBody(body.value);
  if (value.error) return json(request, { error: value.error }, 400);

  const role = await roleByKey(db, value.roleKey);
  if (!role) return json(request, { error: 'role_not_found' }, 404);
  if (role.role_scope !== 'store') return json(request, { error: 'store_role_required' }, 400);

  const existing = await memberByIds(db, storeId, userId);
  const mutation = db.prepare(`
    INSERT INTO store_members(store_id, user_id, role_key, created_at)
    SELECT ?1, ?2, ?3, CURRENT_TIMESTAMP
    WHERE EXISTS (
      SELECT 1 FROM stores target_store
      WHERE target_store.store_id=?1 AND target_store.status<>'disabled'
    )
      AND EXISTS (
        SELECT 1 FROM users target_user
        WHERE target_user.user_id=?2
          AND target_user.status='active'
          AND NOT EXISTS (
            SELECT 1 FROM user_global_roles target_global_role
            WHERE target_global_role.user_id=target_user.user_id
          )
      )
      AND EXISTS (
        SELECT 1 FROM app_roles target_role
        WHERE target_role.role_key=?3 AND target_role.role_scope='store'
      )
      AND EXISTS (
        SELECT 1
        FROM users actor_user
        WHERE actor_user.user_id=?4
          AND actor_user.status='active'
          AND EXISTS (
            SELECT 1
            FROM user_global_roles actor_role
            JOIN app_roles actor_app_role
              ON actor_app_role.role_key=actor_role.role_key
             AND actor_app_role.role_scope='global'
            JOIN role_permissions actor_permission
              ON actor_permission.role_key=actor_role.role_key
            WHERE actor_role.user_id=actor_user.user_id
              AND actor_permission.permission_key='users.manage'
          )
          AND EXISTS (
            SELECT 1
            FROM user_global_roles actor_role
            JOIN app_roles actor_app_role
              ON actor_app_role.role_key=actor_role.role_key
             AND actor_app_role.role_scope='global'
            JOIN role_permissions actor_permission
              ON actor_permission.role_key=actor_role.role_key
            WHERE actor_role.user_id=actor_user.user_id
              AND actor_permission.permission_key='stores.manage'
          )
      )
    ON CONFLICT(store_id, user_id) DO UPDATE SET
      role_key=excluded.role_key
  `).bind(storeId, userId, role.role_key, actor.user_id);
  const audit = auditedMutationStatement(
    db,
    request,
    actor.user_id,
    storeId,
    'store_member.upsert',
    'store_member',
    `${storeId}:${userId}`,
    {
      storeId,
      userId,
      roleKey: role.role_key,
      previousRoleKey: existing?.role_key || null,
    },
  );

  let mutationChanges;
  try {
    mutationChanges = await executeAuditedMutation(db, mutation, audit, 'store_member_audit_atomicity_violation');
  } catch (error) {
    if (isStoreMemberGlobalRoleConflict(error)) {
      return json(request, { error: 'global_role_conflict' }, 409);
    }
    throw error;
  }

  if (mutationChanges !== 1) {
    const currentPermission = await requireMembershipWritePermissions(db, actor.user_id);
    if (currentPermission) return json(request, { error: 'forbidden', permission: currentPermission }, 403);
    const currentStore = await storeById(db, storeId);
    if (!currentStore) return json(request, { error: 'store_not_found' }, 404);
    const currentUser = await userById(db, userId);
    if (!currentUser) return json(request, { error: 'user_not_found' }, 404);
    if (currentUser.status !== 'active') return json(request, { error: 'user_not_active' }, 409);
    if (Boolean(currentUser.has_global_role)) return json(request, { error: 'global_role_conflict' }, 409);
    const currentRole = await roleByKey(db, value.roleKey);
    if (!currentRole) return json(request, { error: 'role_not_found' }, 404);
    if (currentRole.role_scope !== 'store') return json(request, { error: 'store_role_required' }, 400);
    return json(request, { error: 'store_member_conflict' }, 409);
  }

  const member = await memberDetailByIds(db, storeId, userId);
  if (!member) throw new Error('store_member_readback_missing');
  return json(request, { store: publicStore(store), member: publicMember(member) }, existing ? 200 : 201);
}

async function deleteStoreMember(request, db, actor, storeId, userId) {
  requireAtomicBatch(db);
  const permission = await requireMembershipWritePermissions(db, actor.user_id);
  if (permission) return json(request, { error: 'forbidden', permission }, 403);

  const store = await storeById(db, storeId);
  if (!store) return json(request, { error: 'store_not_found' }, 404);
  const existing = await memberByIds(db, storeId, userId);
  if (!existing) return json(request, { error: 'store_member_not_found' }, 404);

  const mutation = db.prepare(`
    DELETE FROM store_members
    WHERE store_id=?1
      AND user_id=?2
      AND EXISTS (
        SELECT 1 FROM stores target_store
        WHERE target_store.store_id=?1 AND target_store.status<>'disabled'
      )
      AND EXISTS (
        SELECT 1
        FROM users actor_user
        WHERE actor_user.user_id=?3
          AND actor_user.status='active'
          AND EXISTS (
            SELECT 1
            FROM user_global_roles actor_role
            JOIN app_roles actor_app_role
              ON actor_app_role.role_key=actor_role.role_key
             AND actor_app_role.role_scope='global'
            JOIN role_permissions actor_permission
              ON actor_permission.role_key=actor_role.role_key
            WHERE actor_role.user_id=actor_user.user_id
              AND actor_permission.permission_key='users.manage'
          )
          AND EXISTS (
            SELECT 1
            FROM user_global_roles actor_role
            JOIN app_roles actor_app_role
              ON actor_app_role.role_key=actor_role.role_key
             AND actor_app_role.role_scope='global'
            JOIN role_permissions actor_permission
              ON actor_permission.role_key=actor_role.role_key
            WHERE actor_role.user_id=actor_user.user_id
              AND actor_permission.permission_key='stores.manage'
          )
      )
  `).bind(storeId, userId, actor.user_id);
  const audit = auditedMutationStatement(
    db,
    request,
    actor.user_id,
    storeId,
    'store_member.delete',
    'store_member',
    `${storeId}:${userId}`,
    {
      storeId,
      userId,
      roleKey: existing.role_key,
    },
  );

  const mutationChanges = await executeAuditedMutation(db, mutation, audit, 'store_member_audit_atomicity_violation');
  if (mutationChanges !== 1) {
    const currentPermission = await requireMembershipWritePermissions(db, actor.user_id);
    if (currentPermission) return json(request, { error: 'forbidden', permission: currentPermission }, 403);
    if (!await storeById(db, storeId)) return json(request, { error: 'store_not_found' }, 404);
    if (!await memberByIds(db, storeId, userId)) return json(request, { error: 'store_member_not_found' }, 404);
    return json(request, { error: 'store_member_conflict' }, 409);
  }

  return json(request, { deleted: true, storeId, userId }, 200);
}

async function requireMembershipWritePermissions(db, userId) {
  if (!await hasGlobalPermission(db, userId, 'users.manage')) return 'users.manage';
  if (!await hasGlobalPermission(db, userId, 'stores.manage')) return 'stores.manage';
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

async function storeById(db, storeId) {
  return db.prepare(`
    SELECT store_id, store_code, display_name, marketplace_code, amazon_region, status
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
}

async function userById(db, userId) {
  return db.prepare(`
    SELECT
      u.user_id,
      u.email,
      u.display_name,
      u.status,
      EXISTS(
        SELECT 1 FROM user_global_roles WHERE user_id=u.user_id
      ) AS has_global_role
    FROM users u
    WHERE u.user_id=?1
    LIMIT 1
  `).bind(userId).first();
}

async function userDetailById(db, userId) {
  return db.prepare(`
    SELECT
      u.user_id,
      u.cf_access_sub,
      u.email,
      u.display_name,
      u.status,
      u.last_seen_at,
      u.created_at,
      u.updated_at,
      (SELECT GROUP_CONCAT(ugr.role_key, ',') FROM user_global_roles ugr WHERE ugr.user_id = u.user_id) AS global_roles_csv
    FROM users u
    WHERE u.user_id=?1
    LIMIT 1
  `).bind(userId).first();
}

async function roleByKey(db, roleKey) {
  return db.prepare(`
    SELECT role_key, role_name, role_scope, priority, is_system
    FROM app_roles
    WHERE role_key=?1
    LIMIT 1
  `).bind(roleKey).first();
}

async function memberByIds(db, storeId, userId) {
  return db.prepare(`
    SELECT store_id, user_id, role_key, created_at
    FROM store_members
    WHERE store_id=?1 AND user_id=?2
    LIMIT 1
  `).bind(storeId, userId).first();
}

async function memberDetailByIds(db, storeId, userId) {
  return db.prepare(`
    SELECT
      sm.store_id,
      sm.user_id,
      sm.role_key,
      sm.created_at,
      u.email,
      u.display_name,
      u.status AS user_status,
      u.last_seen_at,
      ar.role_name,
      ar.role_scope
    FROM store_members sm
    JOIN users u ON u.user_id = sm.user_id
    JOIN app_roles ar ON ar.role_key = sm.role_key AND ar.role_scope = 'store'
    WHERE sm.store_id=?1 AND sm.user_id=?2
    LIMIT 1
  `).bind(storeId, userId).first();
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
  if (mutationChanges === 1 && auditChanges !== 1) {
    throw new Error(violationError);
  }
  if (mutationChanges !== 1 && auditChanges !== 0) {
    throw new Error(violationError);
  }
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

function validateUserProvisionBody(input) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  const allowed = new Set(['email', 'displayName']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { error: 'unsupported_user_provision_field' };

  if (typeof input.email !== 'string') return { error: 'invalid_user_email' };
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) return { error: 'invalid_user_email' };

  let displayName = null;
  if (input.displayName !== undefined && input.displayName !== null) {
    if (typeof input.displayName !== 'string') return { error: 'invalid_user_display_name' };
    displayName = input.displayName.trim();
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) return { error: 'user_display_name_too_long' };
    if (!displayName) displayName = null;
  }

  return { email, emailNorm: email, displayName };
}

function isValidEmail(value) {
  if (!value || value.length > MAX_EMAIL_LENGTH || /[\u0000-\u0020\u007f]/.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at >= value.length - 3) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || domain.length > 255 || !domain.includes('.')) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
    && /^[a-z0-9.-]+$/i.test(domain)
    && domain.split('.').every((label) => label && !label.startsWith('-') && !label.endsWith('-'));
}

function validateMemberBody(input) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  if (Object.keys(input).some((key) => key !== 'roleKey')) return { error: 'unsupported_store_member_field' };
  const roleKey = String(input.roleKey || '').trim();
  if (!roleKey || roleKey.length > 100) return { error: 'invalid_role_key' };
  return { roleKey };
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

function normalizeSearch(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 200) : null;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function publicUser(row) {
  return {
    userId: row.user_id,
    cfAccessBound: Boolean(row.cf_access_sub),
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    globalRoles: String(row.global_roles_csv || '').split(',').map((value) => value.trim()).filter(Boolean).sort(),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicMember(row) {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    userStatus: row.user_status,
    roleKey: row.role_key,
    roleName: row.role_name,
    roleScope: row.role_scope,
    lastSeenAt: row.last_seen_at,
    memberSince: row.created_at,
  };
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

function pageResponse(request, rows, limit, cursorFromRow) {
  return json(request, pagePayload(rows, limit, cursorFromRow), 200);
}

function pagePayload(rows, limit, cursorFromRow) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(cursorFromRow(last)) : null,
  };
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
    if (!parsed || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return { error: true };
    return { value: parsed };
  } catch {
    return { error: true };
  }
}

function isUniqueError(error) {
  return /unique|constraint/i.test(String(error?.message || error || ''));
}

function isStoreMemberGlobalRoleConflict(error) {
  return /store_member_global_role_conflict/i.test(String(error?.message || error || ''));
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
