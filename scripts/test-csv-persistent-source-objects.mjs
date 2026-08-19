import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createCsvImportSourceObjectStore,
  bindCsvImportSourceReceipt,
} from '../cloudflare/runtime/csv-import-source-object.js';
import {
  ingestSearchTermCsvOnce,
  CsvSearchTermIngestionError,
} from '../cloudflare/runtime/csv-search-term-ingestion.js';

const encoder = new TextEncoder();
const CSV = [
  'Date,Campaign Name,Ad Group Name,Customer Search Term,Impressions,Clicks,Spend,7 Day Total Orders,7 Day Total Sales,7 Day Total Units',
  '2026-08-01,Campaign A,Group A,reading glasses,10,2,1.25,1,12.50,1',
].join('\n');
const SOURCE_CONTEXT = Object.freeze({ storeId:'store-01', contentType:'text/csv', importerUserId:'user-dev-owner' });
const UPLOADED_AT = '2026-08-19T02:40:00.000Z';

function assertCreateOnlyConditional(options) {
  assert.ok(options?.onlyIf instanceof Headers);
  assert.equal(options.onlyIf.get('if-none-match'), '*');
  assert.deepEqual([...options.onlyIf.keys()], ['if-none-match']);
}

function makeBucket({ failPut = false } = {}) {
  const objects = new Map();
  let puts = 0;
  return {
    objects,
    get putCount() { return puts; },
    async put(key, bytes, options) {
      puts += 1;
      if (failPut) throw new Error('synthetic_r2_failure');
      assertCreateOnlyConditional(options);
      assert.equal(new Uint8Array(options?.sha256 || new ArrayBuffer(0)).byteLength, 32);
      if (objects.has(key)) return null;
      const copy = new Uint8Array(bytes);
      objects.set(key, copy);
      return { etag:`etag-${puts}`, version:`version-${puts}` };
    },
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
    },
  };
}

function inputFromBytes(bytes, fileName = 'search-terms.csv') {
  return {
    csvText:new TextDecoder('utf-8').decode(bytes),
    sourceBytes:bytes,
    sourceFileName:fileName,
    uploadedAt:UPLOADED_AT,
    marketplace:'US',
    currencyCode:'USD',
  };
}

async function describe(bytes) {
  const bucket = makeBucket();
  const store = createCsvImportSourceObjectStore({ bucket });
  return store.describe({
    bytes,
    storeId:SOURCE_CONTEXT.storeId,
    sourceFileName:'search-terms.csv',
    contentType:SOURCE_CONTEXT.contentType,
    importerUserId:SOURCE_CONTEXT.importerUserId,
    uploadedAt:UPLOADED_AT,
  });
}

const lf = encoder.encode(`${CSV}\n`);
const noTrailing = encoder.encode(CSV);
const crlf = encoder.encode(`${CSV.replaceAll('\n', '\r\n')}\r\n`);
const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...lf]);
const descriptors = await Promise.all([lf, noTrailing, crlf, bom].map(describe));
assert.equal(new Set(descriptors.map((item) => item.contentSha256)).size, 4, 'exact-byte variants must hash differently');
assert.deepEqual(descriptors.map((item) => item.contentBytes), [lf.byteLength, noTrailing.byteLength, crlf.byteLength, bom.byteLength]);

// Persistent R2 create-only source object + replay from receipt.
const replayBucket = makeBucket();
const replayStore = createCsvImportSourceObjectStore({ bucket:replayBucket });
const replayDescriptor = await replayStore.describe({
  bytes:lf,
  storeId:SOURCE_CONTEXT.storeId,
  sourceFileName:'search-terms.csv',
  contentType:'text/csv',
  importerUserId:SOURCE_CONTEXT.importerUserId,
  uploadedAt:UPLOADED_AT,
});
const persisted = await replayStore.persist(replayDescriptor);
const receipt = bindCsvImportSourceReceipt('csv-replay-1', persisted);
const replay = await replayStore.verify(receipt);
assert.equal(replay.ok, true);
assert.equal(replay.contentSha256, replayDescriptor.contentSha256);
assert.deepEqual([...replay.bytes], [...lf]);
await assert.rejects(() => replayStore.persist(replayDescriptor), (error) => error?.code === 'CSV_SOURCE_R2_PERSIST_FAILED');

