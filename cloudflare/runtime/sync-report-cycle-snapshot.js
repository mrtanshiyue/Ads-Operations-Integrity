import { decideReportCycle } from './sync-report-cycle.js';

export class ReportCycleSnapshotError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'ReportCycleSnapshotError';
    this.code = code;
    this.cause = cause;
  }
}

// Load one read-only durable authority bundle and refuse to schedule anything unless
// the frozen run receipt, membership ledger, and report_jobs set agree exactly.
export async function loadAndDecideReportCycle({ repository, runId }) {
  if (!repository || typeof repository.loadSnapshot !== 'function') {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_REPOSITORY_INVALID');
  }
  const canonicalRunId = requiredText(runId, 'REPORT_CYCLE_SNAPSHOT_RUN_ID_REQUIRED');
  let snapshot;
  try {
    snapshot = await repository.loadSnapshot(canonicalRunId);
  } catch (error) {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_LOAD_FAILED', error);
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_INVALID');
  }

  const run = snapshot.run || null;
  const membership = snapshot.membership;
  const jobs = snapshot.jobs;
  assertFrozenReportCycleSnapshot(run, membership, jobs, canonicalRunId);
  const decision = decideReportCycle(run, jobs);

  return Object.freeze({
    run,
    membership: Object.freeze(membership.slice()),
    jobs: Object.freeze(jobs.slice()),
    decision,
  });
}

export function assertFrozenReportCycleSnapshot(run, membership, jobs, expectedRunId = null) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_RUN_MISSING');
  }
  const runId = requiredText(run.run_id, 'REPORT_CYCLE_SNAPSHOT_RUN_ID_INVALID');
  if (expectedRunId != null && runId !== expectedRunId) {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_RUN_ID_MISMATCH');
  }
  const profileId = requiredText(run.profile_id, 'REPORT_CYCLE_SNAPSHOT_PROFILE_ID_INVALID');
  const fingerprint = String(run.report_plan_fingerprint || '');
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_PLAN_FINGERPRINT_INVALID');
  }
  if (!Number.isSafeInteger(run.report_plan_job_count) || run.report_plan_job_count < 1) {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_PLAN_JOB_COUNT_INVALID');
  }
  if (!Array.isArray(membership)) throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_INVALID');
  if (!Array.isArray(jobs)) throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_JOBS_INVALID');
  if (membership.length !== run.report_plan_job_count) {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_COUNT_MISMATCH');
  }
  if (jobs.length !== run.report_plan_job_count) {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_JOB_COUNT_MISMATCH');
  }

  const membershipByJobId = new Map();
  const membershipIdempotencyKeys = new Set();
  for (const row of membership) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_ROW_INVALID');
    }
    const jobId = requiredText(row.job_id, 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_JOB_ID_INVALID');
    if (membershipByJobId.has(jobId)) {
      throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_DUPLICATE_JOB_ID');
    }
    const idempotencyKey = requiredText(row.idempotency_key, 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_IDEMPOTENCY_KEY_INVALID');
    if (membershipIdempotencyKeys.has(idempotencyKey)) {
      throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_DUPLICATE_IDEMPOTENCY_KEY');
    }
    membershipIdempotencyKeys.add(idempotencyKey);

    if (row.run_id !== runId) throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_RUN_MISMATCH');
    if (row.profile_id !== profileId) throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_PROFILE_MISMATCH');
    if (row.report_plan_fingerprint !== fingerprint) {
      throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_FINGERPRINT_MISMATCH');
    }
    for (const [field, code] of [
      ['dataset_key', 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_DATASET_KEY_INVALID'],
      ['contract_id', 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_CONTRACT_ID_INVALID'],
      ['ad_product', 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_AD_PRODUCT_INVALID'],
      ['report_type', 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_REPORT_TYPE_INVALID'],
      ['start_date', 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_START_DATE_INVALID'],
      ['end_date', 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_END_DATE_INVALID'],
      ['request_fingerprint', 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_REQUEST_FINGERPRINT_INVALID'],
      ['request_json', 'REPORT_CYCLE_SNAPSHOT_MEMBERSHIP_REQUEST_JSON_INVALID'],
    ]) {
      requiredText(row[field], code);
    }
    membershipByJobId.set(jobId, row);
  }

  const seenJobs = new Set();
  for (const job of jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
      throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_JOB_INVALID');
    }
    const jobId = requiredText(job.job_id, 'REPORT_CYCLE_SNAPSHOT_JOB_ID_INVALID');
    if (seenJobs.has(jobId)) throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_DUPLICATE_JOB_ID');
    seenJobs.add(jobId);
    const member = membershipByJobId.get(jobId);
    if (!member) throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_EXTRA_JOB');

    for (const field of [
      'run_id', 'profile_id', 'ad_product', 'report_type', 'start_date', 'end_date',
      'idempotency_key', 'request_fingerprint', 'request_json',
    ]) {
      if (job[field] !== member[field]) {
        throw new ReportCycleSnapshotError(`REPORT_CYCLE_SNAPSHOT_JOB_CONFLICT:${field}`);
      }
    }
  }

  for (const jobId of membershipByJobId.keys()) {
    if (!seenJobs.has(jobId)) throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_MISSING_JOB');
  }
  return true;
}

export function createD1ReportCycleSnapshotRepository(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new ReportCycleSnapshotError('REPORT_CYCLE_SNAPSHOT_DB_INVALID');
  }
  return Object.freeze({
    async loadSnapshot(runId) {
      const canonicalRunId = requiredText(runId, 'REPORT_CYCLE_SNAPSHOT_RUN_ID_REQUIRED');
      const results = await db.batch([
        db.prepare(`
          SELECT run_id, profile_id, status, report_plan_fingerprint, report_plan_job_count
          FROM sync_runs
          WHERE run_id = ?1
          LIMIT 1
        `).bind(canonicalRunId),
        db.prepare(`
          SELECT run_id, job_id, profile_id, report_plan_fingerprint, dataset_key, contract_id,
                 ad_product, report_type, start_date, end_date, idempotency_key,
                 request_fingerprint, request_json
          FROM sync_report_plan_jobs
          WHERE run_id = ?1
          ORDER BY job_id
        `).bind(canonicalRunId),
        db.prepare(`
          SELECT job_id, run_id, profile_id, ad_product, report_type, start_date, end_date,
                 status, idempotency_key, request_fingerprint, request_json,
                 amazon_report_id, amazon_created_at,
                 r2_object_key, content_sha256, content_bytes,
                 r2_initial_version, r2_initial_etag, downloaded_at,
                 raw_row_count, row_count, ingested_at
          FROM report_jobs
          WHERE run_id = ?1
          ORDER BY job_id
        `).bind(canonicalRunId),
      ]);
      return Object.freeze({
        run: results?.[0]?.results?.[0] || null,
        membership: results?.[1]?.results || [],
        jobs: results?.[2]?.results || [],
      });
    },
  });
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ReportCycleSnapshotError(code);
  return text;
}
