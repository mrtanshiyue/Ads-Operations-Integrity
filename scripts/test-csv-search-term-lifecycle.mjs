import assert from 'node:assert/strict';
import {
  CSV_HISTORICAL_PERIOD_CAPABILITIES,
  CSV_SEARCH_TERM_LIFECYCLE_SCHEMA_VERSION,
  SEARCH_TERM_LIFECYCLE_STATES,
  buildCsvSearchTermLifecycle,
} from '../cloudflare/runtime/csv-search-term-lifecycle.js';

const common = {
  advertiserAccountId: 'adv-01',
  profileId: 'profile-01',
  marketplace: 'US',
  currencyCode: 'USD',
};

const previousFacts = [
  fact('emerging winner', '2026-05-10', 100, 5, 1, 1_000_000, 4_000_000),
  fact('stable winner', '2026-05-11', 180, 8, 3, 2_000_000, 10_000_000),
  fact('declining term', '2026-05-12', 180, 8, 3, 2_000_000, 10_000_000),
  fact('emerging waste', '2026-05-13', 80, 4, 0, 400_000, 0),
  fact('persistent waste', '2026-05-14', 200, 10, 0, 2_000_000, 0),
  fact('recovered term', '2026-05-15', 200, 10, 0, 2_000_000, 0),
  fact('watchlist term', '2026-05-16', 70, 4, 1, 800_000, 2_000_000),
];

const currentFacts = [
  fact('new term', '2026-06-10', 20, 1, 0, 100_000, 0),
  fact('emerging winner', '2026-06-11', 160, 6, 3, 1_500_000, 8_000_000),
  fact('stable winner', '2026-06-12', 200, 9, 4, 2_200_000, 12_000_000),
  fact('declining term', '2026-06-13', 160, 8, 1, 2_500_000, 4_000_000),
  fact('emerging waste', '2026-06-14', 220, 10, 0, 2_000_000, 0),
  fact('persistent waste', '2026-06-15', 240, 12, 0, 2_400_000, 0),
  fact('recovered term', '2026-06-16', 140, 5, 2, 1_000_000, 5_000_000),
  fact('watchlist term', '2026-06-17', 80, 5, 1, 900_000, 2_200_000),
];

const result = buildCsvSearchTermLifecycle({ currentFacts, previousFacts });

assert.equal(result.schemaVersion, CSV_SEARCH_TERM_LIFECYCLE_SCHEMA_VERSION);
assert.equal(result.authority.authoritative, false);
assert.equal(result.authority.governancePersistenceAllowed, false);
assert.equal(result.authority.executionAuthorized, false);
assert.equal(result.authority.amazonMutationAuthorized, false);
assert.deepEqual(result.periodCapabilities, CSV_HISTORICAL_PERIOD_CAPABILITIES);
assert.deepEqual(result.currentWindow, { startDate: '2026-06-10', endDate: '2026-06-17' });
assert.deepEqual(result.previousWindow, { startDate: '2026-05-10', endDate: '2026-05-16' });

const stateByTerm = new Map(result.items.map((item) => [item.searchTerm, item.state]));
assert.equal(stateByTerm.get('new term'), 'new');
assert.equal(stateByTerm.get('emerging winner'), 'emergingWinner');
assert.equal(stateByTerm.get('stable winner'), 'stableWinner');
assert.equal(stateByTerm.get('declining term'), 'declining');
assert.equal(stateByTerm.get('emerging waste'), 'emergingWaste');
assert.equal(stateByTerm.get('persistent waste'), 'persistentWaste');
assert.equal(stateByTerm.get('recovered term'), 'recovered');
assert.equal(stateByTerm.get('watchlist term'), 'watchlist');

for (const [key, label] of Object.entries(SEARCH_TERM_LIFECYCLE_STATES)) {
  assert.equal(result.summary.lifecycleCounts[key], 1, `expected one lifecycle item for ${label}`);
}
assert.equal(result.summary.analyzedTermCount, 8);

const stable = result.items.find((item) => item.searchTerm === 'stable winner');
assert.equal(stable.currentClassification, 'profit');
assert.equal(stable.previousClassification, 'profit');
assert.ok(stable.currentMetrics.orders > stable.previousMetrics.orders);
assert.ok(stable.reason.includes('remains profitable'));

const declining = result.items.find((item) => item.searchTerm === 'declining term');
assert.equal(declining.previousClassification, 'profit');
assert.notEqual(declining.currentClassification, 'profit');
assert.ok(declining.change.ordersPct < 0);

const recovered = result.items.find((item) => item.searchTerm === 'recovered term');
assert.equal(recovered.previousClassification, 'waste');
assert.notEqual(recovered.currentClassification, 'waste');
assert.equal(recovered.currentMetrics.orders, 2);

for (const item of result.items) {
  assert.equal(item.requiresHumanReview, true);
  assert.equal(item.executionAuthorized, false);
  assert.equal(item.amazonMutationAuthorized, false);
}

assert.throws(
  () => buildCsvSearchTermLifecycle({
    previousFacts: [fact('scope mismatch', '2026-05-01', 10, 1, 0, 100_000, 0)],
    currentFacts: [{ ...fact('scope mismatch', '2026-06-01', 10, 1, 0, 100_000, 0), currencyCode: 'EUR' }],
  }),
  (error) => error?.code === 'CSV_SEARCH_TERM_LIFECYCLE_CURRENCY_CODE_MISMATCH',
);

console.log(JSON.stringify({
  ok: true,
  contract: CSV_SEARCH_TERM_LIFECYCLE_SCHEMA_VERSION,
  lifecycleCounts: result.summary.lifecycleCounts,
  periodCapabilities: result.periodCapabilities,
  amazonMutationAuthorized: result.authority.amazonMutationAuthorized,
}, null, 2));

function fact(searchTerm, reportDate, impressions, clicks, purchases, costMicros, salesMicros) {
  return {
    ...common,
    sourceImportId: reportDate.startsWith('2026-05') ? 'import-may' : 'import-june',
    searchTerm,
    reportDate,
    impressions,
    clicks,
    purchases,
    unitsSold: purchases,
    costMicros,
    salesMicros,
  };
}
