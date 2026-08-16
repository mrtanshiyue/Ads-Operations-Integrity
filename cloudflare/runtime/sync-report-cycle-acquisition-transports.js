import { createR2CreateOnlyRawObjectWriter } from './r2-raw-object-writer.js';
import { SEARCH_TERM_INGESTION_BINDINGS } from './search-term-ingestion-runtime.js';

const AMAZON_TRANSPORT_NAMES = Object.freeze([
  'createReport',
  'pollReport',
  'downloadReport',
]);
const AMAZON_TRANSPORT_NAME_SET = new Set(AMAZON_TRANSPORT_NAMES);

export class CloudflareReportCycleAcquisitionTransportError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareReportCycleAcquisitionTransportError';
    this.code = code;
    this.cause = cause;
  }
}

// Compose caller-supplied Amazon transports with the single concrete R2 write authority.
// The caller may provide only create/poll/download. putRawObject is always derived from the
// bound DATA_BUCKET so one runtime cannot accidentally carry two independent R2 writers.
// Internal jobId context remains inside acquisition; Amazon poll/download transports receive
// only the Amazon report id that is meaningful to the remote API.
export function createCloudflareReportCycleAcquisitionTransportAdapters(options = {}) {
  const { env, amazonTransportAdapters = {} } = options;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new CloudflareReportCycleAcquisitionTransportError(
      'REPORT_CYCLE_ACQUISITION_TRANSPORT_ENV_INVALID',
    );
  }
  const bucket = env[SEARCH_TERM_INGESTION_BINDINGS.dataBucket];
  if (!bucket || typeof bucket.put !== 'function') {
    throw new CloudflareReportCycleAcquisitionTransportError(
      'REPORT_CYCLE_ACQUISITION_DATA_BUCKET_WRITE_BINDING_INVALID',
    );
  }
  if (!amazonTransportAdapters
      || typeof amazonTransportAdapters !== 'object'
      || Array.isArray(amazonTransportAdapters)) {
    throw new CloudflareReportCycleAcquisitionTransportError(
      'REPORT_CYCLE_AMAZON_TRANSPORTS_INVALID',
    );
  }
  if (Object.prototype.hasOwnProperty.call(amazonTransportAdapters, 'putRawObject')) {
    throw new CloudflareReportCycleAcquisitionTransportError(
      'REPORT_CYCLE_TRANSPORT_PUT_AUTHORITY_CONFLICT',
    );
  }

  const unknown = Object.keys(amazonTransportAdapters)
    .filter((name) => !AMAZON_TRANSPORT_NAME_SET.has(name))
    .sort();
  if (unknown.length) {
    throw new CloudflareReportCycleAcquisitionTransportError(
      `REPORT_CYCLE_AMAZON_TRANSPORT_NOT_ALLOWED:${unknown.join(',')}`,
    );
  }

  const result = {};
  for (const name of AMAZON_TRANSPORT_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(amazonTransportAdapters, name)) continue;
    const adapter = amazonTransportAdapters[name];
    if (typeof adapter !== 'function') {
      throw new CloudflareReportCycleAcquisitionTransportError(
        `REPORT_CYCLE_AMAZON_TRANSPORT_INVALID:${name}`,
      );
    }
    if (name === 'pollReport' || name === 'downloadReport') {
      result[name] = async (input) => adapter(requiredReportId(input));
    } else {
      result[name] = adapter;
    }
  }

  try {
    result.putRawObject = createR2CreateOnlyRawObjectWriter({ bucket });
  } catch (error) {
    throw new CloudflareReportCycleAcquisitionTransportError(
      'REPORT_CYCLE_R2_WRITER_BUILD_FAILED',
      error,
    );
  }
  return Object.freeze(result);
}

function requiredReportId(input) {
  const reportId = String(input?.reportId ?? '').trim();
  if (!reportId) {
    throw new CloudflareReportCycleAcquisitionTransportError(
      'REPORT_CYCLE_AMAZON_REPORT_ID_REQUIRED',
    );
  }
  return reportId;
}
