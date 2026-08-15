import { canonicalJson } from './canonical-json.js';

const NONTERMINAL_REPORT_STATUSES = new Set(['queued','requested','processing','ready','downloaded']);
const TERMINAL_REPORT_STATUSES = new Set(['ingested','failed','cancelled']);
const FINAL_RUN_STATUSES = new Set(['succeeded','partial','failed']);

export class SyncRunCompletionError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'SyncRunCompletionError';
    this.code = code;
    this.cause = cause;
  }
}

export function evaluateReportPlanCompletion(run, jobs) {
  assertRunningPlanReceipt(run);
  if (!Array.isArray(jobs)) throw new SyncRunCompletionError('SYNC_COMPLETION_JOBS_INVALID');
  if (jobs.length !== run.report_plan_job_count) throw new SyncRunCompletionError('SYNC_COMPLETION_JOB_COUNT_MISMATCH');

  const counts = { ingested:0, failed:0, cancelled:0, nonterminal:0 };
  for (const job of jobs) {
    if (job?.run_id !== run.run_id) throw new SyncRunCompletionError('SYNC_COMPLETION_JOB_RUN_MISMATCH');
    if (job?.profile_id !== run.profile_id) throw new SyncRunCompletionError('SYNC_COMPLETION_JOB_PROFILE_MISMATCH');
    const status = String(job?.status || '');
    if (NONTERMINAL_REPORT_STATUSES.has(status)) {
      counts.nonterminal += 1;
      continue;
    }
    if (!TERMINAL_REPORT_STATUSES.has(status)) throw new SyncRunCompletionError(`SYNC_COMPLETION_JOB_STATUS_INVALID:${status || 'empty'}`);
    counts[status] += 1;
  }

  const stats = Object.freeze({
    schemaVersion:'sync-report-plan-completion-v1',
    reportPlanFingerprint:run.report_plan_fingerprint,
    jobCount:run.report_plan_job_count,
    ingestedCount:counts.ingested,
    failedCount:counts.failed,
    cancelledCount:counts.cancelled,
  });

  if (counts.nonterminal > 0) {
    return Object.freeze({ decision:'WAITING', stats, statsJson:canonicalJson(stats), errorSummary:null });
  }

  if (counts.ingested === run.report_plan_job_count) {
    return Object.freeze({ decision:'FINALIZE', status:'succeeded', stats, statsJson:canonicalJson(stats), errorSummary:null });
  }
  if (counts.ingested > 0) {
    return Object.freeze({
      decision:'FINALIZE', status:'partial', stats, statsJson:canonicalJson(stats),
      errorSummary:'REPORT_PLAN_PARTIAL_FAILURE',
    });
  }
  return Object.freeze({
    decision:'FINALIZE', status:'failed', stats, statsJson:canonicalJson(stats),
    errorSummary:'REPORT_PLAN_FAILED',
  });
}

export async function finalizeReportPlanRunOnce({ repository, runId, completedAt }) {
  requireRepository(repository);
  const canonicalRunId = requiredText(runId, 'SYNC_RUN_ID_REQUIRED');
  let run = await repository.loadRun(canonicalRunId);
  if (!run) throw new SyncRunCompletionError('SYNC_RUN_RECEIPT_MISSING');

  if (FINAL_RUN_STATUSES.has(run.status)) {
    assertExistingTerminalReceipt(run);
    return Object.freeze({ reused:true, finalized:true, run });
  }
  if (run.status !== 'running') throw new SyncRunCompletionError('SYNC_COMPLETION_RUN_NOT_RUNNING');

  const jobs = await repository.listJobs(canonicalRunId);
  const evaluation = evaluateReportPlanCompletion(run, jobs);
  if (evaluation.decision === 'WAITING') {
    return Object.freeze({ reused:false, finalized:false, run, evaluation });
  }

  await repository.persistTerminalReceipt({
    runId:canonicalRunId,
    reportPlanFingerprint:run.report_plan_fingerprint,
    reportPlanJobCount:run.report_plan_job_count,
    status:evaluation.status,
    statsJson:evaluation.statsJson,
    errorSummary:evaluation.errorSummary,
    completedAt:requiredText(completedAt, 'SYNC_COMPLETION_TIMESTAMP_REQUIRED'),
  });

  run = await repository.loadRun(canonicalRunId);
  assertCommittedTerminalReceipt(run, evaluation);
  return Object.freeze({ reused:false, finalized:true, run, evaluation });
}

