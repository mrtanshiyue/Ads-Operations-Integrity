import assert from 'node:assert/strict';
import {
  createD1SearchTermFactStageRepository,
  SearchTermFactStageRepositoryError,
} from '../cloudflare/runtime/search-term-fact-stage-repository.js';

class BoundStatement {
  constructor(db, sql, args) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  async first() {
    this.db.firstCalls.push(this);
    return this.db.firstResult;
  }
  async all() {
    this.db.allCalls.push(this);
    return this.db.allResult;
  }
}

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args) {
    const bound = new BoundStatement(this.db, this.sql, args);
    this.db.boundStatements.push(bound);
    return bound;
  }
}

class FakeD1 {
  constructor() {
    this.boundStatements = [];
    this.firstCalls = [];
    this.allCalls = [];
    this.batchCalls = [];
    this.firstResult = null;
    this.allResult = { results:[] };
    this.batchResults = null;
    this.batchError = null;
  }
  prepare(sql) {
    return new PreparedStatement(this, sql);
  }
  async batch(statements) {
    this.batchCalls.push(statements);
    if (this.batchError) throw this.batchError;
    if (this.batchResults) return this.batchResults;
    return statements.map((_, index) => ({
      success:true,
      meta:{ changes:index === statements.length - 1 ? 1 : 0 },
    }));
  }
}

const SHA = 'a'.repeat(64);

function job(overrides = {}) {
  return {
    job_id:'job-1',
    run_id:'run-1',
    profile_id:'profile-1',
    account_type:'seller',
    amazon_report_id:'amazon-1',
    amazon_created_at:'source-time',
    ad_product:'SPONSORED_PRODUCTS',
    report_type:'spSearchTerm',
    start_date:'2026-08-12',
    end_date:'2026-08-12',
    status:'downloaded',
    r2_object_key:'raw/job-1.json.gz',
    content_sha256:SHA,
    content_bytes:123,
    r2_initial_version:'version-1',
    r2_initial_etag:'etag-1',
    downloaded_at:'2026-08-15T14:32:00Z',
    raw_row_count:null,
    row_count:null,
    ingested_at:null,
    ...overrides,
  };
}

function row(index, overrides = {}) {
  return {
    datasetKey:'search_term_daily',
    sourceRowOrdinal:index,
    logicalRowKey:`rk-${index}`,
    canonicalRowJson:JSON.stringify({ rowKey:`rk-${index}` }),
    ...overrides,
  };
}

async function expectCode(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof SearchTermFactStageRepositoryError, error);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function assertExactAuthority(sql) {
  for (const fragment of [
    'rj.job_id = ?1',
    'rj.run_id = ?2',
    'rj.profile_id = ?3',
    'rj.ad_product = ?4',
    'rj.report_type = ?5',
    'rj.start_date = ?6',
    'rj.end_date = ?7',
    "rj.status = 'downloaded'",
    'rj.r2_object_key = ?8',
    'rj.content_sha256 = ?9',
    'rj.content_bytes = ?10',
    'rj.r2_initial_version = ?11',
    'rj.r2_initial_etag = ?12',
    'rj.downloaded_at = ?13',
    'rj.raw_row_count IS NULL',
    'rj.row_count IS NULL',
    'rj.ingested_at IS NULL',
  ]) {
    assert.ok(sql.includes(fragment), `missing authority fragment: ${fragment}`);
  }
}

assert.throws(
  () => createD1SearchTermFactStageRepository({}),
  (error) => error instanceof SearchTermFactStageRepositoryError
    && error.code === 'SEARCH_TERM_STAGE_DB_INVALID',
);

// loadJob binds the report receipt to the durable Amazon profile account type used by the parser.
{
  const db = new FakeD1();
  db.firstResult = job();
  const repository = createD1SearchTermFactStageRepository(db);
  const loaded = await repository.loadJob('job-1');
  assert.equal(loaded.account_type, 'seller');
  assert.equal(db.firstCalls.length, 1);
  assert.deepEqual(db.firstCalls[0].args, ['job-1']);
  assert.match(db.firstCalls[0].sql, /JOIN amazon_profiles ap ON ap\.profile_id = rj\.profile_id/);
  assert.match(db.firstCalls[0].sql, /ap\.account_type/);
  assert.match(db.firstCalls[0].sql, /WHERE rj\.job_id = \?1/);
}

// inspectStage returns only the immutable fields needed to prove deterministic stage identity.
{
  const db = new FakeD1();
  db.allResult = { results:[
    { dataset_key:'search_term_daily', source_row_ordinal:0, logical_row_key:'rk-0', canonical_row_json:'{}' },
  ] };
  const repository = createD1SearchTermFactStageRepository(db);
  const staged = await repository.inspectStage('job-1');
  assert.equal(staged.length, 1);
  assert.match(db.allCalls[0].sql, /FROM report_fact_stage/);
  assert.match(db.allCalls[0].sql, /ORDER BY source_row_ordinal/);
  assert.deepEqual(db.allCalls[0].args, ['job-1']);
}

