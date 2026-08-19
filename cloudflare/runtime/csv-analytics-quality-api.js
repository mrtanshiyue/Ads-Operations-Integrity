const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const MAX_RANGE_DAYS = 366;
const ALLOWED_MATCH_TYPES = Object.freeze([
  'EXACT',
  'PHRASE',
  'BROAD',
  'TARGETING_EXPRESSION',
  'TARGETING_EXPRESSION_PREDEFINED',
]);
const SEVERITY_RANK = Object.freeze({ none: 0, low: 1, medium: 2, high: 3, critical: 4 });
const SEVERITY_WEIGHT = Object.freeze({ low: 3, medium: 8, high: 15, critical: 25 });

const ISSUE_DEFINITIONS = Object.freeze([
  ['missing_campaign_id', 'Missing campaign ID', 'low', 'Observed campaign identifiers are absent on one or more facts.'],
  ['missing_ad_group_id', 'Missing ad-group ID', 'low', 'Observed ad-group identifiers are absent on one or more facts.'],
  ['missing_targeting_id', 'Missing targeting ID', 'low', 'Observed targeting identifiers are absent on one or more facts.'],
  ['missing_search_term', 'Missing search term', 'medium', 'Search-term text is empty on one or more facts.'],
  ['unknown_match_type', 'Unknown match type', 'medium', 'Match type is empty or outside the supported analytics vocabulary.'],
  ['zero_impressions_and_clicks', 'Zero impressions and clicks', 'low', 'One or more facts contain no impression or click activity.'],
  ['clicks_gt_impressions', 'Clicks exceed impressions', 'critical', 'Clicks exceed impressions on one or more facts.'],
  ['orders_gt_clicks', 'Orders exceed clicks', 'high', 'Attributed orders exceed clicks and should be reviewed as an analytics anomaly.'],
  ['negative_spend_or_sales', 'Negative spend or sales', 'critical', 'Negative monetary facts are not valid for this analytics contract.'],
  ['duplicate_logical_rows', 'Duplicate logical rows', 'high', 'Exact logical facts with identical metrics appear more than once.'],
  ['invalid_date', 'Invalid report date', 'critical', 'One or more included-import facts contain a non-canonical report date.'],
  ['currency_inconsistency', 'Currency inconsistency', 'high', 'Multiple currency codes are present in the selected business facts.'],
  ['marketplace_inconsistency', 'Marketplace inconsistency', 'medium', 'Multiple marketplaces are present in the selected business facts.'],
  ['import_overlap', 'Import overlap', 'high', 'The same logical fact is supplied by more than one business import.'],
  ['date_gaps', 'Date gaps', 'medium', 'One or more calendar dates in the requested range have no business facts.'],
]);

