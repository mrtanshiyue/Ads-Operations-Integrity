import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CsvSearchTermImportError,
  buildHeaderMap,
  parseAmazonSearchTermCsv,
  parseBoundedCsv,
} from '../cloudflare/runtime/csv-search-term-import.js';
import { createD1CsvSearchTermImportRepository } from '../cloudflare/runtime/csv-search-term-import-repository.js';
import { ingestSearchTermCsvOnce } from '../cloudflare/runtime/csv-search-term-ingestion.js';
import { createCsvImportSourceObjectStore } from '../cloudflare/runtime/csv-import-source-object.js';

const csv = [
  'Date,Portfolio name,Campaign Name,Ad Group Name,Targeting,Match Type,Customer Search Term,Impressions,Clicks,Spend,7 Day Total Orders,7 Day Total Sales,7 Day Total Units',
  '08/12/2026,Readers,Campaign A,Ad Group A,reading glasses,BROAD,reading glasses men,100,10,$12.34,2,$40.00,2',
  '08/12/2026,Readers,Campaign A,Ad Group A,reading glasses,BROAD,"reading, glasses women",80,8,$9.00,1,$25.00,1',
].join('\r\n');
const sourceBytes = new TextEncoder().encode(csv);

const input = {
  csvText:csv,
  sourceBytes,
  sourceFileName:'Sponsored Products Search term report.csv',
  marketplace:'US',
  currencyCode:'USD',
  uploadedAt:'2026-08-18T01:00:00.000Z',
};
const parsed = await parseAmazonSearchTermCsv(input);
assert.equal(parsed.ok, true);
assert.equal(parsed.schemaVersion, 'csv-import-v1');
assert.equal(parsed.reportStartDate, '2026-08-12');
assert.equal(parsed.reportEndDate, '2026-08-12');
assert.equal(parsed.rowCount, 2);
assert.equal(parsed.acceptedRows, 2);
assert.equal(parsed.rejectedRows, 0);
assert.equal(parsed.rows[0].fact.costMicros, '12340000');
assert.equal(parsed.rows[1].fact.searchTerm, 'reading, glasses women');
assert.match(parsed.contentSha256, /^[0-9a-f]{64}$/);
assert.notEqual(parsed.rows[0].logicalRowKey, parsed.rows[1].logicalRowKey);

const localized = [
  '预算货币,广告主账户 ID,广告组合编号,广告组合名称,广告活动编号,广告活动名称,广告组编号,广告组名称,搜索词,日期,投放方案编号,目标竞价,投放类型,投放状态,投放方案,投放匹配类型-Targeting match type,展示量,点击量,总成本,购买量,销售额,已售商品数量',
  'USD,"=""amzn1.ads-account.g.example""",100,Readers,"=""108748301332024""",Campaign CN,"=""474054107145274""",Ad Group CN,+0.5 reading glasses,2026年6月25日,442451552344752,0.96,,ENABLED,loose-match,TARGETING_EXPRESSION_PREDEFINED,423,3,4.11,0,0.00,0',
  'USD,"=""amzn1.ads-account.g.example""",100,Readers,"=""108748301332024""",Campaign CN,"=""474054107145274""",Ad Group CN,womens reading glasses,2026年6月26日,,0.96,,ENABLED,,,3330,12,12.12,0,0.00,0',
].join('\n');
const localizedParsed = await parseAmazonSearchTermCsv({
  csvText:localized,
  sourceFileName:'localized-search-term.csv',
  uploadedAt:'2026-08-18T02:00:00.000Z',
});
assert.equal(localizedParsed.ok, true);
assert.equal(localizedParsed.reportStartDate, '2026-06-25');
assert.equal(localizedParsed.reportEndDate, '2026-06-26');
assert.equal(localizedParsed.currencyCode, 'USD');
assert.equal(localizedParsed.advertiserAccountId, 'amzn1.ads-account.g.example');
assert.equal(localizedParsed.rows[0].fact.campaignId, '108748301332024');
assert.equal(localizedParsed.rows[0].fact.adGroupId, '474054107145274');
assert.equal(localizedParsed.rows[0].fact.targetingId, '442451552344752');
assert.equal(localizedParsed.rows[0].fact.targetBidMicros, '960000');
assert.equal(localizedParsed.rows[0].fact.targetingIdentityState, 'resolved_id');
assert.equal(localizedParsed.rows[0].fact.searchTerm, '+0.5 reading glasses');
assert.equal(localizedParsed.rows[1].fact.targeting, '');
assert.equal(localizedParsed.rows[1].fact.targetingIdentityState, 'unresolved');
assert.deepEqual(localizedParsed.validationSummary.targetingIdentityStates, { resolved_id:1, unresolved:1 });

