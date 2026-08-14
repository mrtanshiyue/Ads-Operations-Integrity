const MAX_ROLLUP_DAYS = 366;

export async function refreshStoreDailySummary({ controlDb, storeDb, storeId, startDate, endDate }) {
  if (!controlDb || !storeDb) throw new Error('rollup_database_binding_required');
  const store = requiredText(storeId, 'store_id');
  const start = isoDate(startDate, 'start_date');
  const end = isoDate(endDate, 'end_date');
  if (end < start) throw new Error('rollup_date_range_invalid');
  const days = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_ROLLUP_DAYS) throw new Error('rollup_date_range_too_large');

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
  `).bind(start, end).all();

  const rows = (source.results || []).map((row) => ({
    reportDate: String(row.report_date),
    adProduct: String(row.ad_product),
    impressions: nonNegativeInteger(row.impressions, 'impressions'),
    clicks: nonNegativeInteger(row.clicks, 'clicks'),
    costMicros: nonNegativeInteger(row.cost_micros, 'cost_micros'),
    purchases: nonNegativeInteger(row.purchases, 'purchases'),
    unitsSold: nonNegativeInteger(row.units_sold, 'units_sold'),
    salesMicros: nonNegativeInteger(row.sales_micros, 'sales_micros'),
  }));

  const statements = [
    controlDb.prepare(`
      DELETE FROM store_daily_summary
      WHERE store_id = ?1 AND report_date BETWEEN ?2 AND ?3
    `).bind(store, start, end),
  ];

  const insert = controlDb.prepare(`
    INSERT INTO store_daily_summary(
      store_id, report_date, ad_product, impressions, clicks, cost_micros,
      purchases, units_sold, sales_micros, updated_at
    ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP)
  `);
  for (const row of rows) {
    statements.push(insert.bind(
      store,
      row.reportDate,
      row.adProduct,
      row.impressions,
      row.clicks,
      row.costMicros,
      row.purchases,
      row.unitsSold,
      row.salesMicros,
    ));
  }

  await controlDb.batch(statements);
  return {
    storeId: store,
    startDate: start,
    endDate: end,
    days,
    summaryRows: rows.length,
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
  `).bind(
    store,
    state,
    activeRunId,
    lastSuccessAt,
    lastErrorAt,
    lastErrorCode,
    lag,
  ).run();
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

function nonNegativeInteger(value, field) {
  const parsed = Number(value || 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`rollup_${field}_invalid`);
  return parsed;
}
