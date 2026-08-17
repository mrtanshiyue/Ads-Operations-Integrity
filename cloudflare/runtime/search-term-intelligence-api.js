import {
  DEFAULT_SEARCH_TERM_RULES,
  SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
  SEARCH_TERM_MODEL_VERSION,
  SEARCH_TERM_RULE_VERSION,
  buildRecommendationAuthority,
  buildRecommendationPreview,
  deriveSearchTermMetrics,
} from './decision-intelligence.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_RANGE_DAYS = 93;

export async function handleSearchTermIntelligenceApiRoute({ request, env, actor, url }) {
  if (request.method !== 'GET') return null;
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/search-term-intelligence(?:\/(recommendation-preview))?$/);
  if (!match) return null;

  const storeId = decodeURIComponent(match[1]);
  const mode = match[2] || 'intelligence';
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, 'analytics.read');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  const profileId = requiredText(url.searchParams.get('profileId'), 200);
  if (!profileId) return json(request, { error: 'profile_id_required' }, 400);
  const profile = await route.storeDb.prepare(`
    SELECT profile_id, marketplace_id, country_code, currency_code, timezone, account_name, account_type, status, synced_at
    FROM amazon_profiles
    WHERE profile_id=?1 AND status <> 'disabled'
    LIMIT 1
  `).bind(profileId).first();
  if (!profile) return json(request, { error: 'profile_not_found' }, 404);

  const range = parseDateRange(url);
  if (range.error) return json(request, { error: range.error }, 400);
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit.error) return json(request, { error: limit.error }, 400);
  const sort = parseSort(url.searchParams.get('sort'));
  if (sort.error) return json(request, { error: sort.error }, 400);
  const q = normalizeSearch(url.searchParams.get('q'));
  const campaignId = optionalText(url.searchParams.get('campaignId'), 200);
  const adGroupId = optionalText(url.searchParams.get('adGroupId'), 200);

  const rows = await querySearchTermIntelligence(route.storeDb, {
    profileId,
    startDate: range.startDate,
    endDate: range.endDate,
    q,
    campaignId,
    adGroupId,
    sort: sort.value,
    limit: limit.value,
  });

  const items = [];
  for (const row of rows) {
    const metrics = deriveSearchTermMetrics({
      impressions: row.impressions,
      clicks: row.clicks,
      purchases: row.purchases,
      unitsSold: row.units_sold,
      costMicros: row.cost_micros,
      salesMicros: row.sales_micros,
    });
    const evidence = evidenceFromRow(row);
    const entity = {
      entityId: row.group_key,
      searchTerm: row.search_term,
      normalizedSearchTerm: row.normalized_search_term,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      adGroupId: row.ad_group_id,
      adGroupName: row.ad_group_name,
      keywordId: row.keyword_id,
      keywordText: row.keyword_text,
      targetId: row.target_id,
      negativeKeywordExists: Boolean(row.negative_collision),
      harvestedKeywordExists: Boolean(row.harvest_collision),
    };

    let preview = await buildRecommendationPreview({
      storeId,
      profileId,
      analysisWindow: range,
      entity,
      metrics,
      evidence,
      env,
      rules: DEFAULT_SEARCH_TERM_RULES,
    });
    preview = suppressCollision(preview, entity);

    items.push({
      entity,
      metrics,
      evidence: preview.decision.evidence,
      confidence: preview.decision.confidence,
      scores: preview.decision.scores,
      authority: preview.authority,
      recommendation: preview.recommendation,
      fingerprint: preview.fingerprint,
      suppression: preview.suppression || null,
    });
  }

  const candidateCount = items.filter((item) => item.recommendation).length;
  const lineageValidCount = items.filter((item) => item.evidence.lineageValid).length;
  const responseAuthority = buildRecommendationAuthority({ env, profileId, lineageValid: items.length > 0 && lineageValidCount === items.length });

  return json(request, {
    schemaVersion: SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
    modelVersion: SEARCH_TERM_MODEL_VERSION,
    ruleVersion: SEARCH_TERM_RULE_VERSION,
    mode,
    authority: responseAuthority,
    storeId,
    profile: {
      profileId: profile.profile_id,
      marketplaceId: profile.marketplace_id || null,
      countryCode: profile.country_code || null,
      currencyCode: profile.currency_code || null,
      timezone: profile.timezone || null,
      accountName: profile.account_name || null,
      accountType: profile.account_type || null,
      syncedAt: profile.synced_at || null,
    },
    range,
    filters: { q, campaignId, adGroupId, sort: sort.value, limit: limit.value },
    metricsContract: metricsContract(),
    rules: DEFAULT_SEARCH_TERM_RULES,
    summary: {
      itemCount: items.length,
      recommendationCandidateCount: candidateCount,
      lineageValidItemCount: lineageValidCount,
      authoritativeRecommendationCount: items.filter((item) => item.recommendation && item.authority.authoritative).length,
      amazonMutationAuthorized: false,
    },
    items: mode === 'recommendation-preview' ? items.filter((item) => item.recommendation) : items,
  }, 200);
}

