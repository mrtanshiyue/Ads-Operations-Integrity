import assert from 'node:assert/strict';
import { decideReportCycle, ReportCycleSchedulerError } from '../cloudflare/runtime/sync-report-cycle.js';

const FP = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

function run(status = 'running', count = 1) {
  return {
    run_id:'run-1',
    profile_id:'profile-1',
    status,
    report_plan_fingerprint:FP,
    report_plan_job_count:count,
  };
}

function job(status, jobId = 'job-1', overrides = {}) {
  const value = {
    job_id:jobId,
    run_id:'run-1',
    profile_id:'profile-1',
    status,
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
    value.raw_row_count = 10;
    value.row_count = 10;
    value.ingested_at = '2026-08-15T00:02:00Z';
  }
  return { ...value, ...overrides };
}

function expectCode(code, fn) {
  assert.throws(
    fn,
    (error) => error instanceof ReportCycleSchedulerError && error.code === code,
  );
}

assert.deepEqual(
  decideReportCycle(run('succeeded'), [job('ingested')]),
  { directive:'RUN_TERMINAL', status:'succeeded' },
);
assert.deepEqual(
  decideReportCycle(run('failed'), [job('failed')]),
  { directive:'RUN_TERMINAL', status:'failed' },
);

// Any ambiguous Create Report state blocks the whole plan, even if another job could act.
assert.deepEqual(
  decideReportCycle(run('running', 2), [job('queued', 'job-a'), job('requested', 'job-z')]),
  { directive:'BLOCKED', reason:'AMAZON_REPORT_CREATE_AMBIGUOUS', jobId:'job-z' },
);
assert.deepEqual(
  decideReportCycle(run('running', 3), [job('requested', 'job-z'), job('requested', 'job-b'), job('queued', 'job-a')]),
  { directive:'BLOCKED', reason:'AMAZON_REPORT_CREATE_AMBIGUOUS', jobId:'job-b' },
);

assert.deepEqual(decideReportCycle(run(), [job('queued')]), {
  directive:'CREATE_AMAZON_REPORT', jobId:'job-1',
});
assert.deepEqual(decideReportCycle(run(), [job('processing')]), {
  directive:'POLL_AMAZON_REPORT', jobId:'job-1',
});
assert.deepEqual(decideReportCycle(run(), [job('ready')]), {
  directive:'MATERIALIZE_RAW_OBJECT', jobId:'job-1',
});
assert.deepEqual(
  decideReportCycle(run(), [job('ready', 'job-1', {
    r2_object_key:'raw/job-1.json.gz',
    content_sha256:SHA,
    content_bytes:100,
  })]),
  { directive:'MATERIALIZE_RAW_OBJECT', jobId:'job-1' },
);
assert.deepEqual(decideReportCycle(run(), [job('downloaded')]), {
  directive:'AWAIT_INGESTION', jobId:'job-1',
});
assert.deepEqual(
  decideReportCycle(run('running', 3), [job('failed','job-c'), job('ingested','job-a'), job('cancelled','job-b')]),
  { directive:'FINALIZE_RUN' },
);

// External actions are selected only by stable lexical job_id, not input order/status priority.
assert.deepEqual(
  decideReportCycle(run('running', 2), [job('queued','job-z'), job('processing','job-a')]),
  { directive:'POLL_AMAZON_REPORT', jobId:'job-a' },
);
assert.deepEqual(
  decideReportCycle(run('running', 2), [job('downloaded','job-a'), job('ready','job-b')]),
  { directive:'MATERIALIZE_RAW_OBJECT', jobId:'job-b' },
);
assert.deepEqual(
  decideReportCycle(run('running', 2), [job('downloaded','job-b'), job('failed','job-z')]),
  { directive:'AWAIT_INGESTION', jobId:'job-b' },
);