assert.throws(() => buildHeaderMap(['Date','DATE']), (error) => error instanceof CsvSearchTermImportError && error.code === 'CSV_DUPLICATE_HEADERS');
assert.throws(() => parseBoundedCsv('a,b\n"broken,b', 10), (error) => error.code === 'CSV_UNTERMINATED_QUOTE');

const injected = csv.replace('Campaign A,Ad Group A', '=HYPERLINK("bad"),Ad Group A');
const rejected = await parseAmazonSearchTermCsv({
  csvText:injected,
  sourceFileName:'bad.csv',
  uploadedAt:'2026-08-18T01:00:00.000Z',
});
assert.equal(rejected.ok, false);
assert.ok(rejected.errors.some((error) => error.errorCode === 'CSV_FORMULA_INJECTION_BLOCKED'));

const duplicate = [csv.split('\r\n')[0], csv.split('\r\n')[1], csv.split('\r\n')[1]].join('\n');
const duplicateParsed = await parseAmazonSearchTermCsv({
  csvText:duplicate,
  sourceFileName:'duplicate.csv',
  uploadedAt:'2026-08-18T01:00:00.000Z',
});
assert.equal(duplicateParsed.ok, false);
assert.ok(duplicateParsed.errors.some((error) => error.errorCode === 'CSV_DUPLICATE_LOGICAL_ROW'));

