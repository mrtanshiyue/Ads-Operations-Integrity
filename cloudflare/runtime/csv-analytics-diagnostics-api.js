const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const MAX_RANGE_DAYS = 366;
const MAX_OBSERVATIONS = 80;

export async function handleCsvAnalyticsDiagnosticsApiRoute({ request, env, actor, url }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/csv-analytics\/diagnostics$/);
  if (!match) return null;

  const storeId = decodeURIComponent(match[1]);
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, 'analytics.read');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  const range = parseDateRange(url);
  if (range.error) return json(request, { error: range.error }, 400);
  const filters = parseFilters(url);
  const where = buildWhere(range, filters);

  const [searchTermsResult, campaignsResult, dailyResult, matchTypesResult] = await Promise.all([
    readSearchTerms(route.storeDb, where),
    readCampaigns(route.storeDb, where),
    readDaily(route.storeDb, where),
    readMatchTypes(route.storeDb, where),
  ]);

  const searchTerms = rows(searchTermsResult).map(searchTermRow);
  const campaigns = rows(campaignsResult).map(campaignRow);
  const daily = rows(dailyResult).map(dailyRow);
  const matchTypes = rows(matchTypesResult).map(matchTypeRow);
  const bundle = generateCsvDiagnostics({
    searchTerms,
    campaigns,
    daily,
    matchTypes,
    scope: {
      storeId,
      startDate: range.startDate,
      endDate: range.endDate,
      filters: publicFilters(filters),
    },
  });

  return json(request, bundle, 200);
}