expectCode('REPORT_CYCLE_JOB_COUNT_MISMATCH', () =>
  decideReportCycle(run('running', 2), [job('queued')]),
);
expectCode('REPORT_CYCLE_DUPLICATE_JOB_ID', () =>
  decideReportCycle(run('running', 2), [job('queued'), job('failed')]),
);
expectCode('REPORT_CYCLE_JOB_RUN_MISMATCH', () =>
  decideReportCycle(run(), [job('queued','job-1',{ run_id:'other' })]),
);
expectCode('REPORT_CYCLE_JOB_PROFILE_MISMATCH', () =>
  decideReportCycle(run(), [job('queued','job-1',{ profile_id:'other' })]),
);

// Partial or status-incompatible durable receipts always fail closed.
expectCode('REPORT_CYCLE_AMAZON_IDENTITY_PARTIAL', () =>
  decideReportCycle(run(), [job('processing','job-1',{ amazon_created_at:null })]),
);
expectCode('REPORT_CYCLE_PROCESSING_AMAZON_IDENTITY_INVALID', () =>
  decideReportCycle(run(), [job('processing','job-1',{ amazon_report_id:null, amazon_created_at:null })]),
);
expectCode('REPORT_CYCLE_PROCESSING_EXPECTED_AUTHORITY_INVALID', () =>
  decideReportCycle(run(), [job('processing','job-1',{
    r2_object_key:'raw/job-1.json.gz', content_sha256:SHA, content_bytes:100,
  })]),
);
expectCode('REPORT_CYCLE_R2_EXPECTED_AUTHORITY_PARTIAL', () =>
  decideReportCycle(run(), [job('ready','job-1',{ r2_object_key:'raw/job-1.json.gz' })]),
);
expectCode('REPORT_CYCLE_READY_INITIAL_R2_RECEIPT_FORBIDDEN', () =>
  decideReportCycle(run(), [job('ready','job-1',{
    r2_object_key:'raw/job-1.json.gz', content_sha256:SHA, content_bytes:100,
    r2_initial_version:'v', r2_initial_etag:'e', downloaded_at:'2026-08-15T00:01:00Z',
  })]),
);
expectCode('REPORT_CYCLE_DOWNLOADED_EXPECTED_AUTHORITY_REQUIRED', () =>
  decideReportCycle(run(), [job('downloaded','job-1',{
    r2_object_key:null, content_sha256:null, content_bytes:null,
    r2_initial_version:null, r2_initial_etag:null, downloaded_at:null,
  })]),
);
expectCode('REPORT_CYCLE_DOWNLOADED_INITIAL_R2_RECEIPT_REQUIRED', () =>
  decideReportCycle(run(), [job('downloaded','job-1',{
    r2_initial_version:null, r2_initial_etag:null, downloaded_at:null,
  })]),
);
expectCode('REPORT_CYCLE_R2_INITIAL_RECEIPT_PARTIAL', () =>
  decideReportCycle(run(), [job('downloaded','job-1',{ r2_initial_etag:null })]),
);
expectCode('REPORT_CYCLE_INGESTED_RAW_ROW_COUNT_REQUIRED', () =>
  decideReportCycle(run(), [job('ingested','job-1',{ raw_row_count:null })]),
);
expectCode('REPORT_CYCLE_INGESTION_RECEIPT_PARTIAL', () =>
  decideReportCycle(run(), [job('ingested','job-1',{ ingested_at:null })]),
);
expectCode('REPORT_CYCLE_REQUESTED_AMAZON_IDENTITY_INVALID', () =>
  decideReportCycle(run(), [job('requested','job-1',{
    amazon_report_id:'amazon-job-1', amazon_created_at:'2026-08-15T00:00:00Z',
  })]),
);
expectCode('REPORT_CYCLE_CONTENT_SHA256_INVALID', () =>
  decideReportCycle(run(), [job('ready','job-1',{
    r2_object_key:'raw/job-1.json.gz', content_sha256:'ABC', content_bytes:100,
  })]),
);

console.log('sync report cycle deterministic scheduler: PASS');
