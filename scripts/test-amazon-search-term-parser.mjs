import assert from 'node:assert/strict';
import { canonicalizeSearchTermFact, normalizeSearchTermV1 } from '../cloudflare/runtime/amazon-search-term-parser.js';

const base = {
  date: '2026-08-12', campaignId: '12345678901234567890', adGroupId: '22345678901234567890',
  keywordId: '32345678901234567890', keywordType: 'BROAD', keyword: 'Reading Glasses',
  matchType: 'BROAD', targeting: 'reading glasses', searchTerm: '  Reading\tGlasses  ',
  campaignBudgetCurrencyCode: 'USD', impressions: 60, clicks: 6, cost: '0.600000',
  purchases1d: 1, purchases7d: 2, purchases14d: 3, purchases30d: 4,
  unitsSoldClicks1d: 1, unitsSoldClicks7d: 3, unitsSoldClicks14d: 4, unitsSoldClicks30d: 5,
  sales1d: '3.000000', sales7d: '9.450000', sales14d: '12.000000', sales30d: '15.000000',
};

const seller = await canonicalizeSearchTermFact({ row: base, profileId:'999999999999999999', accountType:'seller', sourceReportJobId:'job-1' });
assert.equal(seller.fact.keywordId, base.keywordId);
assert.equal(seller.fact.targetId, null);
assert.equal(seller.fact.normalizedSearchTerm, 'reading glasses');
assert.equal(seller.fact.costMicros, '600000');
assert.equal(seller.fact.purchases, 2);
assert.equal(seller.fact.unitsSold, 3);
assert.equal(seller.fact.salesMicros, '9450000');
const sellerMetrics = JSON.parse(seller.fact.metricsJson);
assert.equal(sellerMetrics.attributionWindows.purchases['14'], 3);
assert.equal(sellerMetrics.attributionWindows.salesMicros['30'], '15000000');

const vendor = await canonicalizeSearchTermFact({ row: base, profileId:'999999999999999999', accountType:'vendor', sourceReportJobId:'job-2' });
assert.equal(vendor.fact.purchases, 3);
assert.equal(vendor.fact.unitsSold, 4);
assert.equal(vendor.fact.salesMicros, '12000000');

const targetRow = { ...base, keywordId:'42345678901234567890', keywordType:'TARGETING_EXPRESSION', matchType:null };
const target = await canonicalizeSearchTermFact({ row: targetRow, profileId:'999999999999999999', accountType:'seller', sourceReportJobId:'job-3' });
assert.equal(target.fact.keywordId, null);
assert.equal(target.fact.targetId, targetRow.keywordId);
assert.equal(target.fact.sourceKeywordType, 'TARGETING_EXPRESSION');

assert.equal(normalizeSearchTermV1('ＲＥＡＤＩＮＧ   Glasses'), 'reading glasses');
assert.equal(seller.canonicalRowJson, (await canonicalizeSearchTermFact({ row:{...base}, profileId:'999999999999999999', accountType:'seller', sourceReportJobId:'job-1' })).canonicalRowJson);

try {
  await canonicalizeSearchTermFact({ row:{...base, campaignId:Number.MAX_SAFE_INTEGER + 1}, profileId:'p1', accountType:'seller', sourceReportJobId:'job-1' });
  assert.fail('unsafe ID accepted');
} catch (e) { assert.equal(e.code, 'SOURCE_ID_PRECISION_UNSAFE'); }

try {
  await canonicalizeSearchTermFact({ row:{...base, cost:0.6}, profileId:'p1', accountType:'seller', sourceReportJobId:'job-1' });
  assert.fail('numeric money accepted');
} catch (e) { assert.equal(e.code, 'SOURCE_MONEY_LEXICAL_REQUIRED'); }

const changedRaw = await canonicalizeSearchTermFact({ row:{...base, searchTerm:'reading glasses'}, profileId:'999999999999999999', accountType:'seller', sourceReportJobId:'job-1' });
assert.notEqual(seller.fact.rowKey, changedRaw.fact.rowKey);
assert.equal(seller.fact.normalizedSearchTerm, changedRaw.fact.normalizedSearchTerm);

console.log(JSON.stringify({ ok:true, seller7d:true, vendor14d:true, allWindowsPreserved:true, exactMoney:true, safeIds:true, rawSearchTermIdentity:true }, null, 2));
