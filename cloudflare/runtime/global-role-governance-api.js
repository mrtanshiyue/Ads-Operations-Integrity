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

  const result = await db.prepare(`
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
  `).bind(userId, roleKey, actorUserId).run();

  if (changedRows(result) !== 1) {
    const currentAuthority = await globalRoleActorAuthority(db, actorUserId);
    const authorityError = actorAuthorityError(currentAuthority);
    if (authorityError) return json(request, authorityError.payload, 403);

    const current = await globalRoleTargetById(db, userId);
    if (!current) return json(request, { error: 'user_not_found' }, 404);
    const currentRoles = parseGlobalRoles(current.global_roles_csv);
    if (currentRoles.includes(roleKey) && currentRoles.length === 1) {
      const activeOwnerCount = await countActiveOwners(db);
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

  const globalRoles = [roleKey];
  const activeOwnerCountAfter = await countActiveOwners(db);
  const activeOwnerCountBefore = roleKey === 'owner'
    ? Math.max(0, activeOwnerCountAfter - 1)
    : activeOwnerCountAfter;

  await audit(db, request, actorUserId, 'user.global_role.grant', 'user_global_role', `${userId}:${roleKey}`, {
    userId,
    roleKey,
    previousGlobalRoles,
    globalRoles,
    grantedBy: actorUserId,
    privilegeEscalation: true,
    activeOwnerCountBefore,
    activeOwnerCountAfter,
  });

  return json(request, {
    changed: true,
    userId,
    roleKey,
    globalRoles,
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

  const deleteResult = await db.prepare(`
    DELETE FROM user_global_roles
    WHERE user_id=?1
      AND role_key=?2
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
    RETURNING user_id, role_key, granted_by, granted_at
  `).bind(userId, roleKey, actorUserId).all();

  const revoked = (deleteResult.results || [])[0] || null;
  if (!revoked) {
    const current = await globalRoleTargetById(db, userId);
    if (!current) return json(request, { error: 'user_not_found' }, 404);
    const currentRoles = parseGlobalRoles(current.global_roles_csv);
    if (!currentRoles.includes(roleKey)) {
      const activeOwnerCount = await countActiveOwners(db);
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

  const globalRoles = previousGlobalRoles.filter((item) => item !== roleKey);
  const activeOwnerCountAfter = await countActiveOwners(db);
  const targetWasActiveOwner = roleKey === 'owner' && target.status === 'active';
  const activeOwnerCountBefore = targetWasActiveOwner
    ? activeOwnerCountAfter + 1
    : activeOwnerCountAfter;

  await audit(db, request, actorUserId, 'user.global_role.revoke', 'user_global_role', `${userId}:${roleKey}`, {
    userId,
    roleKey,
    previousGlobalRoles,
    globalRoles,
    grantedBy: revoked.granted_by || null,
    grantedAt: revoked.granted_at || null,
    privilegeEscalation: false,
    activeOwnerCountBefore,
    activeOwnerCountAfter,
  });

  return json(request, {
    changed: true,
    userId,
    roleKey,
    globalRoles,
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

async function countActiveOwners(db) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS active_owner_count
    FROM user_global_roles ugr
    JOIN users u ON u.user_id=ugr.user_id
    WHERE ugr.role_key='owner' AND u.status='active'
  `).first();
  return Number(row?.active_owner_count || 0);
}

async function audit(db, request, actorUserId, action, entityType, entityId, details) {
  await db.prepare(`
    INSERT INTO audit_log(event_id, actor_user_id, store_id, action, entity_type, entity_id, request_id, cf_ray, details_json)
    VALUES(?1,?2,NULL,?3,?4,?5,?6,?7,?8)
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
