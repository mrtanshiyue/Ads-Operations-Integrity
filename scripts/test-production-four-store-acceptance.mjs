import assert from 'node:assert/strict';
import {
  REQUIRED_ANALYTICS,
  evaluateProductionAcceptance,
} from './production-four-store-acceptance.mjs';

function validStore(storeId) {
  return {
    storeId,
    csvImport: {
      accepted: true,
      classification: 'business',
      businessFactsPresent: true,
      observedIdentityAuthority: 'non-canonical',
    },
    analytics: Object.fromEntries(REQUIRED_ANALYTICS.map((dimension) => [dimension, {
      verified: true,
      returnedStoreIds: [storeId],
    }])),
    exportVerified: true,
    crossStoreLeakageDetected: false,
  };
}

const stores = ['store-01', 'store-02', 'store-03', 'store-04'].map(validStore);

const blocked = evaluateProductionAcceptance({ realProductionCsv: false, stores });
assert.equal(blocked.status, 'blocked');
assert.deepEqual(blocked.blockers, ['real_production_csv_required']);
assert.deepEqual(blocked.failures, []);

const passed = evaluateProductionAcceptance({ realProductionCsv: true, stores });
assert.equal(passed.status, 'passed');
assert.deepEqual(passed.blockers, []);
assert.deepEqual(passed.failures, []);

const leakedStores = structuredClone(stores);
leakedStores[0].analytics['search-term'].returnedStoreIds = ['store-01', 'store-02'];
const leaked = evaluateProductionAcceptance({ realProductionCsv: true, stores: leakedStores });
assert.equal(leaked.status, 'failed');
assert.ok(leaked.failures.includes('store-01:analytics_search-term_cross_store_leakage'));

const canonicalizedStores = structuredClone(stores);
canonicalizedStores[2].csvImport.observedIdentityAuthority = 'canonical';
const canonicalized = evaluateProductionAcceptance({ realProductionCsv: true, stores: canonicalizedStores });
assert.equal(canonicalized.status, 'failed');
assert.ok(canonicalized.failures.includes('store-03:observed_csv_identity_authority_must_remain_non_canonical'));

console.log(JSON.stringify({
  ok: true,
  contract: 'production-four-store-acceptance',
  blockedWithoutRealProductionCsv: true,
  crossStoreLeakageFails: true,
  observedCsvAuthorityUpgradeFails: true,
}));
