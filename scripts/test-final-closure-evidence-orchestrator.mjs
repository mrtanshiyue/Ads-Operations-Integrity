import assert from 'node:assert/strict';
import { buildFinalClosureEvidence } from './final-closure-evidence-contract.mjs';
import { verifyEnvironmentReleaseTrace } from './final-closure-control-plane-v3.mjs';

const mainSha = '535552f760dd9f94befc019a61f90b5f5ca145cb';
const migrations24 = Array.from({ length: 24 }, (_, index) => `${String(index + 1).padStart(4, '0')}_store.sql`);
const stores = ['Store01', 'Store02', 'Store03', 'Store04'].map((storeId, index) => ({
  storeId,
  databaseId: `db-${index}`,
  businessImportCount: 1,
  contentSha256: 'a5e0d3a5ca62e4d60d09be04d7693ec81aaef13052d32560100405be2ec35435',
  contentBytes: 3202495,
  rowCount: 8753,
  acceptedRows: 8753,
  rangeStart: '2026-06-01',
  rangeEnd: '2026-06-30',
  marketplace: 'US',
  currencyCode: 'USD',
  dataClass: 'business',
  provenanceClass: 'exact_source_object',
  authorityVersion: 2,
  objectKey: `csv/raw/store-${index}/source`,
  r2Version: `version-${index}`,
  factRows: 8753,
  optimizationActionCount: 0,
}));

const base = {
  generatedAt: '2026-08-22T05:00:00.000Z',
  mainSha,
  ci: { requiredContext: 'Static site and security invariants', conclusion: 'success' },
  dev: {
    sourceCommit: mainSha,
    buildUuid: 'e631f6a8-6b6e-4b29-acc1-4fdbd05799bb',
    deploymentId: '9432660a-1d23-4b7f-bb5e-f31cbfbf3b43',
    versionId: 'daded806-57d2-4924-bb8f-4e8d46052d5e',
    traffic: 100,
    buildOutcome: 'success',
  },
  prod: {
    sourceCommit: mainSha,
    buildUuid: '45e236bd-25bf-4bd8-80f8-7d1ce2b70916',
    deploymentId: 'e76c5a6d-e299-4bb3-acbe-04f018739b6a',
    versionId: 'f9c30fd0-18a6-4b21-90ef-81460f68de37',
    traffic: 100,
    buildOutcome: 'success',
  },
  sync: { versionId: '295df84e-2103-4858-9895-49f67d4b10b4' },
  hardOff: {
    syncTriggerEnabled: false,
    amazonAdsEnabled: false,
    phase5SingleRunPermitId: '',
    phase5SingleRunReportDate: '',
    schedules: [],
  },
  migrations: {
    devControl: Array.from({ length: 6 }, (_, index) => `000${index + 1}_control.sql`),
    devControlFkViolations: 0,
    devStore: migrations24,
    devStoreFkViolations: 0,
    prodControl: Array.from({ length: 6 }, (_, index) => `000${index + 1}_control.sql`),
    prodControlFkViolations: 0,
    prodStores: stores.map((store) => ({ storeId: store.storeId, names: migrations24, fkViolations: 0 })),
  },
  stores,
  access: {
    appStatus: 200,
    policyStatus: 200,
    serviceTokenStatus: 200,
    nonIdentityPolicyCount: 0,
    serviceTokenCount: 0,
  },
  r2: { bucketName: 'ads-ops-data-prod', location: 'APAC', verifiedObjectCount: 4 },
  releaseTrace: {
    development: { verified: true, artifact: `cloudflare-release-trace-development-${mainSha}`, runId: 1 },
    production: { verified: true, artifact: `cloudflare-release-trace-production-${mainSha}`, runId: 1 },
  },
  acceptance: {
    verified: true,
    artifact: 'live-human-review-service-auth-acceptance-1',
    runId: 1,
    headSha: '24b4e3a4c1e610ace5e25848648d787d073b1a03',
  },
};

const ready = buildFinalClosureEvidence(base);
assert.equal(ready.status, 'ready');
assert.deepEqual(ready.blockers, []);
assert.equal(ready.driftReceipt.status, 'ready');
assert.equal(ready.driftReceipt.runtimeDriftStatus, 'exact_runtime_baseline');
assert.equal(ready.productionBaseline.schema, 'production-baseline-v1');
assert.equal(ready.productionBaseline.production.sourceCommit, mainSha);
assert.equal(ready.productionBaseline.acceptance.status, 'passed');

