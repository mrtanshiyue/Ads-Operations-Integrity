import { deriveSearchTermMetrics } from './decision-intelligence.js';

export const CSV_SEARCH_TERM_PRODUCT_UNIVERSE_SCHEMA_VERSION = 'csv-search-term-product-universe-v1';
export const CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP = 1000;

export async function queryCsvSearchTermProductUniverse(db, input) {
  if (!db?.prepare) throw universeError('CSV_PRODUCT_UNIVERSE_DB_REQUIRED');
  const result = await db.prepare(`
    WITH aggregated AS (
      SELECT
        f.normalized_search_term,
        MIN(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.search_term END) AS search_term,
        GROUP_CONCAT(DISTINCT CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.profile_id END) AS profile_ids,
        GROUP_CONCAT(DISTINCT CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.currency_code END) AS currency_codes,
        GROUP_CONCAT(DISTINCT CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN f.marketplace END) AS marketplaces,
        CASE
          WHEN SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN 1 ELSE 0 END) > 0
           AND SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 AND COALESCE(f.targeting_identity_state,'unresolved') <> 'resolved_id' THEN 1 ELSE 0 END) = 0
          THEN 'resolved_id'
          ELSE 'unresolved'
        END AS targeting_identity_state,
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
        GROUP_CONCAT(DISTINCT CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN a.provenance_class END) AS provenance_classes
      FROM csv_search_term_daily f
      JOIN csv_import_authority a ON a.import_id=f.source_import_id AND a.data_class='business'
      LEFT JOIN csv_import_batches b ON b.import_id=f.source_import_id
      WHERE f.report_date BETWEEN ?1 AND ?4
        AND (?5 IS NULL OR f.profile_id=?5)
        AND (?6 IS NULL OR f.campaign_name=?6)
        AND (?7 IS NULL OR f.ad_group_name=?7)
        AND (?8 IS NULL OR f.search_term LIKE ?8 ESCAPE '\\' OR f.normalized_search_term LIKE ?8 ESCAPE '\\')
      GROUP BY f.normalized_search_term
      HAVING SUM(CASE WHEN f.report_date BETWEEN ?3 AND ?4 THEN 1 ELSE 0 END) > 0
    )
    SELECT * FROM aggregated
    ORDER BY normalized_search_term ASC
    LIMIT ?9
  `).bind(
    input.previousStartDate,
    input.previousEndDate,
    input.startDate,
    input.endDate,
    input.profileId || null,
    input.campaignName || null,
    input.adGroupName || null,
    input.q ? `%${escapeLike(input.q)}%` : null,
    CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP + 1,
  ).all();

  return buildCsvSearchTermProductUniverseFromRows(result.results || [], input);
}

