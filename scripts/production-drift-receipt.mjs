const SHA40_PATTERN = /^[0-9a-f]{40}$/iu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EXTERNAL_IDENTITY_BLOCKER = 'production_authenticated_browser_external_identity';

export class ProductionDriftReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProductionDriftReceiptError';
    this.code = code;
  }
}

/**
 * Build a release / drift receipt from already-collected read-only evidence.
 *
 * The current repository main SHA is deliberately separate from runtimeBaselineSha.
 * Tooling/docs-only merges may advance main without requiring a Web deployment. Runtime
 * drift is therefore evaluated against the last canonical runtime-affecting main SHA,
 * never against repository head by accident.
 */
export function createProductionDriftReceipt(input = {}) {
  const mainSha = requiredSha(input.mainSha, 'PRODUCTION_DRIFT_MAIN_SHA_INVALID');
  const runtimeBaselineSha = requiredSha(
    input.runtimeBaselineSha,
    'PRODUCTION_DRIFT_RUNTIME_BASELINE_SHA_INVALID',
  );
  const dev = normalizeWebDeployment(input.dev, 'DEV');
  const prod = normalizeWebDeployment(input.prod, 'PROD');
  const syncVersion = requiredUuid(input.syncVersion, 'PRODUCTION_DRIFT_SYNC_VERSION_INVALID');
  const migrationStatus = requiredText(input.migrationStatus, 'PRODUCTION_DRIFT_MIGRATION_STATUS_REQUIRED');
  const fkStatus = requiredText(input.fkStatus, 'PRODUCTION_DRIFT_FK_STATUS_REQUIRED');
  const accessStatus = requiredText(input.accessStatus, 'PRODUCTION_DRIFT_ACCESS_STATUS_REQUIRED');
  const r2Status = requiredText(input.r2Status, 'PRODUCTION_DRIFT_R2_STATUS_REQUIRED');
  const storeDataStatus = requiredText(input.storeDataStatus, 'PRODUCTION_DRIFT_STORE_DATA_STATUS_REQUIRED');
  const browserAcceptanceStatus = requiredText(
    input.browserAcceptanceStatus,
    'PRODUCTION_DRIFT_BROWSER_ACCEPTANCE_STATUS_REQUIRED',
  );
  const amazonHardOff = normalizeAmazonHardOff(input.amazonHardOff);

  const blockers = new Set(normalizeBlockers(input.blockers));
  const runtimeDrift = [];
  if (dev.commitSha !== runtimeBaselineSha) {
    blockers.add('dev_web_runtime_drift');
    runtimeDrift.push('development');
  }
  if (prod.commitSha !== runtimeBaselineSha) {
    blockers.add('prod_web_runtime_drift');
    runtimeDrift.push('production');
  }
  if (amazonHardOff.status !== 'HARD_OFF') blockers.add('amazon_transport_not_hard_off');
  if (browserAcceptanceStatus === 'BLOCKED_BY_EXTERNAL_IDENTITY') blockers.add(EXTERNAL_IDENTITY_BLOCKER);

  const blockerList = [...blockers].sort();
  const nonExternalBlockers = blockerList.filter((value) => value !== EXTERNAL_IDENTITY_BLOCKER);
  const status = amazonHardOff.status !== 'HARD_OFF'
    ? 'unsafe'
    : nonExternalBlockers.length > 0
      ? 'blocked'
      : blockerList.length > 0
        ? 'ready_with_external_blocker'
        : 'ready';

  return deepFreeze({
    schemaVersion: 'production-drift-receipt-v1',
    status,
    mainSha,
    runtimeBaselineSha,
    mainAheadOfRuntimeBaseline: mainSha !== runtimeBaselineSha,
    runtimeDriftStatus: runtimeDrift.length === 0 ? 'exact_runtime_baseline' : 'runtime_drift',
    runtimeDriftEnvironments: runtimeDrift,
    devBuild: dev.build,
    devDeployment: dev.deployment,
    devVersion: dev.version,
    prodBuild: prod.build,
    prodDeployment: prod.deployment,
    prodVersion: prod.version,
    syncVersion,
    migrationStatus,
    fkStatus,
    accessStatus,
    r2Status,
    amazonHardOffStatus: amazonHardOff.status,
    amazonHardOff,
    storeDataStatus,
    browserAcceptanceStatus,
    blockers: blockerList,
  });
}

export function serializeProductionDriftReceipt(input) {
  return `${JSON.stringify(createProductionDriftReceipt(input), null, 2)}\n`;
}

function normalizeWebDeployment(value, label) {
  const commitSha = requiredSha(value?.commitSha, `PRODUCTION_DRIFT_${label}_COMMIT_SHA_INVALID`);
  const build = requiredUuid(value?.build, `PRODUCTION_DRIFT_${label}_BUILD_INVALID`);
  const deployment = requiredUuid(value?.deployment, `PRODUCTION_DRIFT_${label}_DEPLOYMENT_INVALID`);
  const version = requiredUuid(value?.version, `PRODUCTION_DRIFT_${label}_VERSION_INVALID`);
  return Object.freeze({ commitSha, build, deployment, version });
}

function normalizeAmazonHardOff(value) {
  const amazonAdsEnabled = value?.amazonAdsEnabled;
  const syncTriggerEnabled = value?.syncTriggerEnabled;
  const schedules = Array.isArray(value?.schedules) ? [...value.schedules] : null;
  if (typeof amazonAdsEnabled !== 'boolean' || typeof syncTriggerEnabled !== 'boolean' || schedules === null) {
    throw new ProductionDriftReceiptError('PRODUCTION_DRIFT_AMAZON_HARD_OFF_EVIDENCE_INVALID');
  }
  const schedulesEmpty = schedules.length === 0;
  return deepFreeze({
    status: amazonAdsEnabled === false && syncTriggerEnabled === false && schedulesEmpty ? 'HARD_OFF' : 'VIOLATION',
    amazonAdsEnabled,
    syncTriggerEnabled,
    schedules,
    schedulesEmpty,
  });
}

function normalizeBlockers(values) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new ProductionDriftReceiptError('PRODUCTION_DRIFT_BLOCKERS_INVALID');
  return [...new Set(values.map((value) => requiredText(value, 'PRODUCTION_DRIFT_BLOCKER_INVALID')))].sort();
}

function requiredSha(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!SHA40_PATTERN.test(text)) throw new ProductionDriftReceiptError(code);
  return text;
}

function requiredUuid(value, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(text)) throw new ProductionDriftReceiptError(code);
  return text;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text || /[\u0000-\u001f\u007f]/u.test(text)) throw new ProductionDriftReceiptError(code);
  return text;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
