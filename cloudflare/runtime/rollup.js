const MAX_ROLLUP_DAYS = 366;
const MAX_BATCH_STATEMENTS = 900;
const KEYWORD_WINDOWS = new Set([7, 14, 30, 60, 90, 180, 365]);

export async function refreshStoreDailySummary({ controlDb, storeDb, storeId, startDate, endDate }) {
  requireDatabases(controlDb, storeDb);
  const store = requiredText(storeId, 'store_id');
  const range = dateRange(startDate, endDate, MAX_ROLLUP_DAYS);

  const source = await storeDb.prepare(`
    SELECT report_date, ad_product,
           SUM(impressions) AS impressions,
           SUM(clicks) AS clicks,
           SUM(cost_micros) AS cost_micros,
           SUM(purchases) AS purchases,
           SUM(units_sold) AS units_sold,
           SUM(sales_micros) AS sales_micros
    FROM campaign_daily
    WHERE report_date BETWEEN ?1 AND ?2
    GROUP BY report_date, ad_product
    ORDER BY report_date, ad_product
  `).bind(range.startDate, range.endDate).all();

  const rows = (source.results || []).map(metricSourceRow);
  assertBatchCapacity(rows.length + 1, 'store_daily_summary');

  const statements = [
    controlDb.prepare(`
      DELETE FROM store_daily_summary
      WHERE store_id = ?1 AND report_date BETWEEN ?2 AND ?3
    `).bind(store, range.startDate, range.endDate),
  ];
  const insert = controlDb.prepare(`
    INSERT INTO store_daily_summary(
      store_id, report_date, ad_product, impressions, clicks, cost_micros,
      purchases, units_sold, sales_micros, updated_at
    ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP)
  `);
  for (const row of rows) statements.push(bindMetricInsert(insert, store, row));
  await controlDb.batch(statements);

  return { storeId: store, ...range, summaryRows: rows.length };
}

export async function refreshProductDailySummaryDate({ controlDb, storeDb, storeId, reportDate }) {
  requireDatabases(controlDb, storeDb);
  const store = requiredText(storeId, 'store_id');
  const date = isoDate(reportDate, 'report_date');

  const [mappingResult, sourceResult] = await Promise.all([
    controlDb.prepare(`
      SELECT product_id, seller_sku, asin
      FROM product_store_map
      WHERE store_id = ?1
      ORDER BY product_id, seller_sku
    `).bind(store).all(),
    storeDb.prepare(`
      SELECT report_date, ad_product, advertised_asin, advertised_sku,
             SUM(impressions) AS impressions,
             SUM(clicks) AS clicks,
             SUM(cost_micros) AS cost_micros,
             SUM(purchases) AS purchases,
             SUM(units_sold) AS units_sold,
             SUM(sales_micros) AS sales_micros
      FROM advertised_product_daily
      WHERE report_date = ?1
      GROUP BY report_date, ad_product, advertised_asin, advertised_sku
      ORDER BY ad_product, advertised_sku, advertised_asin
    `).bind(date).all(),
  ]);

  const mapping = buildProductMapping(mappingResult.results || []);
  const aggregated = new Map();
  let unmappedRows = 0;
  let ambiguousRows = 0;

  for (const source of sourceResult.results || []) {
    const resolution = resolveProduct(mapping, source.advertised_sku, source.advertised_asin);
    if (!resolution.productId) {
      if (resolution.ambiguous) ambiguousRows += 1;
      else unmappedRows += 1;
      continue;
    }
    const row = metricSourceRow(source);
    const key = `${resolution.productId}\u0000${row.reportDate}\u0000${row.adProduct}`;
    const current = aggregated.get(key) || emptyMetricRow({
      productId: resolution.productId,
      reportDate: row.reportDate,
      adProduct: row.adProduct,
    });
    addMetrics(current, row);
    aggregated.set(key, current);
  }

  const rows = [...aggregated.values()];
  assertBatchCapacity(rows.length + 1, 'product_daily_summary');
  const statements = [
    controlDb.prepare(`
      DELETE FROM product_daily_summary
      WHERE store_id = ?1 AND report_date = ?2
    `).bind(store, date),
  ];
  const insert = controlDb.prepare(`
    INSERT INTO product_daily_summary(
      store_id, product_id, report_date, ad_product, impressions, clicks, cost_micros,
      purchases, units_sold, sales_micros, updated_at
    ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP)
  `);
  for (const row of rows) {
    statements.push(insert.bind(
      store, row.productId, row.reportDate, row.adProduct,
      row.impressions, row.clicks, row.costMicros, row.purchases, row.unitsSold, row.salesMicros,
    ));
  }
  await controlDb.batch(statements);

  return {
    storeId: store,
    reportDate: date,
    summaryRows: rows.length,
    unmappedRows,
    ambiguousRows,
  };
}

