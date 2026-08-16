const MAX_RANGE_DAYS = 366;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const KEYWORD_WINDOWS = new Set([7,14,30,60,90,180,365]);

export async function handleAnalyticsApiRoute({ request, env, actor, url }) {
  if (request.method !== 'GET') return null;
  const match = url.pathname.match(/^\/api\/v1\/analytics\/(overview|products|keywords)$/);
  if (!match) return null;

  const access = await accessibleStores(env.CONTROL_DB, actor.user_id);
  if (!access.storeIds.length) {
    return json(request, { error: 'forbidden', permission: 'analytics.read' }, 403);
  }

  const requestedStoreId = optionalText(url.searchParams.get('storeId'), 200);
  const scope = restrictScope(access.storeIds, requestedStoreId);
  if (scope.error) return json(request, { error: scope.error }, 403);

  if (match[1] === 'overview') return overview(request, env.CONTROL_DB, url, scope.storeIds);
  if (match[1] === 'products') return products(request, env.CONTROL_DB, url, scope.storeIds);
  if (match[1] === 'keywords') return keywords(request, env.CONTROL_DB, url, scope.storeIds);
  return null;
}

async function overview(request, db, url, storeIds) {
  const range = parseDateRange(url);
  if (range.error) return json(request, { error: range.error }, 400);
  const adProduct = optionalText(url.searchParams.get('adProduct'), 80);
  const inClause = placeholders(storeIds.length, 3);
  const params = [range.startDate, range.endDate, ...storeIds, adProduct];
  const adProductIndex = 3 + storeIds.length;

  const [totals, perStore, daily, sync] = await Promise.all([
    db.prepare(`
      SELECT SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(cost_micros) AS cost_micros,
             SUM(purchases) AS purchases, SUM(units_sold) AS units_sold, SUM(sales_micros) AS sales_micros
      FROM store_daily_summary
      WHERE report_date BETWEEN ?1 AND ?2
        AND store_id IN (${inClause})
        AND (?${adProductIndex} IS NULL OR ad_product = ?${adProductIndex})
    `).bind(...params).first(),
    db.prepare(`
      SELECT s.store_id, s.store_code, s.display_name,
             SUM(d.impressions) AS impressions, SUM(d.clicks) AS clicks, SUM(d.cost_micros) AS cost_micros,
             SUM(d.purchases) AS purchases, SUM(d.units_sold) AS units_sold, SUM(d.sales_micros) AS sales_micros
      FROM store_daily_summary d
      JOIN stores s ON s.store_id = d.store_id
      WHERE d.report_date BETWEEN ?1 AND ?2
        AND d.store_id IN (${inClause})
        AND (?${adProductIndex} IS NULL OR d.ad_product = ?${adProductIndex})
      GROUP BY s.store_id, s.store_code, s.display_name
      ORDER BY cost_micros DESC, s.store_id
    `).bind(...params).all(),
    db.prepare(`
      SELECT report_date,
             SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(cost_micros) AS cost_micros,
             SUM(purchases) AS purchases, SUM(units_sold) AS units_sold, SUM(sales_micros) AS sales_micros
      FROM store_daily_summary
      WHERE report_date BETWEEN ?1 AND ?2
        AND store_id IN (${inClause})
        AND (?${adProductIndex} IS NULL OR ad_product = ?${adProductIndex})
      GROUP BY report_date
      ORDER BY report_date
    `).bind(...params).all(),
    db.prepare(`
      SELECT s.store_id, s.store_code, s.display_name, ss.sync_status, ss.active_run_id,
             ss.last_success_at, ss.last_error_at, ss.last_error_code, ss.lag_minutes, ss.updated_at
      FROM stores s
      LEFT JOIN store_sync_status ss ON ss.store_id = s.store_id
      WHERE s.store_id IN (${placeholders(storeIds.length, 1)})
      ORDER BY s.sort_order, s.store_code
    `).bind(...storeIds).all(),
  ]);

  return json(request, {
    range,
    adProduct,
    totals: metricRow(totals),
    stores: (perStore.results || []).map((row) => ({
      storeId: row.store_id,
      storeCode: row.store_code,
      displayName: row.display_name,
      ...metricRow(row),
    })),
    daily: (daily.results || []).map((row) => ({ reportDate: row.report_date, ...metricRow(row) })),
    sync: (sync.results || []).map((row) => ({
      storeId: row.store_id,
      storeCode: row.store_code,
      displayName: row.display_name,
      status: row.sync_status || 'never',
      activeRunId: row.active_run_id || null,
      lastSuccessAt: row.last_success_at || null,
      lastErrorAt: row.last_error_at || null,
      lastErrorCode: row.last_error_code || null,
      lagMinutes: nullableNumber(row.lag_minutes),
      updatedAt: row.updated_at || null,
    })),
  }, 200);
}

