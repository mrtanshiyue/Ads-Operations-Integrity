import assert from 'node:assert/strict';
import {
  advanceSearchTermIngestionOnce,
  createSearchTermIngestionRuntime,
  SearchTermIngestionError,
} from '../cloudflare/runtime/search-term-ingestion.js';

function job(status = 'downloaded', rawRowCount = null, overrides = {}) {
  return {
    job_id:'job-1',
    profile_id:'profile-1',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    status,
    raw_row_count:rawRowCount,
    row_count:status === 'ingested' ? rawRowCount : null,
    ingested_at:status === 'ingested' ? 'done' : null,
    ...overrides,
  };
}

function harness({
  preflight = job(),
  staged = { action:'search_term_stage_committed', reused:false, job:job('downloaded', 1) },
  published = { reused:false, job:job('ingested', 1) },
  loadError = null,
  stageError = null,
  publishError = null,
} = {}) {
  const calls = { load:0, stage:0, publish:0 };
  return {
    calls,
    loadJob:async (jobId) => {
      calls.load += 1;
      assert.equal(jobId, 'job-1');
      if (loadError) throw loadError;
      return preflight ? { ...preflight } : null;
    },
    stageReport:async (jobId) => {
      calls.stage += 1;
      assert.equal(jobId, 'job-1');
      if (stageError) throw stageError;
      return staged;
    },
    publishPartition:async (jobId) => {
      calls.publish += 1;
      assert.equal(jobId, 'job-1');
      if (publishError) throw publishError;
      return published;
    },
  };
}

async function run(h) {
  return advanceSearchTermIngestionOnce({
    jobId:'job-1',
    loadJob:h.loadJob,
    stageReport:h.stageReport,
    publishPartition:h.publishPartition,
  });
}

async function expectCode(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof SearchTermIngestionError, error);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

// No raw_row_count: this invocation may stage, but it must not immediately publish.
{
  const h = harness({
    preflight:job('downloaded', null),
    staged:{ action:'search_term_stage_committed', reused:false, job:job('downloaded', 2) },
  });
  const result = await run(h);
  assert.equal(result.action, 'search_term_stage_ready');
  assert.equal(result.waiting, true);
  assert.equal(result.job.raw_row_count, 2);
  assert.deepEqual(h.calls, { load:1, stage:1, publish:0 });
}

// If another actor publishes immediately after staging, the second operation here is verification-only.
{
  const h = harness({
    preflight:job('downloaded', null),
    staged:{ action:'stage_committed_then_published', reused:false, job:job('ingested', 1) },
    published:{ reused:true, job:job('ingested', 1) },
  });
  const result = await run(h);
  assert.equal(result.action, 'search_term_ingestion_completed_by_race');
  assert.equal(result.reused, true);
  assert.equal(result.waiting, false);
  assert.deepEqual(h.calls, { load:1, stage:1, publish:1 });
}

// Existing stage receipt: stageReport is used only as a receipt verifier, then one publish mutation is allowed.
{
  const h = harness({
    preflight:job('downloaded', 2),
    staged:{ action:'stage_receipt_reused', reused:true, job:job('downloaded', 2) },
    published:{ reused:false, job:job('ingested', 2) },
  });
  const result = await run(h);
  assert.equal(result.action, 'search_term_ingested');
  assert.equal(result.reused, false);
  assert.deepEqual(h.calls, { load:1, stage:1, publish:1 });
}

// A concurrent publisher after preflight is accepted only through publisher's reused lineage-verification path.
{
  const h = harness({
    preflight:job('downloaded', 2),
    staged:{ action:'stage_receipt_reused', reused:true, job:job('downloaded', 2) },
    published:{ reused:true, job:job('ingested', 2) },
  });
  const result = await run(h);
  assert.equal(result.action, 'search_term_ingestion_reused_after_publish_race');
  assert.equal(result.reused, true);
}

// Already ingested: never restage or reread R2; only committed lineage verification is invoked.
{
  const h = harness({
    preflight:job('ingested', 2),
    published:{ reused:true, job:job('ingested', 2) },
  });
  const result = await run(h);
  assert.equal(result.action, 'search_term_ingestion_reused');
  assert.deepEqual(h.calls, { load:1, stage:0, publish:1 });
}

