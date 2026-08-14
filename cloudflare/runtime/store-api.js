const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_ANALYTICS_DAYS = 93;

export async function handleStoreApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/(campaigns|ad-groups|keywords|targets|search-terms)$/);
  if (!match || request.method !== 'GET') return null;

  const storeId = decodeURIComponent(match[1]);
  const resource = match[2];
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, 'ads.read');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  if (resource === 'campaigns') return listCampaigns(request, route.storeDb, url);
  if (resource === 'ad-groups') return listAdGroups(request, route.storeDb, url);
  if (resource === 'keywords') return listKeywords(request, route.storeDb, url);
  if (resource === 'targets') return listTargets(request, route.storeDb, url);
  if (resource === 'search-terms') return listSearchTerms(request, route.storeDb, url);
  return null;
}

async function listCampaigns(request, db, url) {
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const cursor = decodeEntityCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const profileId = optionalText(url.searchParams.get('profileId'), 200);
  const state = optionalText(url.searchParams.get('state'), 80);
  const adProduct = optionalText(url.searchParams.get('adProduct'), 80);

  const result = await db.prepare(`
    SELECT campaign_id, profile_id, portfolio_id, ad_product, name, state, targeting_type,
           bidding_strategy, daily_budget_micros, start_date, end_date, source_updated_at, synced_at
    FROM campaigns
    WHERE (?1 IS NULL OR profile_id = ?1)
      AND (?2 IS NULL OR state = ?2)
      AND (?3 IS NULL OR ad_product = ?3)
      AND (?4 IS NULL OR name LIKE ?4 ESCAPE '\\' OR campaign_id LIKE ?4 ESCAPE '\\')
      AND (?5 IS NULL OR synced_at < ?5 OR (synced_at = ?5 AND campaign_id < ?6))
    ORDER BY synced_at DESC, campaign_id DESC
    LIMIT ?7
  `).bind(profileId, state, adProduct, q ? `%${escapeLike(q)}%` : null,
    cursor.value?.syncedAt || null, cursor.value?.id || null, paging.limit + 1).all();

  const rows = (result.results || []).map((row) => ({
    campaignId: row.campaign_id,
    profileId: row.profile_id,
    portfolioId: row.portfolio_id,
    adProduct: row.ad_product,
    name: row.name,
    state: row.state,
    targetingType: row.targeting_type,
    biddingStrategy: row.bidding_strategy,
    dailyBudgetMicros: nullableNumber(row.daily_budget_micros),
    startDate: row.start_date,
    endDate: row.end_date,
    sourceUpdatedAt: row.source_updated_at,
    syncedAt: row.synced_at,
  }));
  return entityPage(request, rows, paging.limit, (row) => ({ syncedAt: row.syncedAt, id: row.campaignId }));
}

async function listAdGroups(request, db, url) {
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const cursor = decodeEntityCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const profileId = optionalText(url.searchParams.get('profileId'), 200);
  const campaignId = optionalText(url.searchParams.get('campaignId'), 200);
  const state = optionalText(url.searchParams.get('state'), 80);

  const result = await db.prepare(`
    SELECT ag.ad_group_id, ag.profile_id, ag.campaign_id, c.name AS campaign_name,
           ag.name, ag.state, ag.default_bid_micros, ag.source_updated_at, ag.synced_at
    FROM ad_groups ag
    LEFT JOIN campaigns c ON c.campaign_id = ag.campaign_id
    WHERE (?1 IS NULL OR ag.profile_id = ?1)
      AND (?2 IS NULL OR ag.campaign_id = ?2)
      AND (?3 IS NULL OR ag.state = ?3)
      AND (?4 IS NULL OR ag.name LIKE ?4 ESCAPE '\\' OR ag.ad_group_id LIKE ?4 ESCAPE '\\')
      AND (?5 IS NULL OR ag.synced_at < ?5 OR (ag.synced_at = ?5 AND ag.ad_group_id < ?6))
    ORDER BY ag.synced_at DESC, ag.ad_group_id DESC
    LIMIT ?7
  `).bind(profileId, campaignId, state, q ? `%${escapeLike(q)}%` : null,
    cursor.value?.syncedAt || null, cursor.value?.id || null, paging.limit + 1).all();

  const rows = (result.results || []).map((row) => ({
    adGroupId: row.ad_group_id,
    profileId: row.profile_id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    name: row.name,
    state: row.state,
    defaultBidMicros: nullableNumber(row.default_bid_micros),
    sourceUpdatedAt: row.source_updated_at,
    syncedAt: row.synced_at,
  }));
  return entityPage(request, rows, paging.limit, (row) => ({ syncedAt: row.syncedAt, id: row.adGroupId }));
}

