import assert from 'node:assert/strict';
import { decideReportCycle } from '../cloudflare/runtime/sync-report-cycle.js';
import {
  executeReportCycleDirectiveOnce,
  ReportCycleExecutionError,
} from '../cloudflare/runtime/sync-report-cycle-executor.js';

const FP = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

function run(status = 'running') {
  return {
    run_id:'run-exec',
    profile_id:'profile-1',
    status,
    report_plan_fingerprint:FP,
    report_plan_job_count:1,
  };
}

function membership(jobId = 'job-1', overrides = {}) {
  return {
    run_id:'run-exec',
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

function job(status, jobId = 'job-1', overrides = {}) {
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
    value.raw_row_count = 10;
    value.row_count = 10;
    value.ingested_at = '2026-08-15T00:02:00Z';
  }
  return { ...value, ...overrides };
}

function cycleFor(jobStatus, runStatus = 'running') {
  const cycleRun = run(runStatus);
  const jobs = [job(jobStatus)];
  return {
    run:cycleRun,
    membership:[membership()],
    jobs,
    decision:decideReportCycle(cycleRun, jobs),
  };
}

async function expectCode(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ReportCycleExecutionError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

const calls = [];
const adapters = {
  async createAmazonReport(input) {
    calls.push(['create', input]);
    return { action:'created' };
  },
  async pollAmazonReport(input) {
    calls.push(['poll', input]);
    return { action:'polled' };
  },
  async materializeRawObject(input) {
    calls.push(['materialize', input]);
    return { action:'materialized' };
  },
  async finalizeRun(input) {
    calls.push(['finalize', input]);
    return { finalized:true, status:'failed' };
  },
};

let result = await executeReportCycleDirectiveOnce({ cycle:cycleFor('queued'), adapters });
assert.equal(result.directive, 'CREATE_AMAZON_REPORT');
assert.equal(result.executed, true);
assert.equal(calls.at(-1)[0], 'create');
assert.deepEqual(calls.at(-1)[1], {
  runId:'run-exec', jobId:'job-1', expectedStatus:'queued', directive:'CREATE_AMAZON_REPORT',
});

result = await executeReportCycleDirectiveOnce({ cycle:cycleFor('processing'), adapters });
assert.equal(result.directive, 'POLL_AMAZON_REPORT');
assert.equal(calls.at(-1)[0], 'poll');

result = await executeReportCycleDirectiveOnce({ cycle:cycleFor('ready'), adapters });
assert.equal(result.directive, 'MATERIALIZE_RAW_OBJECT');
assert.equal(calls.at(-1)[0], 'materialize');

const beforeNoop = calls.length;
result = await executeReportCycleDirectiveOnce({ cycle:cycleFor('requested'), adapters });
assert.deepEqual(result, {
  directive:'BLOCKED', executed:false, waiting:true,
  reason:'AMAZON_REPORT_CREATE_AMBIGUOUS', jobId:'job-1',
});
assert.equal(calls.length, beforeNoop);

result = await executeReportCycleDirectiveOnce({ cycle:cycleFor('downloaded'), adapters });
assert.deepEqual(result, {
  directive:'AWAIT_INGESTION', executed:false, waiting:true, jobId:'job-1',
});
assert.equal(calls.length, beforeNoop);

result = await executeReportCycleDirectiveOnce({ cycle:cycleFor('ingested', 'succeeded'), adapters });
assert.deepEqual(result, {
  directive:'RUN_TERMINAL', executed:false, waiting:false, status:'succeeded',
});
assert.equal(calls.length, beforeNoop);

result = await executeReportCycleDirectiveOnce({ cycle:cycleFor('failed'), adapters });
assert.equal(result.directive, 'FINALIZE_RUN');
assert.equal(result.executed, true);
assert.equal(calls.at(-1)[0], 'finalize');
assert.deepEqual(calls.at(-1)[1], { runId:'run-exec' });

const forged = cycleFor('queued');
forged.decision = { directive:'MATERIALIZE_RAW_OBJECT', jobId:'job-1' };
await expectCode('REPORT_CYCLE_EXECUTION_DECISION_CONFLICT', () =>
  executeReportCycleDirectiveOnce({ cycle:forged, adapters }),
);

const extraDecisionField = cycleFor('queued');
extraDecisionField.decision = { ...extraDecisionField.decision, unexpected:true };
await expectCode('REPORT_CYCLE_EXECUTION_DECISION_CONFLICT', () =>
  executeReportCycleDirectiveOnce({ cycle:extraDecisionField, adapters }),
);

const dirtySnapshot = cycleFor('queued');
dirtySnapshot.membership = [membership('job-1', { request_json:'{"changed":true}' })];
const snapshotError = await expectCode('REPORT_CYCLE_EXECUTION_SNAPSHOT_INVALID', () =>
  executeReportCycleDirectiveOnce({ cycle:dirtySnapshot, adapters }),
);
assert.equal(snapshotError.cause.code, 'REPORT_CYCLE_SNAPSHOT_JOB_CONFLICT:request_json');

await expectCode('REPORT_CYCLE_CREATE_AMAZON_REPORT_ADAPTER_REQUIRED', () =>
  executeReportCycleDirectiveOnce({ cycle:cycleFor('queued'), adapters:{} }),
);

const adapterFailure = await expectCode('REPORT_CYCLE_EXECUTION_FAILED:POLL_AMAZON_REPORT', () =>
  executeReportCycleDirectiveOnce({
    cycle:cycleFor('processing'),
    adapters:{ async pollAmazonReport(){ throw new Error('poll failed'); } },
  }),
);
assert.equal(adapterFailure.cause.message, 'poll failed');

await expectCode('REPORT_CYCLE_FINALIZE_RECEIPT_UNVERIFIED', () =>
  executeReportCycleDirectiveOnce({
    cycle:cycleFor('failed'),
    adapters:{ async finalizeRun(){ return { finalized:false }; } },
  }),
);

console.log('sync report cycle directive execution boundary: PASS');
