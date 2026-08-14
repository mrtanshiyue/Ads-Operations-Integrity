const ROLLUP_TYPES = new Set(['store_daily', 'product_daily', 'keyword_window']);
const KEYWORD_WINDOWS = new Set([7, 14, 30, 60, 90, 180, 365]);

export async function observedRollup({ controlDb, metadata, work }) {
  if (!controlDb) throw new Error('rollup_observer_control_db_required');
  if (typeof work !== 'function') throw new Error('rollup_observer_work_required');
  const meta = normalizeMetadata(metadata);
  const runId = crypto.randomUUID();

  await controlDb.prepare(`
    INSERT INTO rollup_runs(
      rollup_run_id, store_id, rollup_type, partition_key,
      start_date, end_date, as_of_date, window_days, status, started_at, created_at
    ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    runId,
    meta.storeId,
    meta.rollupType,
    meta.partitionKey,
    meta.startDate,
    meta.endDate,
    meta.asOfDate,
    meta.windowDays,
  ).run();

  try {
    const result = await work({ rollupRunId: runId });
    const counts = normalizeCounts(result);
    const successDate = meta.endDate || meta.asOfDate || meta.startDate || null;

    await controlDb.batch([
      controlDb.prepare(`
        UPDATE rollup_runs
        SET status = 'succeeded',
            source_rows = ?2,
            summary_rows = ?3,
            unmapped_rows = ?4,
            ambiguous_rows = ?5,
            error_code = NULL,
            completed_at = CURRENT_TIMESTAMP
        WHERE rollup_run_id = ?1 AND status = 'running'
      `).bind(
        runId,
        counts.sourceRows,
        counts.summaryRows,
        counts.unmappedRows,
        counts.ambiguousRows,
      ),
      controlDb.prepare(`
        INSERT INTO rollup_watermarks(
          store_id, rollup_type, partition_key,
          last_success_date, last_success_as_of_date, last_success_run_id,
          summary_rows, unmapped_rows, ambiguous_rows, updated_at
        ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP)
        ON CONFLICT(store_id, rollup_type, partition_key) DO UPDATE SET
          last_success_date = excluded.last_success_date,
          last_success_as_of_date = excluded.last_success_as_of_date,
          last_success_run_id = excluded.last_success_run_id,
          summary_rows = excluded.summary_rows,
          unmapped_rows = excluded.unmapped_rows,
          ambiguous_rows = excluded.ambiguous_rows,
          updated_at = CURRENT_TIMESTAMP
      `).bind(
        meta.storeId,
        meta.rollupType,
        meta.partitionKey,
        meta.rollupType === 'keyword_window' ? null : successDate,
        meta.rollupType === 'keyword_window' ? meta.asOfDate : null,
        runId,
        counts.summaryRows,
        counts.unmappedRows,
        counts.ambiguousRows,
      ),
    ]);

    return { rollupRunId: runId, ...result };
  } catch (error) {
    const code = safeErrorCode(error);
    try {
      await controlDb.prepare(`
        UPDATE rollup_runs
        SET status = 'failed', error_code = ?2, completed_at = CURRENT_TIMESTAMP
        WHERE rollup_run_id = ?1 AND status = 'running'
      `).bind(runId, code).run();
    } catch (recordError) {
      console.error('rollup_failure_record_failed', {
        rollupRunId: runId,
        originalError: error?.message || String(error),
        recordError: recordError?.message || String(recordError),
      });
    }
    throw error;
  }
}

function normalizeMetadata(metadata) {
  const input = metadata && typeof metadata === 'object' ? metadata : {};
  const storeId = requiredText(input.storeId, 'store_id');
  const rollupType = String(input.rollupType || '').trim().toLowerCase();
  if (!ROLLUP_TYPES.has(rollupType)) throw new Error('rollup_observer_type_invalid');
  const partitionKey = String(input.partitionKey || '').trim().slice(0, 120);
  const startDate = optionalDate(input.startDate, 'start_date');
  const endDate = optionalDate(input.endDate, 'end_date');
  const asOfDate = optionalDate(input.asOfDate, 'as_of_date');
  if (startDate && endDate && endDate < startDate) throw new Error('rollup_observer_date_range_invalid');

  let windowDays = null;
  if (input.windowDays !== undefined && input.windowDays !== null) {
    windowDays = Number(input.windowDays);
    if (!KEYWORD_WINDOWS.has(windowDays)) throw new Error('rollup_observer_window_invalid');
  }
  if (rollupType === 'keyword_window' && (!asOfDate || !windowDays)) {
    throw new Error('rollup_observer_keyword_metadata_required');
  }
  return { storeId, rollupType, partitionKey, startDate, endDate, asOfDate, windowDays };
}

function normalizeCounts(result) {
  const value = result && typeof result === 'object' ? result : {};
  return {
    sourceRows: optionalCount(value.sourceRows),
    summaryRows: optionalCount(value.summaryRows),
    unmappedRows: optionalCount(value.unmappedRows) ?? 0,
    ambiguousRows: optionalCount(value.ambiguousRows) ?? 0,
  };
}

function optionalCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('rollup_observer_count_invalid');
  return parsed;
}

function optionalDate(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`rollup_observer_${field}_invalid`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`rollup_observer_${field}_invalid`);
  }
  return text;
}

function requiredText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`rollup_observer_${field}_required`);
  if (text.length > 200) throw new Error(`rollup_observer_${field}_too_long`);
  return text;
}

function safeErrorCode(error) {
  return String(error?.code || error?.name || 'rollup_failed')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 120);
}