export function createD1SyncRunCompletionRepository(db) {
  return {
    async loadRun(runId) {
      return db.prepare(`
        SELECT run_id, profile_id, status, report_plan_fingerprint, report_plan_job_count,
               stats_json, error_summary, completed_at
        FROM sync_runs
        WHERE run_id = ?1
        LIMIT 1
      `).bind(runId).first();
    },
    async listJobs(runId) {
      const result = await db.prepare(`
        SELECT job_id, run_id, profile_id, status
        FROM report_jobs
        WHERE run_id = ?1
        ORDER BY job_id
      `).bind(runId).all();
      return result.results || [];
    },
    async persistTerminalReceipt({
      runId, reportPlanFingerprint, reportPlanJobCount, status, statsJson, errorSummary, completedAt,
    }) {
      const result = await db.prepare(`
        UPDATE sync_runs
        SET status = ?4,
            stats_json = ?5,
            error_summary = ?6,
            completed_at = ?7
        WHERE run_id = ?1
          AND status = 'running'
          AND report_plan_fingerprint = ?2
          AND report_plan_job_count = ?3
      `).bind(
        runId, reportPlanFingerprint, reportPlanJobCount,
        status, statsJson, errorSummary, completedAt,
      ).run();
      return Number(result?.meta?.changes || 0) === 1;
    },
  };
}

function assertRunningPlanReceipt(run) {
  if (!run) throw new SyncRunCompletionError('SYNC_RUN_RECEIPT_MISSING');
  if (run.status !== 'running') throw new SyncRunCompletionError('SYNC_COMPLETION_RUN_NOT_RUNNING');
  if (!run.profile_id) throw new SyncRunCompletionError('SYNC_COMPLETION_PROFILE_RECEIPT_MISSING');
  if (!/^[0-9a-f]{64}$/.test(String(run.report_plan_fingerprint || ''))) {
    throw new SyncRunCompletionError('SYNC_COMPLETION_PLAN_FINGERPRINT_INVALID');
  }
  if (!Number.isSafeInteger(run.report_plan_job_count) || run.report_plan_job_count < 1) {
    throw new SyncRunCompletionError('SYNC_COMPLETION_PLAN_JOB_COUNT_INVALID');
  }
}

function assertCommittedTerminalReceipt(run, expected) {
  if (!run) throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_MISSING');
  if (run.status !== expected.status) throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_CONFLICT:status');
  if (run.stats_json !== expected.statsJson) throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_CONFLICT:stats_json');
  if (run.error_summary !== expected.errorSummary) throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_CONFLICT:error_summary');
  if (!run.completed_at) throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_INCOMPLETE');
  return true;
}

function assertExistingTerminalReceipt(run) {
  if (!run.completed_at || !run.stats_json) throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_INCOMPLETE');
  let stats;
  try { stats = JSON.parse(run.stats_json); } catch { throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_STATS_INVALID'); }
  if (stats?.schemaVersion !== 'sync-report-plan-completion-v1') throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_STATS_INVALID');
  if (stats?.reportPlanFingerprint !== run.report_plan_fingerprint) throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_CONFLICT:plan_fingerprint');
  if (stats?.jobCount !== run.report_plan_job_count) throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_CONFLICT:job_count');
  if (run.status === 'succeeded' && run.error_summary != null) throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_CONFLICT:error_summary');
  if (run.status === 'partial' && run.error_summary !== 'REPORT_PLAN_PARTIAL_FAILURE') throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_CONFLICT:error_summary');
  if (run.status === 'failed' && run.error_summary !== 'REPORT_PLAN_FAILED') throw new SyncRunCompletionError('SYNC_COMPLETION_RECEIPT_CONFLICT:error_summary');
  return true;
}

function requireRepository(repository) {
  if (!repository || typeof repository.loadRun !== 'function'
      || typeof repository.listJobs !== 'function'
      || typeof repository.persistTerminalReceipt !== 'function') {
    throw new SyncRunCompletionError('SYNC_COMPLETION_REPOSITORY_INVALID');
  }
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new SyncRunCompletionError(code);
  return text;
}
