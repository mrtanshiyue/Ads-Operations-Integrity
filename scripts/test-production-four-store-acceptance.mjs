import assert from 'node:assert/strict';
import {
  FOUR_STORE_DECISION_INTELLIGENCE_CONTRACT,
  REQUIRED_ANALYTICS,
  evaluateProductionAcceptance,
} from './production-four-store-acceptance.mjs';

const SOURCE_SHA = 'a'.repeat(64);

function validDecisionIntelligence(index) {
  return {
    verified: true,
    businessFactCount: 8753,
    distinctTermCount: 4973,
    range: { startDate: '2026-06-01', endDate: '2026-06-30' },
    marketplace: 'US',
    currencyCode: 'USD',
    source: {
      contentSha256: SOURCE_SHA,
      importId: `csv-import-${index}`,
      objectKey: `csv/raw/store-${index}/spSearchTerm/sha256/aa/${SOURCE_SHA}`,
      r2Version: `r2-version-${index}`,
      dataClass: 'business',
      provenanceClass: 'exact_source_object',
      authorityVersion: 2,
    },
    analysisScope: {
      complete: false,
      hardCap: 1000,
      overflowObserved: true,
      financiallyComparable: true,
      candidateEmissionAuthorized: false,
      reasons: ['search_term_universe_hard_cap_exceeded'],
    },
    recommendationInbox: {
      candidatePotentialCount: 36,
      reviewCandidateCount: 0,
      blockedByGovernanceCount: 0,
      blockedByScopeCount: 36,
    },
    rootIntelligence: { counts: { profitable: 12, toxic: 7, mixed: 4, protected: 2 } },
    lifecycleIntelligence: { counts: { new: 20, stableWinner: 6, persistentWaste: 10 } },
    authority: {
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
    unexpectedPersistenceDetected: false,
  };
}

function validStore(storeId, index) {
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
    decisionIntelligence: validDecisionIntelligence(index),
  };
}

const stores = ['store-01', 'store-02', 'store-03', 'store-04'].map((id, index) => validStore(id, index + 1));

const blocked = evaluateProductionAcceptance({ realProductionCsv: false, stores });
assert.equal(blocked.status, 'blocked');
assert.deepEqual(blocked.blockers, ['real_production_csv_required']);
assert.deepEqual(blocked.failures, []);

const passed = evaluateProductionAcceptance({ realProductionCsv: true, decisionIntelligenceRequired: true, stores });
assert.equal(passed.status, 'passed');
assert.equal(passed.decisionIntelligenceContract, FOUR_STORE_DECISION_INTELLIGENCE_CONTRACT);
assert.equal(passed.decisionIntelligenceChecked, true);
assert.deepEqual(passed.blockers, []);
assert.deepEqual(passed.failures, []);

const leakedStores = structuredClone(stores);
leakedStores[0].analytics['search-term'].returnedStoreIds = ['store-01', 'store-02'];
const leaked = evaluateProductionAcceptance({ realProductionCsv: true, decisionIntelligenceRequired: true, stores: leakedStores });
assert.equal(leaked.status, 'failed');
assert.ok(leaked.failures.includes('store-01:analytics_search-term_cross_store_leakage'));

const canonicalizedStores = structuredClone(stores);
canonicalizedStores[2].csvImport.observedIdentityAuthority = 'canonical';
const canonicalized = evaluateProductionAcceptance({ realProductionCsv: true, decisionIntelligenceRequired: true, stores: canonicalizedStores });
assert.equal(canonicalized.status, 'failed');
assert.ok(canonicalized.failures.includes('store-03:observed_csv_identity_authority_must_remain_non_canonical'));

const emissionEscalatedStores = structuredClone(stores);
emissionEscalatedStores[1].decisionIntelligence.analysisScope.candidateEmissionAuthorized = true;
const emissionEscalated = evaluateProductionAcceptance({ realProductionCsv: true, decisionIntelligenceRequired: true, stores: emissionEscalatedStores });
assert.equal(emissionEscalated.status, 'failed');
assert.ok(emissionEscalated.failures.includes('store-02:incomplete_scope_candidate_emission_authorized'));
assert.ok(emissionEscalated.failures.includes('store-02:overflow_scope_candidate_emission_must_fail_closed'));

const reusedObjectStores = structuredClone(stores);
reusedObjectStores[3].decisionIntelligence.source.objectKey = reusedObjectStores[0].decisionIntelligence.source.objectKey;
const reusedObject = evaluateProductionAcceptance({ realProductionCsv: true, decisionIntelligenceRequired: true, stores: reusedObjectStores });
assert.equal(reusedObject.status, 'failed');
assert.ok(reusedObject.failures.includes('store-04:same_source_objectKey_reused_across_stores'));

const driftedStores = structuredClone(stores);
driftedStores[2].decisionIntelligence.recommendationInbox.blockedByScopeCount = 35;
driftedStores[2].decisionIntelligence.recommendationInbox.candidatePotentialCount = 35;
const drifted = evaluateProductionAcceptance({ realProductionCsv: true, decisionIntelligenceRequired: true, stores: driftedStores });
assert.equal(drifted.status, 'failed');
assert.ok(drifted.failures.some((failure) => failure.startsWith('store-03:same_source_decision_intelligence_drift:')));

const actionEscalatedStores = structuredClone(stores);
actionEscalatedStores[0].decisionIntelligence.authority.executionAuthorized = true;
const actionEscalated = evaluateProductionAcceptance({ realProductionCsv: true, decisionIntelligenceRequired: true, stores: actionEscalatedStores });
assert.equal(actionEscalated.status, 'failed');
assert.ok(actionEscalated.failures.includes('store-01:decision_intelligence_executionAuthorized_must_be_false'));

console.log(JSON.stringify({
  ok: true,
  contract: 'production-four-store-acceptance',
  decisionIntelligenceContract: FOUR_STORE_DECISION_INTELLIGENCE_CONTRACT,
  blockedWithoutRealProductionCsv: true,
  crossStoreLeakageFails: true,
  sameSourceScopedIdentityReuseFails: true,
  sameSourceDecisionDriftFails: true,
  incompleteScopeCandidateEmissionFailsClosed: true,
  executionAuthorityEscalationFails: true,
}));