async function products(request, db, url, storeIds) {
  const range = parseDateRange(url);
  if (range.error) return json(request, { error: range.error }, 400);
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const sort = metricSort(url.searchParams.get('sort'));
  if (sort.error) return json(request, { error: sort.error }, 400);
  const cursor = decodeMetricCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const adProduct = optionalText(url.searchParams.get('adProduct'), 80);
  const metric = sortColumn(sort.value);
  const inClause = placeholders(storeIds.length, 3);
  const adIndex = 3 + storeIds.length;
  const qIndex = adIndex + 1;
  const cursorMetricIndex = qIndex + 1;
  const cursorIdIndex = cursorMetricIndex + 1;
  const limitIndex = cursorIdIndex + 1;
  const params = [range.startDate, range.endDate, ...storeIds, adProduct, q ? `%${escapeLike(q)}%` : null,
    cursor.value?.sortValue ?? null, cursor.value?.id || null, paging.limit + 1];

  const result = await db.prepare(`
    WITH agg AS (
      SELECT p.product_id, p.model_code, p.model_name, p.brand,
             SUM(d.impressions) AS impressions, SUM(d.clicks) AS clicks, SUM(d.cost_micros) AS cost_micros,
             SUM(d.purchases) AS purchases, SUM(d.units_sold) AS units_sold, SUM(d.sales_micros) AS sales_micros
      FROM product_daily_summary d
      JOIN products p ON p.product_id = d.product_id
      WHERE d.report_date BETWEEN ?1 AND ?2
        AND d.store_id IN (${inClause})
        AND (?${adIndex} IS NULL OR d.ad_product = ?${adIndex})
        AND (?${qIndex} IS NULL OR p.model_code LIKE ?${qIndex} ESCAPE '\\' OR p.model_name LIKE ?${qIndex} ESCAPE '\\')
      GROUP BY p.product_id, p.model_code, p.model_name, p.brand
    ), ranked AS (
      SELECT *, ${metric} AS sort_value FROM agg
    )
    SELECT * FROM ranked
    WHERE (?${cursorMetricIndex} IS NULL OR sort_value < ?${cursorMetricIndex}
      OR (sort_value = ?${cursorMetricIndex} AND product_id < ?${cursorIdIndex}))
    ORDER BY sort_value DESC, product_id DESC
    LIMIT ?${limitIndex}
  `).bind(...params).all();

  const rows = (result.results || []).map((row) => ({
    id: row.product_id,
    sortValue: number(row.sort_value),
    item: {
      productId: row.product_id,
      modelCode: row.model_code,
      modelName: row.model_name,
      brand: row.brand,
      ...metricRow(row),
    },
  }));
  return metricPage(request, rows, paging.limit, { range, sort: sort.value });
}

async function keywords(request, db, url, storeIds) {
  const asOfDate = isoDate(url.searchParams.get('asOfDate'));
  if (!asOfDate) return json(request, { error: 'as_of_date_required' }, 400);
  const windowDays = Number(url.searchParams.get('windowDays') || 30);
  if (!KEYWORD_WINDOWS.has(windowDays)) return json(request, { error: 'invalid_window_days' }, 400);
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const sort = metricSort(url.searchParams.get('sort'));
  if (sort.error) return json(request, { error: sort.error }, 400);
  const cursor = decodeMetricCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const metric = sortColumn(sort.value);
  const inClause = placeholders(storeIds.length, 3);
  const qIndex = 3 + storeIds.length;
  const cursorMetricIndex = qIndex + 1;
  const cursorIdIndex = cursorMetricIndex + 1;
  const limitIndex = cursorIdIndex + 1;
  const params = [asOfDate, windowDays, ...storeIds, q ? `%${escapeLike(q)}%` : null,
    cursor.value?.sortValue ?? null, cursor.value?.id || null, paging.limit + 1];

  const result = await db.prepare(`
    WITH agg AS (
      SELECT k.keyword_id, k.keyword_text, k.normalized_term, k.intent_class, k.semantic_cluster,
             SUM(r.impressions) AS impressions, SUM(r.clicks) AS clicks, SUM(r.cost_micros) AS cost_micros,
             SUM(r.purchases) AS purchases, SUM(r.units_sold) AS units_sold, SUM(r.sales_micros) AS sales_micros
      FROM keyword_performance_rollup r
      JOIN keyword_library k ON k.keyword_id = r.keyword_id
      WHERE r.as_of_date = ?1 AND r.window_days = ?2
        AND r.store_id IN (${inClause})
        AND (?${qIndex} IS NULL OR k.keyword_text LIKE ?${qIndex} ESCAPE '\\' OR k.normalized_term LIKE ?${qIndex} ESCAPE '\\')
      GROUP BY k.keyword_id, k.keyword_text, k.normalized_term, k.intent_class, k.semantic_cluster
    ), ranked AS (
      SELECT *, ${metric} AS sort_value FROM agg
    )
    SELECT * FROM ranked
    WHERE (?${cursorMetricIndex} IS NULL OR sort_value < ?${cursorMetricIndex}
      OR (sort_value = ?${cursorMetricIndex} AND keyword_id < ?${cursorIdIndex}))
    ORDER BY sort_value DESC, keyword_id DESC
    LIMIT ?${limitIndex}
  `).bind(...params).all();

  const rows = (result.results || []).map((row) => ({
    id: row.keyword_id,
    sortValue: number(row.sort_value),
    item: {
      keywordId: row.keyword_id,
      keywordText: row.keyword_text,
      normalizedTerm: row.normalized_term,
      intentClass: row.intent_class,
      semanticCluster: row.semantic_cluster,
      ...metricRow(row),
    },
  }));
  return metricPage(request, rows, paging.limit, { asOfDate, windowDays, sort: sort.value });
}