async function querySearchTermIntelligence(db, input) {
  const sortColumn = {
    cost: 'cost_micros',
    sales: 'sales_micros',
    clicks: 'clicks',
    orders: 'purchases',
    impressions: 'impressions',
  }[input.sort];

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
        SUM(st.sales_micros) AS sales_micros,
        COUNT(*) AS fact_row_count,
        SUM(CASE WHEN st.source_report_job_id IS NULL
                   OR rj.job_id IS NULL
                   OR rj.amazon_report_id IS NULL OR TRIM(rj.amazon_report_id)=''
                   OR rj.r2_object_key IS NULL OR TRIM(rj.r2_object_key)=''
                   OR rj.content_sha256 IS NULL OR LENGTH(TRIM(rj.content_sha256)) <> 64
                   OR rj.status <> 'ingested'
                 THEN 1 ELSE 0 END) AS invalid_lineage_count,
        GROUP_CONCAT(DISTINCT st.source_report_job_id) AS source_report_job_ids,
        GROUP_CONCAT(DISTINCT rj.amazon_report_id) AS amazon_report_ids,
        GROUP_CONCAT(DISTINCT rj.r2_object_key) AS r2_object_keys,
        GROUP_CONCAT(DISTINCT rj.content_sha256) AS content_sha256s,
        MAX(CASE WHEN EXISTS (
          SELECT 1 FROM negative_keywords nk
          WHERE nk.profile_id=st.profile_id
            AND nk.campaign_id=st.campaign_id
            AND (nk.ad_group_id IS NULL OR nk.ad_group_id=st.ad_group_id)
            AND nk.normalized_keyword=st.normalized_search_term
            AND COALESCE(nk.state,'ENABLED') <> 'ARCHIVED'
        ) THEN 1 ELSE 0 END) AS negative_collision,
        MAX(CASE WHEN EXISTS (
          SELECT 1 FROM keywords hk
          WHERE hk.profile_id=st.profile_id
            AND hk.normalized_keyword=st.normalized_search_term
            AND hk.state <> 'ARCHIVED'
        ) THEN 1 ELSE 0 END) AS harvest_collision
      FROM search_term_daily st
      LEFT JOIN campaigns c ON c.campaign_id=st.campaign_id
      LEFT JOIN ad_groups ag ON ag.ad_group_id=st.ad_group_id
      LEFT JOIN keywords k ON k.keyword_id=st.keyword_id
      LEFT JOIN report_jobs rj ON rj.job_id=st.source_report_job_id
      WHERE st.report_date BETWEEN ?1 AND ?2
        AND st.profile_id=?3
        AND (?4 IS NULL OR st.campaign_id=?4)
        AND (?5 IS NULL OR st.ad_group_id=?5)
        AND (?6 IS NULL OR st.search_term LIKE ?6 ESCAPE '\\' OR st.normalized_search_term LIKE ?6 ESCAPE '\\')
      GROUP BY st.profile_id, st.campaign_id, c.name, st.ad_group_id, ag.name,
               st.keyword_id, k.keyword_text, st.target_id, st.normalized_search_term
    )
    SELECT * FROM aggregated
    ORDER BY ${sortColumn} DESC, group_key DESC
    LIMIT ?7
  `).bind(
    input.startDate,
    input.endDate,
    input.profileId,
    input.campaignId,
    input.adGroupId,
    input.q ? `%${escapeLike(input.q)}%` : null,
    input.limit,
  ).all();
  return result.results || [];
}

function suppressCollision(preview, entity) {
  if (!preview.recommendation) return preview;
  const negativeCollision = preview.recommendation.family === 'waste' && entity.negativeKeywordExists;
  const harvestCollision = preview.recommendation.family === 'harvest' && entity.harvestedKeywordExists;
  if (!negativeCollision && !harvestCollision) return preview;
  return Object.freeze({
    ...preview,
    recommendation: null,
    fingerprint: null,
    suppression: Object.freeze({
      code: negativeCollision ? 'existing_negative_collision' : 'existing_keyword_collision',
      reason: 'The proposed target already exists in the Store D1 entity mirror; duplicate proposal suppressed.',
    }),
  });
}

function evidenceFromRow(row) {
  return {
    lineageValid: Number(row.invalid_lineage_count || 0) === 0,
    factRowCount: Number(row.fact_row_count || 0),
    invalidLineageCount: Number(row.invalid_lineage_count || 0),
    sourceReportJobIds: splitCsv(row.source_report_job_ids),
    amazonReportIds: splitCsv(row.amazon_report_ids),
    r2ObjectKeys: splitCsv(row.r2_object_keys),
    contentSha256s: splitCsv(row.content_sha256s),
  };
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

function parseDateRange(url) {
  const startDate = isoDate(url.searchParams.get('startDate'));
  const endDate = isoDate(url.searchParams.get('endDate'));
  if (!startDate || !endDate) return { error: 'date_range_required' };
  if (endDate < startDate) return { error: 'date_range_invalid' };
  const days = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) return { error: 'date_range_too_large' };
  return { startDate, endDate, days };
}
function parseLimit(value) {
  const number = Number(value || DEFAULT_LIMIT);
  return Number.isInteger(number) && number >= 1 && number <= MAX_LIMIT ? { value: number } : { error: 'invalid_limit' };
}
function parseSort(value) {
  const sort = String(value || 'cost').trim().toLowerCase();
  return ['cost', 'sales', 'clicks', 'orders', 'impressions'].includes(sort) ? { value: sort } : { error: 'invalid_sort' };
}
function metricsContract() {
  return Object.freeze({
    moneyUnit: 'micros',
    acos: 'costMicros / salesMicros; null when sales is zero',
    roas: 'salesMicros / costMicros; null when cost is zero',
    cvr: 'orders / clicks; null when clicks is zero',
    cpcMicros: 'costMicros / clicks; null when clicks is zero',
    ctr: 'clicks / impressions; null when impressions is zero',
  });
}
function splitCsv(value) { return String(value || '').split(',').map((item) => item.trim()).filter(Boolean); }
function isoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}
function normalizeSearch(value) { const valueText = String(value || '').trim(); return valueText ? valueText.slice(0, 200) : null; }
function requiredText(value, max) { const valueText = String(value || '').trim(); return valueText ? valueText.slice(0, max) : null; }
function optionalText(value, max) { const valueText = String(value || '').trim(); return valueText ? valueText.slice(0, max) : null; }
function escapeLike(value) { return String(value).replace(/[\\%_]/g, (match) => `\\${match}`); }
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
