const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const MAX_RANGE_DAYS = 366;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const GOVERNED_PROVENANCE = new Set(['exact_source_object', 'reconciled_exact_source']);

const DIMENSION_ALIASES = Object.freeze({
  overview: 'overview',
  daily: 'daily',
  campaign: 'campaign',
  'ad-group': 'ad_group',
  ad_group: 'ad_group',
  targeting: 'targeting',
  'search-term': 'search_term',
  search_term: 'search_term',
  'match-type': 'match_type',
  match_type: 'match_type',
});

const DIMENSIONS = Object.freeze({
  daily: {
    select: ['f.report_date AS report_date'],
    group: ['f.report_date'],
    tieBreaker: 'report_date',
    defaultSort: 'reportDate',
    defaultDirection: 'asc',
    labels: (row) => ({ reportDate: row.report_date }),
  },
  campaign: {
    select: [
      'f.campaign_name AS campaign_name',
      'f.campaign_id AS campaign_id',
      'f.advertiser_account_id AS advertiser_account_id',
      'f.profile_id AS profile_id',
    ],
    group: ['f.campaign_name', 'f.campaign_id', 'f.advertiser_account_id', 'f.profile_id'],
    tieBreaker: 'campaign_name',
    defaultSort: 'spendMicros',
    defaultDirection: 'desc',
    labels: (row) => ({
      campaignName: row.campaign_name,
      campaignId: row.campaign_id || null,
      advertiserAccountId: row.advertiser_account_id || null,
      profileId: row.profile_id || null,
      identityResolved: false,
      identityAuthority: 'observed_csv_only',
    }),
  },
  ad_group: {
    select: [
      'f.campaign_name AS campaign_name',
      'f.campaign_id AS campaign_id',
      'f.ad_group_name AS ad_group_name',
      'f.ad_group_id AS ad_group_id',
      'f.advertiser_account_id AS advertiser_account_id',
      'f.profile_id AS profile_id',
    ],
    group: ['f.campaign_name', 'f.campaign_id', 'f.ad_group_name', 'f.ad_group_id', 'f.advertiser_account_id', 'f.profile_id'],
    tieBreaker: 'ad_group_name',
    defaultSort: 'spendMicros',
    defaultDirection: 'desc',
    labels: (row) => ({
      campaignName: row.campaign_name,
      campaignId: row.campaign_id || null,
      adGroupName: row.ad_group_name,
      adGroupId: row.ad_group_id || null,
      advertiserAccountId: row.advertiser_account_id || null,
      profileId: row.profile_id || null,
      identityResolved: false,
      identityAuthority: 'observed_csv_only',
    }),
  },
  targeting: {
    select: [
      'f.campaign_name AS campaign_name',
      'f.campaign_id AS campaign_id',
      'f.ad_group_name AS ad_group_name',
      'f.ad_group_id AS ad_group_id',
      'f.targeting AS targeting',
      'f.targeting_id AS targeting_id',
      'f.targeting_type AS targeting_type',
      'f.targeting_identity_state AS targeting_identity_state',
      'f.advertiser_account_id AS advertiser_account_id',
      'f.profile_id AS profile_id',
    ],
    group: [
      'f.campaign_name', 'f.campaign_id', 'f.ad_group_name', 'f.ad_group_id',
      'f.targeting', 'f.targeting_id', 'f.targeting_type', 'f.targeting_identity_state',
      'f.advertiser_account_id', 'f.profile_id',
    ],
    tieBreaker: 'targeting',
    defaultSort: 'spendMicros',
    defaultDirection: 'desc',
    labels: (row) => ({
      campaignName: row.campaign_name,
      campaignId: row.campaign_id || null,
      adGroupName: row.ad_group_name,
      adGroupId: row.ad_group_id || null,
      targeting: row.targeting,
      targetingId: row.targeting_id || null,
      targetingType: row.targeting_type || null,
      targetingIdentityState: row.targeting_identity_state || 'name_only',
      advertiserAccountId: row.advertiser_account_id || null,
      profileId: row.profile_id || null,
      identityResolved: false,
      identityAuthority: 'observed_csv_only',
    }),
  },
  search_term: {
    select: [
      'f.search_term AS search_term',
      'f.normalized_search_term AS normalized_search_term',
      'f.match_type AS match_type',
      'f.targeting AS targeting',
      'f.targeting_id AS targeting_id',
      'f.campaign_name AS campaign_name',
      'f.campaign_id AS campaign_id',
      'f.ad_group_name AS ad_group_name',
      'f.ad_group_id AS ad_group_id',
      'f.advertiser_account_id AS advertiser_account_id',
      'f.profile_id AS profile_id',
    ],
    group: [
      'f.search_term', 'f.normalized_search_term', 'f.match_type', 'f.targeting', 'f.targeting_id',
      'f.campaign_name', 'f.campaign_id', 'f.ad_group_name', 'f.ad_group_id',
      'f.advertiser_account_id', 'f.profile_id',
    ],
    tieBreaker: 'normalized_search_term',
    defaultSort: 'spendMicros',
    defaultDirection: 'desc',
    labels: (row) => ({
      searchTerm: row.search_term,
      normalizedSearchTerm: row.normalized_search_term,
      matchType: row.match_type || null,
      targeting: row.targeting || null,
      targetingId: row.targeting_id || null,
      campaignName: row.campaign_name,
      campaignId: row.campaign_id || null,
      adGroupName: row.ad_group_name,
      adGroupId: row.ad_group_id || null,
      advertiserAccountId: row.advertiser_account_id || null,
      profileId: row.profile_id || null,
      identityResolved: false,
      identityAuthority: 'observed_csv_only',
    }),
  },
  match_type: {
    select: ['f.match_type AS match_type'],
    group: ['f.match_type'],
    tieBreaker: 'match_type',
    defaultSort: 'spendMicros',
    defaultDirection: 'desc',
    labels: (row) => ({ matchType: row.match_type || 'unknown' }),
  },
});

