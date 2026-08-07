import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/bid-governance-parity-audit-v1.js', import.meta.url), 'utf8');

assert.match(source, /const AUDIT_VERSION = '1\.0\.1'/);
assert.match(source, /AdsDashboardApp\?\.debug\?\.getBidGovernanceScopedRowsForParity/);
assert.doesNotMatch(source, /\bgetBidGovScopedRows\(/);
assert.match(source, /source: 'query'/);
assert.match(source, /adProduct: 'SP'/);
assert.match(source, /executionAuthorized: false/);
assert.match(source, /migrationCandidate: pass/);
assert.match(source, /rawBootstrapFingerprint/);
assert.match(source, /dataFingerprint/);
assert.match(source, /dataFingerprint 缺失/);
assert.match(source, /missingMonths/);
assert.match(source, /结果达到分页上限/);
assert.match(source, /旧 Bid Governance 只治理 Sponsored Products/);
assert.doesNotMatch(source, /PrivateCloudAds\?*\.?(?:loadRaw|loadFullHistory|loadCurrentMonth|loadRecentMonths)|QueryNativeGovernanceGate\.(?:adopt|refresh|assertActionAllowed)|suggestedBid|report_slots/);

const values = new Map([
  ['dateStart', { value: '2026-06-01' }],
  ['dateEnd', { value: '2026-06-30' }],
  ['filterSource', { value: '' }],
  ['filterPortfolio', { value: '' }],
  ['filterCampaign', { value: '' }],
  ['filterAdGroup', { value: '' }],
  ['filterTargeting', { value: '' }],
  ['filterMatchType', { value: '' }],
  ['filterAdType', { value: '' }],
  ['filterAdProduct', { value: '' }],
  ['filterSearchTerm', { value: '' }],
  ['filterSearchExact', { checked: false }],
]);
const document = {
  readyState: 'loading',
  addEventListener() {},
  getElementById(id) { return values.get(id) || null; },
  createElement() { return { id: '', dataset: {}, style: {}, innerHTML: '', addEventListener() {}, appendChild() {} }; },
  head: { appendChild() {} },
};
class TestCustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
}
const events = [];
let queryRequest = null;
let queryTruncated = false;
let rawLoadCalled = false;
const cloudState = {
  loadedOnce: true,
  rawStale: false,
  loadedScope: 'YTDBNS',
  loadedMonths: ['2026-06'],
  loadedRange: { fromMonth: '2026-06', toMonth: '2026-06', months: ['2026-06'] },
  rawBootstrapFingerprint: 'fp-1',
  dataFingerprint: 'fp-1',
  bootstrap: { coverage: { months: ['2026-06'] } },
};
let globalThisQueryRows = [];
const window = {
  ACTIVE_SHOP: 'YTDBNS',
  ShopScope: { get: () => 'YTDBNS' },
  PrivateCloudAds: {
    state: () => ({ ...cloudState }),
    loadRaw() { rawLoadCalled = true; throw new Error('Parity audit must never load Raw'); },
  },
  QueryNativeModuleData: {
    async ads(request) {
      queryRequest = request;
      return {
        source: 'query-tidb',
        rows: globalThisQueryRows,
        truncated: queryTruncated,
        nextOffset: queryTruncated ? 500 : null,
        governance: { schemaVersion: 'ads-query-governance-v2', readiness: { bidValueNullabilityTrusted: true } },
      };
    },
  },
  addEventListener() {},
  dispatchEvent(event) { events.push(event); return true; },
};
const context = vm.createContext({
  window, document, CustomEvent: TestCustomEvent, console, Error, Date, Map, Set,
  Object, Array, String, Number, Boolean, Math, Promise,
});

const legacyRows = [
  {
    date: '2026-06-01', targetingId: 'T1', campaign: 'C1', adGroup: 'A1', targeting: 'reading glasses', matchType: 'EXACT',
    impressions: 1000, clicks: 50, spend: 10, sales: 50, orders: 2, currentBid: 0.5,
  },
  {
    date: '2026-06-02', targetingId: 'T1', campaign: 'C1', adGroup: 'A1', targeting: 'reading glasses', matchType: 'EXACT',
    impressions: 500, clicks: 20, spend: 5, sales: 25, orders: 1, currentBid: 0.55,
  },
  {
    date: '2026-06-02', targetingId: 'T2', campaign: 'C2', adGroup: 'A2', targeting: 'fashion readers', matchType: 'PHRASE',
    impressions: 300, clicks: 10, spend: 3, sales: 0, orders: 0, currentBid: null,
  },
];
const queryRows = legacyRows.map(row => ({ ...row, bidValueTrusted: true, adProduct: 'SP' }));
globalThisQueryRows = queryRows;
context.__legacyRows = legacyRows;
vm.runInContext('const AdsDashboardApp = { debug: { getBidGovernanceScopedRowsForParity: () => __legacyRows.map(row => ({ ...row })) } };', context);
vm.runInContext(source, context, { filename: 'bid-governance-parity-audit-v1.js' });

const audit = window.BidGovernanceParityAudit;
assert.equal(audit.version, '1.0.1');