const staged = buildFinalClosureEvidence({
  ...base,
  prod: { ...base.prod, sourceCommit: '0557f4eaeae2e0a749d49653844f7ce8e1579f17' },
  releaseTrace: { ...base.releaseTrace, production: { verified: false } },
  acceptance: { verified: false, headSha: null },
});
assert.equal(staged.status, 'blocked');
assert(staged.blockers.includes('production_not_exact_main'));
assert(staged.blockers.includes('production_release_trace_missing'));
assert(staged.blockers.includes('human_review_live_acceptance_missing'));
assert(!staged.blockers.includes('human_review_acceptance_head_mismatch'));
assert.equal(staged.driftReceipt, undefined);
assert.equal(staged.productionBaseline, undefined);

const unreadableR2 = buildFinalClosureEvidence({
  ...base,
  r2: {
    bucketStatus: 403,
    bucketName: null,
    location: null,
    objectProbeStatuses: stores.map((store) => ({ storeId: store.storeId, status: 403 })),
    verifiedObjectCount: 0,
  },
});
assert.equal(unreadableR2.status, 'blocked');
assert(unreadableR2.blockers.includes('production_r2_bucket_unreadable'));
assert(unreadableR2.blockers.includes('production_r2_objects_unreadable'));
assert(!unreadableR2.blockers.includes('production_r2_bucket_missing'));
assert(!unreadableR2.blockers.includes('production_r2_location_mismatch'));
assert(!unreadableR2.blockers.includes('four_store_r2_object_verification_required'));
assert.equal(unreadableR2.productionBaseline, undefined);

const wrongAcceptedHead = buildFinalClosureEvidence({
  ...base,
  acceptance: {
    ...base.acceptance,
    headSha: '1111111111111111111111111111111111111111',
  },
});
assert.equal(wrongAcceptedHead.status, 'blocked');
assert(wrongAcceptedHead.blockers.includes('human_review_acceptance_head_mismatch'));
assert(!wrongAcceptedHead.blockers.includes('human_review_live_acceptance_missing'));

const devArtifactName = `cloudflare-release-trace-development-${mainSha}`;
const fakeGh = async (path) => {
  if (path.includes('/actions/artifacts?')) {
    return {
      artifacts: [{
        id: 71,
        name: devArtifactName,
        created_at: '2026-08-22T05:00:00Z',
        workflow_run: { id: 91 },
      }],
    };
  }
  if (path.endsWith('/actions/runs/91')) {
    return {
      name: 'Cloudflare Release Trace',
      event: 'workflow_run',
      conclusion: 'failure',
    };
  }
  if (path.endsWith('/actions/runs/91/jobs?per_page=100')) {
    return {
      jobs: [
        { id: 101, name: 'Trace development release', conclusion: 'success' },
        { id: 102, name: 'Trace production release', conclusion: 'failure' },
      ],
    };
  }
  throw new Error(`unexpected fake GitHub path:${path}`);
};

const devTraceFromMixedMatrix = await verifyEnvironmentReleaseTrace({
  gh: fakeGh,
  owner: 'mrtanshiyue',
  name: 'Ads-Operations-Integrity',
  mainSha,
  environment: 'development',
});
assert.equal(devTraceFromMixedMatrix.verified, true);
assert.equal(devTraceFromMixedMatrix.runConclusion, 'failure');
assert.equal(devTraceFromMixedMatrix.jobConclusion, 'success');
assert.equal(devTraceFromMixedMatrix.artifact, devArtifactName);

const prodTraceMissingFromMixedMatrix = await verifyEnvironmentReleaseTrace({
  gh: fakeGh,
  owner: 'mrtanshiyue',
  name: 'Ads-Operations-Integrity',
  mainSha,
  environment: 'production',
});
assert.equal(prodTraceMissingFromMixedMatrix.verified, false);

const unsafe = buildFinalClosureEvidence({
  ...base,
  hardOff: { ...base.hardOff, amazonAdsEnabled: true },
});
assert.equal(unsafe.status, 'blocked');
assert(unsafe.blockers.includes('amazon_ads_not_hard_off'));
assert.equal(unsafe.productionBaseline, undefined);

console.log('final-closure-evidence-orchestrator: ok');
