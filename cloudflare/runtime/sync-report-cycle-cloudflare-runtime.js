import { createD1ReportCycleSnapshotRepository } from './sync-report-cycle-snapshot.js';
import { createCloudflareReportCycleIngestionAdapter } from './sync-report-cycle-ingestion-runtime.js';
import { createCloudflareReportCycleFinalizeAdapter } from './sync-report-cycle-finalize-runtime.js';
import { createReportCycleRuntime } from './sync-report-cycle-runtime.js';
import { createReportCycleAcquisitionCapabilityGate } from './sync-report-cycle-acquisition-capability.js';
import { SEARCH_TERM_INGESTION_BINDINGS } from './search-term-ingestion-runtime.js';

export class CloudflareReportCycleRuntimeFactoryError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareReportCycleRuntimeFactoryError';
    this.code = code;
    this.cause = cause;
  }
}

// Compose the verified Cloudflare read/ingestion/finalization boundaries without
// introducing any Amazon or R2 write transport. Acquisition remains explicitly
// adapter-injected and is additionally guarded by both runtime kill switches before
// every delegate call. Missing adapters remain missing and therefore fail closed.
export function createCloudflareReportCycleRuntime(options = {}) {
  const {
    env,
    acquisitionAdapters = {},
    maxCompressedBytes,
    maxDecompressedBytes,
    now,
  } = options;

  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new CloudflareReportCycleRuntimeFactoryError('CLOUDFLARE_REPORT_CYCLE_ENV_INVALID');
  }
  const db = env[SEARCH_TERM_INGESTION_BINDINGS.storeDb];
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new CloudflareReportCycleRuntimeFactoryError('CLOUDFLARE_REPORT_CYCLE_STORE_DB_BINDING_INVALID');
  }
  if (!acquisitionAdapters || typeof acquisitionAdapters !== 'object' || Array.isArray(acquisitionAdapters)) {
    throw new CloudflareReportCycleRuntimeFactoryError('CLOUDFLARE_REPORT_CYCLE_ACQUISITION_ADAPTERS_INVALID');
  }

  let snapshotRepository;
  let ingestionAdapter;
  let finalizeRun;
  let guardedAcquisitionAdapters;
  try {
    snapshotRepository = createD1ReportCycleSnapshotRepository(db);
    ingestionAdapter = createCloudflareReportCycleIngestionAdapter({
      env,
      maxCompressedBytes,
      maxDecompressedBytes,
      now,
    });
    finalizeRun = createCloudflareReportCycleFinalizeAdapter({ env, now });
    guardedAcquisitionAdapters = createReportCycleAcquisitionCapabilityGate({
      env,
      adapters:acquisitionAdapters,
    });
  } catch (error) {
    throw new CloudflareReportCycleRuntimeFactoryError(
      'CLOUDFLARE_REPORT_CYCLE_DEPENDENCY_BUILD_FAILED',
      error,
    );
  }

  try {
    return createReportCycleRuntime({
      snapshotRepository,
      acquisitionAdapters:guardedAcquisitionAdapters,
      ingestionAdapter,
      finalizeRun,
    });
  } catch (error) {
    throw new CloudflareReportCycleRuntimeFactoryError(
      'CLOUDFLARE_REPORT_CYCLE_RUNTIME_BUILD_FAILED',
      error,
    );
  }
}
