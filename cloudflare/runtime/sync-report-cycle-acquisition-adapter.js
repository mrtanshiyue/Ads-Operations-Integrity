import { advanceReportAcquisitionOnce } from './amazon-report-acquisition.js';

const DIRECTIVES = Object.freeze({
  CREATE_AMAZON_REPORT:Object.freeze({ adapterName:'createAmazonReport', expectedStatus:'queued' }),
  POLL_AMAZON_REPORT:Object.freeze({ adapterName:'pollAmazonReport', expectedStatus:'processing' }),
  MATERIALIZE_RAW_OBJECT:Object.freeze({ adapterName:'materializeRawObject', expectedStatus:'ready' }),
});

export class ReportCycleAcquisitionAdapterError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'ReportCycleAcquisitionAdapterError';
    this.code = code;
    this.cause = cause;
  }
}

// Compose the directive executor with the existing acquisition state machine without
// letting a stale directive silently execute whatever durable status happens to exist now.
// The first load performed inside advanceReportAcquisitionOnce is guarded before any
// Amazon/R2 adapter can be reached; subsequent loads remain available for receipt/CAS checks.
export function createReportCycleAcquisitionAdapters({
  repository,
  storeCode,
  acquisitionAdapters,
  maxCompressedBytes,
  now,
}) {
  if (!repository || typeof repository.loadByJobId !== 'function') {
    throw new ReportCycleAcquisitionAdapterError('REPORT_CYCLE_ACQUISITION_REPOSITORY_INVALID');
  }
  const canonicalStoreCode = requiredText(storeCode, 'REPORT_CYCLE_ACQUISITION_STORE_CODE_REQUIRED');

  const execute = async (input, directive) => {
    const spec = DIRECTIVES[directive];
    assertDirectiveInput(input, directive, spec.expectedStatus);
    let guardedLoadObserved = false;

    const guardedRepository = new Proxy(repository, {
      get(target, property) {
        if (property === 'loadByJobId') {
          return async (jobId) => {
            const job = await target.loadByJobId(jobId);
            if (!guardedLoadObserved) {
              guardedLoadObserved = true;
              if (jobId !== input.jobId) {
                throw new ReportCycleAcquisitionAdapterError('REPORT_CYCLE_ACQUISITION_JOB_ID_CONFLICT');
              }
              if (!job) throw new ReportCycleAcquisitionAdapterError('REPORT_CYCLE_ACQUISITION_JOB_MISSING');
              if (job.job_id !== input.jobId) {
                throw new ReportCycleAcquisitionAdapterError('REPORT_CYCLE_ACQUISITION_JOB_RECEIPT_CONFLICT');
              }
              if (job.run_id !== input.runId) {
                throw new ReportCycleAcquisitionAdapterError('REPORT_CYCLE_ACQUISITION_RUN_CONFLICT');
              }
              if (job.status !== spec.expectedStatus) {
                throw new ReportCycleAcquisitionAdapterError(
                  `REPORT_CYCLE_ACQUISITION_STATUS_STALE:${spec.expectedStatus}:${String(job.status || 'empty')}`,
                );
              }
            }
            return job;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    let result;
    try {
      result = await advanceReportAcquisitionOnce({
        repository:guardedRepository,
        jobId:input.jobId,
        storeCode:canonicalStoreCode,
        adapters:acquisitionAdapters,
        maxCompressedBytes,
        now,
      });
    } catch (error) {
      if (error instanceof ReportCycleAcquisitionAdapterError) throw error;
      throw new ReportCycleAcquisitionAdapterError(
        `REPORT_CYCLE_ACQUISITION_EXECUTION_FAILED:${directive}`,
        error,
      );
    }
    if (!guardedLoadObserved) {
      throw new ReportCycleAcquisitionAdapterError('REPORT_CYCLE_ACQUISITION_GUARDED_LOAD_MISSING');
    }
    return result;
  };

  return Object.freeze({
    async createAmazonReport(input) {
      return execute(input, 'CREATE_AMAZON_REPORT');
    },
    async pollAmazonReport(input) {
      return execute(input, 'POLL_AMAZON_REPORT');
    },
    async materializeRawObject(input) {
      return execute(input, 'MATERIALIZE_RAW_OBJECT');
    },
  });
}

function assertDirectiveInput(input, directive, expectedStatus) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ReportCycleAcquisitionAdapterError('REPORT_CYCLE_ACQUISITION_INPUT_INVALID');
  }
  requiredText(input.runId, 'REPORT_CYCLE_ACQUISITION_RUN_ID_REQUIRED');
  requiredText(input.jobId, 'REPORT_CYCLE_ACQUISITION_JOB_ID_REQUIRED');
  if (input.directive !== directive) {
    throw new ReportCycleAcquisitionAdapterError('REPORT_CYCLE_ACQUISITION_DIRECTIVE_CONFLICT');
  }
  if (input.expectedStatus !== expectedStatus) {
    throw new ReportCycleAcquisitionAdapterError('REPORT_CYCLE_ACQUISITION_EXPECTED_STATUS_CONFLICT');
  }
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ReportCycleAcquisitionAdapterError(code);
  return text;
}
