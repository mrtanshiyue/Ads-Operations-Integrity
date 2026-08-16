const READ_BODY_LIMIT = 16 * 1024;

export async function handleUserLifecycleApiRoute({ request, env, actor, url }) {
  if (url.pathname !== '/api/v1/access/users' || request.method.toUpperCase() !== 'PATCH') return null;

  const db = env.CONTROL_DB;
  requireAtomicBatch(db);
  if (!await hasGlobalPermission(db, actor.user_id, 'users.manage')) {
    return json(request, { error: 'forbidden', permission: 'users.manage' }, 403);
  }

  const body = await readJson(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const value = validateLifecycleBody(body.value);
  if (value.error) return json(request, { error: value.error }, 400);

  const existing = await userDetailById(db, value.userId);
  if (!existing) return json(request, { error: 'user_not_found' }, 404);
  if (existing.user_id === actor.user_id) {
    return json(request, { error: 'self_user_lifecycle_change_forbidden' }, 409);
  }
  const globalRoles = parseGlobalRoles(existing.global_roles_csv);
  if (globalRoles.length) {
    return json(request, {
      error: 'global_role_user_lifecycle_change_forbidden',
      globalRoles,
    }, 409);
  }

  if (existing.status === value.status) {
    return json(request, { user: publicUser(existing), changed: false }, 200);
  }

  const auditContext = buildAuditContext(request);
  const mutation = db.prepare(`
    UPDATE users
    SET status=?1, updated_at=CURRENT_TIMESTAMP
    WHERE user_id=?2
      AND status=?3
      AND user_id<>?4
      AND NOT EXISTS (
        SELECT 1 FROM user_global_roles target_global_role
        WHERE target_global_role.user_id=users.user_id
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
      )
  `).bind(value.status, value.userId, existing.status, actor.user_id);

  const auditStatement = db.prepare(`
    INSERT INTO audit_log(
      event_id, actor_user_id, store_id, action, entity_type, entity_id,
      request_id, cf_ray, details_json
    )
    SELECT ?1, ?2, NULL, 'user.status.update', 'user', ?3, ?4, ?5, ?6
    WHERE changes()=1
  `).bind(
    auditContext.eventId,
    actor.user_id,
    value.userId,
    auditContext.requestId,
    auditContext.cfRay,
    JSON.stringify({
      userId: value.userId,
      previousStatus: existing.status,
      status: value.status,
      membershipsPreserved: true,
    }),
  );

  const readBackStatement = userDetailStatement(db, value.userId);
  const [mutationResult, auditResult, readBackResult] = await db.batch([
    mutation,
    auditStatement,
    readBackStatement,
  ]);

  const mutationChanges = changedRows(mutationResult);
  const auditChanges = changedRows(auditResult);
  if (mutationChanges === 1 && auditChanges !== 1) {
    throw new Error('user_lifecycle_audit_atomicity_violation');
  }

  if (mutationChanges !== 1) {
    if (!await hasGlobalPermission(db, actor.user_id, 'users.manage')) {
      return json(request, { error: 'forbidden', permission: 'users.manage' }, 403);
    }
    const current = await userDetailById(db, value.userId);
    if (!current) return json(request, { error: 'user_not_found' }, 404);
    if (current.user_id === actor.user_id) {
      return json(request, { error: 'self_user_lifecycle_change_forbidden' }, 409);
    }
    const currentGlobalRoles = parseGlobalRoles(current.global_roles_csv);
    if (currentGlobalRoles.length) {
      return json(request, {
        error: 'global_role_user_lifecycle_change_forbidden',
        globalRoles: currentGlobalRoles,
      }, 409);
    }
    if (current.status === value.status) {
      return json(request, { user: publicUser(current), changed: false }, 200);
    }
    return json(request, { error: 'user_lifecycle_conflict' }, 409);
  }

  const updated = firstBatchRow(readBackResult);
  if (!updated) throw new Error('user_lifecycle_readback_missing');
  return json(request, { user: publicUser(updated), changed: true }, 200);
}

async function hasGlobalPermission(db, userId, permission) {
  return Boolean(await db.prepare(`
    SELECT 1 AS ok
    FROM users u
    JOIN user_global_roles ugr ON ugr.user_id=u.user_id
    JOIN app_roles ar ON ar.role_key=ugr.role_key AND ar.role_scope='global'
    JOIN role_permissions rp ON rp.role_key=ugr.role_key
    WHERE u.user_id=?1
      AND u.status='active'
      AND rp.permission_key=?2
    LIMIT 1
  `).bind(userId, permission).first());
}

async function userDetailById(db, userId) {
  return userDetailStatement(db, userId).first();
}

function userDetailStatement(db, userId) {
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
      (SELECT GROUP_CONCAT(ugr.role_key, ',') FROM user_global_roles ugr WHERE ugr.user_id=u.user_id) AS global_roles_csv
    FROM users u
    WHERE u.user_id=?1
    LIMIT 1
  `).bind(userId);
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

function firstBatchRow(result) {
  return (result?.results || [])[0] || null;
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

function validateLifecycleBody(input) {
  if (!plainObject(input)) return { error: 'invalid_json_object' };
  const allowed = new Set(['userId', 'status']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { error: 'unsupported_user_lifecycle_field' };

  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (!userId || userId.length > 160) return { error: 'invalid_user_id' };
  if (!['active', 'disabled'].includes(input.status)) return { error: 'invalid_user_status' };
  return { userId, status: input.status };
}

function publicUser(row) {
  return {
    userId: row.user_id,
    cfAccessBound: Boolean(row.cf_access_sub),
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    globalRoles: parseGlobalRoles(row.global_roles_csv),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseGlobalRoles(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean).sort();
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
