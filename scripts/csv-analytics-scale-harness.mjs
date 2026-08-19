import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TABLE = '__csv_analytics_benchmark_facts';
const DEFAULT_SIZES = Object.freeze([10000, 100000]);

export class CsvAnalyticsScaleHarnessError extends Error {
  constructor(code, cause = null) { super(code); this.name = 'CsvAnalyticsScaleHarnessError'; this.code = code; this.cause = cause; }
}

export function setupSql(maxRows = 100000) {
  const rows = boundedRows(maxRows);
  return Object.freeze([
    `DROP TABLE IF EXISTS ${TABLE}`,
    `CREATE TABLE ${TABLE} (
      bench_id INTEGER PRIMARY KEY, report_date TEXT NOT NULL, source_import_id TEXT NOT NULL, source_row_ordinal INTEGER NOT NULL,
      advertiser_account_id TEXT, profile_id TEXT, campaign_id TEXT, campaign_name TEXT NOT NULL, ad_group_id TEXT, ad_group_name TEXT NOT NULL,
      targeting_id TEXT, targeting TEXT NOT NULL, match_type TEXT, search_term TEXT, normalized_search_term TEXT NOT NULL,
      marketplace TEXT, currency_code TEXT, impressions INTEGER NOT NULL, clicks INTEGER NOT NULL, cost_micros INTEGER NOT NULL,
      purchases INTEGER NOT NULL, units_sold INTEGER NOT NULL, sales_micros INTEGER NOT NULL, row_key TEXT NOT NULL
    )`,
    `WITH digits(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)), nums(n) AS (
      SELECT a.d+b.d*10+c.d*100+d.d*1000+e.d*10000+f.d*100000+1
      FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e CROSS JOIN digits f
    ) INSERT INTO ${TABLE}
    SELECT n,printf('2026-06-%02d',1+((n-1)%30)),'bench-import-'||printf('%02d',1+((n-1)%4)),n,
      'bench-account','bench-profile','c-'||printf('%03d',(n-1)%200),'Campaign '||printf('%03d',(n-1)%200),
      'a-'||printf('%04d',(n-1)%1000),'Ad Group '||printf('%04d',(n-1)%1000),
      't-'||printf('%05d',(n-1)%5000),'Target '||printf('%05d',(n-1)%5000),
      CASE ((n-1)%3) WHEN 0 THEN 'EXACT' WHEN 1 THEN 'PHRASE' ELSE 'BROAD' END,
      'search term '||printf('%06d',n),'search term '||printf('%06d',n),'US','USD',100+(n%1000),1+(n%50),100000+(n%10000000),
      CASE WHEN n%11=0 THEN 0 ELSE 1+(n%5) END,CASE WHEN n%11=0 THEN 0 ELSE 1+(n%6) END,
      CASE WHEN n%11=0 THEN 0 ELSE 500000+(n%20000000) END,'bench-row-'||n
    FROM nums WHERE n<=${rows}`,
    `CREATE INDEX idx_bench_date ON ${TABLE}(report_date)`,
    `CREATE INDEX idx_bench_campaign_id ON ${TABLE}(campaign_id,ad_group_id,report_date)`,
    `CREATE INDEX idx_bench_search ON ${TABLE}(normalized_search_term,report_date)`,
    `CREATE INDEX idx_bench_target ON ${TABLE}(targeting_id,report_date)`,
  ]);
}

export function benchmarkSqlForScale(size) {
  const n = boundedRows(size);
  const where = `bench_id<=${n}`;
  const dimensions = {
    overview: [`SELECT COUNT(*) fact_count,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(units_sold) units_sold,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where}`],
    daily: [pageQuery(`SELECT report_date,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(units_sold) units_sold,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY report_date`, 'report_date ASC', 366)],
    campaign: [pageQuery(`SELECT campaign_name,campaign_id,advertiser_account_id,profile_id,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(units_sold) units_sold,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY campaign_name,campaign_id,advertiser_account_id,profile_id`, 'spend_micros DESC,campaign_name ASC', 25)],
    'ad-group': [pageQuery(`SELECT campaign_name,campaign_id,ad_group_name,ad_group_id,advertiser_account_id,profile_id,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(units_sold) units_sold,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY campaign_name,campaign_id,ad_group_name,ad_group_id,advertiser_account_id,profile_id`, 'spend_micros DESC,ad_group_name ASC', 25)],
    targeting: [pageQuery(`SELECT targeting,targeting_id,campaign_name,campaign_id,ad_group_name,ad_group_id,advertiser_account_id,profile_id,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(units_sold) units_sold,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY targeting,targeting_id,campaign_name,campaign_id,ad_group_name,ad_group_id,advertiser_account_id,profile_id`, 'spend_micros DESC,targeting ASC', 25)],
    'search-term': [pageQuery(`SELECT search_term,normalized_search_term,match_type,targeting,targeting_id,campaign_name,campaign_id,ad_group_name,ad_group_id,advertiser_account_id,profile_id,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(units_sold) units_sold,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY search_term,normalized_search_term,match_type,targeting,targeting_id,campaign_name,campaign_id,ad_group_name,ad_group_id,advertiser_account_id,profile_id`, 'spend_micros DESC,normalized_search_term ASC', 25)],
    'match-type': [pageQuery(`SELECT match_type,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(units_sold) units_sold,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY match_type`, 'spend_micros DESC,match_type ASC', 25)],
    quality: qualityQueries(where),
    diagnostics: diagnosticsQueries(where),
  };
  return Object.freeze(dimensions);
}

