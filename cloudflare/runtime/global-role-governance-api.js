const GLOBAL_ROLE_KEYS = new Set(['owner', 'admin']);

export async function handleGlobalRoleGovernanceApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/access\/users\/([^/]+)\/global-roles\/([^/]+)$/);
  if (!match) return null;

  const method = request.method.toUpperCase();
  if (method !== 'PUT' && method !== 'DELETE') {
    return json(request, { error: 'method_not_allowed' }, 405);
  }

  const userId = safeDecode(match[1]);
  const roleKey = safeDecode(match[2]);
  if (!userId) return json(request, { error: 'invalid_user_id' }, 400);
  if (!roleKey || !GLOBAL_ROLE_KEYS.has(roleKey)) {
    return json(request, { error: 'invalid_global_role', allowedRoles: [...GLOBAL_ROLE_KEYS] }, 400);
  }

  const db = env.CONTROL_DB;
  requireAtomicBatch(db);

  const authority = await globalRoleActorAuthority(db, actor.user_id);
  const authorityError = actorAuthorityError(authority);
  if (authorityError) return json(request, authorityError.payload, 403);

  if (userId === actor.user_id) {
    return json(request, { error: 'self_global_role_change_forbidden' }, 409);
  }

  if (method === 'PUT') return grantGlobalRole(request, db, actor.user_id, userId, roleKey);
  return revokeGlobalRole(request, db, actor.user_id, userId, roleKey);
}

