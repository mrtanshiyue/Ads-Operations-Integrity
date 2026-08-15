import { canonicalJson } from './canonical-json.js';
import {
  resolveReportContract,
  planReportChunks,
  buildAmazonReportRequest,
  computeRequestFingerprint,
  computeReportAcquisitionIdentity,
} from './amazon-report-contract.js';
import { amazonCreateDecision } from './amazon-producer-state.js';

export class ReportProducerError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'ReportProducerError';
    this.code = code;
    this.cause = cause;
  }
}

export async function planReportJobs({ workflowInstanceId, intent, profile }) {
  const instanceId = requiredText(workflowInstanceId, 'WORKFLOW_INSTANCE_ID_REQUIRED');
  const storeId = requiredText(intent?.storeId, 'STORE_ID_REQUIRED');
  const profileId = requiredText(profile?.profileId, 'PROFILE_ID_REQUIRED');
  const accountType = requiredText(profile?.accountType, 'PROFILE_ACCOUNT_TYPE_REQUIRED').toLowerCase();
  const datasets = Array.isArray(intent?.datasets) ? intent.datasets : [];
  if (!datasets.length) throw new ReportProducerError('SYNC_DATASETS_REQUIRED');

  const jobs = [];
  for (const datasetKey of datasets) {
    const contract = resolveReportContract(datasetKey, accountType);
    const chunks = planReportChunks(intent.startDate, intent.endDate, contract.maxPeriodDays);
    for (const chunk of chunks) {
      const request = buildAmazonReportRequest(contract, chunk);
      const requestFingerprint = await computeRequestFingerprint({ contract, storeId, profileId, chunk });
      const acquisition = await computeReportAcquisitionIdentity({
        workflowInstanceId: instanceId,
        requestFingerprint,
      });
      jobs.push(Object.freeze({
        jobId: acquisition.jobId,
        runId: instanceId,
        datasetKey,
        profileId,
        adProduct: contract.adProduct,
        reportType: contract.reportTypeId,
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        status: 'queued',
        idempotencyKey: acquisition.idempotencyKey,
        requestFingerprint,
        requestJson: canonicalJson(request),
        contractId: contract.contractId,
      }));
    }
  }
  return Object.freeze(jobs);
}

export async function reserveReportJob(repository, plan) {
  await repository.insertQueued(plan);
  const row = await repository.loadByIdempotencyKey(plan.idempotencyKey);
  assertReservedReportJob(row, plan);
  return row;
}

export function assertReservedReportJob(row, plan) {
  if (!row) throw new ReportProducerError('REPORT_JOB_RESERVATION_RECEIPT_MISSING');
  const fields = [
    ['job_id', 'jobId'],
    ['run_id', 'runId'],
    ['profile_id', 'profileId'],
    ['ad_product', 'adProduct'],
    ['report_type', 'reportType'],
    ['start_date', 'startDate'],
    ['end_date', 'endDate'],
    ['idempotency_key', 'idempotencyKey'],
    ['request_fingerprint', 'requestFingerprint'],
    ['request_json', 'requestJson'],
  ];
  for (const [dbField, planField] of fields) {
    if (row[dbField] !== plan[planField]) {
      throw new ReportProducerError(`REPORT_JOB_RESERVATION_CONFLICT:${dbField}`);
    }
  }
  return true;
}

// Call this function inside one Workflow step.do callback. It deliberately never retries createReport.
export async function createAmazonReportOnce({ repository, jobId, createReport, now }) {
  let job = await repository.loadByJobId(jobId);
  const initialDecision = amazonCreateDecision(job);
  if (initialDecision === 'REUSE_AMAZON_REPORT' || initialDecision === 'TERMINAL') return job;
  if (initialDecision !== 'ARM_AND_CREATE_ONCE') throw new ReportProducerError('AMAZON_REPORT_CREATE_DECISION_INVALID');

  // Only the callback that wins queued -> requested CAS owns the one POST authority.
  const armedByThisCallback = await repository.armCreate(jobId);
  job = await repository.loadByJobId(jobId);
  if (!armedByThisCallback) {
    // Another callback may have armed or completed it. Never assume ownership of POST authority.
    return resolveLostCreateArmRace(job);
  }
  if (job?.status !== 'requested' || job?.amazon_report_id != null) {
    throw new ReportProducerError('AMAZON_REPORT_CREATE_ARM_RECEIPT_INVALID');
  }

  let response;
  try {
    response = await createReport(JSON.parse(job.request_json));
  } catch (error) {
    // Keep requested + NULL report id. A retry will fail closed as ambiguous and MUST NOT POST again.
    throw new ReportProducerError('AMAZON_REPORT_CREATE_OUTCOME_UNKNOWN', error);
  }

  const amazonReportId = requiredText(response?.reportId, 'AMAZON_REPORT_ID_INVALID');
  const amazonCreatedAt = requiredText(response?.createdAt || now, 'AMAZON_REPORT_CREATED_AT_REQUIRED');
  await repository.persistAmazonReportReceipt(jobId, amazonReportId, amazonCreatedAt);
  job = await repository.loadByJobId(jobId);
  if (job?.status !== 'processing' || job?.amazon_report_id !== amazonReportId) {
    throw new ReportProducerError('AMAZON_REPORT_CREATE_RECEIPT_PERSIST_FAILED');
  }
  return job;
}

