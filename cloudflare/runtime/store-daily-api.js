const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_DAYS = 93;
const SOURCE_CONTRACT_VERSION = 'store-targeting-source-v2';
const FACT_CONTRACT_VERSION = 'store-search-term-fact-v1';

export async function handleStoreDailyApiRoute({ request, env, actor, url }) {
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/search-terms-daily$/);
  if (!match || request.method !== 'GET') return null;

  const storeId = decodeURIComponent(match[1]);
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, 'ads.read');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);
  return listDailySearchTerms(request, route.storeDb, url);
}

async function listDailySearchTerms(request, db, url) {
  const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return json(request, { error: 'invalid_limit' }, 400);
  }
  const startDate = isoDate(url.searchParams.get('startDate'));
  const endDate = isoDate(url.searchParams.get('endDate'));
  if (!startDate || !endDate) return json(request, { error: 'date_range_required' }, 400);
  if (endDate < startDate) return json(request, { error: 'date_range_invalid' }, 400);
  const days = dateSpan(startDate, endDate);
  if (days > MAX_DAYS) return json(request, { error: 'date_range_too_large' }, 400);

  const sort = String(url.searchParams.get('sort') || 'cost').trim().toLowerCase();
  const sortColumn = {
    cost: 'cost_micros',
    sales: 'sales_micros',
    clicks: 'clicks',
    purchases: 'purchases',
    impressions: 'impressions',
  }[sort];
  if (!sortColumn) return json(request, { error: 'invalid_sort' }, 400);

  const cursor = decodeCursor(url.searchParams.get('cursor'));
  if (cursor.error) return json(request, { error: 'invalid_cursor' }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const profileId = optionalText(url.searchParams.get('profileId'), 200);
  const campaignId = optionalText(url.searchParams.get('campaignId'), 200);
  const adGroupId = optionalText(url.searchParams.get('adGroupId'), 200);

  const result = await db.prepare(`
    WITH aggregated AS (
      SELECT
        MIN(st.row_key) AS group_key,
        st.report_date,
        st.profile_id,
        st.ad_product,
        st.campaign_id,
        c.name AS campaign_name,
        st.ad_group_id,
        ag.name AS ad_group_name,
        st.keyword_id,
        k.keyword_text,
        k.match_type AS keyword_match_type,
        k.state AS keyword_state,
        k.bid_micros AS keyword_bid_micros,
        k.source_updated_at AS keyword_source_updated_at,
        k.synced_at AS keyword_synced_at,
        st.target_id,
        t.target_type,
        t.expression_text AS target_expression_text,
        t.state AS target_state,
        t.bid_micros AS target_bid_micros,
        t.source_updated_at AS target_source_updated_at,
        t.synced_at AS target_synced_at,
        MIN(st.search_term) AS search_term,
        st.normalized_search_term,
        MAX(st.match_type) AS report_match_type,
        MAX(st.updated_at) AS fact_mirror_updated_at,
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
      LEFT JOIN targets t ON t.target_id = st.target_id
      WHERE st.report_date BETWEEN ?1 AND ?2
        AND (?3 IS NULL OR st.profile_id = ?3)
        AND (?4 IS NULL OR st.campaign_id = ?4)
        AND (?5 IS NULL OR st.ad_group_id = ?5)
        AND (?6 IS NULL OR st.search_term LIKE ?6 ESCAPE '\\' OR st.normalized_search_term LIKE ?6 ESCAPE '\\')
      GROUP BY st.report_date, st.profile_id, st.ad_product, st.campaign_id, c.name,
               st.ad_group_id, ag.name, st.keyword_id, k.keyword_text, k.match_type, k.state, k.bid_micros, k.source_updated_at, k.synced_at,
               st.target_id, t.target_type, t.expression_text, t.state, t.bid_micros, t.source_updated_at, t.synced_at, st.normalized_search_term
    ), ranked AS (
      SELECT *, ${sortColumn} AS sort_value FROM aggregated
    )
    SELECT * FROM ranked
    WHERE (?7 IS NULL OR sort_value < ?7 OR (sort_value = ?7 AND group_key < ?8))
    ORDER BY sort_value DESC, group_key DESC
    LIMIT ?9
  `).bind(
    startDate,
    endDate,
    profileId,
    campaignId,
    adGroupId,
    q ? `%${escapeLike(q)}%` : null,
    cursor.value?.sortValue ?? null,
    cursor.value?.groupKey || null,
    limit + 1,
  ).all();

  const rows = (result.results || []).map((row) => {
    const source = targetingSource(row);
    return {
      groupKey: row.group_key,
      reportDate: row.report_date,
      profileId: row.profile_id,
      adProduct: row.ad_product,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      adGroupId: row.ad_group_id,
      adGroupName: row.ad_group_name,
      keywordId: row.keyword_id,
      keywordText: row.keyword_text,
      targetId: row.target_id,
      targetType: row.target_type,
      targetExpressionText: row.target_expression_text,
      targetingKind: source.kind,
      targetingIdentityValid: source.valid,
      targetingState: source.state,
      currentBidMicros: source.bidMicros,
      currentBidSyncedAt: source.syncedAt,
      targetingSourceUpdatedAt: source.sourceUpdatedAt,
      bidSource: source.bidSource,
      searchTerm: row.search_term,
      normalizedSearchTerm: row.normalized_search_term,
      matchType: row.keyword_match_type || row.report_match_type || null,
      factMirrorUpdatedAt: nullableText(row.fact_mirror_updated_at),
      impressions: number(row.impressions),
      clicks: number(row.clicks),
      costMicros: number(row.cost_micros),
      purchases: number(row.purchases),
      unitsSold: number(row.units_sold),
      salesMicros: number(row.sales_micros),
      sortValue: number(row.sort_value),
    };
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return json(request, {
    sourceContract: {
      schemaVersion: SOURCE_CONTRACT_VERSION,
      identityRule: 'keyword_xor_target',
      bidUnit: 'micros',
      bidNullability: 'preserved',
      currentBidMirrorTimestamp: 'synced_at',
      targetingSourceTimestamp: 'source_updated_at',
    },
    factContract: {
      schemaVersion: FACT_CONTRACT_VERSION,
      mirrorTimestamp: 'search_term_daily.updated_at',
      mirrorTimestampAggregation: 'max',
    },
    range: { startDate, endDate, days },
    grain: 'day',
    sort,
    items: items.map(({ groupKey, sortValue, ...row }) => row),
    nextCursor: hasMore && last ? encodeCursor({ sortValue: last.sortValue, groupKey: last.groupKey }) : null,
  }, 200);
}

async function authorizedStoreRoute(env, userId, storeId, permission) {
  const global = await env.CONTROL_DB.prepare(`
    SELECT 1 AS ok FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id=?1 AND rp.permission_key=?2 LIMIT 1
  `).bind(userId, permission).first();
  const scoped = global ? true : Boolean(await env.CONTROL_DB.prepare(`
    SELECT 1 AS ok FROM store_members sm
    JOIN role_permissions rp ON rp.role_key=sm.role_key
    WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3 LIMIT 1
  `).bind(userId, storeId, permission).first());
  if (!scoped) return { error: 'forbidden', permission, status: 403 };

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

function targetingSource(row) {
  const keywordId = String(row.keyword_id || '').trim();
  const targetId = String(row.target_id || '').trim();
  if (Boolean(keywordId) === Boolean(targetId)) {
    return { valid: false, kind: null, state: null, bidMicros: null, syncedAt: null, sourceUpdatedAt: null, bidSource: null };
  }
  if (keywordId) {
    return {
      valid: true,
      kind: 'keyword',
      state: nullableText(row.keyword_state),
      bidMicros: nullableNonNegativeNumber(row.keyword_bid_micros),
      syncedAt: nullableText(row.keyword_synced_at),
      sourceUpdatedAt: nullableText(row.keyword_source_updated_at),
      bidSource: 'keyword',
    };
  }
  return {
    valid: true,
    kind: 'target',
    state: nullableText(row.target_state),
    bidMicros: nullableNonNegativeNumber(row.target_bid_micros),
    syncedAt: nullableText(row.target_synced_at),
    sourceUpdatedAt: nullableText(row.target_source_updated_at),
    bidSource: 'target',
  };
}

function isoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}
function dateSpan(startDate, endDate) {
  return Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
}
function optionalText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length <= maxLength ? text : null;
}
function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
function normalizeSearch(value) {
  const text = String(value || '').trim();
  return text.length > 200 ? text.slice(0, 200) : text;
}
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}
function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function nullableNonNegativeNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function encodeCursor(value) {
  return btoa(JSON.stringify(value));
}
function decodeCursor(value) {
  if (!value) return { value: null };
  try {
    const parsed = JSON.parse(atob(value));
    if (!parsed || typeof parsed !== 'object') return { error: true };
    if (!Number.isFinite(Number(parsed.sortValue)) || !parsed.groupKey) return { error: true };
    return { value: { sortValue: Number(parsed.sortValue), groupKey: String(parsed.groupKey) } };
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