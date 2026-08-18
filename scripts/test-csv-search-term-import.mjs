import assert from 'node:assert/strict';
import {
  CsvSearchTermImportError,
  buildHeaderMap,
  parseAmazonSearchTermCsv,
  parseBoundedCsv,
} from '../cloudflare/runtime/csv-search-term-import.js';

const csv = [
  'Date,Portfolio name,Campaign Name,Ad Group Name,Targeting,Match Type,Customer Search Term,Impressions,Clicks,Spend,7 Day Total Orders,7 Day Total Sales,7 Day Total Units',
  '08/12/2026,Readers,Campaign A,Ad Group A,reading glasses,BROAD,reading glasses men,100,10,$12.34,2,$40.00,2',
  '08/12/2026,Readers,Campaign A,Ad Group A,reading glasses,BROAD,"reading, glasses women",80,8,$9.00,1,$25.00,1',
].join('\r\n');

const parsed = await parseAmazonSearchTermCsv({
  csvText:csv,
  sourceFileName:'Sponsored Products Search term report.csv',
  marketplace:'US',
  currencyCode:'USD',
  uploadedAt:'2026-08-18T01:00:00.000Z',
});
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

const duplicate = [
  csv.split('\r\n')[0],
  csv.split('\r\n')[1],
  csv.split('\r\n')[1],
].join('\n');
const duplicateParsed = await parseAmazonSearchTermCsv({
  csvText:duplicate,
  sourceFileName:'duplicate.csv',
  uploadedAt:'2026-08-18T01:00:00.000Z',
});
assert.equal(duplicateParsed.ok, false);
assert.ok(duplicateParsed.errors.some((error) => error.errorCode === 'CSV_DUPLICATE_LOGICAL_ROW'));

console.log(JSON.stringify({ ok:true, rows:parsed.rowCount, schemaVersion:parsed.schemaVersion }));