const SORT_COLUMNS = Object.freeze({
  impressions: 'impressions',
  clicks: 'clicks',
  spendMicros: 'spend_micros',
  purchases: 'purchases',
  orders: 'purchases',
  unitsSold: 'units_sold',
  salesMicros: 'sales_micros',
  ctr: 'ctr',
  cpcMicros: 'cpc_micros',
  cvr: 'cvr',
  acos: 'acos',
  roas: 'roas',
  reportDate: 'report_date',
  campaignName: 'campaign_name',
  adGroupName: 'ad_group_name',
  targeting: 'targeting',
  searchTerm: 'normalized_search_term',
  matchType: 'match_type',
});

export async function handleCsvAnalyticsApiRoute({ request, env, actor, url }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/csv-analytics\/(overview|daily|campaign|ad-group|ad_group|targeting|search-term|search_term|match-type|match_type)$/);
  if (!match) return null;

  const storeId = decodeURIComponent(match[1]);
  const dimension = DIMENSION_ALIASES[match[2]];
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, 'analytics.read');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  const range = parseDateRange(url);
  if (range.error) return json(request, { error: range.error }, 400);
  const filters = parseFilters(url);
  if (filters.error) return json(request, { error: filters.error }, 400);

  const currentWhere = buildWhere(range, filters.value);
  const previousRange = previousComparableRange(range);
  const previousWhere = buildWhere(previousRange, filters.value);

  const [governance, currentTotals, previousTotals] = await Promise.all([
    readGovernance(route.storeDb, currentWhere),
    readTotals(route.storeDb, currentWhere),
    readTotals(route.storeDb, previousWhere),
  ]);
  const governanceMetadata = governanceMetadataFromRow(governance, range);
  const comparison = comparisonPayload(previousRange, currentTotals, previousTotals);

  if (dimension === 'overview') {
    return json(request, {
      storeId,
      dimension,
      dateRange: publicRange(range),
      filters: publicFilters(filters.value),
      metrics: metricRow(currentTotals),
      comparison,
      governance: governanceMetadata,
    }, 200);
  }

  const spec = DIMENSIONS[dimension];
  if (!spec) return json(request, { error: 'dimension_not_supported' }, 400);
  const paging = parsePaging(url);
  if (paging.error) return json(request, { error: paging.error }, 400);
  const sorting = parseSorting(url, spec);
  if (sorting.error) return json(request, { error: sorting.error }, 400);

  const [itemsResult, countRow] = await Promise.all([
    readDimension(route.storeDb, spec, currentWhere, sorting.value, paging.value),
    countDimension(route.storeDb, spec, currentWhere),
  ]);
  const items = (itemsResult.results || []).map((row) => ({
    ...spec.labels(row),
    ...metricRow(row),
  }));
  const totalItems = integer(countRow?.count);

  return json(request, {
    storeId,
    dimension,
    dateRange: publicRange(range),
    filters: publicFilters(filters.value),
    sort: sorting.value,
    pagination: {
      page: paging.value.page,
      limit: paging.value.limit,
      totalItems,
      totalPages: paging.value.limit > 0 ? Math.ceil(totalItems / paging.value.limit) : 0,
    },
    items,
    comparison,
    governance: governanceMetadata,
  }, 200);
}