// Duplicate D1 authority must short-circuit before R2 PUT.
const duplicateBucket = makeBucket();
const duplicateStore = createCsvImportSourceObjectStore({ bucket:duplicateBucket });
let duplicateCommitCalls = 0;
const duplicateOutcome = await ingestSearchTermCsvOnce({
  importId:'csv-duplicate-attempt',
  input:inputFromBytes(lf),
  sourceContext:SOURCE_CONTEXT,
  sourceObjectStore:duplicateStore,
  repository:{
    async findDuplicate() { return { import_id:'csv-existing', status:'published', uploaded_at:UPLOADED_AT, published_at:UPLOADED_AT }; },
    async recordRejectedImport() { throw new Error('must_not_record'); },
    async commitValidatedImport() { duplicateCommitCalls += 1; throw new Error('must_not_commit'); },
  },
  now:UPLOADED_AT,
});
assert.equal(duplicateOutcome.action, 'csv_import_duplicate');
assert.equal(duplicateBucket.putCount, 0, 'duplicate import must not write R2 again');
assert.equal(duplicateCommitCalls, 0);

// R2 failure must fail closed before any D1 authoritative write.
const failingBucket = makeBucket({ failPut:true });
const failingStore = createCsvImportSourceObjectStore({ bucket:failingBucket });
let r2FailureD1Writes = 0;
await assert.rejects(
  () => ingestSearchTermCsvOnce({
    importId:'csv-r2-failure',
    input:inputFromBytes(lf),
    sourceContext:SOURCE_CONTEXT,
    sourceObjectStore:failingStore,
    repository:{
      async findDuplicate() { return null; },
      async recordRejectedImport() { r2FailureD1Writes += 1; },
      async commitValidatedImport() { r2FailureD1Writes += 1; },
    },
    now:UPLOADED_AT,
  }),
  (error) => error instanceof CsvSearchTermIngestionError && error.code === 'CSV_IMPORT_SOURCE_PERSIST_FAILED',
);
assert.equal(r2FailureD1Writes, 0, 'R2 failure must not create batch, stage, or facts');

// D1 transaction failure after successful R2 preservation may leave an identifiable orphan raw object,
// but no successful publication receipt can escape.
const orphanBucket = makeBucket();
const orphanStore = createCsvImportSourceObjectStore({ bucket:orphanBucket });
let commitAttempts = 0;
await assert.rejects(
  () => ingestSearchTermCsvOnce({
    importId:'csv-d1-failure',
    input:inputFromBytes(lf),
    sourceContext:SOURCE_CONTEXT,
    sourceObjectStore:orphanStore,
    repository:{
      async findDuplicate() { return null; },
      async recordRejectedImport() { throw new Error('unexpected_rejected'); },
      async commitValidatedImport() { commitAttempts += 1; throw new Error('synthetic_d1_transaction_failure'); },
    },
    now:UPLOADED_AT,
  }),
  (error) => error instanceof CsvSearchTermIngestionError && error.code === 'CSV_IMPORT_COMMIT_FAILED',
);
assert.equal(commitAttempts, 1);
assert.equal(orphanBucket.objects.size, 1, 'successful raw preservation remains identifiable for orphan reconciliation');

const migration = spawnSync('python3', ['scripts/test-csv-import-source-object-migration.py'], {
  cwd:process.cwd(),
  encoding:'utf8',
});
assert.equal(migration.status, 0, `migration contract failed:\n${migration.stdout}\n${migration.stderr}`);

console.log(JSON.stringify({
  ok:true,
  contract:'csv-persistent-source-objects-v1',
  exactByteHashing:true,
  duplicateR2Writes:0,
  r2FailurePublishesFacts:false,
  d1FailureLeavesIdentifiableOrphan:true,
  persistentReplay:true,
  amazonNetworkTransport:false,
}));
