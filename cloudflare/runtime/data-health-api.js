export async function handleDataHealthApiRoute({ request, env, actor, url }) {
  if (request.method !== 'GET' || url.pathname !== '/api/v1/analytics/data-health') return null;

  const storeIds = await accessibleStoreIds(env.CONTROL_DB, actor.user_id);
  if (!storeIds.length) return json(request, { error: 'forbidden', permission: 'analytics.read' }, 403);

  const requestedStoreId = optionalText(url.searchParams.get('storeId'), 200);
  const scopedStoreIds = requestedStoreId
    ? (storeIds.includes(requestedStoreId) ? [requestedStoreId] : [])
    : storeIds;
  if (!scopedStoreIds.length) return json(request, { error: 'store_scope_forbidden' }, 403);

  const placeholders = scopedStoreIds.map((_, index) => `?${index + 1}`).join(',');
  const [stores, watermarks, failures] = await Promise.all([
    env.CONTROL_DB.prepare(`
      SELECT s.store_id, s.store_code, s.display_name, s.status,
             ss.sync_status, ss.active_run_id, ss.last_success_at, ss.last_error_at,
             ss.last_error_code, ss.lag_minutes, ss.updated_at AS sync_updated_at
      FROM stores s
      LEFT JOIN store_sync_status ss ON ss.store_id = s.store_id
      WHERE s.store_id IN (${placeholders})
      ORDER BY s.sort_order, s.store_code
    `).bind(...scopedStoreIds).all(),
    env.CONTROL_DB.prepare(`
      SELECT store_id, rollup_type, partition_key,
             last_success_date, last_success_as_of_date, last_success_run_id,
             summary_rows, unmapped_rows, ambiguous_rows, updated_at
      FROM rollup_watermarks
      WHERE store_id IN (${placeholders})
      ORDER BY store_id, rollup_type, partition_key
    `).bind(...scopedStoreIds).all(),
    env.CONTROL_DB.prepare(`
      SELECT store_id, rollup_type, partition_key, error_code, started_at, completed_at
      FROM rollup_runs
      WHERE store_id IN (${placeholders}) AND status = 'failed'
      ORDER BY started_at DESC
      LIMIT 50
    `).bind(...scopedStoreIds).all(),
  ]);

  const watermarkByStore = {};
  for (const row of watermarks.results || []) {
    if (!watermarkByStore[row.store_id]) watermarkByStore[row.store_id] = [];
    watermarkByStore[row.store_id].push({
      rollupType: row.rollup_type,
      partitionKey: row.partition_key || '',
      lastSuccessDate: row.last_success_date || null,
      lastSuccessAsOfDate: row.last_success_as_of_date || null,
      lastSuccessRunId: row.last_success_run_id || null,
      summaryRows: nullableNumber(row.summary_rows),
      unmappedRows: number(row.unmapped_rows),
      ambiguousRows: number(row.ambiguous_rows),
      updatedAt: row.updated_at || null,
    });
  }

  return json(request, {
    generatedAt: new Date().toISOString(),
    stores: (stores.results || []).map((row) => ({
      storeId: row.store_id,
      storeCode: row.store_code,
      displayName: row.display_name,
      storeStatus: row.status,
      sync: {
        status: row.sync_status || 'never',
        activeRunId: row.active_run_id || null,
        lastSuccessAt: row.last_success_at || null,
        lastErrorAt: row.last_error_at || null,
        lastErrorCode: row.last_error_code || null,
        lagMinutes: nullableNumber(row.lag_minutes),
        updatedAt: row.sync_updated_at || null,
      },
      rollups: watermarkByStore[row.store_id] || [],
    })),
    recentRollupFailures: (failures.results || []).map((row) => ({
      storeId: row.store_id,
      rollupType: row.rollup_type,
      partitionKey: row.partition_key || '',
      errorCode: row.error_code || null,
      startedAt: row.started_at,
      completedAt: row.completed_at || null,
    })),
  }, 200);
}

async function accessibleStoreIds(db, userId) {
  const global = await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id = ?1 AND rp.permission_key = 'analytics.read'
    LIMIT 1
  `).bind(userId).first();
  if (global) {
    const result = await db.prepare(`
      SELECT store_id FROM stores WHERE status = 'active' ORDER BY sort_order, store_id
    `).all();
    return (result.results || []).map((row) => row.store_id);
  }

  const result = await db.prepare(`
    SELECT DISTINCT sm.store_id
    FROM store_members sm
    JOIN role_permissions rp ON rp.role_key = sm.role_key
    JOIN stores s ON s.store_id = sm.store_id
    WHERE sm.user_id = ?1 AND rp.permission_key = 'analytics.read' AND s.status = 'active'
    ORDER BY sm.store_id
  `).bind(userId).all();
  return (result.results || []).map((row) => row.store_id);
}

function optionalText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length <= maxLength ? text : null;
}
function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