export function buildCsvSearchTermProductUniverseFromRows(rows, input = {}) {
  if (!Array.isArray(rows)) throw universeError('CSV_PRODUCT_UNIVERSE_ROWS_REQUIRED');
  const complete = rows.length <= CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP;
  const boundedRows = rows.slice(0, CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP);
  const currencyCodes = uniqueCsvValues(rows, 'currency_codes');
  const marketplaces = uniqueCsvValues(rows, 'marketplaces');
  const profileIds = uniqueCsvValues(rows, 'profile_ids');
  const hasRows = boundedRows.length > 0;
  const financiallyComparable = !hasRows || (currencyCodes.length === 1 && marketplaces.length === 1);
  const reasons = [];
  if (!complete) reasons.push('search_term_universe_hard_cap_exceeded');
  if (currencyCodes.length > 1) reasons.push('multiple_currency_codes');
  if (marketplaces.length > 1) reasons.push('multiple_marketplaces');
  if (hasRows && currencyCodes.length === 0) reasons.push('currency_code_missing');
  if (hasRows && marketplaces.length === 0) reasons.push('marketplace_missing');
  const financialScopeUsable = financiallyComparable
    && (!hasRows || (currencyCodes.length === 1 && marketplaces.length === 1));
  if (!financialScopeUsable && !reasons.length) reasons.push('financial_scope_not_comparable');

  const items = boundedRows.map((row) => productItemFromRow(row));
  const productItems = financialScopeUsable ? items : Object.freeze([]);
  const scope = Object.freeze({
    kind: 'complete_filtered_search_term_universe',
    complete,
    hardCap: CSV_SEARCH_TERM_PRODUCT_UNIVERSE_HARD_CAP,
    observedTermCount: boundedRows.length,
    overflowObserved: !complete,
    financiallyComparable: financialScopeUsable,
    candidateEmissionAuthorized: complete && financialScopeUsable,
    currencyCodes: Object.freeze(currencyCodes),
    marketplaces: Object.freeze(marketplaces),
    profileIds: Object.freeze(profileIds),
    reasons: Object.freeze(reasons),
    incompleteBehavior: 'analytics_visible_candidates_fail_closed',
    financialMismatchBehavior: 'financial_intelligence_suppressed',
  });

  return Object.freeze({
    schemaVersion: CSV_SEARCH_TERM_PRODUCT_UNIVERSE_SCHEMA_VERSION,
    scope,
    profile: Object.freeze({
      profileId: profileIds.length === 1 ? profileIds[0] : (cleanText(input.profileId) || null),
      countryCode: marketplaces.length === 1 ? marketplaces[0] : null,
      currencyCode: currencyCodes.length === 1 ? currencyCodes[0] : null,
    }),
    items: Object.freeze(items),
    productItems,
  });
}

function productItemFromRow(row) {
  const evidence = csvEvidenceFromRow(row);
  return Object.freeze({
    entity: Object.freeze({
      entityId: `csv-term:${cleanText(row.normalized_search_term)}`,
      searchTerm: cleanText(row.search_term) || cleanText(row.normalized_search_term),
      normalizedSearchTerm: cleanText(row.normalized_search_term),
      targetingIdentityState: cleanText(row.targeting_identity_state) === 'resolved_id' ? 'resolved_id' : 'unresolved',
      identityResolved: false,
    }),
    metrics: metricsFromRow(row, ''),
    previousMetrics: metricsFromRow(row, 'previous_'),
    evidence: Object.freeze({
      sourceKind: 'csv_import',
      dataClass: 'business',
      sourceImportIds: evidence.sourceImportIds,
      contentSha256s: evidence.contentSha256s,
      provenanceClasses: evidence.provenanceClasses,
      csvProvenanceValid: evidence.provenanceValid,
      targetingIdentityState: cleanText(row.targeting_identity_state) === 'resolved_id' ? 'resolved_id' : 'unresolved',
      identityResolved: false,
    }),
  });
}

function metricsFromRow(row, prefix) {
  return deriveSearchTermMetrics({
    impressions: row[`${prefix}impressions`],
    clicks: row[`${prefix}clicks`],
    purchases: row[`${prefix}purchases`],
    unitsSold: row[`${prefix}units_sold`],
    costMicros: row[`${prefix}cost_micros`],
    salesMicros: row[`${prefix}sales_micros`],
  });
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
    sourceImportIds: Object.freeze(sourceImportIds),
    contentSha256s: Object.freeze(contentSha256s),
    provenanceClasses: Object.freeze(provenanceClasses),
  });
}

function uniqueCsvValues(rows, key) {
  const values = new Set();
  for (const row of rows) for (const value of splitCsv(row?.[key])) values.add(value);
  return [...values].sort();
}

function splitCsv(value) { return String(value || '').split(',').map((item) => item.trim()).filter(Boolean); }
function cleanText(value) { return String(value ?? '').trim(); }
function escapeLike(value) { return String(value).replace(/[\\%_]/g, (match) => `\\${match}`); }
function universeError(code) { const error = new Error(code); error.name = 'CsvSearchTermProductUniverseError'; error.code = code; return error; }