async function accessibleStores(db, userId) {
  const global = await db.prepare(`
    SELECT 1 AS ok FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key=ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key='analytics.read' LIMIT 1
  `).bind(userId).first();
  if (global) {
    const result = await db.prepare(`SELECT store_id FROM stores WHERE status='active' ORDER BY sort_order, store_id`).all();
    return { storeIds: (result.results || []).map((row) => row.store_id), global: true };
  }
  const result = await db.prepare(`
    SELECT DISTINCT sm.store_id FROM store_members sm
    JOIN role_permissions rp ON rp.role_key=sm.role_key
    JOIN stores s ON s.store_id=sm.store_id
    WHERE sm.user_id=?1 AND rp.permission_key='analytics.read' AND s.status='active'
    ORDER BY sm.store_id
  `).bind(userId).all();
  return { storeIds: (result.results || []).map((row) => row.store_id), global: false };
}

function restrictScope(allowed, requested) {
  if (!requested) return { storeIds: allowed };
  return allowed.includes(requested) ? { storeIds: [requested] } : { error: 'store_scope_forbidden' };
}

function parseDateRange(url) {
  const startDate = isoDate(url.searchParams.get('startDate'));
  const endDate = isoDate(url.searchParams.get('endDate'));
  if (!startDate || !endDate) return { error: 'date_range_required' };
  if (endDate < startDate) return { error: 'date_range_invalid' };
  const days = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) return { error: 'date_range_too_large' };
  return { startDate, endDate, days };
}

function parsePaging(url) {
  const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: 'invalid_limit' };
  return { limit, cursor: url.searchParams.get('cursor') };
}
function metricSort(value) {
  const sort = String(value || 'cost').trim().toLowerCase();
  return ['cost','sales','clicks','purchases','impressions'].includes(sort) ? { value: sort } : { error: 'invalid_sort' };
}
function sortColumn(sort) {
  return { cost: 'cost_micros', sales: 'sales_micros', clicks: 'clicks', purchases: 'purchases', impressions: 'impressions' }[sort];
}
function placeholders(count, start) {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(',');
}
function metricRow(row) {
  return {
    impressions: number(row?.impressions),
    clicks: number(row?.clicks),
    costMicros: number(row?.cost_micros),
    purchases: number(row?.purchases),
    unitsSold: number(row?.units_sold),
    salesMicros: number(row?.sales_micros),
  };
}
function metricPage(request, rows, limit, metadata) {
  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  const last = selected.at(-1);
  return json(request, {
    ...metadata,
    items: selected.map((row) => row.item),
    nextCursor: hasMore && last ? encodeCursor({ sortValue: last.sortValue, id: last.id }) : null,
  }, 200);
}
function decodeMetricCursor(value) {
  if (!value) return { value: null };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
    if (!Number.isFinite(parsed?.sortValue) || typeof parsed?.id !== 'string') throw new Error('bad');
    return { value: parsed };
  } catch { return { error: true }; }
}
function encodeCursor(value) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
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
function isoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}
function optionalText(value, max) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}
function normalizeSearch(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 200) : null;
}
function escapeLike(value) { return String(value).replace(/[\\%_]/g, (m) => `\\${m}`); }
function number(value) { return Number(value || 0); }
function nullableNumber(value) { return value === null || value === undefined ? null : Number(value); }
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