async function grantGlobalRole(request, db, actorUserId, userId, roleKey) {
  const target = await globalRoleTargetById(db, userId);
  if (!target) return json(request, { error: 'user_not_found' }, 404);

  const previousGlobalRoles = parseGlobalRoles(target.global_roles_csv);
  if (previousGlobalRoles.includes(roleKey) && previousGlobalRoles.length === 1) {
    const activeOwnerCount = await countActiveOwners(db);
    return json(request, {
      changed: false,
      userId,
      roleKey,
      globalRoles: previousGlobalRoles,
      activeOwnerCount,
    }, 200);
  }
  if (target.status !== 'active') return json(request, { error: 'user_not_active' }, 409);
  if (target.cf_access_sub === null || target.cf_access_sub === undefined) {
    return json(request, { error: 'cf_access_binding_required' }, 409);
  }
  if (previousGlobalRoles.length) {
    return json(request, { error: 'global_role_conflict', globalRoles: previousGlobalRoles }, 409);
  }
  if (Number(target.store_membership_count || 0) > 0) {
    return json(request, { error: 'store_membership_conflict' }, 409);
  }

  const auditContext = buildAuditContext(request);
  const mutation = db.prepare(`
    INSERT INTO user_global_roles(user_id, role_key, granted_by, granted_at)
    SELECT u.user_id, ?2, ?3, CURRENT_TIMESTAMP
    FROM users u
    WHERE u.user_id=?1
      AND u.status='active'
      AND u.cf_access_sub IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_global_roles existing_role
        WHERE existing_role.user_id=u.user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM store_members existing_member
        WHERE existing_member.user_id=u.user_id
      )
      AND EXISTS (
        SELECT 1
        FROM users actor_user
        WHERE actor_user.user_id=?3
          AND actor_user.status='active'
          AND EXISTS (
            SELECT 1 FROM user_global_roles actor_owner
            WHERE actor_owner.user_id=actor_user.user_id AND actor_owner.role_key='owner'
          )
          AND EXISTS (
            SELECT 1
            FROM user_global_roles actor_role
            JOIN app_roles actor_app_role ON actor_app_role.role_key=actor_role.role_key AND actor_app_role.role_scope='global'
            JOIN role_permissions actor_permission ON actor_permission.role_key=actor_role.role_key
            WHERE actor_role.user_id=actor_user.user_id AND actor_permission.permission_key='users.manage'
          )
          AND EXISTS (
            SELECT 1
            FROM user_global_roles actor_role
            JOIN app_roles actor_app_role ON actor_app_role.role_key=actor_role.role_key AND actor_app_role.role_scope='global'
            JOIN role_permissions actor_permission ON actor_permission.role_key=actor_role.role_key
            WHERE actor_role.user_id=actor_user.user_id AND actor_permission.permission_key='system.manage'
          )
      )
  `).bind(userId, roleKey, actorUserId);

  const auditStatement = db.prepare(`
    INSERT INTO audit_log(
      event_id, actor_user_id, store_id, action, entity_type, entity_id,
      request_id, cf_ray, details_json
    )
    SELECT
      ?1, ?2, NULL, 'user.global_role.grant', 'user_global_role', ?3,
      ?4, ?5,
      json_object(
        'userId', ?6,
        'roleKey', ?7,
        'previousGlobalRoles', json('[]'),
        'globalRoles', json_array(?7),
        'grantedBy', ?2,
        'privilegeEscalation', json('true'),
        'activeOwnerCountBefore',
          (SELECT COUNT(*)
           FROM user_global_roles owner_role
           JOIN users owner_user ON owner_user.user_id=owner_role.user_id
           WHERE owner_role.role_key='owner' AND owner_user.status='active')
          - CASE WHEN ?7='owner' THEN 1 ELSE 0 END,
        'activeOwnerCountAfter',
          (SELECT COUNT(*)
           FROM user_global_roles owner_role
           JOIN users owner_user ON owner_user.user_id=owner_role.user_id
           WHERE owner_role.role_key='owner' AND owner_user.status='active')
      )
    WHERE changes()=1
  `).bind(
    auditContext.eventId,
    actorUserId,
    `${userId}:${roleKey}`,
    auditContext.requestId,
    auditContext.cfRay,
    userId,
    roleKey,
  );

  const ownerCountStatement = activeOwnerCountStatement(db);
  const [mutationResult, auditResult, ownerCountResult] = await db.batch([
    mutation,
    auditStatement,
    ownerCountStatement,
  ]);

  const mutationChanges = changedRows(mutationResult);
  const auditChanges = changedRows(auditResult);
  if (mutationChanges === 1 && auditChanges !== 1) {
    throw new Error('global_role_audit_atomicity_violation');
  }

  if (mutationChanges !== 1) {
    const currentAuthority = await globalRoleActorAuthority(db, actorUserId);
    const authorityError = actorAuthorityError(currentAuthority);
    if (authorityError) return json(request, authorityError.payload, 403);

    const current = await globalRoleTargetById(db, userId);
    if (!current) return json(request, { error: 'user_not_found' }, 404);
    const currentRoles = parseGlobalRoles(current.global_roles_csv);
    if (currentRoles.includes(roleKey) && currentRoles.length === 1) {
      const activeOwnerCount = ownerCountFromBatch(ownerCountResult, await countActiveOwners(db));
      return json(request, { changed: false, userId, roleKey, globalRoles: currentRoles, activeOwnerCount }, 200);
    }
    if (current.status !== 'active') return json(request, { error: 'user_not_active' }, 409);
    if (current.cf_access_sub === null || current.cf_access_sub === undefined) {
      return json(request, { error: 'cf_access_binding_required' }, 409);
    }
    if (currentRoles.length) {
      return json(request, { error: 'global_role_conflict', globalRoles: currentRoles }, 409);
    }
    if (Number(current.store_membership_count || 0) > 0) {
      return json(request, { error: 'store_membership_conflict' }, 409);
    }
    return json(request, { error: 'global_role_conflict' }, 409);
  }

  const activeOwnerCountAfter = ownerCountFromBatch(ownerCountResult);
  return json(request, {
    changed: true,
    userId,
    roleKey,
    globalRoles: [roleKey],
    activeOwnerCount: activeOwnerCountAfter,
  }, 200);
}