export async function refreshKeywordPerformanceRollupPartition({
  controlDb,
  storeDb,
  storeId,
  asOfDate,
  windowDays,
  partitionPrefix = '',
  languageCode = 'en-US',
}) {
  requireDatabases(controlDb, storeDb);
  const store = requiredText(storeId, 'store_id');
  const asOf = isoDate(asOfDate, 'as_of_date');
  const window = Number(windowDays);
  if (!KEYWORD_WINDOWS.has(window)) throw new Error('rollup_keyword_window_invalid');
  const prefix = normalizeKeywordPrefix(partitionPrefix);
  const language = requiredText(languageCode, 'language_code');
  const startDate = shiftIsoDate(asOf, -(window - 1));
  const likePattern = `${escapeLike(prefix)}%`;

  const [libraryResult, sourceResult] = await Promise.all([
    controlDb.prepare(`
      SELECT keyword_id, normalized_term
      FROM keyword_library
      WHERE language_code = ?1 AND normalized_term LIKE ?2 ESCAPE '\\'
      ORDER BY normalized_term, keyword_id
    `).bind(language, likePattern).all(),
    storeDb.prepare(`
      SELECT k.normalized_keyword,
             SUM(d.impressions) AS impressions,
             SUM(d.clicks) AS clicks,
             SUM(d.cost_micros) AS cost_micros,
             SUM(d.purchases) AS purchases,
             SUM(d.units_sold) AS units_sold,
             SUM(d.sales_micros) AS sales_micros
      FROM keyword_daily d
      JOIN keywords k ON k.keyword_id = d.keyword_id
      WHERE d.report_date BETWEEN ?1 AND ?2
        AND k.normalized_keyword LIKE ?3 ESCAPE '\\'
      GROUP BY k.normalized_keyword
      ORDER BY k.normalized_keyword
    `).bind(startDate, asOf, likePattern).all(),
  ]);

  const library = new Map();
  for (const row of libraryResult.results || []) {
    const key = normalizeKeywordTerm(row.normalized_term);
    if (!key) continue;
    const ids = library.get(key) || new Set();
    ids.add(String(row.keyword_id));
    library.set(key, ids);
  }

  const rows = [];
  let unmappedRows = 0;
  let ambiguousRows = 0;
  for (const source of sourceResult.results || []) {
    const key = normalizeKeywordTerm(source.normalized_keyword);
    const ids = library.get(key);
    if (!ids || ids.size === 0) {
      unmappedRows += 1;
      continue;
    }
    if (ids.size !== 1) {
      ambiguousRows += 1;
      continue;
    }
    rows.push({
      keywordId: [...ids][0],
      impressions: nonNegativeInteger(source.impressions, 'impressions'),
      clicks: nonNegativeInteger(source.clicks, 'clicks'),
      costMicros: nonNegativeInteger(source.cost_micros, 'cost_micros'),
      purchases: nonNegativeInteger(source.purchases, 'purchases'),
      unitsSold: nonNegativeInteger(source.units_sold, 'units_sold'),
      salesMicros: nonNegativeInteger(source.sales_micros, 'sales_micros'),
    });
  }

  assertBatchCapacity(rows.length + 1, 'keyword_performance_rollup');
  const statements = [
    controlDb.prepare(`
      DELETE FROM keyword_performance_rollup
      WHERE store_id = ?1 AND as_of_date = ?2 AND window_days = ?3
        AND keyword_id IN (
          SELECT keyword_id FROM keyword_library
          WHERE language_code = ?4 AND normalized_term LIKE ?5 ESCAPE '\\'
        )
    `).bind(store, asOf, window, language, likePattern),
  ];
  const insert = controlDb.prepare(`
    INSERT INTO keyword_performance_rollup(
      store_id, keyword_id, as_of_date, window_days, impressions, clicks,
      cost_micros, purchases, units_sold, sales_micros, updated_at
    ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP)
  `);
  for (const row of rows) {
    statements.push(insert.bind(
      store, row.keywordId, asOf, window,
      row.impressions, row.clicks, row.costMicros, row.purchases, row.unitsSold, row.salesMicros,
    ));
  }
  await controlDb.batch(statements);

  return {
    storeId: store,
    asOfDate: asOf,
    startDate,
    windowDays: window,
    partitionPrefix: prefix,
    summaryRows: rows.length,
    unmappedRows,
    ambiguousRows,
  };
}