async function authorizedStoreRoute(env, userId, storeId, permission) {
  if (!env.CONTROL_DB) return { error: 'control_db_not_bound', status: 503 };
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error: 'forbidden', permission, status: 403 };
  const store = await env.CONTROL_DB.prepare(`
    SELECT store_id, d1_binding_key, status
    FROM stores
    WHERE store_id = ?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(storeId).first();
  if (!store) return { error: 'store_not_found', status: 404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error: 'store_db_unavailable', status: 503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { store, storeDb };
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id = ?1 AND rp.permission_key = ?2
    LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok
    FROM store_members sm
    JOIN role_permissions rp ON rp.role_key = sm.role_key
    WHERE sm.user_id = ?1 AND sm.store_id = ?2 AND rp.permission_key = ?3
    LIMIT 1
  `).bind(userId, storeId, permission).first());
}

async function readTotals(db, where) {
  return db.prepare(`
    SELECT
      COUNT(*) AS fact_count,
      COALESCE(SUM(f.impressions), 0) AS impressions,
      COALESCE(SUM(f.clicks), 0) AS clicks,
      COALESCE(SUM(f.cost_micros), 0) AS spend_micros,
      COALESCE(SUM(f.purchases), 0) AS purchases,
      COALESCE(SUM(f.units_sold), 0) AS units_sold,
      COALESCE(SUM(f.sales_micros), 0) AS sales_micros
    FROM csv_business_search_term_daily f
    WHERE ${where.sql}
  `).bind(...where.params).first();
}

async function readGovernance(db, where) {
  return db.prepare(`
    SELECT
      COUNT(*) AS fact_count,
      MIN(f.report_date) AS observed_start_date,
      MAX(f.report_date) AS observed_end_date,
      GROUP_CONCAT(DISTINCT f.source_import_id) AS included_import_ids,
      GROUP_CONCAT(DISTINCT a.provenance_class) AS provenance_classes,
      GROUP_CONCAT(DISTINCT CAST(a.authority_version AS TEXT)) AS authority_versions,
      GROUP_CONCAT(DISTINCT f.currency_code) AS currency_codes,
      GROUP_CONCAT(DISTINCT f.marketplace) AS marketplaces
    FROM csv_business_search_term_daily f
    JOIN csv_import_authority a ON a.import_id = f.source_import_id
    WHERE ${where.sql}
  `).bind(...where.params).first();
}

async function readDimension(db, spec, where, sorting, paging) {
  const select = spec.select.join(',\n      ');
  const group = spec.group.join(', ');
  const offset = (paging.page - 1) * paging.limit;
  return db.prepare(`
    WITH aggregated AS (
      SELECT
        ${select},
        SUM(f.impressions) AS impressions,
        SUM(f.clicks) AS clicks,
        SUM(f.cost_micros) AS spend_micros,
        SUM(f.purchases) AS purchases,
        SUM(f.units_sold) AS units_sold,
        SUM(f.sales_micros) AS sales_micros
      FROM csv_business_search_term_daily f
      WHERE ${where.sql}
      GROUP BY ${group}
    ), enriched AS (
      SELECT
        *,
        CASE WHEN impressions = 0 THEN NULL ELSE CAST(clicks AS REAL) / impressions END AS ctr,
        CASE WHEN clicks = 0 THEN NULL ELSE CAST(spend_micros AS REAL) / clicks END AS cpc_micros,
        CASE WHEN clicks = 0 THEN NULL ELSE CAST(purchases AS REAL) / clicks END AS cvr,
        CASE WHEN sales_micros = 0 THEN NULL ELSE CAST(spend_micros AS REAL) / sales_micros END AS acos,
        CASE WHEN spend_micros = 0 THEN NULL ELSE CAST(sales_micros AS REAL) / spend_micros END AS roas
      FROM aggregated
    )
    SELECT *
    FROM enriched
    ORDER BY ${sorting.column} ${sorting.direction.toUpperCase()}, ${spec.tieBreaker} ASC
    LIMIT ? OFFSET ?
  `).bind(...where.params, paging.limit, offset).all();
}