// Unsupported lifecycle states have zero downstream side effects.
for (const status of ['queued','requested','processing','ready','failed','cancelled']) {
  const h = harness({ preflight:job(status, null) });
  await expectCode('SEARCH_TERM_INGESTION_JOB_NOT_READY', () => run(h));
  assert.deepEqual(h.calls, { load:1, stage:0, publish:0 }, status);
}

// Missing job and preflight transport failures fail before stage/publish.
{
  const h = harness({ preflight:null });
  await expectCode('SEARCH_TERM_INGESTION_JOB_NOT_FOUND', () => run(h));
  assert.deepEqual(h.calls, { load:1, stage:0, publish:0 });
}
{
  const h = harness({ loadError:new Error('d1 read failed') });
  const error = await expectCode('SEARCH_TERM_INGESTION_PREFLIGHT_FAILED', () => run(h));
  assert.equal(error.cause.message, 'd1 read failed');
  assert.deepEqual(h.calls, { load:1, stage:0, publish:0 });
}

// Stage and publish errors remain causally distinct.
{
  const h = harness({ stageError:new Error('stage failed') });
  const error = await expectCode('SEARCH_TERM_INGESTION_STAGE_FAILED', () => run(h));
  assert.equal(error.cause.message, 'stage failed');
  assert.equal(h.calls.publish, 0);
}
{
  const h = harness({
    preflight:job('downloaded', 1),
    staged:{ action:'stage_receipt_reused', reused:true, job:job('downloaded', 1) },
    publishError:new Error('publish failed'),
  });
  const error = await expectCode('SEARCH_TERM_INGESTION_PUBLISH_FAILED', () => run(h));
  assert.equal(error.cause.message, 'publish failed');
}

// An immutable raw_row_count cannot silently change between preflight and stage verification.
{
  const h = harness({
    preflight:job('downloaded', 1),
    staged:{ action:'stage_receipt_reused', reused:true, job:job('downloaded', 2) },
  });
  await expectCode('SEARCH_TERM_INGESTION_STAGE_RECEIPT_CONFLICT', () => run(h));
  assert.equal(h.calls.publish, 0);
}

// Malformed adapter receipts are rejected before crossing the next mutation boundary.
{
  const h = harness({ staged:null });
  await expectCode('SEARCH_TERM_INGESTION_STAGE_RESULT_INVALID', () => run(h));
  assert.equal(h.calls.publish, 0);
}
{
  const h = harness({
    preflight:job('downloaded', 1),
    staged:{ action:'stage_receipt_reused', reused:true, job:job('downloaded', 1) },
    published:{ reused:false, job:job('downloaded', 1) },
  });
  await expectCode('SEARCH_TERM_INGESTION_PUBLISH_RECEIPT_INVALID', () => run(h));
}

// Concrete runtime binds the existing publisher for ingested replay; it remains read-only and verifies lineage.
{
  class Statement {
    constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
    bind(...args) { this.args = args; return this; }
    async first() {
      if (this.sql.includes('FROM report_jobs')) return { ...this.db.job };
      if (this.sql.includes('lineage_rows')) return { total_rows:2, lineage_rows:2 };
      throw new Error(`unexpected query: ${this.sql}`);
    }
  }
  const db = {
    job:job('ingested', 2),
    prepare(sql) { return new Statement(this, sql); },
    async batch() { throw new Error('ingested replay must not batch'); },
  };
  const stageRepository = {
    async loadJob(jobId) {
      assert.equal(jobId, 'job-1');
      return { ...db.job };
    },
  };
  const runtime = createSearchTermIngestionRuntime({
    stageRepository,
    db,
    now:'ignored-for-ingested-replay',
  });
  const result = await runtime.advance('job-1');
  assert.equal(result.action, 'search_term_ingestion_reused');
  assert.equal(result.reused, true);
}

assert.throws(
  () => createSearchTermIngestionRuntime({ stageRepository:{}, db:{ prepare(){}, batch(){} } }),
  (error) => error instanceof SearchTermIngestionError
    && error.code === 'SEARCH_TERM_INGESTION_STAGE_REPOSITORY_INVALID',
);

console.log('downloaded search term ingestion composition boundary: PASS');