async function listKeywords(request, db, url) {
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const cursor = decodeEntityCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const profileId = optionalText(url.searchParams.get('profileId'), 200);
  const campaignId = optionalText(url.searchParams.get('campaignId'), 200);
  const adGroupId = optionalText(url.searchParams.get('adGroupId'), 200);
  const state = optionalText(url.searchParams.get('state'), 80);
  const matchType = optionalText(url.searchParams.get('matchType'), 80);

  const result = await db.prepare(`
    SELECT k.keyword_id, k.profile_id, k.campaign_id, c.name AS campaign_name,
           k.ad_group_id, ag.name AS ad_group_name, k.keyword_text, k.normalized_keyword,
           k.match_type, k.state, k.bid_micros, k.source_updated_at, k.synced_at
    FROM keywords k
    LEFT JOIN campaigns c ON c.campaign_id = k.campaign_id
    LEFT JOIN ad_groups ag ON ag.ad_group_id = k.ad_group_id
    WHERE (?1 IS NULL OR k.profile_id = ?1)
      AND (?2 IS NULL OR k.campaign_id = ?2)
      AND (?3 IS NULL OR k.ad_group_id = ?3)
      AND (?4 IS NULL OR k.state = ?4)
      AND (?5 IS NULL OR k.match_type = ?5)
      AND (?6 IS NULL OR k.keyword_text LIKE ?6 ESCAPE '\\' OR k.normalized_keyword LIKE ?6 ESCAPE '\\')
      AND (?7 IS NULL OR k.synced_at < ?7 OR (k.synced_at = ?7 AND k.keyword_id < ?8))
    ORDER BY k.synced_at DESC, k.keyword_id DESC
    LIMIT ?9
  `).bind(profileId, campaignId, adGroupId, state, matchType, q ? `%${escapeLike(q)}%` : null,
    cursor.value?.syncedAt || null, cursor.value?.id || null, paging.limit + 1).all();

  const rows = (result.results || []).map((row) => ({
    keywordId: row.keyword_id,
    profileId: row.profile_id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adGroupId: row.ad_group_id,
    adGroupName: row.ad_group_name,
    keywordText: row.keyword_text,
    normalizedKeyword: row.normalized_keyword,
    matchType: row.match_type,
    state: row.state,
    bidMicros: nullableNumber(row.bid_micros),
    sourceUpdatedAt: row.source_updated_at,
    syncedAt: row.synced_at,
  }));
  return entityPage(request, rows, paging.limit, (row) => ({ syncedAt: row.syncedAt, id: row.keywordId }));
}

