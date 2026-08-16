import { createD1ReportJobRepository } from './amazon-report-producer.js';
import { createReportCycleAcquisitionAdapters } from './sync-report-cycle-acquisition-adapter.js';
import { SEARCH_TERM_INGESTION_BINDINGS } from './search-term-ingestion-runtime.js';

const TRANSPORT_NAMES = Object.freeze([
  'createReport',
  'pollReport',
  'downloadReport',
  'putRawObject',
]);
const TRANSPORT_NAME_SET = new Set(TRANSPORT_NAMES);

export class CloudflareReportCycleAcquisitionFactoryError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareReportCycleAcquisitionFactoryError';
    this.code = code;
    this.cause = cause;
  }
}

// Bind the verified acquisition freshness adapter to the concrete Store D1 repository.
// Amazon HTTP/download and R2 PUT remain explicit transport injections; this factory creates
// no network client and performs no R2 write on its own.
export function createCloudflareReportCycleAcquisitionAdapters(options = {}) {
  const {
    env,
    storeCode,
    transportAdapters = {},
    maxCompressedBytes,
    now,
  } = options;

  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new CloudflareReportCycleAcquisitionFactoryError('REPORT_CYCLE_ACQUISITION_ENV_INVALID');
  }
  const db = env[SEARCH_TERM_INGESTION_BINDINGS.storeDb];
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new CloudflareReportCycleAcquisitionFactoryError(
      'REPORT_CYCLE_ACQUISITION_STORE_DB_BINDING_INVALID',
    );
  }
  const canonicalStoreCode = requiredText(
    storeCode,
    'REPORT_CYCLE_ACQUISITION_STORE_CODE_REQUIRED',
  );
  if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes <= 0) {
    throw new CloudflareReportCycleAcquisitionFactoryError(
      'REPORT_CYCLE_ACQUISITION_COMPRESSED_SIZE_POLICY_INVALID',
    );
  }
  if (typeof now !== 'function' && !requiredTextOrNull(now)) {
    throw new CloudflareReportCycleAcquisitionFactoryError('REPORT_CYCLE_ACQUISITION_NOW_INVALID');
  }

  const transports = validateTransports(transportAdapters);
  const repository = createD1ReportJobRepository(db);

  const invoke = async (method, input) => {
    let adapters;
    try {
      adapters = createReportCycleAcquisitionAdapters({
        repository,
        storeCode:canonicalStoreCode,
        acquisitionAdapters:transports,
        maxCompressedBytes,
        now:resolveNow(now),
      });
    } catch (error) {
      throw new CloudflareReportCycleAcquisitionFactoryError(
        'REPORT_CYCLE_ACQUISITION_ADAPTER_BUILD_FAILED',
        error,
      );
    }
    return adapters[method](input);
  };

  return Object.freeze({
    async createAmazonReport(input) {
      return invoke('createAmazonReport', input);
    },
    async pollAmazonReport(input) {
      return invoke('pollAmazonReport', input);
    },
    async materializeRawObject(input) {
      return invoke('materializeRawObject', input);
    },
  });
}

function validateTransports(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudflareReportCycleAcquisitionFactoryError(
      'REPORT_CYCLE_ACQUISITION_TRANSPORTS_INVALID',
    );
  }
  const unknown = Object.keys(value).filter((name) => !TRANSPORT_NAME_SET.has(name)).sort();
  if (unknown.length) {
    throw new CloudflareReportCycleAcquisitionFactoryError(
      `REPORT_CYCLE_ACQUISITION_TRANSPORT_NOT_ALLOWED:${unknown.join(',')}`,
    );
  }
  const result = {};
  for (const name of TRANSPORT_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    if (typeof value[name] !== 'function') {
      throw new CloudflareReportCycleAcquisitionFactoryError(
        `REPORT_CYCLE_ACQUISITION_TRANSPORT_INVALID:${name}`,
      );
    }
    result[name] = value[name];
  }
  return Object.freeze(result);
}

function resolveNow(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : now;
  } catch (error) {
    throw new CloudflareReportCycleAcquisitionFactoryError(
      'REPORT_CYCLE_ACQUISITION_NOW_FAILED',
      error,
    );
  }
  return requiredText(value, 'REPORT_CYCLE_ACQUISITION_NOW_INVALID');
}

function requiredTextOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function requiredText(value, code) {
  const text = requiredTextOrNull(value);
  if (!text) throw new CloudflareReportCycleAcquisitionFactoryError(code);
  return text;
}
