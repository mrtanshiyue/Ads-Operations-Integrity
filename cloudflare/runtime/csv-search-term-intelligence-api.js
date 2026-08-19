import {
  DEFAULT_SEARCH_TERM_RULES,
  SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
  SEARCH_TERM_MODEL_VERSION,
  SEARCH_TERM_RULE_VERSION,
  buildRecommendationPreview,
  deriveSearchTermMetrics,
} from './decision-intelligence.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_RANGE_DAYS = 93;

// CSV analytics is admitted only from imports explicitly classified as business data.
// Recommendation evaluation is stricter: every contributing current-window import must also
// carry exact/reconciled source provenance. CSV remains non-authoritative for Amazon mutation.
const CSV_ADVISORY_RULES = Object.freeze({
  quality: Object.freeze({
    ...DEFAULT_SEARCH_TERM_RULES.quality,
    suppressInvalidLineage: false,
    suppressStale: false,
    minConfidenceScore: 0.10,
  }),
  observation: DEFAULT_SEARCH_TERM_RULES.observation,
  waste: DEFAULT_SEARCH_TERM_RULES.waste,
  harvest: DEFAULT_SEARCH_TERM_RULES.harvest,
});

export async function handleCsvSearchTermIntelligenceApiRoute({ request, env, actor, url }) {
  if (request.method !== 'GET') return null;
  if (url.searchParams.get('source') !== 'csv') return null;
  const match = url.pathname.match(/^\/api\/v1\/stores\/([^/]+)\/search-term-intelligence$/);
  if (!match) return null;

  const storeId = safeDecode(match[1]);
  if (!storeId) return json(request, { error: 'invalid_store_id' }, 400);
  const route = await authorizedStoreRoute(env, actor.user_id, storeId, 'analytics.read');
  if (route.error) return json(request, { error: route.error, permission: route.permission }, route.status);

  const range = parseDateRange(url);
  if (range.error) return json(request, { error: range.error }, 400);
  const comparisonRange = previousComparableRange(range);
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit.error) return json(request, { error: limit.error }, 400);
  const sort = parseSort(url.searchParams.get('sort'));
  if (sort.error) return json(request, { error: sort.error }, 400);

  const profileId = optionalText(url.searchParams.get('profileId'), 200);
  const q = normalizeSearch(url.searchParams.get('q'));
  const campaignName = optionalText(url.searchParams.get('campaignName'), 300);
  const adGroupName = optionalText(url.searchParams.get('adGroupName'), 300);

  const rows = await queryCsvSearchTermIntelligence(route.storeDb, {
    profileId,
    startDate: range.startDate,
    endDate: range.endDate,
    previousStartDate: comparisonRange.startDate,
    previousEndDate: comparisonRange.endDate,
    q,
    campaignName,
    adGroupName,
    sort: sort.value,
    limit: limit.value,
  });

  const items = [];
  for (const row of rows) {
    const metrics = currentMetricsFromRow(row);
    const previousMetrics = previousMetricsFromRow(row);
    const csvEvidence = csvEvidenceFromRow(row);
    const freshness = deriveFreshness({
      latestReportDate: row.latest_report_date,
      factUpdatedAt: row.fact_updated_at,
      profileSyncedAt: null,
    });
    const trend = buildTrendContext(metrics, previousMetrics, range, comparisonRange);
    const entity = Object.freeze({
      entityId: row.group_key,
      searchTerm: row.search_term,
      normalizedSearchTerm: row.normalized_search_term,
      campaignId: null,
      campaignName: row.campaign_name,
      adGroupId: null,
      adGroupName: row.ad_group_name,
      keywordId: null,
      keywordText: null,
      targetId: null,
      targeting: row.targeting,
      matchType: row.match_type || null,
      identityResolved: false,
      negativeKeywordExists: null,
      harvestedKeywordExists: null,
    });

    // Feed content hashes into the common fingerprint model, while leaving Amazon lineage fields
    // empty. The core model therefore keeps its confidence penalty and can never mark CSV data as
    // Amazon-authoritative.
    let preview = await buildRecommendationPreview({
      storeId,
      profileId: profileId || '',
      analysisWindow: range,
      entity,
      metrics,
      evidence: {
        lineageValid: false,
        factRowCount: csvEvidence.factRowCount,
        invalidLineageCount: 0,
        sourceReportJobIds: [],
        amazonReportIds: [],
        r2ObjectKeys: [],
        contentSha256s: csvEvidence.contentSha256s,
        latestReportDate: csvEvidence.latestReportDate,
        factUpdatedAt: csvEvidence.factUpdatedAt,
      },
      freshness,
      trend,
      env,
      rules: CSV_ADVISORY_RULES,
    });

    if (!csvEvidence.provenanceValid) {
      preview = Object.freeze({
        ...preview,
        recommendation: null,
        fingerprint: null,
        suppression: Object.freeze({
          code: 'csv_import_authority_not_governed',
          reason: 'CSV recommendation suppressed because one or more business imports lack exact or reconciled source provenance.',
          governancePersistenceAllowed: false,
        }),
      });
    }

    const recommendation = preview.recommendation
      ? Object.freeze({
          ...preview.recommendation,
          persistenceAuthorized: false,
          governancePersistenceAllowed: false,
          executionAuthorized: false,
          identityResolutionRequired: true,
        })
      : null;

    items.push(Object.freeze({
      entity,
      metrics,
      previousMetrics,
      trend: preview.trend,
      freshness: preview.decision.freshness,
      evidence: Object.freeze({
        ...preview.decision.evidence,
        sourceKind: 'csv_import',
        dataClass: 'business',
        provenanceClasses: csvEvidence.provenanceClasses,
        csvProvenanceValid: csvEvidence.provenanceValid,
        sourceImportIds: csvEvidence.sourceImportIds,
        contentSha256s: csvEvidence.contentSha256s,
        identityResolved: false,
      }),
      confidence: preview.decision.confidence,
      scores: preview.decision.scores,
      authority: Object.freeze({
        ...preview.authority,
        authoritative: false,
        mode: 'non_authoritative',
        label: 'non-authoritative',
        dataClass: 'business',
        provenanceClasses: csvEvidence.provenanceClasses,
        recommendationGoverned: csvEvidence.provenanceValid,
        reasons: Object.freeze([...new Set([...(preview.authority?.reasons || []), 'csv_source_not_amazon_authority', 'amazon_entity_identity_unresolved'])]),
        amazonMutationAuthorized: false,
      }),
      recommendation,
      fingerprint: recommendation ? preview.fingerprint : null,
      suppression: recommendation ? null : (preview.suppression || preview.decision.suppression || null),
    }));
  }

  const provenanceValidCount = items.filter((item) => item.evidence.csvProvenanceValid).length;
  const candidateCount = items.filter((item) => item.recommendation).length;
  const currencyCodes = uniqueTexts(rows.map((row) => row.currency_code));
  const marketplaces = uniqueTexts(rows.map((row) => row.marketplace));

  return json(request, {
    schemaVersion: SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
    modelVersion: SEARCH_TERM_MODEL_VERSION,
    ruleVersion: `${SEARCH_TERM_RULE_VERSION}+csv-authority-v2`,
    source: Object.freeze({
      kind: 'csv_import',
      schemaVersion: 'csv-import-v1',
      authority: 'non-authoritative',
      dataClassGate: 'business',
      recommendationProvenanceGate: ['exact_source_object', 'reconciled_exact_source'],
      amazonEntityIdentityResolved: false,
      governancePersistenceAllowed: false,
      amazonMutationAuthorized: false,
    }),
    authority: Object.freeze({
      authoritative: false,
      mode: 'non_authoritative',
      label: 'non-authoritative',
      reasons: Object.freeze(['csv_source_not_amazon_authority', 'amazon_entity_identity_unresolved']),
      amazonMutationAuthorized: false,
    }),
    storeId,
    profile: {
      profileId: profileId || null,
      marketplaceId: null,
      countryCode: marketplaces.length === 1 ? marketplaces[0] : null,
      currencyCode: currencyCodes.length === 1 ? currencyCodes[0] : null,
      timezone: null,
      accountName: 'Imported CSV facts',
      accountType: null,
      syncedAt: null,
    },
    range,
    comparisonRange,
    filters: { q, campaignName, adGroupName, profileId, sort: sort.value, limit: limit.value },
    metricsContract: metricsContract(),
    freshnessContract: freshnessContract(),
    rules: CSV_ADVISORY_RULES,
    summary: {
      itemCount: items.length,
      businessDataOnly: true,
      recommendationCandidateCount: candidateCount,
      governedProvenanceItemCount: provenanceValidCount,
      csvProvenanceValidItemCount: provenanceValidCount,
      authoritativeRecommendationCount: 0,
      governancePersistenceAllowed: false,
      identityResolutionRequired: candidateCount,
      freshness: summarizeFreshness(items),
      amazonMutationAuthorized: false,
    },
    items,
  }, 200);
}