async function listTargets(request, db, url) {
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const cursor = decodeEntityCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const profileId = optionalText(url.searchParams.get('profileId'), 200);
  const campaignId = optionalText(url.searchParams.get('campaignId'), 200);
  const adGroupId = optionalText(url.searchParams.get('adGroupId'), 200);
  const state = optionalText(url.searchParams.get('state'), 80);
  const targetType = optionalText(url.searchParams.get('targetType'), 80);

  const result = await db.prepare(`
    SELECT t.target_id, t.profile_id, t.campaign_id, c.name AS campaign_name,
           t.ad_group_id, ag.name AS ad_group_name, t.target_type, t.expression_text,
           t.state, t.bid_micros, t.source_updated_at, t.synced_at
    FROM targets t
    LEFT JOIN campaigns c ON c.campaign_id = t.campaign_id
    LEFT JOIN ad_groups ag ON ag.ad_group_id = t.ad_group_id
    WHERE (?1 IS NULL OR t.profile_id = ?1)
      AND (?2 IS NULL OR t.campaign_id = ?2)
      AND (?3 IS NULL OR t.ad_group_id = ?3)
      AND (?4 IS NULL OR t.state = ?4)
      AND (?5 IS NULL OR t.target_type = ?5)
      AND (?6 IS NULL OR t.expression_text LIKE ?6 ESCAPE '\\' OR t.target_id LIKE ?6 ESCAPE '\\')
      AND (?7 IS NULL OR t.synced_at < ?7 OR (t.synced_at = ?7 AND t.target_id < ?8))
    ORDER BY t.synced_at DESC, t.target_id DESC
    LIMIT ?9
  `).bind(profileId, campaignId, adGroupId, state, targetType, q ? `%${escapeLike(q)}%` : null,
    cursor.value?.syncedAt || null, cursor.value?.id || null, paging.limit + 1).all();

  const rows = (result.results || []).map((row) => ({
    targetId: row.target_id,
    profileId: row.profile_id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adGroupId: row.ad_group_id,
    adGroupName: row.ad_group_name,
    targetType: row.target_type,
    expressionText: row.expression_text,
    state: row.state,
    bidMicros: nullableNumber(row.bid_micros),
    sourceUpdatedAt: row.source_updated_at,
    syncedAt: row.synced_at,
  }));
  return entityPage(request, rows, paging.limit, (row) => ({ syncedAt: row.syncedAt, id: row.targetId }));
}

async function listSearchTerms(request, db, url) {
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const range = parseDateRange(url);
  if (range.error) return json(request, { error: range.error }, 400);
  const sort = parseSearchTermSort(url.searchParams.get('sort'));
  if (sort.error) return json(request, { error: sort.error }, 400);
  const cursor = decodeMetricCursor(paging.cursor);
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const profileId = optionalText(url.searchParams.get('profileId'), 200);
  const campaignId = optionalText(url.searchParams.get('campaignId'), 200);
  const adGroupId = optionalText(url.searchParams.get('adGroupId'), 200);

  const sortColumn = {
    cost: 'cost_micros',
    sales: 'sales_micros',
    clicks: 'clicks',
    purchases: 'purchases',
    impressions: 'impressions',
  }[sort.value];

  const result = await db.prepare(`
    WITH aggregated AS (
      SELECT
        MIN(st.row_key) AS group_key,
        st.profile_id,
        st.campaign_id,
        c.name AS campaign_name,
        st.ad_group_id,
        ag.name AS ad_group_name,
        st.keyword_id,
        k.keyword_text,
        st.target_id,
        MIN(st.search_term) AS search_term,
        st.normalized_search_term,
        SUM(st.impressions) AS impressions,
        SUM(st.clicks) AS clicks,
        SUM(st.cost_micros) AS cost_micros,
        SUM(st.purchases) AS purchases,
        SUM(st.units_sold) AS units_sold,
        SUM(st.sales_micros) AS sales_micros
      FROM search_term_daily st
      LEFT JOIN campaigns c ON c.campaign_id = st.campaign_id
      LEFT JOIN ad_groups ag ON ag.ad_group_id = st.ad_group_id
      LEFT JOIN keywords k ON k.keyword_id = st.keyword_id
      WHERE st.report_date BETWEEN ?1 AND ?2
        AND (?3 IS NULL OR st.profile_id = ?3)
        AND (?4 IS NULL OR st.campaign_id = ?4)
        AND (?5 IS NULL OR st.ad_group_id = ?5)
        AND (?6 IS NULL OR st.search_term LIKE ?6 ESCAPE '\\' OR st.normalized_search_term LIKE ?6 ESCAPE '\\')
      GROUP BY st.profile_id, st.campaign_id, c.name, st.ad_group_id, ag.name,
               st.keyword_id, k.keyword_text, st.target_id, st.normalized_search_term
    ), ranked AS (
      SELECT *, ${sortColumn} AS sort_value FROM aggregated
    )
    SELECT * FROM ranked
    WHERE (?7 IS NULL OR sort_value < ?7 OR (sort_value = ?7 AND group_key < ?8))
    ORDER BY sort_value DESC, group_key DESC
    LIMIT ?9
  `).bind(range.startDate, range.endDate, profileId, campaignId, adGroupId,
    q ? `%${escapeLike(q)}%` : null,
    cursor.value?.sortValue ?? null, cursor.value?.groupKey || null, paging.limit + 1).all();

  const rows = (result.results || []).map((row) => ({
    groupKey: row.group_key,
    profileId: row.profile_id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adGroupId: row.ad_group_id,
    adGroupName: row.ad_group_name,
    keywordId: row.keyword_id,
    keywordText: row.keyword_text,
    targetId: row.target_id,
    searchTerm: row.search_term,
    normalizedSearchTerm: row.normalized_search_term,
    impressions: number(row.impressions),
    clicks: number(row.clicks),
    costMicros: number(row.cost_micros),
    purchases: number(row.purchases),
    unitsSold: number(row.units_sold),
    salesMicros: number(row.sales_micros),
    sortValue: number(row.sort_value),
  }));

  const hasMore = rows.length > paging.limit;
  const items = hasMore ? rows.slice(0, paging.limit) : rows;
  const last = items.at(-1);
  return json(request, {
    range: { startDate: range.startDate, endDate: range.endDate },
    sort: sort.value,
    items: items.map(({ groupKey, sortValue, ...row }) => row),
    nextCursor: hasMore && last ? encodeCursor({ sortValue: last.sortValue, groupKey: last.groupKey }) : null,
  }, 200);
}