export async function handleCsvAnalyticsQualityApiRoute({ request, env, actor, url }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/csv-analytics\/quality$/);
  if (!match) return null;

  const startedAt = Date.now();
  const storeId = decodeURIComponent(match[1]);
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, 'analytics.read');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  const range = parseDateRange(url);
  if (range.error) return json(request, { error: range.error }, 400);
  const filters = parseFilters(url);
  const where = buildWhere(range, filters);

  const [summary, rowIssues, duplicates, overlap, dates] = await Promise.all([
    readSummary(route.storeDb, where),
    readRowIssues(route.storeDb, where),
    readDuplicateSummary(route.storeDb, where),
    readImportOverlapSummary(route.storeDb, where),
    readObservedDates(route.storeDb, where),
  ]);

  const factCount = integer(summary?.fact_count);
  const importCount = integer(summary?.import_count);
  const observedDates = (dates?.results || []).map((row) => row.report_date).filter(Boolean);
  const missingDates = missingCalendarDates(range, observedDates);
  const currencies = csvList(summary?.currency_codes);
  const marketplaces = csvList(summary?.marketplaces);

  const duplicateGroupCount = integer(duplicates?.duplicate_group_count);
  const overlapGroupCount = integer(overlap?.overlap_group_count);
  const rawStats = {
    missing_campaign_id: factIssue(rowIssues, 'missing_campaign_id', importCount),
    missing_ad_group_id: factIssue(rowIssues, 'missing_ad_group_id', importCount),
    missing_targeting_id: factIssue(rowIssues, 'missing_targeting_id', importCount),
    missing_search_term: factIssue(rowIssues, 'missing_search_term', importCount),
    unknown_match_type: factIssue(rowIssues, 'unknown_match_type', importCount),
    zero_impressions_and_clicks: factIssue(rowIssues, 'zero_impressions_and_clicks', importCount),
    clicks_gt_impressions: factIssue(rowIssues, 'clicks_gt_impressions', importCount),
    orders_gt_clicks: factIssue(rowIssues, 'orders_gt_clicks', importCount),
    negative_spend_or_sales: factIssue(rowIssues, 'negative_spend_or_sales', importCount),
    duplicate_logical_rows: {
      count: duplicateGroupCount,
      affectedFacts: integer(duplicates?.affected_facts),
      affectedImports: duplicateGroupCount > 0 ? importCount : 0,
      scope: 'fact',
    },
    invalid_date: {
      count: integer(summary?.invalid_date_count),
      affectedFacts: integer(summary?.invalid_date_count),
      affectedImports: integer(summary?.invalid_date_count) > 0 ? importCount : 0,
      scope: 'import',
    },
    currency_inconsistency: structuralIssue(currencies.length > 1, factCount, importCount, currencies.length),
    marketplace_inconsistency: structuralIssue(marketplaces.length > 1, factCount, importCount, marketplaces.length),
    import_overlap: {
      count: overlapGroupCount,
      affectedFacts: integer(overlap?.affected_facts),
      affectedImports: overlapGroupCount > 0 ? importCount : 0,
      scope: 'fact',
    },
    date_gaps: {
      count: missingDates.length,
      affectedFacts: missingDates.length > 0 ? factCount : 0,
      affectedImports: missingDates.length > 0 ? importCount : 0,
      scope: 'coverage',
    },
  };

  const issues = ISSUE_DEFINITIONS.map(([code, label, severity, explanation]) => ({
    code,
    label,
    severity,
    count: rawStats[code].count,
    affectedFacts: rawStats[code].affectedFacts,
    affectedImports: rawStats[code].affectedImports,
    scope: rawStats[code].scope,
    explanation,
  })).filter((issue) => issue.count > 0);

  const issueCount = issues.length;
  const issueOccurrences = issues.reduce((sum, issue) => sum + issue.count, 0);
  const severity = overallSeverity(issues);
  const qualityScore = calculateQualityScore(issues, factCount);
  const affectedFacts = Math.min(factCount, Math.max(integer(rowIssues?.affected_fact_count), ...issues.map((issue) => issue.affectedFacts), 0));
  const affectedImports = Math.min(importCount, Math.max(integer(rowIssues?.affected_import_count), ...issues.map((issue) => issue.affectedImports), 0));

  return json(request, {
    storeId,
    dimension: 'quality',
    dateRange: publicRange(range),
    filters: publicFilters(filters),
    quality: {
      qualityScore,
      issueCount,
      issueOccurrences,
      severity,
      affectedFacts,
      affectedImports,
      reliabilityOnly: true,
      changesIdentityAuthority: false,
      changesRecommendationAuthority: false,
      amazonExecutionAuthorized: false,
    },
    coverage: {
      factCount,
      importCount,
      observedStartDate: summary?.observed_start_date || null,
      observedEndDate: summary?.observed_end_date || null,
      expectedDays: range.days,
      observedDays: observedDates.length,
      missingDays: missingDates.length,
      missingDates,
      campaignIdPresentRate: presenceRate(factCount, rowIssues?.missing_campaign_id),
      adGroupIdPresentRate: presenceRate(factCount, rowIssues?.missing_ad_group_id),
      targetingIdPresentRate: presenceRate(factCount, rowIssues?.missing_targeting_id),
      searchTermPresentRate: presenceRate(factCount, rowIssues?.missing_search_term),
      currencyCodes: currencies,
      marketplaces,
    },
    issues,
    governance: {
      sourceKind: 'csv_import',
      dataClass: 'business',
      identityResolved: false,
      identityAuthority: 'observed_csv_only',
      qualityDoesNotChangeIdentityAuthority: true,
      qualityDoesNotChangeRecommendationAuthority: true,
      amazonExecutionAuthorized: false,
    },
    meta: {
      computedAt: new Date().toISOString(),
      responseTimeMs: Math.max(0, Date.now() - startedAt),
      persisted: false,
    },
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

async function readSummary(db, where) {
  return db.prepare(`
    SELECT
      COUNT(*) AS fact_count,
      COUNT(DISTINCT f.source_import_id) AS import_count,
      MIN(f.report_date) AS observed_start_date,
      MAX(f.report_date) AS observed_end_date,
      GROUP_CONCAT(DISTINCT f.currency_code) AS currency_codes,
      GROUP_CONCAT(DISTINCT f.marketplace) AS marketplaces,
      SUM(CASE
        WHEN f.report_date IS NULL
          OR f.report_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        THEN 1 ELSE 0 END) AS invalid_date_count
    FROM csv_business_search_term_daily f
    WHERE ${where.sql}
  `).bind(...where.params).first();
}

async function readRowIssues(db, where) {
  return db.prepare(`
    SELECT
      SUM(CASE WHEN f.campaign_id IS NULL OR TRIM(f.campaign_id) = '' THEN 1 ELSE 0 END) AS missing_campaign_id,
      SUM(CASE WHEN f.ad_group_id IS NULL OR TRIM(f.ad_group_id) = '' THEN 1 ELSE 0 END) AS missing_ad_group_id,
      SUM(CASE WHEN f.targeting_id IS NULL OR TRIM(f.targeting_id) = '' THEN 1 ELSE 0 END) AS missing_targeting_id,
      SUM(CASE WHEN f.search_term IS NULL OR TRIM(f.search_term) = '' THEN 1 ELSE 0 END) AS missing_search_term,
      SUM(CASE WHEN f.match_type IS NULL OR TRIM(f.match_type) = '' OR UPPER(TRIM(f.match_type)) NOT IN (${ALLOWED_MATCH_TYPES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS unknown_match_type,
      SUM(CASE WHEN f.impressions = 0 AND f.clicks = 0 THEN 1 ELSE 0 END) AS zero_impressions_and_clicks,
      SUM(CASE WHEN f.clicks > f.impressions THEN 1 ELSE 0 END) AS clicks_gt_impressions,
      SUM(CASE WHEN f.purchases > f.clicks THEN 1 ELSE 0 END) AS orders_gt_clicks,
      SUM(CASE WHEN f.cost_micros < 0 OR f.sales_micros < 0 THEN 1 ELSE 0 END) AS negative_spend_or_sales,
      COUNT(DISTINCT CASE WHEN (
        f.campaign_id IS NULL OR TRIM(f.campaign_id) = ''
        OR f.ad_group_id IS NULL OR TRIM(f.ad_group_id) = ''
        OR f.targeting_id IS NULL OR TRIM(f.targeting_id) = ''
        OR f.search_term IS NULL OR TRIM(f.search_term) = ''
        OR f.match_type IS NULL OR TRIM(f.match_type) = '' OR UPPER(TRIM(f.match_type)) NOT IN (${ALLOWED_MATCH_TYPES.map(() => '?').join(',')})
        OR (f.impressions = 0 AND f.clicks = 0)
        OR f.clicks > f.impressions
        OR f.purchases > f.clicks
        OR f.cost_micros < 0 OR f.sales_micros < 0
      ) THEN f.row_key END) AS affected_fact_count,
      COUNT(DISTINCT CASE WHEN (
        f.campaign_id IS NULL OR TRIM(f.campaign_id) = ''
        OR f.ad_group_id IS NULL OR TRIM(f.ad_group_id) = ''
        OR f.targeting_id IS NULL OR TRIM(f.targeting_id) = ''
        OR f.search_term IS NULL OR TRIM(f.search_term) = ''
        OR f.match_type IS NULL OR TRIM(f.match_type) = '' OR UPPER(TRIM(f.match_type)) NOT IN (${ALLOWED_MATCH_TYPES.map(() => '?').join(',')})
        OR (f.impressions = 0 AND f.clicks = 0)
        OR f.clicks > f.impressions
        OR f.purchases > f.clicks
        OR f.cost_micros < 0 OR f.sales_micros < 0
      ) THEN f.source_import_id END) AS affected_import_count
    FROM csv_business_search_term_daily f
    WHERE ${where.sql}
  `).bind(...ALLOWED_MATCH_TYPES, ...ALLOWED_MATCH_TYPES, ...ALLOWED_MATCH_TYPES, ...where.params).first();
}

async function readDuplicateSummary(db, where) {
  return db.prepare(`
    WITH duplicates AS (
      SELECT COUNT(*) AS row_count, COUNT(DISTINCT f.source_import_id) AS import_count
      FROM csv_business_search_term_daily f
      WHERE ${where.sql}
      GROUP BY
        f.report_date,
        COALESCE(f.advertiser_account_id, ''), COALESCE(f.profile_id, ''),
        COALESCE(f.campaign_id, ''), f.campaign_name,
        COALESCE(f.ad_group_id, ''), f.ad_group_name,
        COALESCE(f.targeting_id, ''), f.targeting,
        COALESCE(f.match_type, ''), f.normalized_search_term,
        COALESCE(f.marketplace, ''), COALESCE(f.currency_code, ''),
        f.impressions, f.clicks, f.cost_micros, f.purchases, f.units_sold, f.sales_micros
      HAVING COUNT(*) > 1
    )
    SELECT
      COUNT(*) AS duplicate_group_count,
      COALESCE(SUM(row_count), 0) AS affected_facts,
      COALESCE(SUM(import_count), 0) AS affected_imports
    FROM duplicates
  `).bind(...where.params).first();
}

async function readImportOverlapSummary(db, where) {
  return db.prepare(`
    WITH overlaps AS (
      SELECT COUNT(*) AS row_count, COUNT(DISTINCT f.source_import_id) AS import_count
      FROM csv_business_search_term_daily f
      WHERE ${where.sql}
      GROUP BY
        f.report_date,
        COALESCE(f.advertiser_account_id, ''), COALESCE(f.profile_id, ''),
        COALESCE(f.campaign_id, ''), f.campaign_name,
        COALESCE(f.ad_group_id, ''), f.ad_group_name,
        COALESCE(f.targeting_id, ''), f.targeting,
        COALESCE(f.match_type, ''), f.normalized_search_term,
        COALESCE(f.marketplace, ''), COALESCE(f.currency_code, '')
      HAVING COUNT(DISTINCT f.source_import_id) > 1
    )
    SELECT
      COUNT(*) AS overlap_group_count,
      COALESCE(SUM(row_count), 0) AS affected_facts,
      COALESCE(SUM(import_count), 0) AS affected_imports
    FROM overlaps
  `).bind(...where.params).first();
}

async function readObservedDates(db, where) {
  return db.prepare(`
    SELECT DISTINCT f.report_date AS report_date
    FROM csv_business_search_term_daily f
    WHERE ${where.sql}
    ORDER BY f.report_date ASC
  `).bind(...where.params).all();
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

function parseFilters(url) {
  return {
    q: normalizeSearch(url.searchParams.get('q')),
    campaignId: optionalText(url.searchParams.get('campaignId'), 200),
    adGroupId: optionalText(url.searchParams.get('adGroupId'), 200),
    targetingId: optionalText(url.searchParams.get('targetingId'), 200),
    matchType: optionalText(url.searchParams.get('matchType'), 80),
    marketplace: optionalText(url.searchParams.get('marketplace'), 80),
    profileId: optionalText(url.searchParams.get('profileId'), 200),
    advertiserAccountId: optionalText(url.searchParams.get('advertiserAccountId'), 240),
  };
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

function factIssue(row, key, importCount) {
  const count = integer(row?.[key]);
  return { count, affectedFacts: count, affectedImports: count > 0 ? importCount : 0, scope: 'fact' };
}

function structuralIssue(active, factCount, importCount, count) {
  return {
    count: active ? Math.max(1, integer(count)) : 0,
    affectedFacts: active ? factCount : 0,
    affectedImports: active ? importCount : 0,
    scope: 'dataset',
  };
}

function calculateQualityScore(issues, factCount) {
  if (factCount === 0) return null;
  let penalty = 0;
  for (const issue of issues) {
    const weight = SEVERITY_WEIGHT[issue.severity] || 0;
    const affectedRatio = issue.affectedFacts > 0 ? Math.min(1, issue.affectedFacts / factCount) : 0;
    penalty += weight * Math.max(0.05, affectedRatio);
  }
  return Math.max(0, Math.round((100 - Math.min(100, penalty)) * 10) / 10);
}

function overallSeverity(issues) {
  let severity = 'none';
  for (const issue of issues) {
    if ((SEVERITY_RANK[issue.severity] || 0) > (SEVERITY_RANK[severity] || 0)) severity = issue.severity;
  }
  return severity;
}

function missingCalendarDates(range, observedDates) {
  const observed = new Set(observedDates);
  const missing = [];
  for (let cursor = range.startDate; cursor <= range.endDate; cursor = addDays(cursor, 1)) {
    if (!observed.has(cursor)) missing.push(cursor);
  }
  return missing;
}

function presenceRate(total, missing) {
  if (total === 0) return null;
  return Math.max(0, (total - integer(missing)) / total);
}

function publicRange(range) { return { startDate: range.startDate, endDate: range.endDate, days: range.days }; }
function publicFilters(filters) { return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== null)); }

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
function csvList(value) {
  if (!value) return [];
  return [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean))].sort();
}
