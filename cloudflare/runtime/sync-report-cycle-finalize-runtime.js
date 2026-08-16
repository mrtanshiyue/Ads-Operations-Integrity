import { createD1ReportCycleSnapshotRepository } from './sync-report-cycle-snapshot.js';
import { createD1SyncRunCompletionRepository } from './sync-run-completion.js';
import { createReportCycleFinalizeAdapter } from './sync-report-cycle-finalize-adapter.js';
import { SEARCH_TERM_INGESTION_BINDINGS } from './search-term-ingestion-runtime.js';

export class CloudflareReportCycleFinalizeFactoryError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareReportCycleFinalizeFactoryError';
    this.code = code;
    this.cause = cause;
  }
}

// Bind finalization to the same Store D1 authority used by frozen report-plan snapshots.
// The completion timestamp is resolved per invocation so a long-lived Worker isolate never
// reuses a stale timestamp captured at factory construction time.
export function createCloudflareReportCycleFinalizeAdapter(options = {}) {
  const { env, now } = options;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new CloudflareReportCycleFinalizeFactoryError('REPORT_CYCLE_FINALIZE_ENV_INVALID');
  }

  const db = env[SEARCH_TERM_INGESTION_BINDINGS.storeDb];
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new CloudflareReportCycleFinalizeFactoryError('REPORT_CYCLE_FINALIZE_STORE_DB_BINDING_INVALID');
  }
  if (typeof now !== 'function' && !requiredTextOrNull(now)) {
    throw new CloudflareReportCycleFinalizeFactoryError('REPORT_CYCLE_FINALIZE_NOW_INVALID');
  }

  const snapshotRepository = createD1ReportCycleSnapshotRepository(db);
  const completionRepository = createD1SyncRunCompletionRepository(db);

  return async function finalizeRun(input) {
    const completedAt = resolveNow(now);
    let adapter;
    try {
      adapter = createReportCycleFinalizeAdapter({
        snapshotRepository,
        completionRepository,
        completedAt,
      });
    } catch (error) {
      throw new CloudflareReportCycleFinalizeFactoryError(
        'REPORT_CYCLE_FINALIZE_ADAPTER_BUILD_FAILED',
        error,
      );
    }
    return adapter(input);
  };
}

function resolveNow(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : now;
  } catch (error) {
    throw new CloudflareReportCycleFinalizeFactoryError('REPORT_CYCLE_FINALIZE_NOW_FAILED', error);
  }
  const text = requiredTextOrNull(value);
  if (!text) throw new CloudflareReportCycleFinalizeFactoryError('REPORT_CYCLE_FINALIZE_NOW_INVALID');
  return text;
}

function requiredTextOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
