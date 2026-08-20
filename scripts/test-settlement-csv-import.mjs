import assert from 'node:assert/strict';
import { parseAmazonSettlementCsv } from '../cloudflare/runtime/settlement-csv-import.js';

const headers = [
  'date/time','settlement id','type','order id','sku','description','quantity','marketplace',
  'account type','fulfillment','order city','order state','order postal','tax collection model',
  'product sales','product sales tax','shipping credits','shipping credits tax','gift wrap credits',
  'giftwrap credits tax','Regulatory Fee','Tax On Regulatory Fee','promotional rebates',
  'promotional rebates tax','marketplace withheld tax','selling fees','fba fees',
  'other transaction fees','other','total','transaction status','transaction release date',
];

function row(overrides = {}) {
  const values = {
    'date/time':'Jun 1, 2026 1:00:00 AM PDT',
    'settlement id':'1234567890',
    type:'Order',
    'order id':'111-2222222-3333333',
    sku:'SKU-1',
    description:'Reading Glasses',
    quantity:'1',
    marketplace:'Amazon.com',
    'account type':'Standard Orders',
    fulfillment:'Amazon',
    'order city':'Seattle',
    'order state':'WA',
    'order postal':'98101',
    'tax collection model':'MarketplaceFacilitator',
    'product sales':'10.00',
    'product sales tax':'0',
    'shipping credits':'0',
    'shipping credits tax':'0',
    'gift wrap credits':'0',
    'giftwrap credits tax':'0',
    'Regulatory Fee':'0',
    'Tax On Regulatory Fee':'0',
    'promotional rebates':'0',
    'promotional rebates tax':'0',
    'marketplace withheld tax':'0',
    'selling fees':'-1.00',
    'fba fees':'0',
    'other transaction fees':'0',
    other:'0',
    total:'9.00',
    'transaction status':'Released',
    'transaction release date':'Jun 15, 2026 1:00:00 AM PDT',
    ...overrides,
  };
  return headers.map((header) => csvCell(values[header] ?? '')).join(',');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function fixture(secondRowOverrides = {}) {
  const preamble = [
    '\ufeffAmazon Settlement Report',
    'This report includes Amazon Marketplace transactions.',
    'All amounts in USD',
    'Information line 4',
    'Information line 5',
    'Information line 6',
    'Information line 7',
    'Information line 8',
    'Information line 9',
  ];
  return [
    ...preamble,
    headers.join(','),
    row(),
    row({
      'date/time':'Jun 30, 2026 11:30:00 PM PDT',
      'settlement id':'',
      type:'Transfer',
      'order id':'',
      sku:'',
      description:'Transfer to bank',
      quantity:'',
      marketplace:'amazon.com',
      'tax collection model':'',
      'product sales':'0',
      'selling fees':'0',
      other:'-1,234.56',
      total:'-1,234.56',
      'transaction release date':'',
      ...secondRowOverrides,
    }),
  ].join('\r\n');
}

const source = new TextEncoder().encode(fixture());
const parsed = await parseAmazonSettlementCsv({
  csvBytes:source,
  sourceFileName:'settlement.csv',
  uploadedAt:'2026-08-19T10:00:00.000Z',
});

assert.equal(parsed.ok, true);
assert.equal(parsed.rowCount, 2);
assert.equal(parsed.acceptedRows, 2);
assert.equal(parsed.rejectedRows, 0);
assert.equal(parsed.reportStartDate, '2026-06-01');
assert.equal(parsed.reportEndDate, '2026-06-30');
assert.equal(parsed.currencyCode, 'USD');
assert.equal(parsed.marketplace, 'amazon.com');
assert.equal(parsed.validationSummary.headerLineNumber, 10);
assert.equal(parsed.validationSummary.preambleLineCount, 9);
assert.equal(parsed.reconciliation.status, 'pass');
assert.equal(parsed.reconciliation.differenceMicros, 0);
assert.equal(parsed.reconciliation.mismatchRows, 0);
assert.equal(parsed.reconciliation.reportedTotalMicros, -1_225_560_000);
assert.equal(parsed.rows[1].fact.otherMicros, -1_234_560_000);
assert.equal(parsed.rows[1].fact.totalMicros, -1_234_560_000);
assert.ok(/^[0-9a-f]{64}$/.test(parsed.contentSha256));
assert.equal(parsed.contentBytes, source.byteLength);

const canonical = JSON.parse(parsed.rows[0].canonicalRowJson);
assert.equal(canonical.orderId, '111-2222222-3333333');
assert.equal(canonical.sku, 'SKU-1');
assert.equal(Object.hasOwn(canonical, 'orderCity'), false);
assert.equal(Object.hasOwn(canonical, 'orderState'), false);
assert.equal(Object.hasOwn(canonical, 'orderPostal'), false);

const mismatch = await parseAmazonSettlementCsv({
  csvBytes:new TextEncoder().encode(fixture({ total:'-1,234.55' })),
  sourceFileName:'bad-settlement.csv',
  uploadedAt:'2026-08-19T10:00:00.000Z',
});
assert.equal(mismatch.ok, false);
assert.equal(mismatch.rowCount, 2);
assert.equal(mismatch.acceptedRows, 1);
assert.equal(mismatch.rejectedRows, 1);
assert.equal(mismatch.reconciliation.status, 'fail');
assert.equal(mismatch.reconciliation.mismatchRows, 1);
assert.equal(mismatch.errors[0].errorCode, 'SETTLEMENT_ROW_TOTAL_MISMATCH');

const usContext = await parseAmazonSettlementCsv({
  csvBytes:source,
  sourceFileName:'settlement-us-context.csv',
  uploadedAt:'2026-08-19T10:00:00.000Z',
  marketplace:'US',
});
assert.equal(usContext.ok, true);
assert.equal(usContext.acceptedRows, 2);
assert.equal(usContext.rejectedRows, 0);
assert.equal(usContext.marketplace, 'amazon.com');
assert.deepEqual(usContext.errors, []);

const trueMarketplaceMismatch = await parseAmazonSettlementCsv({
  csvBytes:source,
  sourceFileName:'settlement-wrong-marketplace.csv',
  uploadedAt:'2026-08-19T10:00:00.000Z',
  marketplace:'amazon.co.uk',
});
assert.equal(trueMarketplaceMismatch.ok, false);
assert.equal(trueMarketplaceMismatch.acceptedRows, 0);
assert.equal(trueMarketplaceMismatch.rejectedRows, 2);
assert.equal(trueMarketplaceMismatch.errors.at(-1)?.errorCode, 'SETTLEMENT_MARKETPLACE_CONTEXT_MISMATCH');

console.log('settlement CSV parser and reconciliation: PASS');