export async function markStoreSyncStatus({
  controlDb,
  storeId,
  status,
  activeRunId = null,
  lastSuccessAt = null,
  lastErrorAt = null,
  lastErrorCode = null,
  lagMinutes = null,
}) {
  if (!controlDb) throw new Error('control_db_binding_required');
  const store = requiredText(storeId, 'store_id');
  const state = String(status || '').trim().toLowerCase();
  if (!['never', 'idle', 'running', 'degraded', 'failed', 'paused'].includes(state)) {
    throw new Error('sync_status_invalid');
  }
  const lag = lagMinutes === null || lagMinutes === undefined
    ? null
    : nonNegativeInteger(lagMinutes, 'lag_minutes');

  await controlDb.prepare(`
    INSERT INTO store_sync_status(
      store_id, sync_status, active_run_id, last_success_at, last_error_at,
      last_error_code, lag_minutes, updated_at
    ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id) DO UPDATE SET
      sync_status = excluded.sync_status,
      active_run_id = excluded.active_run_id,
      last_success_at = COALESCE(excluded.last_success_at, store_sync_status.last_success_at),
      last_error_at = COALESCE(excluded.last_error_at, store_sync_status.last_error_at),
      last_error_code = excluded.last_error_code,
      lag_minutes = excluded.lag_minutes,
      updated_at = CURRENT_TIMESTAMP
  `).bind(store, state, activeRunId, lastSuccessAt, lastErrorAt, lastErrorCode, lag).run();
}

function buildProductMapping(rows) {
  const bySku = new Map();
  const byAsin = new Map();
  for (const row of rows) {
    addProductMapping(bySku, normalizeIdentity(row.seller_sku), row.product_id);
    addProductMapping(byAsin, normalizeIdentity(row.asin), row.product_id);
  }
  return { bySku, byAsin };
}

function addProductMapping(map, key, productId) {
  if (!key || !productId) return;
  const ids = map.get(key) || new Set();
  ids.add(String(productId));
  map.set(key, ids);
}

function resolveProduct(mapping, sku, asin) {
  for (const [map, key] of [
    [mapping.bySku, normalizeIdentity(sku)],
    [mapping.byAsin, normalizeIdentity(asin)],
  ]) {
    if (!key) continue;
    const ids = map.get(key);
    if (!ids || ids.size === 0) continue;
    if (ids.size === 1) return { productId: [...ids][0], ambiguous: false };
    return { productId: null, ambiguous: true };
  }
  return { productId: null, ambiguous: false };
}

function metricSourceRow(row) {
  return {
    reportDate: String(row.report_date),
    adProduct: String(row.ad_product),
    impressions: nonNegativeInteger(row.impressions, 'impressions'),
    clicks: nonNegativeInteger(row.clicks, 'clicks'),
    costMicros: nonNegativeInteger(row.cost_micros, 'cost_micros'),
    purchases: nonNegativeInteger(row.purchases, 'purchases'),
    unitsSold: nonNegativeInteger(row.units_sold, 'units_sold'),
    salesMicros: nonNegativeInteger(row.sales_micros, 'sales_micros'),
  };
}

function bindMetricInsert(insert, store, row) {
  return insert.bind(
    store, row.reportDate, row.adProduct, row.impressions, row.clicks,
    row.costMicros, row.purchases, row.unitsSold, row.salesMicros,
  );
}

function emptyMetricRow(extra) {
  return {
    ...extra,
    impressions: 0,
    clicks: 0,
    costMicros: 0,
    purchases: 0,
    unitsSold: 0,
    salesMicros: 0,
  };
}

function addMetrics(target, source) {
  for (const key of ['impressions', 'clicks', 'costMicros', 'purchases', 'unitsSold', 'salesMicros']) {
    target[key] = safeAdd(target[key], source[key], key);
  }
}

function safeAdd(left, right, field) {
  const value = Number(left) + Number(right);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`rollup_${field}_overflow`);
  return value;
}

function requireDatabases(controlDb, storeDb) {
  if (!controlDb || !storeDb) throw new Error('rollup_database_binding_required');
}

function dateRange(startDate, endDate, maxDays) {
  const start = isoDate(startDate, 'start_date');
  const end = isoDate(endDate, 'end_date');
  if (end < start) throw new Error('rollup_date_range_invalid');
  const days = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > maxDays) throw new Error('rollup_date_range_too_large');
  return { startDate: start, endDate: end, days };
}

function shiftIsoDate(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function requiredText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`rollup_${field}_required`);
  if (text.length > 200) throw new Error(`rollup_${field}_too_long`);
  return text;
}

function isoDate(value, field) {
  const text = requiredText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`rollup_${field}_invalid`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`rollup_${field}_invalid`);
  }
  return text;
}

function normalizeIdentity(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeKeywordTerm(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeKeywordPrefix(value) {
  const prefix = normalizeKeywordTerm(value);
  if (prefix.length > 8) throw new Error('rollup_keyword_prefix_too_long');
  return prefix;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function nonNegativeInteger(value, field) {
  const parsed = Number(value || 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`rollup_${field}_invalid`);
  return parsed;
}

function assertBatchCapacity(statementCount, label) {
  if (!Number.isInteger(statementCount) || statementCount < 1 || statementCount > MAX_BATCH_STATEMENTS) {
    throw new Error(`rollup_${label}_batch_too_large`);
  }
}
