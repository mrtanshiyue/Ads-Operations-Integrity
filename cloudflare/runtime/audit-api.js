const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_FILTER_TEXT = 160;

export async function handleAuditApiRoute({ request, env, actor, url }) {
  if (url.pathname !== '/api/v1/audit/events') return null;
  if (request.method.toUpperCase() !== 'GET') {
    return json(request, { error: 'method_not_allowed' }, 405);
  }

  const filters = parseFilters(url);
  if (filters.error) return json(request, { error: filters.error }, 400);

  const db = env.CONTROL_DB;
  const globalRead = await hasGlobalPermission(db, actor.user_id, 'audit.read');
  if (filters.storeId) {
    const store = await storeById(db, filters.storeId);
    if (!store) return json(request, { error: 'store_not_found' }, 404);
    if (!globalRead && !await hasStorePermission(db, actor.user_id, filters.storeId, 'audit.read')) {
      return json(request, { error: 'forbidden', permission: 'audit.read' }, 403);
    }
  } else if (!globalRead) {
    return json(request, { error: 'forbidden', permission: 'audit.read' }, 403);
  }

  const result = await db.prepare(`
    SELECT
      a.event_id,
      a.occurred_at,
      a.actor_user_id,
      u.email AS actor_email,
      u.display_name AS actor_display_name,
      a.store_id,
      s.store_code,
      s.display_name AS store_display_name,
      a.action,
      a.entity_type,
      a.entity_id,
      a.request_id,
      a.cf_ray,
      a.details_json
    FROM audit_log a
    LEFT JOIN users u ON u.user_id = a.actor_user_id
    LEFT JOIN stores s ON s.store_id = a.store_id
    WHERE (?1 IS NULL OR a.store_id = ?1)
      AND (?2 IS NULL OR a.action = ?2)
      AND (?3 IS NULL OR a.entity_type = ?3)
      AND (?4 IS NULL OR a.actor_user_id = ?4)
      AND (?5 IS NULL OR a.occurred_at >= ?5)
      AND (?6 IS NULL OR a.occurred_at <= ?6)
      AND (?7 IS NULL OR a.occurred_at < ?7 OR (a.occurred_at = ?7 AND a.event_id < ?8))
    ORDER BY a.occurred_at DESC, a.event_id DESC
    LIMIT ?9
  `).bind(
    filters.storeId,
    filters.action,
    filters.entityType,
    filters.actorUserId,
    filters.from,
    filters.to,
    filters.cursor?.occurredAt || null,
    filters.cursor?.eventId || null,
    filters.limit + 1,
  ).all();

  const rows = (result.results || []).map(publicAuditEvent);
  const hasMore = rows.length > filters.limit;
  const items = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = items.at(-1);

  return json(request, {
    filters: {
      storeId: filters.storeId,
      action: filters.action,
      entityType: filters.entityType,
      actorUserId: filters.actorUserId,
      from: filters.from,
      to: filters.to,
    },
    items,
    nextCursor: hasMore && last
      ? encodeCursor({ occurredAt: last.occurredAt, eventId: last.eventId })
      : null,
  }, 200);
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

async function hasStorePermission(db, userId, storeId, permission) {
  return Boolean(await db.prepare(`
    SELECT 1 AS ok
    FROM store_members sm
    JOIN app_roles ar ON ar.role_key = sm.role_key AND ar.role_scope = 'store'
    JOIN role_permissions rp ON rp.role_key = sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3
    LIMIT 1
  `).bind(userId, storeId, permission).first());
}

async function storeById(db, storeId) {
  return db.prepare(`
    SELECT store_id
    FROM stores
    WHERE store_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
}

function parseFilters(url) {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: 'invalid_limit' };

  const storeId = optionalText(url.searchParams.get('storeId'));
  if (storeId.error) return { error: 'invalid_store_id' };
  const action = optionalText(url.searchParams.get('action'));
  if (action.error) return { error: 'invalid_audit_action' };
  const entityType = optionalText(url.searchParams.get('entityType'));
  if (entityType.error) return { error: 'invalid_audit_entity_type' };
  const actorUserId = optionalText(url.searchParams.get('actorUserId'));
  if (actorUserId.error) return { error: 'invalid_audit_actor_user_id' };

  const from = optionalDateTime(url.searchParams.get('from'), false);
  if (from.error) return { error: 'invalid_audit_from' };
  const to = optionalDateTime(url.searchParams.get('to'), true);
  if (to.error) return { error: 'invalid_audit_to' };
  if (from.value && to.value && from.value > to.value) return { error: 'invalid_audit_date_range' };

  const cursor = decodeCursor(url.searchParams.get('cursor'));
  if (cursor.error) return { error: 'invalid_cursor' };

  return {
    limit,
    storeId: storeId.value,
    action: action.value,
    entityType: entityType.value,
    actorUserId: actorUserId.value,
    from: from.value,
    to: to.value,
    cursor: cursor.value,
  };
}

function optionalText(value) {
  if (value === null || value === '') return { value: null };
  const text = String(value).trim();
  if (!text || text.length > MAX_FILTER_TEXT || /[\u0000-\u001f\u007f]/.test(text)) return { error: true };
  return { value: text };
}

function optionalDateTime(value, endOfDay) {
  if (value === null || value === '') return { value: null };
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (!isCanonicalDate(text)) return { error: true };
    return { value: `${text} ${endOfDay ? '23:59:59' : '00:00:00'}` };
  }
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return { error: true };
  const [, date, hour, minute, second = '00'] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return { error: true };
  if (!isCanonicalDate(date)) return { error: true };
  return { value: `${date} ${hour}:${minute}:${second}` };
}

function isCanonicalDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function publicAuditEvent(row) {
  return {
    eventId: row.event_id,
    occurredAt: row.occurred_at,
    actor: {
      userId: row.actor_user_id,
      email: row.actor_email,
      displayName: row.actor_display_name,
    },
    store: row.store_id ? {
      storeId: row.store_id,
      storeCode: row.store_code,
      displayName: row.store_display_name,
    } : null,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    requestId: row.request_id,
    cfRay: row.cf_ray,
    details: parseDetails(row.details_json),
  };
}

function parseDetails(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return { unparsed: String(value) };
  }
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
    if (!parsed || typeof parsed.occurredAt !== 'string' || typeof parsed.eventId !== 'string') return { error: true };
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
