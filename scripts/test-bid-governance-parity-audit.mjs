import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/bid-governance-parity-audit-v1.js', import.meta.url), 'utf8');
assert.match(source, /const AUDIT_VERSION = '1\.0\.4'/);
assert.match(source, /getBidGovernanceScopedRowsForParity/);
assert.match(source, /getBidGovernanceControlRowsForParity/);
assert.match(source, /function compareBidControls\(/);
assert.match(source, /legacyBidComparable/);
assert.match(source, /legacyBidParity/);
assert.match(source, /executionAuthorized: false/);
assert.doesNotMatch(source, /PrivateCloudAds\?*\.?(?:loadRaw|loadFullHistory|loadCurrentMonth|loadRecentMonths)|QueryNativeGovernanceGate\.(?:adopt|refresh|assertActionAllowed)|suggestedBid|report_slots/);

const values = new Map([
  ['dateStart', { value: '2026-06-01' }], ['dateEnd', { value: '2026-06-30' }],
  ['filterSource', { value: '' }], ['filterPortfolio', { value: '' }], ['filterCampaign', { value: '' }],
  ['filterAdGroup', { value: '' }], ['filterTargeting', { value: '' }], ['filterMatchType', { value: '' }],
  ['filterAdType', { value: '' }], ['filterAdProduct', { value: '' }], ['filterSearchTerm', { value: '' }],
  ['filterSearchExact', { checked: false }],
]);
const document = {
  readyState: 'loading', addEventListener() {}, getElementById(id) { return values.get(id) || null; },
  createElement() { return { id: '', dataset: {}, style: {}, innerHTML: '', addEventListener() {}, appendChild() {} }; },
  head: { appendChild() {} },
};
class TestCustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
const events = [];
let queryRequest = null; let queryTruncated = false; let rawLoadCalled = false;
const cloudState = {
  loadedOnce: true, rawStale: false, loadedScope: 'YTDBNS', loadedMonths: ['2026-06'],
  loadedRange: { fromMonth: '2026-06', toMonth: '2026-06', months: ['2026-06'] },
  rawBootstrapFingerprint: 'fp-1', dataFingerprint: 'fp-1', bootstrap: { coverage: { months: ['2026-06'] } },
};
let globalThisQueryRows = []; let readinessOverrides = {};
const baseReadiness = {
  targetingIdentityReady: true, bidSourceColumnReady: true, bidValueNullabilityTrusted: true,
  adProductReady: false, advertisedProductIdentityReady: false, attributionMaturityReady: false, bidGovernanceReady: false,
};
const window = {
  ACTIVE_SHOP: 'YTDBNS', ShopScope: { get: () => 'YTDBNS' },
  PrivateCloudAds: { state: () => ({ ...cloudState }), loadRaw() { rawLoadCalled = true; throw new Error('Parity audit must never load Raw'); } },
  QueryNativeModuleData: { async ads(request) { queryRequest = request; return { source: 'query-tidb', rows: globalThisQueryRows, truncated: queryTruncated, nextOffset: queryTruncated ? 500 : null, governance: { schemaVersion: 'ads-query-governance-v2', readiness: { ...baseReadiness, ...readinessOverrides } } }; } },
  addEventListener() {}, dispatchEvent(event) { events.push(event); return true; },
};
const context = vm.createContext({ window, document, CustomEvent: TestCustomEvent, console, Error, Date, Map, Set, Object, Array, String, Number, Boolean, Math, Promise });

const legacyRows = [
  { date: '2026-06-01', targetingId: 'T1', campaign: 'C1', adGroup: 'A1', targeting: 'reading glasses', matchType: 'EXACT', impressions: 1000, clicks: 50, spend: 10, sales: 50, orders: 2, currentBid: 0.50 },
  { date: '2026-06-02', targetingId: 'T1', campaign: 'C1', adGroup: 'A1', targeting: 'reading glasses', matchType: 'EXACT', impressions: 500, clicks: 20, spend: 5, sales: 25, orders: 1, currentBid: 0.55 },
  { date: '2026-06-02', targetingId: 'T2', campaign: 'C2', adGroup: 'A2', targeting: 'fashion readers', matchType: 'PHRASE', impressions: 300, clicks: 10, spend: 3, sales: 0, orders: 0, currentBid: 0.40 },
];
const legacyControls = legacyRows.map(({ date, targetingId, campaign, adGroup, targeting, matchType, currentBid }) => ({ date, targetingId, campaign, adGroup, targeting, matchType, currentBid }));
const queryRows = legacyRows.map(row => ({ ...row, bidValueTrusted: true, adProduct: 'SP' }));
globalThisQueryRows = queryRows;
context.__legacyRows = legacyRows; context.__legacyControls = legacyControls;
vm.runInContext('const AdsDashboardApp = { debug: { getBidGovernanceScopedRowsForParity: () => __legacyRows.map(row => ({ ...row })), getBidGovernanceControlRowsForParity: () => __legacyControls.map(row => ({ ...row })) } };', context);
vm.runInContext(source, context, { filename: 'bid-governance-parity-audit-v1.js' });
const audit = window.BidGovernanceParityAudit;
assert.equal(audit.version, '1.0.4');

// Performance parity must ignore Bid values completely.
const queryWithDifferentBids = queryRows.map((row, index) => ({ ...row, currentBid: 9 + index }));
const performance = audit.compareRows(legacyRows, queryWithDifferentBids);
assert.equal(performance.metricParityPass, true);
assert.equal(performance.verdict, 'pass');
assert.equal(performance.groupOverlap, 1);
assert.equal(performance.mismatches.length, 0);
assert.equal('bidParityPass' in performance, false);

// Control parity collapses repeated search-term rows to the latest Bid per route.
const controlPass = audit.compareBidControls(legacyControls, queryRows);
assert.equal(controlPass.comparable, true);
assert.equal(controlPass.pass, true);
assert.equal(controlPass.matchedGroups, 2);
assert.equal(controlPass.bidCompared, 2);
assert.equal(controlPass.bidMismatch, 0);
assert.equal(controlPass.targetingIdMismatch, 0);

const bidMismatchRows = queryRows.map(row => ({ ...row }));
bidMismatchRows[1].currentBid = 0.60;
const controlMismatch = audit.compareBidControls(legacyControls, bidMismatchRows);
assert.equal(controlMismatch.comparable, true);
assert.equal(controlMismatch.pass, false);
assert.equal(controlMismatch.bidMismatch, 1);
assert.ok(controlMismatch.mismatches.some(row => row.state === 'bid-mismatch'));

const ambiguousQuery = [...queryRows.map(row => ({ ...row })), { ...queryRows[1], currentBid: 0.61 }];
const ambiguous = audit.compareBidControls(legacyControls, ambiguousQuery);
assert.equal(ambiguous.comparable, false);
assert.equal(ambiguous.pass, false);
assert.equal(ambiguous.bidAmbiguousEither, 1);

const missingBidLegacy = legacyControls.map(row => ({ ...row }));
missingBidLegacy[2].currentBid = null;
const missingBid = audit.compareBidControls(missingBidLegacy, queryRows);
assert.equal(missingBid.comparable, false);
assert.equal(missingBid.bidMissingEither, 1);

const idMismatchRows = queryRows.map(row => ({ ...row }));
idMismatchRows[2].targetingId = 'T9';
const idMismatch = audit.compareBidControls(legacyControls, idMismatchRows);
assert.equal(idMismatch.comparable, true);
assert.equal(idMismatch.pass, false);
assert.equal(idMismatch.targetingIdMismatch, 1);

const notLoaded = audit.rawEligibility({ scope: 'YTDBNS', from: '2026-06-01', to: '2026-06-30', adProduct: '' }, { loadedOnce: false, loadedScope: '', loadedMonths: [], loadedRange: null, rawStale: false, rawBootstrapFingerprint: '', dataFingerprint: 'fp-1', bootstrap: { coverage: { months: ['2026-06'] } } });
assert.equal(notLoaded.ready, false);
assert.ok(notLoaded.reasons.some(reason => /显式加载 Raw/.test(reason)));

// Real run: Bid Control passes, but source governance blockers keep migration closed.
readinessOverrides = {};
const runResult = await audit.run({ force: true });
assert.equal(runResult.status, 'ready');
assert.equal(runResult.comparison.metricParityPass, true);
assert.equal(runResult.comparison.bidControlComparable, true);
assert.equal(runResult.comparison.bidControlParityPass, true);
assert.equal(runResult.comparison.bidComparable, true);
assert.equal(runResult.comparison.bidParityPass, true);
assert.equal(runResult.comparison.verdict, 'warn');
assert.deepEqual([...runResult.comparison.migrationBlockers], ['adProductReady', 'advertisedProductIdentityReady', 'attributionMaturityReady']);
assert.equal(runResult.comparison.migrationCandidate, false);
assert.equal(runResult.executionAuthorized, false);
assert.equal(queryRequest.source, 'query');
assert.equal(queryRequest.adProduct, '');
assert.equal(rawLoadCalled, false);
assert.ok(events.some(event => event.type === 'lr:bid-governance-parity-ready'));

// A control mismatch must fail even while execution remains closed.
context.__legacyControls[1].currentBid = 0.60;
const failedRun = await audit.run({ force: true });
assert.equal(failedRun.comparison.verdict, 'fail');
assert.equal(failedRun.comparison.bidControlComparable, true);
assert.equal(failedRun.comparison.bidControlParityPass, false);
assert.ok(failedRun.comparison.migrationBlockers.includes('legacyBidParity'));
assert.equal(failedRun.comparison.migrationCandidate, false);
assert.equal(failedRun.executionAuthorized, false);
context.__legacyControls[1].currentBid = 0.55;

// Hypothetical fully proven source + control parity can become a migration candidate, never execution authorization.
readinessOverrides = { adProductReady: true, advertisedProductIdentityReady: true, attributionMaturityReady: true, bidGovernanceReady: true };
const provenRun = await audit.run({ force: true });
assert.equal(provenRun.comparison.verdict, 'pass');
assert.deepEqual([...provenRun.comparison.migrationBlockers], []);
assert.equal(provenRun.comparison.migrationCandidate, true);
assert.equal(provenRun.executionAuthorized, false);

queryTruncated = true;
await assert.rejects(() => audit.run({ force: true }), error => { assert.equal(error.status, 409); assert.match(error.message, /分页上限/); return true; });
assert.equal(audit.state().status, 'error');
assert.equal(audit.state().comparison, null);
assert.equal(audit.state().executionAuthorized, false);
assert.equal(rawLoadCalled, false);

console.log('Bid Governance performance and Bid Control parity contracts passed');
