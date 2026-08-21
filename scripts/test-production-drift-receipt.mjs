import assert from 'node:assert/strict';
import {
  ProductionDriftReceiptError,
  createProductionDriftReceipt,
  serializeProductionDriftReceipt,
} from './production-drift-receipt.mjs';

const RUNTIME_SHA = 'c8b3c7e83ab3862267e3618d610c9ec776f16a70';
const TOOLING_MAIN_SHA = 'cc991c2a421e8c77bb23b4d3f3ddec44e23c1f43';

function baseline(overrides = {}) {
  return {
    mainSha: TOOLING_MAIN_SHA,
    runtimeBaselineSha: RUNTIME_SHA,
    dev: {
      commitSha: RUNTIME_SHA,
      build: 'e631f6a8-6b6e-4b29-acc1-4fdbd05799bb',
      deployment: '9432660a-1d23-4b7f-bb5e-f31cbfbf3b43',
      version: 'daded806-57d2-4924-bb8f-4e8d46052d5e',
    },
    prod: {
      commitSha: RUNTIME_SHA,
      build: '45e236bd-25bf-4bd8-80f8-7d1ce2b70916',
      deployment: 'e76c5a6d-e299-4bb3-acbe-04f018739b6a',
      version: 'f9c30fd0-18a6-4b21-90ef-81460f68de37',
    },
    syncVersion: '295df84e-2103-4858-9895-49f67d4b10b4',
    migrationStatus: '24/24 all stores',
    fkStatus: 'ok',
    accessStatus: 'enforced',
    r2Status: 'isolated',
    amazonHardOff: {
      amazonAdsEnabled: false,
      syncTriggerEnabled: false,
      schedules: [],
    },
    storeDataStatus: 'four_store_business_authority_accepted',
    browserAcceptanceStatus: 'BLOCKED_BY_EXTERNAL_IDENTITY',
    blockers: [],
    ...overrides,
  };
}

{
  const receipt = createProductionDriftReceipt(baseline());
  assert.equal(receipt.schemaVersion, 'production-drift-receipt-v1');
  assert.equal(receipt.status, 'ready_with_external_blocker');
  assert.equal(receipt.mainAheadOfRuntimeBaseline, true);
  assert.equal(receipt.runtimeDriftStatus, 'exact_runtime_baseline');
  assert.deepEqual(receipt.runtimeDriftEnvironments, []);
  assert.equal(receipt.amazonHardOffStatus, 'HARD_OFF');
  assert.equal(receipt.amazonHardOff.amazonAdsEnabled, false);
  assert.equal(receipt.amazonHardOff.syncTriggerEnabled, false);
  assert.equal(receipt.amazonHardOff.schedulesEmpty, true);
  assert.deepEqual(receipt.blockers, ['production_authenticated_browser_external_identity']);
  assert(Object.isFrozen(receipt));
  assert(Object.isFrozen(receipt.amazonHardOff));
  assert.match(serializeProductionDriftReceipt(baseline()), /"status": "ready_with_external_blocker"/u);
}

{
  const receipt = createProductionDriftReceipt(baseline({
    prod: {
      ...baseline().prod,
      commitSha: '93e00628e271c3e4515b0a729db089b9d6203baf',
    },
  }));
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.runtimeDriftStatus, 'runtime_drift');
  assert.deepEqual(receipt.runtimeDriftEnvironments, ['production']);
  assert(receipt.blockers.includes('prod_web_runtime_drift'));
}

{
  const receipt = createProductionDriftReceipt(baseline({
    amazonHardOff: {
      amazonAdsEnabled: true,
      syncTriggerEnabled: false,
      schedules: [],
    },
  }));
  assert.equal(receipt.status, 'unsafe');
  assert.equal(receipt.amazonHardOffStatus, 'VIOLATION');
  assert(receipt.blockers.includes('amazon_transport_not_hard_off'));
}

{
  const receipt = createProductionDriftReceipt(baseline({
    browserAcceptanceStatus: 'accepted',
  }));
  assert.equal(receipt.status, 'ready');
  assert.deepEqual(receipt.blockers, []);
}

assert.throws(
  () => createProductionDriftReceipt(baseline({ runtimeBaselineSha: 'not-a-sha' })),
  (error) => error instanceof ProductionDriftReceiptError
    && error.code === 'PRODUCTION_DRIFT_RUNTIME_BASELINE_SHA_INVALID',
);

assert.throws(
  () => createProductionDriftReceipt(baseline({
    amazonHardOff: { amazonAdsEnabled: false, syncTriggerEnabled: false },
  })),
  (error) => error instanceof ProductionDriftReceiptError
    && error.code === 'PRODUCTION_DRIFT_AMAZON_HARD_OFF_EVIDENCE_INVALID',
);

console.log('production-drift-receipt: ok');