export async function runScaleHarness(options = {}) {
  const accountId = requiredText(options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID, 'CSV_SCALE_ACCOUNT_ID_REQUIRED');
  const databaseId = requiredText(options.databaseId ?? process.env.CSV_SCALE_D1_DATABASE_ID, 'CSV_SCALE_DATABASE_ID_REQUIRED');
  const token = requiredText(options.token ?? process.env.CLOUDFLARE_API_TOKEN, 'CSV_SCALE_API_TOKEN_REQUIRED');
  const sizes = normalizeSizes(options.sizes ?? process.env.CSV_SCALE_SIZES);
  const keep = String(options.keep ?? process.env.CSV_SCALE_KEEP_TABLE ?? '').toLowerCase() === 'true';
  const fetchImpl = options.fetchImpl ?? fetch;
  const execute = options.execute ?? ((sql) => executeD1Sql({ accountId, databaseId, token, sql, fetchImpl }));
  const maxRows = Math.max(...sizes);
  const report = { contract: 'csv-analytics-scale-harness-v1', generatedAt: new Date().toISOString(), sizes: {}, table: TABLE };
  try {
    for (const sql of setupSql(maxRows)) await execute(sql);
    for (const size of sizes) {
      const dimensions = benchmarkSqlForScale(size);
      report.sizes[size] = {};
      for (const [name, queries] of Object.entries(dimensions)) {
        const metrics = [];
        for (const sql of queries) metrics.push(await execute(sql));
        report.sizes[size][name] = summarizeMetrics(metrics);
      }
    }
  } finally {
    if (!keep) await execute(`DROP TABLE IF EXISTS ${TABLE}`);
  }
  return Object.freeze(report);
}

export function summarizeMetrics(metrics) {
  const values = metrics || [];
  return Object.freeze({
    rows_read: values.reduce((sum, item) => sum + number(item.rows_read ?? item.meta?.rows_read), 0),
    sql_duration_ms: Number(values.reduce((sum, item) => sum + number(item.sql_duration_ms ?? item.meta?.timings?.sql_duration_ms ?? item.meta?.duration), 0).toFixed(4)),
    response_size_bytes: values.reduce((sum, item) => sum + number(item.response_size_bytes), 0),
    query_count: values.length,
  });
}

async function executeD1Sql({ accountId, databaseId, token, sql, fetchImpl }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sql }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) throw new CsvAnalyticsScaleHarnessError(`CSV_SCALE_D1_QUERY_FAILED:${response.status}`);
  const result = payload.result?.[0] || {};
  return { rows_read: number(result.meta?.rows_read), sql_duration_ms: number(result.meta?.timings?.sql_duration_ms ?? result.meta?.duration), response_size_bytes: Buffer.byteLength(JSON.stringify(result.results || [])), result_rows: Array.isArray(result.results) ? result.results.length : 0 };
}