function resolveLostCreateArmRace(job) {
  const decision = amazonCreateDecision(job);
  if (decision === 'REUSE_AMAZON_REPORT' || decision === 'TERMINAL') return job;
  // requested + NULL throws AMAZON_REPORT_CREATE_AMBIGUOUS here by design.
  throw new ReportProducerError('AMAZON_REPORT_CREATE_ARM_NOT_OWNED');
}

export function createD1ReportJobRepository(db) {
  return {
    async insertQueued(plan) {
      await db.prepare(`
        INSERT INTO report_jobs(
          job_id, run_id, profile_id, ad_product, report_type, start_date, end_date,
          status, idempotency_key, request_fingerprint, request_json, created_at, updated_at
        ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9, ?10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(idempotency_key) DO NOTHING
      `).bind(
        plan.jobId, plan.runId, plan.profileId, plan.adProduct, plan.reportType,
        plan.startDate, plan.endDate, plan.idempotencyKey, plan.requestFingerprint, plan.requestJson,
      ).run();
    },

    async loadByIdempotencyKey(idempotencyKey) {
      return db.prepare(`${REPORT_JOB_SELECT} WHERE idempotency_key = ?1 LIMIT 1`).bind(idempotencyKey).first();
    },

    async loadByJobId(jobId) {
      return db.prepare(`${REPORT_JOB_SELECT} WHERE job_id = ?1 LIMIT 1`).bind(jobId).first();
    },

    async armCreate(jobId) {
      const result = await db.prepare(`
        UPDATE report_jobs
        SET status = 'requested', updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?1 AND status = 'queued' AND amazon_report_id IS NULL
      `).bind(jobId).run();
      return Number(result?.meta?.changes || 0) === 1;
    },

    async persistAmazonReportReceipt(jobId, amazonReportId, amazonCreatedAt) {
      await db.prepare(`
        UPDATE report_jobs
        SET amazon_report_id = ?2,
            amazon_created_at = ?3,
            status = 'processing',
            updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?1 AND status = 'requested' AND amazon_report_id IS NULL
      `).bind(jobId, amazonReportId, amazonCreatedAt).run();
    },

    async markReady(jobId) {
      await db.prepare(`
        UPDATE report_jobs
        SET status = 'ready', updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?1 AND status = 'processing' AND amazon_report_id IS NOT NULL
      `).bind(jobId).run();
      return this.loadByJobId(jobId);
    },

    async persistRawExpectedAuthority(jobId, { r2ObjectKey, contentSha256, contentBytes }) {
      await db.prepare(`
        UPDATE report_jobs
        SET r2_object_key = ?2,
            content_sha256 = ?3,
            content_bytes = ?4,
            updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?1
          AND status = 'ready'
          AND (r2_object_key IS NULL OR r2_object_key = ?2)
          AND (content_sha256 IS NULL OR content_sha256 = ?3)
          AND (content_bytes IS NULL OR content_bytes = ?4)
      `).bind(jobId, r2ObjectKey, contentSha256, contentBytes).run();
      return this.loadByJobId(jobId);
    },

    async persistInitialR2Receipt(jobId, { r2InitialVersion, r2InitialEtag, downloadedAt }) {
      await db.prepare(`
        UPDATE report_jobs
        SET r2_initial_version = ?2,
            r2_initial_etag = ?3,
            downloaded_at = ?4,
            status = 'downloaded',
            updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?1
          AND status = 'ready'
          AND r2_object_key IS NOT NULL
          AND content_sha256 IS NOT NULL
          AND content_bytes IS NOT NULL
      `).bind(jobId, r2InitialVersion, r2InitialEtag, downloadedAt).run();
      return this.loadByJobId(jobId);
    },

    async persistRawRowCount(jobId, rawRowCount) {
      await db.prepare(`
        UPDATE report_jobs
        SET raw_row_count = ?2, updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?1
          AND status = 'downloaded'
          AND (raw_row_count IS NULL OR raw_row_count = ?2)
      `).bind(jobId, rawRowCount).run();
      return this.loadByJobId(jobId);
    },
  };
}

const REPORT_JOB_SELECT = `
  SELECT job_id, run_id, profile_id, amazon_report_id, ad_product, report_type,
         start_date, end_date, status, idempotency_key, request_fingerprint, request_json,
         r2_object_key, content_sha256, content_bytes, r2_initial_version, r2_initial_etag,
         raw_row_count, row_count, amazon_created_at, downloaded_at, ingested_at,
         error_code, error_message, created_at, updated_at
  FROM report_jobs
`;

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ReportProducerError(code);
  return text;
}