async function revokeGlobalRole(request, db, actorUserId, userId, roleKey) {
  const target = await globalRoleTargetById(db, userId);
  if (!target) return json(request, { error: 'user_not_found' }, 404);

  const previousGlobalRoles = parseGlobalRoles(target.global_roles_csv);
  if (!previousGlobalRoles.includes(roleKey)) {
    const activeOwnerCount = await countActiveOwners(db);
    return json(request, {
      changed: false,
      userId,
      roleKey,
      globalRoles: previousGlobalRoles,
      activeOwnerCount,
    }, 200);
  }

  const relation = await globalRoleRelationById(db, userId, roleKey);
  if (!relation) {
    const current = await globalRoleTargetById(db, userId);
    const currentRoles = parseGlobalRoles(current?.global_roles_csv);
    const activeOwnerCount = await countActiveOwners(db);
    return json(request, {
      changed: false,
      userId,
      roleKey,
      globalRoles: currentRoles,
      activeOwnerCount,
    }, 200);
  }

  const auditContext = buildAuditContext(request);
  const mutation = db.prepare(`
    DELETE FROM user_global_roles
    WHERE user_id=?1
      AND role_key=?2
      AND rowid=?4
      AND granted_by IS ?5
      AND granted_at=?6
      AND EXISTS (
        SELECT 1
        FROM users actor_user
        WHERE actor_user.user_id=?3
          AND actor_user.status='active'
          AND EXISTS (
            SELECT 1 FROM user_global_roles actor_owner
            WHERE actor_owner.user_id=actor_user.user_id AND actor_owner.role_key='owner'
          )
          AND EXISTS (
            SELECT 1
            FROM user_global_roles actor_role
            JOIN app_roles actor_app_role ON actor_app_role.role_key=actor_role.role_key AND actor_app_role.role_scope='global'
            JOIN role_permissions actor_permission ON actor_permission.role_key=actor_role.role_key
            WHERE actor_role.user_id=actor_user.user_id AND actor_permission.permission_key='users.manage'
          )
          AND EXISTS (
            SELECT 1
            FROM user_global_roles actor_role
            JOIN app_roles actor_app_role ON actor_app_role.role_key=actor_role.role_key AND actor_app_role.role_scope='global'
            JOIN role_permissions actor_permission ON actor_permission.role_key=actor_role.role_key
            WHERE actor_role.user_id=actor_user.user_id AND actor_permission.permission_key='system.manage'
          )
      )
      AND (
        ?2 <> 'owner'
        OR NOT EXISTS (
          SELECT 1 FROM users target_user
          WHERE target_user.user_id=?1 AND target_user.status='active'
        )
        OR (
          SELECT COUNT(*)
          FROM user_global_roles owner_role
          JOIN users owner_user ON owner_user.user_id=owner_role.user_id
          WHERE owner_role.role_key='owner' AND owner_user.status='active'
        ) > 1
      )
  `).bind(
    userId,
    roleKey,
    actorUserId,
    Number(relation.relation_rowid),
    relation.granted_by ?? null,
    relation.granted_at,
  );

  const auditStatement = db.prepare(`
    INSERT INTO audit_log(
      event_id, actor_user_id, store_id, action, entity_type, entity_id,
      request_id, cf_ray, details_json
    )
    SELECT
      ?1, ?2, NULL, 'user.global_role.revoke', 'user_global_role', ?3,
      ?4, ?5,
      json_object(
        'userId', ?6,
        'roleKey', ?7,
        'previousGlobalRoles', json_array(?7),
        'globalRoles', json('[]'),
        'grantedBy', ?8,
        'grantedAt', ?9,
        'privilegeEscalation', json('false'),
        'activeOwnerCountBefore',
          (SELECT COUNT(*)
           FROM user_global_roles owner_role
           JOIN users owner_user ON owner_user.user_id=owner_role.user_id
           WHERE owner_role.role_key='owner' AND owner_user.status='active')
          + CASE WHEN ?7='owner' THEN 1 ELSE 0 END,
        'activeOwnerCountAfter',
          (SELECT COUNT(*)
           FROM user_global_roles owner_role
           JOIN users owner_user ON owner_user.user_id=owner_role.user_id
           WHERE owner_role.role_key='owner' AND owner_user.status='active')
      )
    WHERE changes()=1
  `).bind(
    auditContext.eventId,
    actorUserId,
    `${userId}:${roleKey}`,
    auditContext.requestId,
    auditContext.cfRay,
    userId,
    roleKey,
    relation.granted_by ?? null,
    relation.granted_at,
  );

  const ownerCountStatement = activeOwnerCountStatement(db);
  const [mutationResult, auditResult, ownerCountResult] = await db.batch([
    mutation,
    auditStatement,
    ownerCountStatement,
  ]);

  const mutationChanges = changedRows(mutationResult);
  const auditChanges = changedRows(auditResult);
  if (mutationChanges === 1 && auditChanges !== 1) {
    throw new Error('global_role_audit_atomicity_violation');
  }

  if (mutationChanges !== 1) {
    const current = await globalRoleTargetById(db, userId);
    if (!current) return json(request, { error: 'user_not_found' }, 404);
    const currentRoles = parseGlobalRoles(current.global_roles_csv);
    if (!currentRoles.includes(roleKey)) {
      const activeOwnerCount = ownerCountFromBatch(ownerCountResult, await countActiveOwners(db));
      return json(request, { changed: false, userId, roleKey, globalRoles: currentRoles, activeOwnerCount }, 200);
    }
    const currentAuthority = await globalRoleActorAuthority(db, actorUserId);
    const authorityError = actorAuthorityError(currentAuthority);
    if (authorityError) return json(request, authorityError.payload, 403);
    if (roleKey === 'owner') {
      return json(request, { error: 'last_owner_protection' }, 409);
    }
    return json(request, { error: 'global_role_conflict' }, 409);
  }

  const activeOwnerCountAfter = ownerCountFromBatch(ownerCountResult);
  return json(request, {
    changed: true,
    userId,
    roleKey,
    globalRoles: [],
    activeOwnerCount: activeOwnerCountAfter,
  }, 200);
}