const exact = audit.compareRows(legacyRows, queryRows);
assert.equal(exact.verdict, 'pass');
assert.equal(exact.migrationCandidate, true);
assert.equal(exact.executionAuthorized, false);
assert.equal(exact.groupOverlap, 1);
assert.equal(exact.bidMismatch, 0);
assert.equal(exact.bidMissingEither, 0);
assert.equal(exact.metrics.spend.absolute, 0);
assert.equal(exact.metrics.sales.absolute, 0);

const changedQuery = queryRows.map(row => ({ ...row }));
changedQuery[0].spend = 14;
changedQuery[1].currentBid = 0.6;
const changed = audit.compareRows(legacyRows, changedQuery);
assert.equal(changed.verdict, 'fail');
assert.equal(changed.migrationCandidate, false);
assert.equal(changed.metrics.spend.pass, false);
assert.equal(changed.bidMismatch, 1);
assert.ok(changed.mismatches.length >= 1);

const notLoaded = audit.rawEligibility({ scope: 'YTDBNS', from: '2026-06-01', to: '2026-06-30', adProduct: '' }, {
  loadedOnce: false, loadedScope: '', loadedMonths: [], loadedRange: null, rawStale: false,
  rawBootstrapFingerprint: '', dataFingerprint: 'fp-1', bootstrap: { coverage: { months: ['2026-06'] } },
});
assert.equal(notLoaded.ready, false);
assert.ok(notLoaded.reasons.some(reason => /显式加载 Raw/.test(reason)));

const stale = audit.rawEligibility({ scope: 'YTDBNS', from: '2026-06-01', to: '2026-06-30', adProduct: '' }, { ...cloudState, rawStale: true });
assert.equal(stale.ready, false);
assert.ok(stale.reasons.some(reason => /过期/.test(reason)));

const missingFingerprint = audit.rawEligibility({ scope: 'YTDBNS', from: '2026-06-01', to: '2026-06-30', adProduct: '' }, {
  ...cloudState, rawBootstrapFingerprint: '', dataFingerprint: 'fp-1',
});
assert.equal(missingFingerprint.ready, false);
assert.equal(missingFingerprint.fingerprintMatch, false);
assert.ok(missingFingerprint.reasons.some(reason => /dataFingerprint 缺失/.test(reason)));

const mismatchFingerprint = audit.rawEligibility({ scope: 'YTDBNS', from: '2026-06-01', to: '2026-06-30', adProduct: '' }, {
  ...cloudState, rawBootstrapFingerprint: 'fp-old', dataFingerprint: 'fp-new',
});
assert.equal(mismatchFingerprint.ready, false);
assert.ok(mismatchFingerprint.reasons.some(reason => /不一致/.test(reason)));

const wrongProduct = audit.rawEligibility({ scope: 'YTDBNS', from: '2026-06-01', to: '2026-06-30', adProduct: 'SB' }, cloudState);
assert.equal(wrongProduct.ready, false);
assert.ok(wrongProduct.reasons.some(reason => /Sponsored Products/.test(reason)));

const partialWithoutDates = audit.rawEligibility({ scope: 'YTDBNS', from: '', to: '', adProduct: '' }, {
  ...cloudState,
  loadedMonths: ['2026-06'],
  loadedRange: { fromMonth: '2026-06', toMonth: '2026-06', months: ['2026-06'] },
  bootstrap: { coverage: { months: ['2026-04', '2026-05', '2026-06'] } },
});
assert.equal(partialWithoutDates.ready, false);
assert.deepEqual([...partialWithoutDates.missingMonths], ['2026-04', '2026-05']);
assert.ok(partialWithoutDates.reasons.some(reason => /完整历史 Raw/.test(reason)));

const accumulatedCoverage = audit.rawEligibility({ scope: 'YTDBNS', from: '2026-04-01', to: '2026-06-30', adProduct: '' }, {
  ...cloudState,
  loadedMonths: ['2026-04', '2026-05', '2026-06'],
  loadedRange: { fromMonth: '2026-06', toMonth: '2026-06', months: ['2026-06'] },
  bootstrap: { coverage: { months: ['2026-04', '2026-05', '2026-06'] } },
});
assert.equal(accumulatedCoverage.ready, true, 'Accumulated loadedMonths should be authoritative even when the last loadedRange is narrower');
assert.deepEqual([...accumulatedCoverage.requiredMonths], ['2026-04', '2026-05', '2026-06']);
assert.deepEqual([...accumulatedCoverage.missingMonths], []);

queryTruncated = false;
const runResult = await audit.run({ force: true });
assert.equal(runResult.status, 'ready');
assert.equal(runResult.comparison.verdict, 'pass');
assert.equal(runResult.executionAuthorized, false);
assert.equal(queryRequest.source, 'query');
assert.equal(queryRequest.adProduct, 'SP');
assert.equal(queryRequest.scope, 'YTDBNS');
assert.equal(rawLoadCalled, false);
assert.ok(events.some(event => event.type === 'lr:bid-governance-parity-ready'));

queryTruncated = true;
await assert.rejects(() => audit.run({ force: true }), error => {
  assert.equal(error.status, 409);
  assert.match(error.message, /分页上限/);
  return true;
});
assert.equal(audit.state().status, 'error');
assert.equal(audit.state().comparison, null);
assert.equal(audit.state().executionAuthorized, false);
assert.equal(rawLoadCalled, false);

console.log('Bid Governance parity audit contracts passed');
