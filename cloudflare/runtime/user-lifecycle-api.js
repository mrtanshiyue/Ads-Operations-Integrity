const READ_BODY_LIMIT = 16 * 1024;

export async function handleUserLifecycleApiRoute({ request, env, actor, url }) {
  if (url.pathname !== '/api/v1/access/users' || request.method.toUpperCase() !== 'PATCH') return null;

  const db = env.CONTROL_DB;
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

  await db.prepare(`
    UPDATE users
    SET status=?1, updated_at=CURRENT_TIMESTAMP
    WHERE user_id=?2
  `).bind(value.status, value.userId).run();

  await audit(db, request, actor.user_id, 'user.status.update', 'user', value.userId, {
    userId: value.userId,
    previousStatus: existing.status,
    status: value.status,
    membershipsPreserved: true,
  });

  const updated = await userDetailById(db, value.userId);
  return json(request, { user: publicUser(updated), changed: true }, 200);
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