async function countDimension(db, spec, where) {
  const group = spec.group.join(', ');
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT 1
      FROM csv_business_search_term_daily f
      WHERE ${where.sql}
      GROUP BY ${group}
    ) grouped_rows
  `).bind(...where.params).first();
}

function parseDateRange(url) {
  const startDate = isoDate(url.searchParams.get('startDate'));
  const endDate = isoDate(url.searchParams.get('endDate'));
  if (!startDate || !endDate) return { error: 'date_range_required' };
  if (endDate < startDate) return { error: 'date_range_invalid' };
  const days = inclusiveDays(startDate, endDate);
  if (days > MAX_RANGE_DAYS) return { error: 'date_range_too_large' };
  return { startDate, endDate, days };
}

function previousComparableRange(range) {
  const previousEnd = addDays(range.startDate, -1);
  const previousStart = addDays(previousEnd, -(range.days - 1));
  return { startDate: previousStart, endDate: previousEnd, days: range.days };
}

function parseFilters(url) {
  const value = {
    q: normalizeSearch(url.searchParams.get('q')),
    campaignId: optionalText(url.searchParams.get('campaignId'), 200),
    adGroupId: optionalText(url.searchParams.get('adGroupId'), 200),
    targetingId: optionalText(url.searchParams.get('targetingId'), 200),
    matchType: optionalText(url.searchParams.get('matchType'), 80),
    marketplace: optionalText(url.searchParams.get('marketplace'), 80),
    profileId: optionalText(url.searchParams.get('profileId'), 200),
    advertiserAccountId: optionalText(url.searchParams.get('advertiserAccountId'), 240),
  };
  return { value };
}

function buildWhere(range, filters) {
  const clauses = ['f.report_date BETWEEN ? AND ?'];
  const params = [range.startDate, range.endDate];
  const eq = [
    ['campaignId', 'f.campaign_id'],
    ['adGroupId', 'f.ad_group_id'],
    ['targetingId', 'f.targeting_id'],
    ['matchType', 'f.match_type'],
    ['marketplace', 'f.marketplace'],
    ['profileId', 'f.profile_id'],
    ['advertiserAccountId', 'f.advertiser_account_id'],
  ];
  for (const [key, column] of eq) {
    if (filters[key] !== null) {
      clauses.push(`${column} = ?`);
      params.push(filters[key]);
    }
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    clauses.push(`(
      f.campaign_name LIKE ? ESCAPE '\\'
      OR f.ad_group_name LIKE ? ESCAPE '\\'
      OR f.targeting LIKE ? ESCAPE '\\'
      OR f.search_term LIKE ? ESCAPE '\\'
      OR f.normalized_search_term LIKE ? ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  return { sql: clauses.join('\n      AND '), params };
}

function parsePaging(url) {
  const page = Number(url.searchParams.get('page') || 1);
  const limit = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  if (!Number.isInteger(page) || page < 1 || page > 100000) return { error: 'invalid_page' };
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: 'invalid_limit' };
  return { value: { page, limit } };
}

function parseSorting(url, spec) {
  const field = optionalText(url.searchParams.get('sort'), 80) || spec.defaultSort;
  const direction = String(url.searchParams.get('direction') || spec.defaultDirection).trim().toLowerCase();
  if (!Object.hasOwn(SORT_COLUMNS, field)) return { error: 'invalid_sort' };
  if (!['asc', 'desc'].includes(direction)) return { error: 'invalid_sort_direction' };
  const column = SORT_COLUMNS[field];
  const allowedLabels = new Set(spec.select.map((item) => item.split(/\s+AS\s+/i)[1]).filter(Boolean));
  const metricColumn = !['report_date', 'campaign_name', 'ad_group_name', 'targeting', 'normalized_search_term', 'match_type'].includes(column);
  if (!metricColumn && !allowedLabels.has(column)) return { error: 'invalid_sort_for_dimension' };
  return { value: { field, direction, column } };
}

