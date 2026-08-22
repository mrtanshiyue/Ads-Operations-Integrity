import { createProductionDriftReceipt } from './production-drift-receipt.mjs';
import { buildProductionBaseline } from './production-baseline-v1.mjs';

const SHA40 = /^[0-9a-f]{40}$/i;
export const FINAL_CLOSURE_EXPECTED = Object.freeze({
  requiredContext: 'Static site and security invariants',
  acceptanceBranch: 'feature/access-service-token-acceptance',
  acceptanceHeadSha: '09af65be79db87f53d715dd686736fb5349b47c6',
  accessAppId: '499b5470-a257-4aec-9ede-7c3a460a42a4',
  r2Bucket: 'ads-ops-data-prod',
  sourceSha256: 'a5e0d3a5ca62e4d60d09be04d7693ec81aaef13052d32560100405be2ec35435',
  sourceBytes: 3202495,
  sourceRows: 8753,
  rangeStart: '2026-06-01',
  rangeEnd: '2026-06-30',
  marketplace: 'US',
  currencyCode: 'USD',
  controlMigrationCount: 6,
  storeMigrationCount: 24,
});

export function buildFinalClosureEvidence(input = {}) {
  const mainSha = requireSha(input.mainSha, 'FINAL_CLOSURE_MAIN_SHA_INVALID');
  const blockers = [];
  const add = (condition, code) => { if (!condition) blockers.push(code); };
  const dev = input.dev || {};
  const prod = input.prod || {};
  const sync = input.sync || {};
  const hardOff = input.hardOff || {};
  const ci = input.ci || {};
  const migrations = input.migrations || {};
  const stores = Array.isArray(input.stores) ? input.stores : [];
  const access = input.access || {};
  const r2 = input.r2 || {};
  const releaseTrace = input.releaseTrace || {};
  const acceptance = input.acceptance || {};

  add(dev.sourceCommit === mainSha, 'dev_not_exact_main');
  add(prod.sourceCommit === mainSha, 'production_not_exact_main');
  add(Number(dev.traffic) === 100, 'dev_traffic_not_100_percent');
  add(Number(prod.traffic) === 100, 'production_traffic_not_100_percent');
  add(dev.buildOutcome === 'success', 'dev_build_not_success');
  add(prod.buildOutcome === 'success', 'production_build_not_success');

  add(hardOff.syncTriggerEnabled === false, 'sync_trigger_not_hard_off');
  add(hardOff.amazonAdsEnabled === false, 'amazon_ads_not_hard_off');
  add(hardOff.phase5SingleRunPermitId === '', 'phase5_permit_not_blank');
  add(hardOff.phase5SingleRunReportDate === '', 'phase5_report_date_not_blank');
  add(Array.isArray(hardOff.schedules) && hardOff.schedules.length === 0, 'production_sync_schedules_not_empty');

  add(ci.requiredContext === FINAL_CLOSURE_EXPECTED.requiredContext, 'required_context_mismatch');
  add(ci.conclusion === 'success', 'required_context_not_success');

  add(Array.isArray(migrations.devControl) && migrations.devControl.length === FINAL_CLOSURE_EXPECTED.controlMigrationCount, 'dev_control_migrations_not_exact');
  add(Number(migrations.devControlFkViolations) === 0, 'dev_control_fk_violation');
  add(Array.isArray(migrations.devStore) && migrations.devStore.length === FINAL_CLOSURE_EXPECTED.storeMigrationCount, 'dev_store_migrations_not_exact');
  add(Number(migrations.devStoreFkViolations) === 0, 'dev_store_fk_violation');
  add(Array.isArray(migrations.prodControl) && migrations.prodControl.length === FINAL_CLOSURE_EXPECTED.controlMigrationCount, 'prod_control_migrations_not_exact');
  add(Number(migrations.prodControlFkViolations) === 0, 'prod_control_fk_violation');
  add(Array.isArray(migrations.prodStores) && migrations.prodStores.length === 4, 'four_store_migration_evidence_required');
  for (const store of Array.isArray(migrations.prodStores) ? migrations.prodStores : []) {
    add(Array.isArray(store.names) && store.names.length === FINAL_CLOSURE_EXPECTED.storeMigrationCount, `${store.storeId || 'unknown'}_migrations_not_exact`);
    add(Number(store.fkViolations) === 0, `${store.storeId || 'unknown'}_fk_violation`);
  }

  add(stores.length === 4, 'four_store_baseline_required');
  const objectKeys = new Set();
  const r2Versions = new Set();
  for (const store of stores) {
    const id = String(store.storeId || 'unknown');
    add(Number(store.businessImportCount) === 1, `${id}_business_import_count_mismatch`);
    add(store.contentSha256 === FINAL_CLOSURE_EXPECTED.sourceSha256, `${id}_source_sha_mismatch`);
    add(Number(store.contentBytes) === FINAL_CLOSURE_EXPECTED.sourceBytes, `${id}_source_size_mismatch`);
    add(Number(store.rowCount) === FINAL_CLOSURE_EXPECTED.sourceRows && Number(store.acceptedRows) === FINAL_CLOSURE_EXPECTED.sourceRows, `${id}_row_count_mismatch`);
    add(store.rangeStart === FINAL_CLOSURE_EXPECTED.rangeStart && store.rangeEnd === FINAL_CLOSURE_EXPECTED.rangeEnd, `${id}_date_range_mismatch`);
    add(store.marketplace === FINAL_CLOSURE_EXPECTED.marketplace, `${id}_marketplace_mismatch`);
    add(store.currencyCode === FINAL_CLOSURE_EXPECTED.currencyCode, `${id}_currency_mismatch`);
    add(store.dataClass === 'business', `${id}_data_class_not_business`);
    add(store.provenanceClass === 'exact_source_object', `${id}_provenance_not_exact_source_object`);
    add(Number(store.authorityVersion) === 2, `${id}_authority_version_mismatch`);
    add(Number(store.factRows) === FINAL_CLOSURE_EXPECTED.sourceRows, `${id}_fact_rows_mismatch`);
    add(Number(store.optimizationActionCount) === 0, `${id}_optimization_action_count_changed`);
    add(Boolean(store.objectKey), `${id}_object_key_missing`);
    add(Boolean(store.r2Version), `${id}_r2_version_missing`);
    if (store.objectKey) objectKeys.add(store.objectKey);
    if (store.r2Version) r2Versions.add(store.r2Version);
  }
  add(objectKeys.size === stores.length, 'cross_store_object_key_reuse');
  add(r2Versions.size === stores.length, 'cross_store_r2_version_reuse');

  add(access.appStatus === 200, 'production_access_app_unreadable');
  add(access.policyStatus === 200, 'production_access_policies_unreadable');
  add(access.serviceTokenStatus === 200, 'production_access_service_tokens_unreadable');
  add(Number(access.nonIdentityPolicyCount) === 0, 'temporary_non_identity_policy_leaked');
  add(Number(access.serviceTokenCount) === 0, 'temporary_service_token_leaked');

  const r2BucketReadable = r2.bucketStatus === undefined
    ? Boolean(r2.bucketName)
    : Number(r2.bucketStatus) === 200;
  add(r2BucketReadable, 'production_r2_bucket_unreadable');
  if (r2BucketReadable) {
    add(r2.bucketName === FINAL_CLOSURE_EXPECTED.r2Bucket, 'production_r2_bucket_missing');
    add(r2.location === 'APAC', 'production_r2_location_mismatch');
  }
  const objectProbeStatuses = Array.isArray(r2.objectProbeStatuses) ? r2.objectProbeStatuses : [];
  const r2ObjectsReadable = objectProbeStatuses.length
    ? objectProbeStatuses.length === 4 && objectProbeStatuses.every((probe) => Number(probe?.status) === 200)
    : Number(r2.verifiedObjectCount) === 4;
  add(r2ObjectsReadable, 'production_r2_objects_unreadable');
  if (r2ObjectsReadable) {
    add(Number(r2.verifiedObjectCount) === 4, 'four_store_r2_object_verification_required');
  }

  add(releaseTrace.development?.verified === true, 'development_release_trace_missing');
  add(releaseTrace.production?.verified === true, 'production_release_trace_missing');
  add(acceptance.verified === true, 'human_review_live_acceptance_missing');
  if (acceptance.verified === true) {
    add(acceptance.headSha === FINAL_CLOSURE_EXPECTED.acceptanceHeadSha, 'human_review_acceptance_head_mismatch');
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  const snapshot = {
    schemaVersion: 'final-closure-evidence-orchestrator-v1',
    status: uniqueBlockers.length ? 'blocked' : 'ready',
    generatedAt: input.generatedAt,
    mainSha,
    ci,
    dev,
    prod,
    sync,
    hardOff,
    migrations,
    stores,
    access,
    r2,
    releaseTrace,
    acceptance,
    blockers: uniqueBlockers,
  };
  if (uniqueBlockers.length) return snapshot;

  const driftReceipt = createProductionDriftReceipt({
    mainSha,
    runtimeBaselineSha: mainSha,
    dev: { commitSha: dev.sourceCommit, build: dev.buildUuid, deployment: dev.deploymentId, version: dev.versionId },
    prod: { commitSha: prod.sourceCommit, build: prod.buildUuid, deployment: prod.deploymentId, version: prod.versionId },
    syncVersion: sync.versionId,
    migrationStatus: `dev control ${migrations.devControl.length}/6; dev store ${migrations.devStore.length}/24; prod control ${migrations.prodControl.length}/6; prod stores 24/24 x4`,
    fkStatus: '0 violations across dev control/store and production control/four stores',
    accessStatus: 'production access enforced; ephemeral acceptance identity cleaned',
    r2Status: `bucket ${r2.bucketName} ${r2.location}; exact source objects verified ${r2.verifiedObjectCount}/4`,
    amazonHardOff: { amazonAdsEnabled: hardOff.amazonAdsEnabled, syncTriggerEnabled: hardOff.syncTriggerEnabled, schedules: hardOff.schedules },
    storeDataStatus: 'four_store_business_authority_exact_source_object_accepted',
    browserAcceptanceStatus: 'accepted',
    blockers: [],
  });

  const releaseArtifact = [releaseTrace.development.artifact, releaseTrace.production.artifact].join(' + ');
  const productionBaseline = buildProductionBaseline({
    sourceKind: 'live-control-plane',
    generatedAt: input.generatedAt,
    git: { mainSha },
    ci: { requiredContext: ci.requiredContext, conclusion: ci.conclusion },
    dev: { buildUuid: dev.buildUuid, workerVersion: dev.versionId, deploymentId: dev.deploymentId, traffic: Number(dev.traffic), sourceCommit: dev.sourceCommit },
    prod: { buildUuid: prod.buildUuid, workerVersion: prod.versionId, deploymentId: prod.deploymentId, traffic: Number(prod.traffic), sourceCommit: prod.sourceCommit },
    migrations: {
      devControl: migrations.devControl,
      devStore: migrations.devStore,
      prodControl: migrations.prodControl,
      prodStores: migrations.prodStores.map((store) => store.names),
    },
    hardOff: {
      SYNC_TRIGGER_ENABLED: String(hardOff.syncTriggerEnabled),
      PHASE5_SINGLE_RUN_PERMIT_ID: hardOff.phase5SingleRunPermitId,
      PHASE5_SINGLE_RUN_REPORT_DATE: hardOff.phase5SingleRunReportDate,
      AMAZON_ADS_ENABLED: String(hardOff.amazonAdsEnabled),
    },
    releaseTrace: {
      artifact: releaseArtifact,
      development: releaseTrace.development,
      production: releaseTrace.production,
    },
    acceptance: {
      status: 'passed',
      remainingBlockers: [],
      artifact: acceptance.artifact,
      runId: acceptance.runId,
      headSha: acceptance.headSha,
    },
  });

  return { ...snapshot, driftReceipt, productionBaseline };
}

function requireSha(value, code) { const text = String(value ?? '').trim().toLowerCase(); if (!SHA40.test(text)) throw new Error(code); return text; }