const sourceObjects = new Map();
const sourceBucket = {
  async put(key, bytes) {
    if (sourceObjects.has(key)) return null;
    const copy = new Uint8Array(bytes);
    sourceObjects.set(key, copy);
    return { etag:'test-etag', version:'test-version' };
  },
  async get(key) {
    const bytes = sourceObjects.get(key);
    if (!bytes) return null;
    return {
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  },
};
const sourceObjectStore = createCsvImportSourceObjectStore({ bucket:sourceBucket });
const sourceContext = {
  storeId:'store-test',
  contentType:'text/csv',
  importerUserId:'user-test',
};

const calls = [];
const repository = {
  async findDuplicate(args) { calls.push(['findDuplicate', args]); return null; },
  async recordRejectedImport(args) { calls.push(['recordRejectedImport', args]); return { import_id:args.importId, status:'rejected' }; },
  async commitValidatedImport(args) { calls.push(['commitValidatedImport', args]); return { import_id:args.importId, status:'published' }; },
};
const published = await ingestSearchTermCsvOnce({
  importId:'imp-published',
  input,
  repository,
  sourceObjectStore,
  sourceContext,
  now:'2026-08-18T01:01:00.000Z',
});
assert.equal(published.action, 'csv_import_published');
assert.equal(published.published, true);
assert.equal(calls.filter(([name]) => name === 'commitValidatedImport').length, 1);
assert.equal(sourceObjects.size, 1, 'published import must preserve one immutable raw source object');
const commitCall = calls.find(([name]) => name === 'commitValidatedImport')?.[1];
assert.equal(commitCall.sourceObject.contentSha256, published.parsed.contentSha256);
assert.equal(commitCall.sourceObject.contentBytes, sourceBytes.byteLength);

const duplicateRepository = {
  ...repository,
  async findDuplicate() { return { import_id:'imp-existing', status:'published', uploaded_at:'2026-08-18T00:00:00Z' }; },
  async commitValidatedImport() { throw new Error('must not commit duplicate'); },
};
const reused = await ingestSearchTermCsvOnce({
  importId:'imp-ignored',
  input,
  repository:duplicateRepository,
  sourceObjectStore,
  sourceContext,
  now:'2026-08-18T01:01:00.000Z',
});
assert.equal(reused.action, 'csv_import_duplicate');
assert.equal(reused.reused, true);
assert.equal(reused.importId, 'imp-existing');
assert.equal(sourceObjects.size, 1, 'duplicate authority must not create a second R2 object');

const repositorySource = await readFile(new URL('../cloudflare/runtime/csv-search-term-import-repository.js', import.meta.url), 'utf8');
for (const token of ['advertiser_account_id','campaign_id','ad_group_id','targeting_id','targeting_identity_state','target_bid_micros']) {
  assert.match(repositorySource, new RegExp(token), `repository must persist ${token}`);
}
assert.match(repositorySource, /INSERT INTO csv_import_source_objects/, 'repository must bind D1 authority to immutable source receipt');

function fakeStatement(sql, values = []) {
  return {
    sql,
    values,
    bind(...nextValues) { return fakeStatement(sql, nextValues); },
    async first() { return { import_id:'imp-scale-8753', status:'published' }; },
  };
}
const scaleBatches = [];
const scaleDb = {
  prepare(sql) { return fakeStatement(sql); },
  async batch(statements) {
    scaleBatches.push(statements);
    return statements.map(() => ({ success:true, meta:{ changes:1 } }));
  },
};
const realScaleRowCount = 8753;
const scaleParsed = {
  ok:true,
  sourceFileName:'202606 (1).csv',
  marketplace:'US',
  profileId:null,
  advertiserAccountId:'amzn1.ads-account.g.scale',
  currencyCode:'USD',
  reportStartDate:'2026-06-01',
  reportEndDate:'2026-06-30',
  contentSha256:'a'.repeat(64),
  contentBytes:3_202_495,
  rowCount:realScaleRowCount,
  acceptedRows:realScaleRowCount,
  rejectedRows:0,
  validationSummary:{ targetingIdentityStates:{ resolved_id:8750, unresolved:3 } },
  uploadedAt:'2026-08-18T03:13:03.000Z',
  rows:Array.from({ length:realScaleRowCount }, (_, index) => ({
    sourceRowOrdinal:index + 1,
    logicalRowKey:`row-${index + 1}`,
    canonicalRowJson:JSON.stringify({ rowKey:`row-${index + 1}`, reportDate:'2026-06-01' }),
  })),
};
const scaleSourceObject = {
  importId:'imp-scale-8753',
  sourceObjectId:`csv-source-${scaleParsed.contentSha256}`,
  sourceKind:'manual_csv_upload',
  r2BindingKey:'DATA_BUCKET',
  objectKey:`csv/raw/store-scale/spSearchTerm/sha256/aa/${scaleParsed.contentSha256}`,
  contentSha256:scaleParsed.contentSha256,
  contentBytes:scaleParsed.contentBytes,
  contentType:'text/csv',
  sourceFileName:scaleParsed.sourceFileName,
  importerUserId:'user-test',
  uploadedAt:scaleParsed.uploadedAt,
  r2Etag:'etag-scale',
  r2Version:'version-scale',
};
const scaleRepository = createD1CsvSearchTermImportRepository(scaleDb);
const scaleResult = await scaleRepository.commitValidatedImport({
  importId:'imp-scale-8753',
  parsed:scaleParsed,
  sourceObject:scaleSourceObject,
  now:'2026-08-18T03:14:00.000Z',
});
assert.equal(scaleResult.status, 'published');
assert.equal(scaleBatches.length, 1, 'validated import must remain one atomic D1 batch');
const scaleStatements = scaleBatches[0];
assert.ok(scaleStatements.length < 50, `real-scale import must stay below the Free D1 per-invocation query ceiling; got ${scaleStatements.length}`);
assert.match(scaleStatements[0].sql, /INSERT INTO csv_import_source_objects/, 'source receipt must be first in the D1 transactional batch');
const stageStatements = scaleStatements.filter((statement) => /INSERT INTO csv_search_term_stage/.test(statement.sql));
assert.equal(stageStatements.length, Math.ceil(realScaleRowCount / 500));
assert.ok(stageStatements.every((statement) => /FROM json_each\(\?2\)/.test(statement.sql)), 'stage writes must be set-based JSON1 inserts');
assert.equal(stageStatements.reduce((sum, statement) => sum + JSON.parse(statement.values[1]).length, 0), realScaleRowCount);
assert.ok(stageStatements.every((statement) => Buffer.byteLength(statement.values[1], 'utf8') <= 1_000_000), 'stage JSON bind payloads must stay under the repository chunk byte ceiling');

console.log(JSON.stringify({
  ok:true,
  rows:parsed.rowCount,
  localizedRows:localizedParsed.rowCount,
  localizedDailyDate:true,
  excelSafeIds:true,
  unresolvedTargetingPreserved:true,
  schemaVersion:parsed.schemaVersion,
  ingestion:true,
  persistentSourceReceipt:true,
  realScaleRows:realScaleRowCount,
  realScaleD1Statements:scaleStatements.length,
}));
