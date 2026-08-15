import assert from 'node:assert/strict';
import { createReportCycleRuntime, ReportCycleRuntimeError } from '../cloudflare/runtime/sync-report-cycle-runtime.js';

const FP = 'd'.repeat(64);

function run(status = 'running') {
  return {
    run_id:'run-router',
    profile_id:'profile-1',
    status,
    report_plan_fingerprint:FP,
    report_plan_job_count:1,
  };
}

function membership() {
  return {
    run_id:'run-router',
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

function job(status, overrides = {}) {
  const member = membership();
  const amazonReceipt = ['processing','ready','downloaded','ingested'].includes(status);
  const rawReceipt = ['downloaded','ingested'].includes(status);
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
    amazon_report_id:amazonReceipt ? 'amazon-1' : null,
    amazon_created_at:amazonReceipt ? '2026-08-15T14:00:00Z' : null,
    r2_object_key:rawReceipt ? 'raw/key.json.gz' : null,
    content_sha256:rawReceipt ? 'a'.repeat(64) : null,
    content_bytes:rawReceipt ? 128 : null,
    r2_initial_version:rawReceipt ? 'version-1' : null,
    r2_initial_etag:rawReceipt ? 'etag-1' : null,
    downloaded_at:rawReceipt ? '2026-08-15T14:30:00Z' : null,
    raw_row_count:status === 'ingested' ? 1 : null,
    row_count:status === 'ingested' ? 1 : null,
    ingested_at:status === 'ingested' ? '2026-08-15T14:31:00Z' : null,
    ...overrides,
  };
}

function snapshotRepository({ jobRow, runRow = run(), error = null }) {
  return {
    calls:0,
    async loadSnapshot(runId) {
      this.calls += 1;
      assert.equal(runId, 'run-router');
      if (error) throw error;
      return {
        run:{ ...runRow },
        membership:[membership()],
        jobs:[{ ...jobRow }],
      };
    },
  };
}

function adapters() {
  const calls = { create:0, poll:0, materialize:0, ingest:0, finalize:0 };
  return {
    calls,
    acquisitionAdapters:{
      async createAmazonReport(input) {
        calls.create += 1;
        assert.deepEqual(input, {
          runId:'run-router', jobId:'job-1', expectedStatus:'queued', directive:'CREATE_AMAZON_REPORT',
        });
        return { action:'created' };
      },
      async pollAmazonReport(input) {
        calls.poll += 1;
        assert.deepEqual(input, {
          runId:'run-router', jobId:'job-1', expectedStatus:'processing', directive:'POLL_AMAZON_REPORT',
        });
        return { action:'polled' };
      },
      async materializeRawObject(input) {
        calls.materialize += 1;
        assert.deepEqual(input, {
          runId:'run-router', jobId:'job-1', expectedStatus:'ready', directive:'MATERIALIZE_RAW_OBJECT',
        });
        return { action:'materialized' };
      },
    },
    async ingestionAdapter(input) {
      calls.ingest += 1;
      assert.deepEqual(input, { runId:'run-router', jobId:'job-1' });
      return { action:'search_term_stage_ready', waiting:true };
    },
    async finalizeRun(input) {
      calls.finalize += 1;
      assert.deepEqual(input, { runId:'run-router' });
      return { finalized:true, reused:false, run:{ run_id:'run-router', status:'failed' } };
    },
  };
}

async function route(status, expectedDirective) {
  const repo = snapshotRepository({ jobRow:job(status) });
  const a = adapters();
  const runtime = createReportCycleRuntime({
    snapshotRepository:repo,
    acquisitionAdapters:a.acquisitionAdapters,
    ingestionAdapter:a.ingestionAdapter,
    finalizeRun:a.finalizeRun,
  });
  const result = await runtime.advance('run-router');
  assert.equal(result.directive, expectedDirective);
  assert.equal(repo.calls, 1);
  return { result, calls:a.calls };
}

for (const [status, directive, key] of [
  ['queued','CREATE_AMAZON_REPORT','create'],
  ['processing','POLL_AMAZON_REPORT','poll'],
  ['ready','MATERIALIZE_RAW_OBJECT','materialize'],
]) {
  const { result, calls } = await route(status, directive);
  assert.equal(result.executed, true);
  assert.equal(result.jobId, 'job-1');
  assert.equal(calls[key], 1);
  const other = Object.entries(calls).filter(([name]) => name !== key);
  assert.ok(other.every(([, count]) => count === 0), `${directive} crossed adapter boundary`);
}

// Downloaded is not left as an executor no-op: it routes only through the dedicated ingestion adapter.
{
  const { result, calls } = await route('downloaded', 'AWAIT_INGESTION');
  assert.equal(result.executed, true);
  assert.equal(result.waiting, true);
  assert.equal(result.result.action, 'search_term_stage_ready');
  assert.deepEqual(calls, { create:0, poll:0, materialize:0, ingest:1, finalize:0 });
}

// All-terminal plan routes finalization and no acquisition/ingestion adapter.
{
  const { result, calls } = await route('failed', 'FINALIZE_RUN');
  assert.equal(result.executed, true);
  assert.equal(result.result.finalized, true);
  assert.deepEqual(calls, { create:0, poll:0, materialize:0, ingest:0, finalize:1 });
}

// Ambiguous requested state remains BLOCKED with zero downstream side effect.
{
  const { result, calls } = await route('requested', 'BLOCKED');
  assert.equal(result.executed, false);
  assert.equal(result.waiting, true);
  assert.deepEqual(calls, { create:0, poll:0, materialize:0, ingest:0, finalize:0 });
}

// Missing directive-specific adapters fail only after the fresh snapshot selects that directive.
{
  const repo = snapshotRepository({ jobRow:job('downloaded') });
  const runtime = createReportCycleRuntime({ snapshotRepository:repo });
  await assert.rejects(
    () => runtime.advance('run-router'),
    (error) => error instanceof ReportCycleRuntimeError
      && error.code === 'REPORT_CYCLE_RUNTIME_INGESTION_ADAPTER_REQUIRED',
  );
  assert.equal(repo.calls, 1);
}

// Snapshot errors are causally isolated from execution adapters and preserve the nested loader cause.
{
  const repo = snapshotRepository({ jobRow:job('queued'), error:new Error('d1 snapshot failed') });
  const a = adapters();
  const runtime = createReportCycleRuntime({
    snapshotRepository:repo,
    acquisitionAdapters:a.acquisitionAdapters,
    ingestionAdapter:a.ingestionAdapter,
    finalizeRun:a.finalizeRun,
  });
  await assert.rejects(
    () => runtime.advance('run-router'),
    (error) => error instanceof ReportCycleRuntimeError
      && error.code === 'REPORT_CYCLE_RUNTIME_SNAPSHOT_FAILED'
      && error.cause?.code === 'REPORT_CYCLE_SNAPSHOT_LOAD_FAILED'
      && error.cause?.cause?.message === 'd1 snapshot failed',
  );
  assert.deepEqual(a.calls, { create:0, poll:0, materialize:0, ingest:0, finalize:0 });
}

assert.throws(
  () => createReportCycleRuntime({ snapshotRepository:{} }),
  (error) => error instanceof ReportCycleRuntimeError
    && error.code === 'REPORT_CYCLE_RUNTIME_SNAPSHOT_REPOSITORY_INVALID',
);

console.log('report cycle runtime router boundary: PASS');
