import { createD1ReportCycleSnapshotRepository } from './sync-report-cycle-snapshot.js';
import { createCloudflareReportCycleIngestionAdapter } from './sync-report-cycle-ingestion-runtime.js';
import { createCloudflareReportCycleFinalizeAdapter } from './sync-report-cycle-finalize-runtime.js';
import { createCloudflareReportCycleAcquisitionAdapters } from './sync-report-cycle-acquisition-runtime.js';
import { createCloudflareReportCycleAcquisitionTransportAdapters } from './sync-report-cycle-acquisition-transports.js';
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

// Compose the verified Cloudflare snapshot/ingestion/finalization boundaries. Acquisition
// may come from exactly one authority level:
//   1. executor-level acquisitionAdapters,
//   2. full low-level acquisitionTransportAdapters (compatibility path), or
//   3. Amazon-only amazonTransportAdapters, with putRawObject derived from DATA_BUCKET.
// In all cases AMAZON_ADS_ENABLED remains the per-invocation execution capability gate.
export function createCloudflareReportCycleRuntime(options = {}) {
  const {
    env,
    acquisitionAdapters,
    acquisitionTransportAdapters,
    amazonTransportAdapters,
    storeCode,
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

  const hasBuiltAdapters = acquisitionAdapters !== undefined && acquisitionAdapters !== null;
  const hasTransportAdapters = acquisitionTransportAdapters !== undefined
    && acquisitionTransportAdapters !== null;
  const hasAmazonTransports = amazonTransportAdapters !== undefined
    && amazonTransportAdapters !== null;
  const sourceCount = Number(hasBuiltAdapters) + Number(hasTransportAdapters) + Number(hasAmazonTransports);
  if (sourceCount > 1) {
    throw new CloudflareReportCycleRuntimeFactoryError(
      'CLOUDFLARE_REPORT_CYCLE_ACQUISITION_SOURCE_CONFLICT',
    );
  }
  if (hasBuiltAdapters
      && (!acquisitionAdapters || typeof acquisitionAdapters !== 'object'
        || Array.isArray(acquisitionAdapters))) {
    throw new CloudflareReportCycleRuntimeFactoryError(
      'CLOUDFLARE_REPORT_CYCLE_ACQUISITION_ADAPTERS_INVALID',
    );
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

    let resolvedAcquisitionAdapters = hasBuiltAdapters ? acquisitionAdapters : {};
    let resolvedTransports = null;
    if (hasTransportAdapters) {
      resolvedTransports = acquisitionTransportAdapters;
    } else if (hasAmazonTransports) {
      resolvedTransports = createCloudflareReportCycleAcquisitionTransportAdapters({
        env,
        amazonTransportAdapters,
      });
    }
    if (resolvedTransports) {
      resolvedAcquisitionAdapters = createCloudflareReportCycleAcquisitionAdapters({
        env,
        storeCode,
        transportAdapters:resolvedTransports,
        maxCompressedBytes,
        now,
      });
    }
    guardedAcquisitionAdapters = createReportCycleAcquisitionCapabilityGate({
      env,
      adapters:resolvedAcquisitionAdapters,
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
