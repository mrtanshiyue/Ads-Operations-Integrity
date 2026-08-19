import assert from 'node:assert/strict';
import { buildProductionBaseline } from './production-baseline-v1.mjs';

const sha = '76162fa185627f25b299756183ed145c92697554';
const liveTruth = {
  sourceKind: 'live-control-plane',
  generatedAt: '2026-08-19T08:00:00Z',
  git: { mainSha: sha },
  ci: { requiredContext: 'Static site and security invariants', conclusion: 'success' },
  dev: {
    buildUuid: 'dev-build-live',
    workerVersion: 'dev-version-live',
    deploymentId: 'dev-deployment-live',
    traffic: 100,
    sourceCommit: sha,
  },
  prod: {
    buildUuid: 'prod-build-live',
    workerVersion: 'prod-version-live',
    deploymentId: 'prod-deployment-live',
    traffic: 100,
    sourceCommit: sha,
  },
  migrations: {
    devControl: ['0006_control_access_recovery.sql'],
    devStore: ['0023_store_csv_legacy_reconciliation_receipts.sql'],
    prodControl: ['0006_control_access_recovery.sql'],
    prodStores: [
      ['0023_store_csv_legacy_reconciliation_receipts.sql'],
      ['0023_store_csv_legacy_reconciliation_receipts.sql'],
      ['0023_store_csv_legacy_reconciliation_receipts.sql'],
      ['0023_store_csv_legacy_reconciliation_receipts.sql'],
    ],
  },
  hardOff: {
    SYNC_TRIGGER_ENABLED: 'false',
    PHASE5_SINGLE_RUN_PERMIT_ID: '',
    PHASE5_SINGLE_RUN_REPORT_DATE: '',
    AMAZON_ADS_ENABLED: 'false',
  },
  releaseTrace: { artifact: 'cloudflare-release-trace-live' },
  acceptance: { status: 'blocked', remainingBlockers: ['real_production_csv_required'] },
};

const baseline = buildProductionBaseline(liveTruth);
assert.equal(baseline.schema, 'production-baseline-v1');
assert.equal(baseline.authority, 'live-control-plane-derived');
assert.equal(baseline.git.mainSha, sha);
assert.equal(baseline.production.sourceCommit, sha);
assert.equal(baseline.acceptance.status, 'blocked');

assert.throws(
  () => buildProductionBaseline({ ...liveTruth, sourceKind: 'manual' }),
  /sourceKind_live_control_plane_required/,
);
assert.throws(
  () => buildProductionBaseline({ ...liveTruth, prod: { ...liveTruth.prod, sourceCommit: 'drifted' } }),
  /prod_not_exact_main/,
);
assert.throws(
  () => buildProductionBaseline({ ...liveTruth, hardOff: { ...liveTruth.hardOff, AMAZON_ADS_ENABLED: 'true' } }),
  /production_hard_off_mismatch:AMAZON_ADS_ENABLED/,
);
assert.throws(
  () => buildProductionBaseline({ ...liveTruth, prod: { ...liveTruth.prod, workerVersion: '' } }),
  /live_truth_missing:prod.workerVersion/,
);

console.log(JSON.stringify({
  ok: true,
  contract: 'production-baseline-v1',
  liveTruthRequired: true,
  exactMainRequired: true,
  hardOffRequired: true,
  acceptanceBlockersPreserved: true,
}));
