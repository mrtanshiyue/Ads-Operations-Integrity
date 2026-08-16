import assert from 'node:assert/strict';
import {
  publishSearchTermPartition,
  verifyCommittedSearchTermLineage,
} from '../cloudflare/runtime/search-term-fact-publisher.js';

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.bindings = []; }
  bind(...values) { this.bindings = values; return this; }
  async first() { return this.db.first(this); }
}

class FakeDb {
  constructor({ job, stageCount, datasetCount = stageCount, mismatchCount = 0, updateChanges = 1, lineageRows = null }) {
    this.job = { ...job };
    this.stageCount = stageCount;
    this.datasetCount = datasetCount;
    this.mismatchCount = mismatchCount;
    this.updateChanges = updateChanges;
    this.lineageRows = lineageRows ?? Number(job.row_count ?? stageCount);
    this.totalRows = Number(job.row_count ?? stageCount);
    this.batchCalled = false;
  }
  prepare(sql) { return new FakeStatement(this, sql); }
  async first(statement) {
    if (statement.sql.includes('identity_mismatch_count')) {
      return {
        row_count: this.stageCount,
        dataset_count: this.datasetCount,
        identity_mismatch_count: this.mismatchCount,
      };
    }
    if (statement.sql.includes('lineage_rows')) {
      return { total_rows: this.totalRows, lineage_rows: this.lineageRows };
    }
    if (statement.sql.includes('FROM report_jobs')) return { ...this.job };
    throw new Error(`unexpected SELECT: ${statement.sql}`);
  }
  async batch(statements) {
    this.batchCalled = true;
    assert.equal(statements.length, 4);
    assert.match(statements[0].sql, /DELETE FROM search_term_daily/);
    assert.match(statements[0].sql, /rj\.status = 'downloaded'/);
    assert.match(statements[1].sql, /INSERT INTO search_term_daily/);
    assert.match(statements[1].sql, /rj\.job_id,/);
    assert.match(statements[1].sql, /source_report_job_id, source_keyword_type/);
    assert.match(statements[2].sql, /UPDATE report_jobs/);
    assert.match(statements[2].sql, /status = 'ingested'/);
    assert.match(statements[3].sql, /DELETE FROM report_fact_stage/);
    assert.match(statements[3].sql, /rj\.status = 'ingested'/);

    if (this.updateChanges === 1) {
      this.job.status = 'ingested';
      this.job.row_count = this.stageCount;
      this.job.ingested_at = statements[2].bindings[2];
      this.totalRows = this.stageCount;
      this.lineageRows = this.stageCount;
    }
    return [
      { meta: { changes: 1 } },
      { meta: { changes: this.stageCount } },
      { meta: { changes: this.updateChanges } },
      { meta: { changes: this.updateChanges === 1 ? this.stageCount : 0 } },
    ];
  }
}

const downloadedJob = {
  job_id: 'job-1',
  profile_id: 'profile-1',
  ad_product: 'SPONSORED_PRODUCTS',
  report_type: 'spSearchTerm',
  start_date: '2026-08-12',
  end_date: '2026-08-12',
  status: 'downloaded',
  raw_row_count: 2,
  row_count: null,
  ingested_at: null,
};

{
  const db = new FakeDb({ job: downloadedJob, stageCount: 2 });
  const result = await publishSearchTermPartition({ db, jobId: 'job-1', now: '2026-08-15T11:15:00Z' });
  assert.equal(result.reused, false);
  assert.equal(result.job.status, 'ingested');
  assert.equal(result.job.row_count, 2);
  assert.equal(db.batchCalled, true);
}

for (const bad of [
  { stageCount: 1, datasetCount: 1, mismatchCount: 0 },
  { stageCount: 2, datasetCount: 1, mismatchCount: 0 },
  { stageCount: 2, datasetCount: 2, mismatchCount: 1 },
]) {
  const db = new FakeDb({ job: downloadedJob, ...bad });
  try {
    await publishSearchTermPartition({ db, jobId: 'job-1', now: 't' });
    assert.fail('inconsistent stage accepted');
  } catch (error) {
    assert.equal(error.code, 'STAGE_RECEIPT_INCONSISTENT');
  }
  assert.equal(db.batchCalled, false);
}

{
  const db = new FakeDb({ job: downloadedJob, stageCount: 2, updateChanges: 0 });
  try {
    await publishSearchTermPartition({ db, jobId: 'job-1', now: 't' });
    assert.fail('missing publish receipt accepted');
  } catch (error) {
    assert.equal(error.code, 'FACT_PUBLISH_RECEIPT_UNAVAILABLE');
  }
}

{
  const ingested = { ...downloadedJob, status: 'ingested', row_count: 2, ingested_at: 't' };
  const db = new FakeDb({ job: ingested, stageCount: 0, lineageRows: 2 });
  db.totalRows = 2;
  const result = await publishSearchTermPartition({ db, jobId: 'job-1', now: 'ignored' });
  assert.equal(result.reused, true);
  assert.equal(db.batchCalled, false);
  assert.equal(await verifyCommittedSearchTermLineage(db, ingested), true);
}

{
  const ingested = { ...downloadedJob, status: 'ingested', row_count: 2, ingested_at: 't' };
  const db = new FakeDb({ job: ingested, stageCount: 0, lineageRows: 1 });
  db.totalRows = 2;
  try {
    await verifyCommittedSearchTermLineage(db, ingested);
    assert.fail('bad lineage accepted');
  } catch (error) {
    assert.equal(error.code, 'FACT_PUBLISH_COMMITTED_LINEAGE_MISMATCH');
  }
}

console.log(JSON.stringify({
  ok: true,
  atomicBatchOrder: true,
  stageReceiptGuard: true,
  currentJobLineageForcedAtPublish: true,
  publishReceiptRequired: true,
  ingestedReplayVerifiesLineage: true,
}, null, 2));