function metricRow(row) {
  const impressions = integer(row?.impressions);
  const clicks = integer(row?.clicks);
  const spendMicros = integer(row?.spend_micros);
  const purchases = integer(row?.purchases);
  const unitsSold = integer(row?.units_sold);
  const salesMicros = integer(row?.sales_micros);
  return {
    impressions,
    clicks,
    spendMicros,
    purchases,
    orders: purchases,
    unitsSold,
    salesMicros,
    ctr: safeRatio(clicks, impressions),
    cpcMicros: safeRatio(spendMicros, clicks),
    cvr: safeRatio(purchases, clicks),
    acos: safeRatio(spendMicros, salesMicros),
    roas: safeRatio(salesMicros, spendMicros),
  };
}

function governanceMetadataFromRow(row, range) {
  const includedImportIds = csvList(row?.included_import_ids);
  const provenanceClasses = csvList(row?.provenance_classes);
  const currencyCodes = csvList(row?.currency_codes);
  const marketplaces = csvList(row?.marketplaces);
  const authorityVersions = csvList(row?.authority_versions).map((value) => Number(value)).filter(Number.isFinite);
  const factCount = integer(row?.fact_count);
  const analyticsEligible = factCount > 0;
  const recommendationEligible = analyticsEligible
    && provenanceClasses.length > 0
    && provenanceClasses.every((value) => GOVERNED_PROVENANCE.has(value));
  return {
    sourceKind: 'csv_import',
    dataClass: 'business',
    includedImportIds,
    provenanceClasses,
    authorityVersions,
    factCount,
    dateRange: publicRange(range),
    observedDateRange: row?.observed_start_date && row?.observed_end_date
      ? { startDate: row.observed_start_date, endDate: row.observed_end_date }
      : null,
    currencyCode: currencyCodes.length === 1 ? currencyCodes[0] : null,
    currencyCodes,
    marketplace: marketplaces.length === 1 ? marketplaces[0] : null,
    marketplaces,
    analyticsEligible,
    recommendationEligible,
    reviewEligible: recommendationEligible,
    authorityExplanation: recommendationEligible
      ? 'Business CSV facts have governed exact-source provenance.'
      : analyticsEligible
        ? 'Business CSV facts are analytics-eligible, but one or more imports lack governed exact-source provenance.'
        : 'No business-class CSV facts matched this request; analytics and advisory gates remain fail-closed.',
    amazonExecutionAuthorized: false,
  };
}

function comparisonPayload(previousRange, currentRow, previousRow) {
  const current = metricRow(currentRow);
  const previousFactCount = integer(previousRow?.fact_count);
  if (previousFactCount === 0) {
    return {
      available: false,
      dateRange: publicRange(previousRange),
      reason: 'comparison_period_has_no_business_facts',
      metrics: null,
      delta: null,
    };
  }
  const previous = metricRow(previousRow);
  return {
    available: true,
    dateRange: publicRange(previousRange),
    reason: null,
    metrics: previous,
    delta: metricDelta(current, previous),
  };
}

function metricDelta(current, previous) {
  const fields = ['impressions', 'clicks', 'spendMicros', 'purchases', 'orders', 'unitsSold', 'salesMicros', 'ctr', 'cpcMicros', 'cvr', 'acos', 'roas'];
  return Object.fromEntries(fields.map((field) => {
    const currentValue = current[field];
    const previousValue = previous[field];
    if (currentValue === null || previousValue === null) {
      return [field, { absolute: null, relative: null }];
    }
    const absolute = currentValue - previousValue;
    return [field, {
      absolute,
      relative: previousValue === 0 ? null : absolute / previousValue,
    }];
  }));
}

function publicRange(range) {
  return { startDate: range.startDate, endDate: range.endDate, days: range.days };
}

function publicFilters(filters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== null));
}

function json(request, payload, status) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const ray = request.headers.get('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(JSON.stringify(payload), { status, headers });
}

function isoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}

function inclusiveDays(startDate, endDate) {
  return Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function normalizeSearch(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 200) : null;
}
function optionalText(value, max) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}
function escapeLike(value) { return String(value).replace(/[\\%_]/g, (match) => `\\${match}`); }
function integer(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function safeRatio(numerator, denominator) { return denominator === 0 ? null : numerator / denominator; }
function csvList(value) {
  if (!value) return [];
  return [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean))].sort();
}