async function queryCsvSearchTermIntelligence(db, input) {
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
        MIN(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.row_key END) AS group_key,
        f.profile_id,
        f.campaign_name,
        f.ad_group_name,
        f.targeting,
        f.match_type,
        MIN(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.search_term END) AS search_term,
        f.normalized_search_term,
        MIN(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.currency_code END) AS currency_code,
        MIN(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.marketplace END) AS marketplace,
        SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.impressions ELSE 0 END) AS impressions,
        SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.clicks ELSE 0 END) AS clicks,
        SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.cost_micros ELSE 0 END) AS cost_micros,
        SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.purchases ELSE 0 END) AS purchases,
        SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.units_sold ELSE 0 END) AS units_sold,
        SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.sales_micros ELSE 0 END) AS sales_micros,
        SUM(CASE WHEN f.report_date BETWEEN ?1 AND ?2 THEN f.impressions ELSE 0 END) AS previous_impressions,
        SUM(CASE WHEN f.report_date BETWEEN ?1 AND ?2 THEN f.clicks ELSE 0 END) AS previous_clicks,
        SUM(CASE WHEN f.report_date BETWEEN ?1 AND ?2 THEN f.cost_micros ELSE 0 END) AS previous_cost_micros,
        SUM(CASE WHEN f.report_date BETWEEN ?1 AND ?2 THEN f.purchases ELSE 0 END) AS previous_purchases,
        SUM(CASE WHEN f.report_date BETWEEN ?1 AND ?2 THEN f.units_sold ELSE 0 END) AS previous_units_sold,
        SUM(CASE WHEN f.report_date BETWEEN ?1 AND ?2 THEN f.sales_micros ELSE 0 END) AS previous_sales_micros,
        SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN 1 ELSE 0 END) AS fact_row_count,
        SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 AND (
                   b.import_id IS NULL
                   OR b.status <> 'published'
                   OR b.schema_version <> 'csv-import-v1'
                   OR b.content_sha256 IS NULL
                   OR LENGTH(b.content_sha256) <> 64
                   OR f.report_date < b.report_start_date
                   OR f.report_date > b.report_end_date
                   OR a.provenance_class NOT IN ('exact_source_object','reconciled_exact_source')
                 ) THEN 1 ELSE 0 END) AS invalid_provenance_count,
        GROUP_CONCAT(DISTINCT CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.source_import_id END) AS source_import_ids,
        GROUP_CONCAT(DISTINCT CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN b.content_sha256 END) AS content_sha256s,
        GROUP_CONCAT(DISTINCT CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN a.provenance_class END) AS provenance_classes,
        MAX(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.report_date END) AS latest_report_date,
        MAX(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.updated_at END) AS fact_updated_at
      FROM csv_search_term_daily f
      JOIN csv_import_authority a ON a.import_id=f.source_import_id AND a.data_class='business'
      LEFT JOIN csv_import_batches b ON b.import_id=f.source_import_id
      WHERE f.report_date BETWEEN ?1 AND ?4
        AND (?5 IS NULL OR f.profile_id=?5)
        AND (?6 IS NULL OR f.campaign_name=?6)
        AND (?7 IS NULL OR f.ad_group_name=?7)
        AND (?8 IS NULL OR f.search_term LIKE ?8 ESCAPE '\\' OR f.normalized_search_term LIKE ?8 ESCAPE '\\')
      GROUP BY f.profile_id, f.campaign_name, f.ad_group_name, f.targeting, f.match_type, f.normalized_search_term
      HAVING SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN 1 ELSE 0 END) > 0
    )
    SELECT * FROM aggregated
    ORDER BY ${sortColumn} DESC, group_key DESC
    LIMIT ?9
  `).bind(
    input.previousStartDate,
    input.previousEndDate,
    input.startDate,
    input.endDate,
    input.profileId,
    input.campaignName,
    input.adGroupName,
    input.q ? `%${escapeLike(input.q)}%` : null,
    input.limit,
  ).all();
  return result.results || [];
}

function csvEvidenceFromRow(row) {
  const sourceImportIds = splitCsv(row.source_import_ids);
  const contentSha256s = splitCsv(row.content_sha256s).map((value) => value.toLowerCase());
  const provenanceClasses = splitCsv(row.provenance_classes);
  const invalidProvenanceCount = Number(row.invalid_provenance_count || 0);
  const provenanceValid = Number(row.fact_row_count || 0) > 0
    && invalidProvenanceCount === 0
    && sourceImportIds.length > 0
    && contentSha256s.length > 0
    && provenanceClasses.length > 0
    && provenanceClasses.every((value) => ['exact_source_object', 'reconciled_exact_source'].includes(value))
    && contentSha256s.every((value) => /^[a-f0-9]{64}$/.test(value));
  return Object.freeze({
    provenanceValid,
    factRowCount: Number(row.fact_row_count || 0),
    invalidProvenanceCount,
    sourceImportIds: Object.freeze(sourceImportIds),
    contentSha256s: Object.freeze(contentSha256s),
    provenanceClasses: Object.freeze(provenanceClasses),
    latestReportDate: row.latest_report_date || null,
    factUpdatedAt: row.fact_updated_at || null,
  });
}

function currentMetricsFromRow(row) {
  return deriveSearchTermMetrics({
    impressions: row.impressions,
    clicks: row.clicks,
    purchases: row.purchases,
    unitsSold: row.units_sold,
    costMicros: row.cost_micros,
    salesMicros: row.sales_micros,
  });
}

function previousMetricsFromRow(row) {
  return deriveSearchTermMetrics({
    impressions: row.previous_impressions,
    clicks: row.previous_clicks,
    purchases: row.previous_purchases,
    unitsSold: row.previous_units_sold,
    costMicros: row.previous_cost_micros,
    salesMicros: row.previous_sales_micros,
  });
}

function buildTrendContext(current, previous, range, comparisonRange) {
  return Object.freeze({
    currentWindow: range,
    previousWindow: comparisonRange,
    current,
    previous,
    delta: Object.freeze({
      spendPct: relativeDelta(current.spendMicros, previous.spendMicros),
      salesPct: relativeDelta(current.salesMicros, previous.salesMicros),
      ordersPct: relativeDelta(current.orders, previous.orders),
      clicksPct: relativeDelta(current.clicks, previous.clicks),
      impressionsPct: relativeDelta(current.impressions, previous.impressions),
      acosPp: percentagePointDelta(current.acos, previous.acos),
      roas: absoluteDelta(current.roas, previous.roas),
      cvrPp: percentagePointDelta(current.cvr, previous.cvr),
      cpcPct: relativeDelta(current.cpcMicros, previous.cpcMicros),
      ctrPp: percentagePointDelta(current.ctr, previous.ctr),
    }),
  });
}

function deriveFreshness({ latestReportDate, factUpdatedAt, profileSyncedAt }) {
  const latest = isoDate(latestReportDate);
  if (!latest) return Object.freeze({ state: 'unknown', latestReportDate: null, factUpdatedAt: factUpdatedAt || null, profileSyncedAt: profileSyncedAt || null, ageDays: null, confidenceFactor: 0.65 });
  const today = new Date().toISOString().slice(0, 10);
  const ageDays = Math.max(0, dateDiffDays(latest, today));
  const state = ageDays <= 2 ? 'fresh' : (ageDays <= 7 ? 'aging' : 'stale');
  return Object.freeze({
    state,
    latestReportDate: latest,
    factUpdatedAt: factUpdatedAt || null,
    profileSyncedAt: profileSyncedAt || null,
    ageDays,
    confidenceFactor: state === 'fresh' ? 1 : (state === 'aging' ? 0.8 : 0.5),
  });
}

function summarizeFreshness(items) {
  const summary = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  for (const item of items) {
    const state = item.freshness?.state || 'unknown';
    if (Object.prototype.hasOwnProperty.call(summary, state)) summary[state] += 1;
    else summary.unknown += 1;
  }
  return summary;
}

async function authorizedStoreRoute(env, userId, storeId, permission) {
  const allowed = await hasStorePermission(env.CONTROL_DB, userId, storeId, permission);
  if (!allowed) return { error: 'forbidden', permission, status: 403 };
  const store = await env.CONTROL_DB.prepare(`SELECT store_id,d1_binding_key,status FROM stores WHERE store_id=?1 AND status <> 'disabled' LIMIT 1`).bind(storeId).first();
  if (!store) return { error: 'store_not_found', status: 404 };
  if (!STORE_BINDINGS.has(store.d1_binding_key)) return { error: 'store_db_unavailable', status: 503 };
  const storeDb = env[store.d1_binding_key];
  if (!storeDb) return { error: 'store_db_unavailable', status: 503 };
  return { store, storeDb };
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`SELECT 1 AS ok FROM user_global_roles ugr JOIN role_permissions rp ON rp.role_key=ugr.role_key WHERE ugr.user_id=?1 AND rp.permission_key=?2 LIMIT 1`).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`SELECT 1 AS ok FROM store_members sm JOIN role_permissions rp ON rp.role_key=sm.role_key WHERE sm.user_id=?1 AND sm.store_id=?2 AND rp.permission_key=?3 LIMIT 1`).bind(userId, storeId, permission).first());
}

function parseDateRange(url) {
  const startDate = isoDate(url.searchParams.get('startDate'));
  const endDate = isoDate(url.searchParams.get('endDate'));
  if (!startDate || !endDate) return { error: 'date_range_required' };
  if (endDate < startDate) return { error: 'date_range_invalid' };
  const days = dateDiffDays(startDate, endDate) + 1;
  if (days > MAX_RANGE_DAYS) return { error: 'date_range_too_large' };
  return { startDate, endDate, days };
}
function previousComparableRange(range) {
  const previousEnd = addDays(range.startDate, -1);
  const previousStart = addDays(previousEnd, -(range.days - 1));
  return { startDate: previousStart, endDate: previousEnd, days: range.days };
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
  return Object.freeze({ moneyUnit:'micros', acos:'costMicros / salesMicros; null when sales is zero', roas:'salesMicros / costMicros; null when cost is zero', cvr:'orders / clicks; null when clicks is zero', cpcMicros:'costMicros / clicks; null when clicks is zero', ctr:'clicks / impressions; null when impressions is zero', trend:'current analysis window compared with the immediately preceding equal-length window' });
}
function freshnessContract() {
  return Object.freeze({ states:['fresh','aging','stale','unknown'], fresh:'latest report date age <= 2 days', aging:'latest report date age 3-7 days', stale:'latest report date age > 7 days', unknown:'latest report date unavailable', confidence:'freshness factor multiplies sample confidence; CSV remains non-authoritative regardless of freshness' });
}
function relativeDelta(current, previous) { const c=Number(current),p=Number(previous); return !Number.isFinite(c)||!Number.isFinite(p)||p===0 ? null : round4((c-p)/p); }
function percentagePointDelta(current, previous) { const c=Number(current),p=Number(previous); return !Number.isFinite(c)||!Number.isFinite(p) ? null : round2((c-p)*100); }
function absoluteDelta(current, previous) { const c=Number(current),p=Number(previous); return !Number.isFinite(c)||!Number.isFinite(p) ? null : round4(c-p); }
function splitCsv(value) { return String(value || '').split(',').map((item) => item.trim()).filter(Boolean); }
function uniqueTexts(values) { return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort(); }
function isoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== text ? null : text;
}
function dateDiffDays(startDate, endDate) { return Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000); }
function addDays(date, days) { const parsed=new Date(`${date}T00:00:00Z`); parsed.setUTCDate(parsed.getUTCDate()+days); return parsed.toISOString().slice(0,10); }
function normalizeSearch(value) { const text=String(value || '').trim(); return text ? text.slice(0,200) : null; }
function optionalText(value, max) { const text=String(value || '').trim(); return text ? text.slice(0,max) : null; }
function escapeLike(value) { return String(value).replace(/[\\%_]/g, (match) => `\\${match}`); }
function safeDecode(value) { try { return decodeURIComponent(value); } catch { return null; } }
function round2(value) { return Math.round(value*100)/100; }
function round4(value) { return Math.round(value*10000)/10000; }
function json(request, payload, status) {
  const headers = new Headers({ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
  const ray=request.headers.get('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status, headers });
}