async function authorizedStoreRoute(env, userId, storeId, permission) {
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error: 'forbidden', permission, status: 403 };
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, d1_binding_key, status
    FROM stores WHERE store_id=?1 AND status <> 'disabled' LIMIT 1
  `).bind(storeId).first();
  if (!store) return { error: 'store_not_found', status: 404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error: 'store_db_unavailable', status: 503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { store, storeDb };
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`
    SELECT 1 AS ok FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key=ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2 LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok FROM store_members sm
    JOIN role_permissions rp ON rp.role_key=sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3 LIMIT 1
  `).bind(userId, storeId, permission).first());
}

function parsePaging(url) {
  const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: 'invalid_limit' };
  return { limit, cursor: url.searchParams.get('cursor') };
}

function parseDateRange(url) {
  const startDate = isoDate(url.searchParams.get('startDate'));
  const endDate = isoDate(url.searchParams.get('endDate'));
  if (!startDate || !endDate) return { error: 'date_range_required' };
  if (endDate < startDate) return { error: 'date_range_invalid' };
  const days = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_ANALYTICS_DAYS) return { error: 'date_range_too_large' };
  return { startDate, endDate, days };
}

function parseSearchTermSort(value) {
  const sort = String(value || 'cost').trim().toLowerCase();
  return ['cost','sales','clicks','purchases','impressions'].includes(sort)
    ? { value: sort }
    : { error: 'invalid_sort' };
}

function entityPage(request, rows, limit, cursorFromRow) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return json(request, {
    items,
    nextCursor: hasMore && last ? encodeCursor(cursorFromRow(last)) : null,
  }, 200);
}

function decodeEntityCursor(value) {
  if (!value) return { value: null };
  const decoded = decodeCursor(value);
  if (decoded.error || typeof decoded.value?.syncedAt !== 'string' || typeof decoded.value?.id !== 'string') return { error: true };
  return decoded;
}
function decodeMetricCursor(value) {
  if (!value) return { value: null };
  const decoded = decodeCursor(value);
  if (decoded.error || !Number.isFinite(decoded.value?.sortValue) || typeof decoded.value?.groupKey !== 'string') return { error: true };
  return decoded;
}
function encodeCursor(value) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}
function decodeCursor(value) {
  try {
    return { value: JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) };
  } catch { return { error: true }; }
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
function normalizeSearch(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 200) : null;
}
function optionalText(value, max) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
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
