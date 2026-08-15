import { createD1ReportCycleSnapshotRepository } from './sync-report-cycle-snapshot.js';
import { createReportCycleIngestionAdapter } from './sync-report-cycle-ingestion-adapter.js';
import {
  createCloudflareSearchTermIngestionRuntime,
  SEARCH_TERM_INGESTION_BINDINGS,
} from './search-term-ingestion-runtime.js';

export class CloudflareReportCycleIngestionFactoryError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareReportCycleIngestionFactoryError';
    this.code = code;
    this.cause = cause;
  }
}

// Compose the frozen-plan ingestion freshness boundary with the concrete Cloudflare
// search-term ingestion runtime. Both snapshot authority and durable ingestion state
// use the exact same STORE_01_DB binding; raw content remains reachable only through
// the GET-only DATA_BUCKET reader owned by the lower ingestion runtime.
export function createCloudflareReportCycleIngestionAdapter(options = {}) {
  const {
    env,
    maxCompressedBytes,
    maxDecompressedBytes,
    now,
  } = options;

  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new CloudflareReportCycleIngestionFactoryError('REPORT_CYCLE_INGESTION_ENV_INVALID');
  }

  const db = env[SEARCH_TERM_INGESTION_BINDINGS.storeDb];
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new CloudflareReportCycleIngestionFactoryError('REPORT_CYCLE_INGESTION_STORE_DB_BINDING_INVALID');
  }

  let snapshotRepository;
  let ingestionRuntime;
  try {
    snapshotRepository = createD1ReportCycleSnapshotRepository(db);
    ingestionRuntime = createCloudflareSearchTermIngestionRuntime({
      env,
      maxCompressedBytes,
      maxDecompressedBytes,
      now,
    });
  } catch (error) {
    throw new CloudflareReportCycleIngestionFactoryError(
      'REPORT_CYCLE_INGESTION_DEPENDENCY_BUILD_FAILED',
      error,
    );
  }

  try {
    return createReportCycleIngestionAdapter({ snapshotRepository, ingestionRuntime });
  } catch (error) {
    throw new CloudflareReportCycleIngestionFactoryError(
      'REPORT_CYCLE_INGESTION_ADAPTER_BUILD_FAILED',
      error,
    );
  }
}
