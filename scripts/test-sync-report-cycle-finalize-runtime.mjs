import assert from 'node:assert/strict';
import {
  createCloudflareReportCycleFinalizeAdapter,
  CloudflareReportCycleFinalizeFactoryError,
} from '../cloudflare/runtime/sync-report-cycle-finalize-runtime.js';

const FP = 'c'.repeat(64);

function run(status = 'running', overrides = {}) {
  return {
    run_id:'run-finalize',
    profile_id:'profile-1',
    status,
    report_plan_fingerprint:FP,
    report_plan_job_count:1,
    stats_json:null,
    error_summary:null,
    completed_at:null,
    ...overrides,
  };
}

function membership() {
  return {
    run_id:'run-finalize',
    job_id:'job-1',
    profile_id:'profile-1',
    report_plan_fingerprint:FP,
    dataset_key:'search_term_daily',
    contract_id:'search-term-sp-v1',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    idempotency_key:'idem-1',
    request_fingerprint:'request-1',
    request_json:'{"reportType":"spSearchTerm"}',
  };
}

function job(status = 'failed') {
  const member = membership();
  return {
    job_id:member.job_id,
    run_id:member.run_id,
    profile_id:member.profile_id,
    ad_product:member.ad_product,
    report_type:member.report_type,
    start_date:member.start_date,
    end_date:member.end_date,
    status,
    idempotency_key:member.idempotency_key,
    request_fingerprint:member.request_fingerprint,
    request_json:member.request_json,
    amazon_report_id:null,
    amazon_created_at:null,
    r2_object_key:null,
    content_sha256:null,
    content_bytes:null,
    r2_initial_version:null,
    r2_initial_etag:null,
    downloaded_at:null,
    raw_row_count:null,
    row_count:null,
    ingested_at:null,
  };
}

function createDb({ snapshotJob = job('failed') } = {}) {
  const state = { run:run(), jobs:[{ job_id:'job-1', run_id:'run-finalize', profile_id:'profile-1', status:snapshotJob.status }] };
  const calls = { snapshotBatch:0, loadRun:0, listJobs:0, persist:0 };

  class Statement {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async first() {
      if (this.sql.includes('SELECT run_id, profile_id, status, report_plan_fingerprint, report_plan_job_count,')
          && this.sql.includes('stats_json')) {
        calls.loadRun += 1;
        return { ...state.run };
      }
      throw new Error(`unexpected first query: ${this.sql}`);
    }
    async all() {
      if (this.sql.includes('SELECT job_id, run_id, profile_id, status')
          && this.sql.includes('FROM report_jobs')) {
        calls.listJobs += 1;
        return { results:state.jobs.map((row) => ({ ...row })) };
      }
      throw new Error(`unexpected all query: ${this.sql}`);
    }
    async run() {
      if (this.sql.includes('UPDATE sync_runs') && this.sql.includes('stats_json = ?5')) {
        calls.persist += 1;
        const [runId, fingerprint, jobCount, status, statsJson, errorSummary, completedAt] = this.args;
        assert.equal(runId, state.run.run_id);
        assert.equal(fingerprint, state.run.report_plan_fingerprint);
        assert.equal(jobCount, state.run.report_plan_job_count);
        if (state.run.status !== 'running') return { meta:{ changes:0 } };
        state.run = {
          ...state.run,
          status,
          stats_json:statsJson,
          error_summary:errorSummary,
          completed_at:completedAt,
        };
        return { meta:{ changes:1 } };
      }
      throw new Error(`unexpected run query: ${this.sql}`);
    }
  }

  return {
    calls,
    state,
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      const sql = statements.map((statement) => statement.sql || '').join('\n');
      if (statements.length === 3
          && sql.includes('FROM sync_runs')
          && sql.includes('FROM sync_report_plan_jobs')
          && sql.includes('FROM report_jobs')) {
        calls.snapshotBatch += 1;
        return [
          { results:[run()] },
          { results:[membership()] },
          { results:[snapshotJob] },
        ];
      }
      throw new Error('unexpected batch');
    },
  };
}

assert.throws(
  () => createCloudflareReportCycleFinalizeAdapter(),
  (error) => error instanceof CloudflareReportCycleFinalizeFactoryError
    && error.code === 'REPORT_CYCLE_FINALIZE_ENV_INVALID',
);
assert.throws(
  () => createCloudflareReportCycleFinalizeAdapter({ env:{}, now:'2026-08-16T03:00:00+08:00' }),
  (error) => error instanceof CloudflareReportCycleFinalizeFactoryError
    && error.code === 'REPORT_CYCLE_FINALIZE_STORE_DB_BINDING_INVALID',
);

// Fresh all-terminal authority writes exactly one completion receipt through the concrete D1 repository.
{
  const db = createDb({ snapshotJob:job('failed') });
  let nowCalls = 0;
  const finalizeRun = createCloudflareReportCycleFinalizeAdapter({
    env:{ STORE_01_DB:db },
    now:() => {
      nowCalls += 1;
      return `2026-08-16T03:0${nowCalls}:00+08:00`;
    },
  });
  const result = await finalizeRun({ runId:'run-finalize' });
  assert.equal(result.finalized, true);
  assert.equal(result.reused, false);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.error_summary, 'REPORT_PLAN_FAILED');
  assert.equal(result.run.completed_at, '2026-08-16T03:01:00+08:00');
  assert.equal(nowCalls, 1);
  assert.deepEqual(db.calls, { snapshotBatch:1, loadRun:2, listJobs:1, persist:1 });
}

// A fresh nonterminal job invalidates the finalize directive before completion D1 methods are touched.
{
  const db = createDb({ snapshotJob:job('queued') });
  const finalizeRun = createCloudflareReportCycleFinalizeAdapter({
    env:{ STORE_01_DB:db },
    now:'2026-08-16T03:05:00+08:00',
  });
  let caught = null;
  try {
    await finalizeRun({ runId:'run-finalize' });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'REPORT_CYCLE_FINALIZE_DIRECTIVE_STALE:CREATE_AMAZON_REPORT');
  assert.deepEqual(db.calls, { snapshotBatch:1, loadRun:0, listJobs:0, persist:0 });
}

// `now` is resolved on invocation rather than factory construction.
{
  const db = createDb({ snapshotJob:job('queued') });
  let nowCalls = 0;
  const finalizeRun = createCloudflareReportCycleFinalizeAdapter({
    env:{ STORE_01_DB:db },
    now:() => { nowCalls += 1; return '2026-08-16T03:06:00+08:00'; },
  });
  assert.equal(nowCalls, 0);
  try { await finalizeRun({ runId:'run-finalize' }); } catch {}
  assert.equal(nowCalls, 1);
}

console.log('concrete report cycle finalize adapter factory: PASS');