export function generateCsvDiagnostics(input = {}) {
  const searchTerms = (input.searchTerms || []).map(metricRow);
  const campaigns = (input.campaigns || []).map(metricRow);
  const daily = (input.daily || []).map(metricRow);
  const matchTypes = (input.matchTypes || []).map(metricRow);
  const observations = [];

  const searchThresholds = {
    spendP90: quantile(searchTerms, 'spendMicros', 0.90),
    clicksP50: quantile(searchTerms, 'clicks', 0.50),
    clicksP75: quantile(searchTerms, 'clicks', 0.75),
    clicksP90: quantile(searchTerms, 'clicks', 0.90),
    acosP90: quantile(searchTerms, 'acos', 0.90),
    roasP90: quantile(searchTerms, 'roas', 0.90),
    cvrP25: quantile(searchTerms, 'cvr', 0.25),
    cvrP90: quantile(searchTerms, 'cvr', 0.90),
  };
  addRanked(observations, searchTerms.filter((row) => row.orders === 0 && finiteAtLeast(row.spendMicros, searchThresholds.spendP90)), 'spendMicros', 'desc', 10,
    (row) => observation('search-term', 'high_spend_zero_orders', 'high', row.searchTerm, `Spend ${money(row.spendMicros)} is in the top decile while attributed orders are zero.`, row));
  addRanked(observations, searchTerms.filter((row) => Number.isFinite(row.acos) && finiteAtLeast(row.acos, searchThresholds.acosP90)), 'acos', 'desc', 10,
    (row) => observation('search-term', 'high_acos', 'medium', row.searchTerm, `ACoS ${pct(row.acos)} is in the highest decile of this scope.`, row));
  addRanked(observations, searchTerms.filter((row) => Number.isFinite(row.roas) && finiteAtLeast(row.roas, searchThresholds.roasP90)), 'roas', 'desc', 8,
    (row) => observation('search-term', 'high_roas', 'info', row.searchTerm, `ROAS ${ratio(row.roas)} is in the highest decile of this scope.`, row));
  addRanked(observations, searchTerms.filter((row) => Number.isFinite(row.cvr) && row.clicks >= numberOr(searchThresholds.clicksP50, 0) && finiteAtLeast(row.cvr, searchThresholds.cvrP90)), 'cvr', 'desc', 8,
    (row) => observation('search-term', 'high_conversion', 'info', row.searchTerm, `CVR ${pct(row.cvr)} is in the highest decile with at least median click volume.`, row));
  addRanked(observations, searchTerms.filter((row) => finiteAtLeast(row.clicks, searchThresholds.clicksP90)), 'clicks', 'desc', 8,
    (row) => observation('search-term', 'large_click_volume', 'info', row.searchTerm, `${formatInt(row.clicks)} clicks place this search term in the highest click-volume decile.`, row));
  addRanked(observations, searchTerms.filter((row) => row.clicks >= numberOr(searchThresholds.clicksP75, 0) && Number.isFinite(row.cvr) && finiteAtMost(row.cvr, searchThresholds.cvrP25)), 'clicks', 'desc', 10,
    (row) => observation('search-term', 'low_conversion', 'medium', row.searchTerm, `${formatInt(row.clicks)} clicks with CVR ${pct(row.cvr)} are weak relative to this scope.`, row));

  const campaignThresholds = {
    acosP90: quantile(campaigns, 'acos', 0.90),
    cvrP10: quantile(campaigns, 'cvr', 0.10),
    cvrP90: quantile(campaigns, 'cvr', 0.90),
    clicksP50: quantile(campaigns, 'clicks', 0.50),
    clicksP75: quantile(campaigns, 'clicks', 0.75),
  };
  addConcentration(observations, campaigns, 'spendMicros', 'campaign_spend_concentration', 'Spend');
  addConcentration(observations, campaigns, 'salesMicros', 'campaign_sales_concentration', 'Sales');
  addRanked(observations, campaigns.filter((row) => Number.isFinite(row.acos) && finiteAtLeast(row.acos, campaignThresholds.acosP90)), 'acos', 'desc', 5,
    (row) => observation('campaign', 'acos_outlier', 'medium', row.campaignName, `Campaign ACoS ${pct(row.acos)} is in the highest decile.`, row, { observedId: row.campaignId, identityResolved: false }));
  addRanked(observations, campaigns.filter((row) => row.clicks >= numberOr(campaignThresholds.clicksP50, 0) && Number.isFinite(row.cvr) && finiteAtLeast(row.cvr, campaignThresholds.cvrP90)), 'cvr', 'desc', 5,
    (row) => observation('campaign', 'high_conversion_outlier', 'info', row.campaignName, `Campaign CVR ${pct(row.cvr)} is in the highest decile with meaningful traffic.`, row, { observedId: row.campaignId, identityResolved: false }));
  addRanked(observations, campaigns.filter((row) => row.clicks >= numberOr(campaignThresholds.clicksP50, 0) && Number.isFinite(row.cvr) && finiteAtMost(row.cvr, campaignThresholds.cvrP10)), 'cvr', 'asc', 5,
    (row) => observation('campaign', 'low_conversion_outlier', 'medium', row.campaignName, `Campaign CVR ${pct(row.cvr)} is in the lowest decile with meaningful traffic.`, row, { observedId: row.campaignId, identityResolved: false }));
  addRanked(observations, campaigns.filter((row) => row.orders === 0 && row.clicks >= numberOr(campaignThresholds.clicksP75, 0)), 'clicks', 'desc', 5,
    (row) => observation('campaign', 'traffic_without_conversion', 'high', row.campaignName, `${formatInt(row.clicks)} clicks produced zero attributed orders.`, row, { observedId: row.campaignId, identityResolved: false }));
  addMatchTypeObservations(observations, matchTypes);
  addTrendObservations(observations, daily);

  const totalGroups = searchTerms.length;
  return Object.freeze({
    kind: 'diagnostic_bundle',
    authoritative: false,
    recommendationAuthorized: false,
    reviewAuthorized: false,
    amazonExecutionAuthorized: false,
    sourceKind: 'csv_business_analytics',
    computeLocation: 'worker_server_side',
    scope: input.scope || null,
    coverage: Object.freeze({
      totalGroups,
      analyzedGroups: totalGroups,
      coverageRatio: 1,
      partial: false,
      truncationReason: null,
      pagesLoaded: 0,
      searchTermRowsAnalyzed: totalGroups,
      searchTermRowsTotal: totalGroups,
      searchTermComplete: true,
      campaignRowsAnalyzed: campaigns.length,
      dailyRowsAnalyzed: daily.length,
      matchTypeRowsAnalyzed: matchTypes.length,
    }),
    thresholds: Object.freeze({ searchTerm: searchThresholds, campaign: campaignThresholds }),
    observations: Object.freeze(observations.slice(0, MAX_OBSERVATIONS)),
  });
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

function readSearchTerms(db, where) {
  return db.prepare(`
    SELECT
      f.search_term AS search_term,
      f.normalized_search_term AS normalized_search_term,
      f.match_type AS match_type,
      f.targeting AS targeting,
      f.targeting_id AS targeting_id,
      f.campaign_name AS campaign_name,
      f.campaign_id AS campaign_id,
      f.ad_group_name AS ad_group_name,
      f.ad_group_id AS ad_group_id,
      f.advertiser_account_id AS advertiser_account_id,
      f.profile_id AS profile_id,
      SUM(f.impressions) AS impressions,
      SUM(f.clicks) AS clicks,
      SUM(f.cost_micros) AS spend_micros,
      SUM(f.purchases) AS purchases,
      SUM(f.sales_micros) AS sales_micros
    FROM csv_business_search_term_daily f
    WHERE ${where.sql}
    GROUP BY
      f.search_term, f.normalized_search_term, f.match_type, f.targeting, f.targeting_id,
      f.campaign_name, f.campaign_id, f.ad_group_name, f.ad_group_id,
      f.advertiser_account_id, f.profile_id
  `).bind(...where.params).all();
}

function readCampaigns(db, where) {
  return db.prepare(`
    SELECT
      f.campaign_name AS campaign_name,
      f.campaign_id AS campaign_id,
      f.advertiser_account_id AS advertiser_account_id,
      f.profile_id AS profile_id,
      SUM(f.impressions) AS impressions,
      SUM(f.clicks) AS clicks,
      SUM(f.cost_micros) AS spend_micros,
      SUM(f.purchases) AS purchases,
      SUM(f.sales_micros) AS sales_micros
    FROM csv_business_search_term_daily f
    WHERE ${where.sql}
    GROUP BY f.campaign_name, f.campaign_id, f.advertiser_account_id, f.profile_id
  `).bind(...where.params).all();
}

function readDaily(db, where) {
  return db.prepare(`
    SELECT
      f.report_date AS report_date,
      SUM(f.impressions) AS impressions,
      SUM(f.clicks) AS clicks,
      SUM(f.cost_micros) AS spend_micros,
      SUM(f.purchases) AS purchases,
      SUM(f.sales_micros) AS sales_micros
    FROM csv_business_search_term_daily f
    WHERE ${where.sql}
    GROUP BY f.report_date
    ORDER BY f.report_date ASC
  `).bind(...where.params).all();
}

function readMatchTypes(db, where) {
  return db.prepare(`
    SELECT
      f.match_type AS match_type,
      SUM(f.impressions) AS impressions,
      SUM(f.clicks) AS clicks,
      SUM(f.cost_micros) AS spend_micros,
      SUM(f.purchases) AS purchases,
      SUM(f.sales_micros) AS sales_micros
    FROM csv_business_search_term_daily f
    WHERE ${where.sql}
    GROUP BY f.match_type
  `).bind(...where.params).all();
}

function parseDateRange(url) {
  const startDate = isoDate(url.searchParams.get('startDate'));
  const endDate = isoDate(url.searchParams.get('endDate'));
  if (!startDate || !endDate) return { error: 'date_range_required' };
  if (endDate < startDate) return { error: 'date_range_invalid' };
  if (inclusiveDays(startDate, endDate) > MAX_RANGE_DAYS) return { error: 'date_range_too_large' };
  return { startDate, endDate };
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

function publicFilters(filters) {
  return Object.freeze({ ...filters });
}

function searchTermRow(row) {
  return {
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
    ...metricRowFromSql(row),
  };
}

function campaignRow(row) {
  return {
    campaignName: row.campaign_name,
    campaignId: row.campaign_id || null,
    advertiserAccountId: row.advertiser_account_id || null,
    profileId: row.profile_id || null,
    ...metricRowFromSql(row),
  };
}

function dailyRow(row) {
  return { reportDate: row.report_date, ...metricRowFromSql(row) };
}

function matchTypeRow(row) {
  return { matchType: row.match_type || 'unknown', ...metricRowFromSql(row) };
}

function metricRowFromSql(row) {
  const impressions = integer(row?.impressions);
  const clicks = integer(row?.clicks);
  const spendMicros = integer(row?.spend_micros);
  const orders = integer(row?.purchases);
  const salesMicros = integer(row?.sales_micros);
  return {
    impressions,
    clicks,
    spendMicros,
    purchases: orders,
    orders,
    salesMicros,
    cvr: safeRatio(orders, clicks),
    acos: safeRatio(spendMicros, salesMicros),
    roas: safeRatio(salesMicros, spendMicros),
  };
}

function addConcentration(out, rowsValue, field, rule, label) {
  if (!rowsValue.length) return;
  const total = rowsValue.reduce((sum, row) => sum + numberOr(row[field], 0), 0);
  if (total <= 0) return;
  const top = [...rowsValue].sort((a, b) => numberOr(b[field], 0) - numberOr(a[field], 0))[0];
  const share = numberOr(top[field], 0) / total;
  if (share < 0.25) return;
  out.push(observation('campaign', rule, share >= 0.40 ? 'high' : 'medium', top.campaignName,
    `${label} concentration is ${pct(share)} in the leading campaign.`, top,
    { share, observedId: top.campaignId, identityResolved: false }));
}

function addMatchTypeObservations(out, rowsValue) {
  const valid = rowsValue.filter((row) => row.spendMicros > 0);
  if (!valid.length) return;
  const spendLeader = [...valid].sort((a, b) => b.spendMicros - a.spendMicros)[0];
  const acosBest = [...valid].filter((row) => Number.isFinite(row.acos)).sort((a, b) => a.acos - b.acos)[0];
  const acosWorst = [...valid].filter((row) => Number.isFinite(row.acos)).sort((a, b) => b.acos - a.acos)[0];
  if (spendLeader) out.push(observation('match-type', 'spend_leader', 'info', spendLeader.matchType,
    `${spendLeader.matchType || 'Unknown'} carries the largest spend in the selected scope.`, spendLeader));
  if (acosBest) out.push(observation('match-type', 'efficiency_leader', 'info', acosBest.matchType,
    `${acosBest.matchType || 'Unknown'} has the lowest observed ACoS among match types with spend.`, acosBest));
  if (acosWorst && acosWorst !== acosBest) out.push(observation('match-type', 'efficiency_laggard', 'medium', acosWorst.matchType,
    `${acosWorst.matchType || 'Unknown'} has the highest observed ACoS among match types with spend.`, acosWorst));
}

function addTrendObservations(out, rowsValue) {
  const ordered = [...rowsValue].sort((a, b) => String(a.reportDate || '').localeCompare(String(b.reportDate || '')));
  for (let index = 7; index < ordered.length; index += 1) {
    const current = ordered[index];
    const prior = ordered.slice(index - 7, index);
    const avgSpend = average(prior, 'spendMicros');
    const avgSales = average(prior, 'salesMicros');
    const avgAcos = averageFinite(prior, 'acos');
    const avgRoas = averageFinite(prior, 'roas');
    const avgCvr = averageFinite(prior, 'cvr');
    if (avgSpend > 0 && current.spendMicros > avgSpend * 1.5) out.push(observation('trend', 'spend_spike', 'medium', current.reportDate, `Spend is ${pct(current.spendMicros / avgSpend - 1)} above the trailing 7-day average.`, current));
    if (avgSales > 0 && current.salesMicros < avgSales * 0.6) out.push(observation('trend', 'sales_drop', 'high', current.reportDate, `Sales are ${pct(1 - current.salesMicros / avgSales)} below the trailing 7-day average.`, current));
    if (Number.isFinite(current.acos) && Number.isFinite(avgAcos) && avgAcos > 0 && current.acos > avgAcos * 1.5) out.push(observation('trend', 'acos_deterioration', 'medium', current.reportDate, `ACoS is ${pct(current.acos / avgAcos - 1)} above the trailing 7-day average.`, current));
    if (Number.isFinite(current.roas) && Number.isFinite(avgRoas) && avgRoas > 0 && current.roas > avgRoas * 1.5) out.push(observation('trend', 'roas_improvement', 'info', current.reportDate, `ROAS is ${pct(current.roas / avgRoas - 1)} above the trailing 7-day average.`, current));
    if (Number.isFinite(current.cvr) && Number.isFinite(avgCvr) && avgCvr > 0 && Math.abs(current.cvr / avgCvr - 1) > 0.5) out.push(observation('trend', 'conversion_shift', 'medium', current.reportDate, `CVR shifted ${pct(current.cvr / avgCvr - 1)} versus the trailing 7-day average.`, current));
  }
}

function observation(category, rule, severity, subject, explanation, row, extra = {}) {
  return Object.freeze({
    kind: 'diagnostic',
    category,
    rule,
    severity,
    subject: subject || '—',
    explanation,
    evidence: Object.freeze({
      impressions: numberOr(row.impressions, 0),
      clicks: numberOr(row.clicks, 0),
      spendMicros: numberOr(row.spendMicros, 0),
      orders: numberOr(row.orders ?? row.purchases, 0),
      salesMicros: numberOr(row.salesMicros, 0),
      acos: finiteOrNull(row.acos),
      roas: finiteOrNull(row.roas),
      cvr: finiteOrNull(row.cvr),
      ...extra,
    }),
    authoritative: false,
    recommendationAuthorized: false,
    amazonExecutionAuthorized: false,
  });
}

function addRanked(out, rowsValue, field, direction, limit, mapper) {
  const sign = direction === 'asc' ? 1 : -1;
  for (const row of [...rowsValue]
    .sort((a, b) => sign * (numberOr(a[field], 0) - numberOr(b[field], 0)))
    .slice(0, limit)) out.push(mapper(row));
}

function metricRow(row = {}) {
  const impressions = numberOr(row.impressions, 0);
  const clicks = numberOr(row.clicks, 0);
  const spendMicros = numberOr(row.spendMicros, 0);
  const orders = numberOr(row.orders ?? row.purchases, 0);
  const salesMicros = numberOr(row.salesMicros, 0);
  return {
    ...row,
    impressions,
    clicks,
    spendMicros,
    orders,
    salesMicros,
    cvr: finiteNumber(row.cvr) ?? (clicks === 0 ? null : orders / clicks),
    acos: finiteNumber(row.acos) ?? (salesMicros === 0 ? null : spendMicros / salesMicros),
    roas: finiteNumber(row.roas) ?? (spendMicros === 0 ? null : salesMicros / spendMicros),
  };
}

function quantile(rowsValue, field, p) {
  const values = rowsValue.map((row) => finiteNumber(row[field])).filter((value) => value !== null).sort((a, b) => a - b);
  return values.length ? values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))] : null;
}
function average(rowsValue, field) { return rowsValue.length ? rowsValue.reduce((sum, row) => sum + numberOr(row[field], 0), 0) / rowsValue.length : null; }
function averageFinite(rowsValue, field) { const values = rowsValue.map((row) => finiteNumber(row[field])).filter((value) => value !== null); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function finiteNumber(value) { if (value === null || value === undefined || value === '') return null; const numeric = Number(value); return Number.isFinite(numeric) ? numeric : null; }
function finiteAtLeast(value, threshold) { const numeric = finiteNumber(value); const benchmark = finiteNumber(threshold); return numeric !== null && benchmark !== null && numeric >= benchmark; }
function finiteAtMost(value, threshold) { const numeric = finiteNumber(value); const benchmark = finiteNumber(threshold); return numeric !== null && benchmark !== null && numeric <= benchmark; }
function finiteOrNull(value) { return finiteNumber(value); }
function numberOr(value, fallback) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : fallback; }
function integer(value) { const numeric = Number(value); return Number.isFinite(numeric) ? Math.trunc(numeric) : 0; }
function safeRatio(numerator, denominator) { return denominator === 0 ? null : numerator / denominator; }
function pct(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—'; }
function ratio(value) { return Number.isFinite(value) ? `${value.toFixed(2)}x` : '—'; }
function money(value) { return Number.isFinite(value) ? `$${(value / 1_000_000).toFixed(2)}` : '—'; }
function formatInt(value) { return Math.trunc(numberOr(value, 0)).toLocaleString('en-US'); }
function rows(result) { return Array.isArray(result?.results) ? result.results : []; }

function isoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text;
}
function inclusiveDays(startDate, endDate) { return Math.floor((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86400000) + 1; }
function normalizeSearch(value) { const text = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 200); return text || null; }
function optionalText(value, maxLength) { const text = String(value || '').trim(); return text ? text.slice(0, maxLength) : null; }
function escapeLike(value) { return value.replace(/[\\%_]/g, (match) => `\\${match}`); }

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