async function globalRoleActorAuthority(db, userId) {
  const row = await db.prepare(`
    SELECT
      u.status,
      EXISTS(
        SELECT 1 FROM user_global_roles owner_role
        WHERE owner_role.user_id=u.user_id AND owner_role.role_key='owner'
      ) AS is_owner,
      EXISTS(
        SELECT 1
        FROM user_global_roles ugr
        JOIN role_permissions rp ON rp.role_key=ugr.role_key
        JOIN app_roles ar ON ar.role_key=ugr.role_key AND ar.role_scope='global'
        WHERE ugr.user_id=u.user_id AND rp.permission_key='users.manage'
      ) AS has_users_manage,
      EXISTS(
        SELECT 1
        FROM user_global_roles ugr
        JOIN role_permissions rp ON rp.role_key=ugr.role_key
        JOIN app_roles ar ON ar.role_key=ugr.role_key AND ar.role_scope='global'
        WHERE ugr.user_id=u.user_id AND rp.permission_key='system.manage'
      ) AS has_system_manage
    FROM users u
    WHERE u.user_id=?1
    LIMIT 1
  `).bind(userId).first();

  return {
    active: row?.status === 'active',
    owner: Boolean(row?.is_owner),
    usersManage: Boolean(row?.has_users_manage),
    systemManage: Boolean(row?.has_system_manage),
  };
}

function actorAuthorityError(authority) {
  if (!authority.active) return { payload: { error: 'forbidden', reason: 'actor_not_active' } };
  if (!authority.owner) return { payload: { error: 'forbidden', role: 'owner' } };
  if (!authority.usersManage) return { payload: { error: 'forbidden', permission: 'users.manage' } };
  if (!authority.systemManage) return { payload: { error: 'forbidden', permission: 'system.manage' } };
  return null;
}

async function globalRoleTargetById(db, userId) {
  return db.prepare(`
    SELECT
      u.user_id,
      u.cf_access_sub,
      u.email,
      u.display_name,
      u.status,
      (SELECT GROUP_CONCAT(ugr.role_key, ',') FROM user_global_roles ugr WHERE ugr.user_id=u.user_id) AS global_roles_csv,
      (SELECT COUNT(*) FROM store_members sm WHERE sm.user_id=u.user_id) AS store_membership_count
    FROM users u
    WHERE u.user_id=?1
    LIMIT 1
  `).bind(userId).first();
}

async function globalRoleRelationById(db, userId, roleKey) {
  return db.prepare(`
    SELECT rowid AS relation_rowid, user_id, role_key, granted_by, granted_at
    FROM user_global_roles
    WHERE user_id=?1 AND role_key=?2
    LIMIT 1
  `).bind(userId, roleKey).first();
}

async function countActiveOwners(db) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS active_owner_count
    FROM user_global_roles ugr
    JOIN users u ON u.user_id=ugr.user_id
    WHERE ugr.role_key='owner' AND u.status='active'
  `).first();
  return Number(row?.active_owner_count || 0);
}

function activeOwnerCountStatement(db) {
  return db.prepare(`
    SELECT COUNT(*) AS active_owner_count
    FROM user_global_roles ugr
    JOIN users u ON u.user_id=ugr.user_id
    WHERE ugr.role_key='owner' AND u.status='active'
  `);
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

function ownerCountFromBatch(result, fallback = null) {
  const row = (result?.results || [])[0] || null;
  if (row && row.active_owner_count !== undefined && row.active_owner_count !== null) {
    return Number(row.active_owner_count || 0);
  }
  if (fallback !== null && fallback !== undefined) return Number(fallback || 0);
  throw new Error('active_owner_count_batch_result_missing');
}

function changedRows(result) {
  const value = result?.meta?.changes ?? result?.changes ?? 0;
  return Number(value || 0);
}

function parseGlobalRoles(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean).sort();
}

function safeDecode(value) {
  try {
    const decoded = decodeURIComponent(String(value || '')).trim();
    return decoded && decoded.length <= 160 ? decoded : null;
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