function pageQuery(grouped, orderBy, limit) { return `WITH a AS (${grouped}),e AS (SELECT *,COUNT(*) OVER() total_count FROM a) SELECT * FROM e ORDER BY ${orderBy} LIMIT ${limit}`; }
function qualityQueries(where) { return [
  `SELECT COUNT(*) fact_count,COUNT(DISTINCT source_import_id) import_count,MIN(report_date),MAX(report_date),GROUP_CONCAT(DISTINCT currency_code),GROUP_CONCAT(DISTINCT marketplace) FROM ${TABLE} f WHERE ${where}`,
  `SELECT SUM(CASE WHEN campaign_id IS NULL OR TRIM(campaign_id)='' THEN 1 ELSE 0 END) missing_campaign_id,SUM(CASE WHEN ad_group_id IS NULL OR TRIM(ad_group_id)='' THEN 1 ELSE 0 END) missing_ad_group_id,SUM(CASE WHEN targeting_id IS NULL OR TRIM(targeting_id)='' THEN 1 ELSE 0 END) missing_targeting_id,SUM(CASE WHEN search_term IS NULL OR TRIM(search_term)='' THEN 1 ELSE 0 END) missing_search_term,SUM(CASE WHEN clicks>impressions THEN 1 ELSE 0 END) clicks_gt_impressions,SUM(CASE WHEN purchases>clicks THEN 1 ELSE 0 END) orders_gt_clicks FROM ${TABLE} f WHERE ${where}`,
  `WITH d AS (SELECT COUNT(*) row_count,COUNT(DISTINCT source_import_id) import_count FROM ${TABLE} f WHERE ${where} GROUP BY report_date,advertiser_account_id,profile_id,campaign_id,campaign_name,ad_group_id,ad_group_name,targeting_id,targeting,match_type,normalized_search_term,marketplace,currency_code,impressions,clicks,cost_micros,purchases,units_sold,sales_micros HAVING COUNT(*)>1) SELECT COUNT(*) duplicate_group_count,COALESCE(SUM(row_count),0) affected_facts FROM d`,
  `WITH o AS (SELECT COUNT(*) row_count,COUNT(DISTINCT source_import_id) import_count FROM ${TABLE} f WHERE ${where} GROUP BY report_date,advertiser_account_id,profile_id,campaign_id,ad_group_id,targeting_id,match_type,normalized_search_term,marketplace,currency_code HAVING COUNT(DISTINCT source_import_id)>1) SELECT COUNT(*) overlap_group_count,COALESCE(SUM(row_count),0) affected_facts FROM o`,
  `SELECT DISTINCT report_date FROM ${TABLE} f WHERE ${where} ORDER BY report_date`,
]; }
function diagnosticsQueries(where) { return [
  optimizedSearchDiagnosticsSql(where),
  `SELECT campaign_name,campaign_id,advertiser_account_id,profile_id,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY campaign_name,campaign_id,advertiser_account_id,profile_id`,
  `SELECT report_date,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY report_date ORDER BY report_date`,
  `SELECT match_type,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY match_type`,
]; }
function optimizedSearchDiagnosticsSql(where) { return `WITH aggregated AS (SELECT search_term,normalized_search_term,SUM(impressions) impressions,SUM(clicks) clicks,SUM(cost_micros) spend_micros,SUM(purchases) purchases,SUM(sales_micros) sales_micros FROM ${TABLE} f WHERE ${where} GROUP BY search_term,normalized_search_term,match_type,targeting,targeting_id,campaign_name,campaign_id,ad_group_name,ad_group_id,advertiser_account_id,profile_id),metrics AS (SELECT *,CASE WHEN clicks=0 THEN NULL ELSE CAST(purchases AS REAL)/clicks END cvr,CASE WHEN sales_micros=0 THEN NULL ELSE CAST(spend_micros AS REAL)/sales_micros END acos,CASE WHEN spend_micros=0 THEN NULL ELSE CAST(sales_micros AS REAL)/spend_micros END roas FROM aggregated),thresholds AS (SELECT (SELECT spend_micros FROM metrics ORDER BY spend_micros LIMIT 1 OFFSET (SELECT MAX(0,((COUNT(*)*90+99)/100)-1) FROM metrics)) spend_p90,(SELECT clicks FROM metrics ORDER BY clicks LIMIT 1 OFFSET (SELECT MAX(0,((COUNT(*)*90+99)/100)-1) FROM metrics)) clicks_p90,(SELECT COUNT(*) FROM metrics) total_groups) SELECT total_groups,spend_p90,clicks_p90,(SELECT json_group_array(json_object('searchTerm',search_term,'spendMicros',spend_micros,'clicks',clicks)) FROM (SELECT m.* FROM metrics m,t thresholds WHERE m.spend_micros>=t.spend_p90 ORDER BY m.spend_micros DESC LIMIT 10)) observations FROM thresholds`; }
function normalizeSizes(value) { if (!value) return [...DEFAULT_SIZES]; const raw=Array.isArray(value)?value:String(value).split(','); const sizes=[...new Set(raw.map((item)=>boundedRows(item)))].sort((a,b)=>a-b); if (!sizes.length) throw new CsvAnalyticsScaleHarnessError('CSV_SCALE_SIZES_REQUIRED'); return sizes; }
function boundedRows(value) { const n=Number(value); if (!Number.isInteger(n)||n<1||n>1000000) throw new CsvAnalyticsScaleHarnessError('CSV_SCALE_ROWS_INVALID'); return n; }
function requiredText(value, code) { const text=String(value??'').trim(); if(!text) throw new CsvAnalyticsScaleHarnessError(code); return text; }
function number(value) { const n=Number(value); return Number.isFinite(n)?n:0; }

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const report = await runScaleHarness();
  console.log(JSON.stringify(report, null, 2));
}