// Full replacement + completion receipt is one ordered D1 batch with exact authority on every mutation.
{
  const db = new FakeD1();
  const repository = createD1SearchTermFactStageRepository(db);
  const rows = [row(0), row(1)];
  const committed = await repository.replaceStageAndPersistReceipt({ job:job(), rows, rawRowCount:2 });
  assert.equal(committed, true);
  assert.equal(db.batchCalls.length, 1);
  const statements = db.batchCalls[0];
  assert.equal(statements.length, 4);

  const [remove, firstInsert, secondInsert, receipt] = statements;
  assert.match(remove.sql, /DELETE FROM report_fact_stage/);
  assert.match(remove.sql, /AND EXISTS/);
  assertExactAuthority(remove.sql);

  for (const insert of [firstInsert, secondInsert]) {
    assert.match(insert.sql, /INSERT INTO report_fact_stage/);
    assert.match(insert.sql, /SELECT \?1, \?14, \?15, \?16, \?17/);
    assert.match(insert.sql, /WHERE EXISTS/);
    assertExactAuthority(insert.sql);
  }

  assert.match(receipt.sql, /UPDATE report_jobs AS rj/);
  assert.match(receipt.sql, /SET raw_row_count = \?14/);
  assertExactAuthority(receipt.sql);

  const authorityArgs = [
    'job-1','run-1','profile-1','SPONSORED_PRODUCTS','spSearchTerm',
    '2026-08-12','2026-08-12','raw/job-1.json.gz',SHA,123,
    'version-1','etag-1','2026-08-15T14:32:00Z',
  ];
  assert.deepEqual(remove.args, authorityArgs);
  assert.deepEqual(firstInsert.args, [...authorityArgs, 'search_term_daily',0,'rk-0',rows[0].canonicalRowJson]);
  assert.deepEqual(secondInsert.args, [...authorityArgs, 'search_term_daily',1,'rk-1',rows[1].canonicalRowJson]);
  assert.deepEqual(receipt.args, [...authorityArgs, 2]);
}

// Empty Amazon reports still use the same atomic boundary: guarded DELETE + raw_row_count=0 receipt.
{
  const db = new FakeD1();
  const repository = createD1SearchTermFactStageRepository(db);
  await repository.replaceStageAndPersistReceipt({ job:job(), rows:[], rawRowCount:0 });
  const statements = db.batchCalls[0];
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /DELETE FROM report_fact_stage/);
  assert.match(statements[1].sql, /SET raw_row_count = \?14/);
  assert.equal(statements[1].args.at(-1), 0);
}

// A stale exact-authority CAS can never be reported as a committed stage receipt.
{
  const db = new FakeD1();
  db.batchResults = [
    { success:true, meta:{ changes:0 } },
    { success:true, meta:{ changes:1 } },
    { success:true, meta:{ changes:0 } },
  ];
  const repository = createD1SearchTermFactStageRepository(db);
  await expectCode('SEARCH_TERM_STAGE_DB_COMMIT_UNVERIFIED', () =>
    repository.replaceStageAndPersistReceipt({ job:job(), rows:[row(0)], rawRowCount:1 }),
  );
}

// SQL/trigger failures remain causal so the producer can reload durable state and distinguish a race.
{
  const db = new FakeD1();
  db.batchError = new Error('REPORT_FACT_STAGE_RECEIPT_COUNT_MISMATCH');
  const repository = createD1SearchTermFactStageRepository(db);
  const error = await expectCode('SEARCH_TERM_STAGE_DB_BATCH_FAILED', () =>
    repository.replaceStageAndPersistReceipt({ job:job(), rows:[row(0)], rawRowCount:1 }),
  );
  assert.equal(error.cause.message, 'REPORT_FACT_STAGE_RECEIPT_COUNT_MISMATCH');
}

// Invalid caller inputs fail before db.batch and cannot mutate provisional stage state.
for (const [payload, code] of [
  [{ job:job({ status:'processing' }), rows:[row(0)], rawRowCount:1 }, 'SEARCH_TERM_STAGE_DB_JOB_RECEIPT_INVALID'],
  [{ job:job({ raw_row_count:1 }), rows:[row(0)], rawRowCount:1 }, 'SEARCH_TERM_STAGE_DB_JOB_RECEIPT_INVALID'],
  [{ job:job({ content_sha256:'bad' }), rows:[row(0)], rawRowCount:1 }, 'SEARCH_TERM_STAGE_DB_CONTENT_SHA256_INVALID'],
  [{ job:job(), rows:[row(0)], rawRowCount:2 }, 'SEARCH_TERM_STAGE_DB_ROW_COUNT_INVALID'],
  [{ job:job(), rows:[row(0, { datasetKey:'campaign_daily' })], rawRowCount:1 }, 'SEARCH_TERM_STAGE_DB_DATASET_INVALID'],
  [{ job:job(), rows:[row(1)], rawRowCount:1 }, 'SEARCH_TERM_STAGE_DB_ORDINAL_INVALID'],
]) {
  const db = new FakeD1();
  const repository = createD1SearchTermFactStageRepository(db);
  await expectCode(code, () => repository.replaceStageAndPersistReceipt(payload));
  assert.equal(db.batchCalls.length, 0, code);
}

console.log('D1 search term fact stage repository contract: PASS');
