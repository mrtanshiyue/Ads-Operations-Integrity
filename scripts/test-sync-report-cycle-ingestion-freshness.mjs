import assert from 'node:assert/strict';
import {
  createReportCycleIngestionAdapter,
  ReportCycleIngestionAdapterError,
} from '../cloudflare/runtime/sync-report-cycle-ingestion-adapter.js';

const FP = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

function run(count = 1, status = 'running') {
  return {
    run_id:'run-ingestion',
    profile_id:'profile-1',
    status,
    report_plan_fingerprint:FP,
    report_plan_job_count:count,
  };
}

function membership(jobId = 'job-1', overrides = {}) {
  return {
    run_id:'run-ingestion',
    job_id:jobId,
    profile_id:'profile-1',
    report_plan_fingerprint:FP,
    dataset_key:'search_term_daily',
    contract_id:'search-term-sp-v1',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    idempotency_key:`idem-${jobId}`,
    request_fingerprint:`request-${jobId}`,
    request_json:`{"job":"${jobId}"}`,
    ...overrides,
  };
}

function job(status = 'downloaded', jobId = 'job-1', overrides = {}) {
  const member = membership(jobId);
  const value = {
    job_id:jobId,
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
  if (['processing','ready','downloaded','ingested'].includes(status)) {
    value.amazon_report_id = `amazon-${jobId}`;
    value.amazon_created_at = '2026-08-15T00:00:00Z';
  }
  if (['downloaded','ingested'].includes(status)) {
    value.r2_object_key = `raw/${jobId}.json.gz`;
    value.content_sha256 = SHA;
    value.content_bytes = 100;
    value.r2_initial_version = `version-${jobId}`;
    value.r2_initial_etag = `etag-${jobId}`;
    value.downloaded_at = '2026-08-15T00:01:00Z';
  }
  if (status === 'ingested') {
    value.raw_row_count = 2;
    value.row_count = 2;
    value.ingested_at = '2026-08-15T00:02:00Z';
  }
  return { ...value, ...overrides };
}

function snapshotRepository({ runRow = run(), jobs = [job()], membershipRows = null, error = null } = {}) {
  const members = membershipRows || jobs.map((entry) => membership(entry.job_id));
  return {
    loads:0,
    async loadSnapshot(runId) {
      this.loads += 1;
      assert.equal(runId, 'run-ingestion');
      if (error) throw error;
      return {
        run:{ ...runRow },
        membership:members.map((row) => ({ ...row })),
        jobs:jobs.map((row) => ({ ...row })),
      };
    },
  };
}

function ingestionRuntime(result = null, error = null) {
  return {
    calls:0,
    async advance(jobId) {
      this.calls += 1;
      assert.equal(jobId, 'job-1');
      if (error) throw error;
      return result || {
        action:'search_term_stage_ready',
        reused:false,
        waiting:true,
        job:job('downloaded', 'job-1', { raw_row_count:2 }),
      };
    },
  };
}

async function expectCode(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ReportCycleIngestionAdapterError, error);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

// Fresh frozen authority still selects the same downloaded job: one ingestion step may run.
{
  const snapshots = snapshotRepository();
  const runtime = ingestionRuntime();
  const advance = createReportCycleIngestionAdapter({ snapshotRepository:snapshots, ingestionRuntime:runtime });
  const result = await advance({ runId:'run-ingestion', jobId:'job-1' });
  assert.equal(result.directive, 'AWAIT_INGESTION');
  assert.equal(result.executed, true);
  assert.equal(result.waiting, true);
  assert.equal(result.jobId, 'job-1');
  assert.equal(runtime.calls, 1);
}

// A completed ingestion receipt is accepted only as an ingested durable job.
{
  const runtime = ingestionRuntime({
    action:'search_term_ingested', reused:false, waiting:false,
    job:job('ingested'),
  });
  const advance = createReportCycleIngestionAdapter({ snapshotRepository:snapshotRepository(), ingestionRuntime:runtime });
  const result = await advance({ runId:'run-ingestion', jobId:'job-1' });
  assert.equal(result.waiting, false);
  assert.equal(result.result.job.status, 'ingested');
}

// Multi-job scheduler authority is stable: an old intent for a non-selected downloaded job cannot run.
{
  const jobs = [job('downloaded', 'job-a'), job('downloaded', 'job-b')];
  const snapshots = snapshotRepository({ runRow:run(2), jobs });
  const runtime = ingestionRuntime();
  const advance = createReportCycleIngestionAdapter({ snapshotRepository:snapshots, ingestionRuntime:runtime });
  await expectCode('REPORT_CYCLE_INGESTION_JOB_STALE', () =>
    advance({ runId:'run-ingestion', jobId:'job-b' }),
  );
  assert.equal(runtime.calls, 0);
}

// Any fresh higher-priority or terminal directive blocks ingestion before the runtime is touched.
for (const [jobs, code] of [
  [[job('queued')], 'REPORT_CYCLE_INGESTION_DIRECTIVE_STALE:CREATE_AMAZON_REPORT'],
  [[job('requested')], 'REPORT_CYCLE_INGESTION_DIRECTIVE_STALE:BLOCKED'],
  [[job('processing')], 'REPORT_CYCLE_INGESTION_DIRECTIVE_STALE:POLL_AMAZON_REPORT'],
  [[job('ready')], 'REPORT_CYCLE_INGESTION_DIRECTIVE_STALE:MATERIALIZE_RAW_OBJECT'],
  [[job('failed')], 'REPORT_CYCLE_INGESTION_DIRECTIVE_STALE:FINALIZE_RUN'],
]) {
  const runtime = ingestionRuntime();
  const advance = createReportCycleIngestionAdapter({ snapshotRepository:snapshotRepository({ jobs }), ingestionRuntime:runtime });
  await expectCode(code, () => advance({ runId:'run-ingestion', jobId:'job-1' }));
  assert.equal(runtime.calls, 0, code);
}

// Invalid/malformed frozen authority is wrapped and blocks all ingestion work.
{
  const snapshots = snapshotRepository({ membershipRows:[membership('job-1', { request_json:'{"changed":true}' })] });
  const runtime = ingestionRuntime();
  const advance = createReportCycleIngestionAdapter({ snapshotRepository:snapshots, ingestionRuntime:runtime });
  const error = await expectCode('REPORT_CYCLE_INGESTION_SNAPSHOT_INVALID', () =>
    advance({ runId:'run-ingestion', jobId:'job-1' }),
  );
  assert.equal(error.cause.code, 'REPORT_CYCLE_SNAPSHOT_JOB_CONFLICT:request_json');
  assert.equal(runtime.calls, 0);
}

// Snapshot transport and ingestion runtime failures remain causally distinct.
{
  const runtime = ingestionRuntime();
  const advance = createReportCycleIngestionAdapter({
    snapshotRepository:snapshotRepository({ error:new Error('snapshot read failed') }),
    ingestionRuntime:runtime,
  });
  const error = await expectCode('REPORT_CYCLE_INGESTION_SNAPSHOT_INVALID', () =>
    advance({ runId:'run-ingestion', jobId:'job-1' }),
  );
  assert.equal(error.cause.code, 'REPORT_CYCLE_SNAPSHOT_LOAD_FAILED');
  assert.equal(runtime.calls, 0);
}
{
  const runtime = ingestionRuntime(null, new Error('ingestion failed'));
  const advance = createReportCycleIngestionAdapter({ snapshotRepository:snapshotRepository(), ingestionRuntime:runtime });
  const error = await expectCode('REPORT_CYCLE_INGESTION_EXECUTION_FAILED', () =>
    advance({ runId:'run-ingestion', jobId:'job-1' }),
  );
  assert.equal(error.cause.message, 'ingestion failed');
  assert.equal(runtime.calls, 1);
}

// Forged downstream receipts cannot escape the boundary.
for (const [result, code] of [
  [null, 'REPORT_CYCLE_INGESTION_RESULT_INVALID'],
  [{ waiting:true, job:job('downloaded', 'other-job', { raw_row_count:1 }) }, 'REPORT_CYCLE_INGESTION_RESULT_JOB_CONFLICT'],
  [{ waiting:true, job:job('downloaded', 'job-1', { raw_row_count:null }) }, 'REPORT_CYCLE_INGESTION_WAITING_RECEIPT_INVALID'],
  [{ waiting:false, job:job('downloaded', 'job-1', { raw_row_count:1 }) }, 'REPORT_CYCLE_INGESTION_COMPLETION_RECEIPT_INVALID'],
  [{ waiting:false, job:job('ingested', 'job-1', { row_count:null }) }, 'REPORT_CYCLE_INGESTION_COMPLETION_RECEIPT_INVALID'],
]) {
  const runtime = ingestionRuntime(result);
  const advance = createReportCycleIngestionAdapter({ snapshotRepository:snapshotRepository(), ingestionRuntime:runtime });
  await expectCode(code, () => advance({ runId:'run-ingestion', jobId:'job-1' }));
}

assert.throws(
  () => createReportCycleIngestionAdapter({ snapshotRepository:{}, ingestionRuntime:{ advance(){} } }),
  (error) => error instanceof ReportCycleIngestionAdapterError
    && error.code === 'REPORT_CYCLE_INGESTION_SNAPSHOT_REPOSITORY_INVALID',
);
assert.throws(
  () => createReportCycleIngestionAdapter({ snapshotRepository:{ loadSnapshot(){} }, ingestionRuntime:{} }),
  (error) => error instanceof ReportCycleIngestionAdapterError
    && error.code === 'REPORT_CYCLE_INGESTION_RUNTIME_INVALID',
);

console.log('report cycle ingestion fresh snapshot boundary: PASS');
