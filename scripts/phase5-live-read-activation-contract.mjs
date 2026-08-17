import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PHASE5_ACTIVATION_STATES = Object.freeze({
  safe_disabled:Object.freeze({
    amazonAdsEnabled:false,
    syncTriggerEnabled:false,
    allowedFrom:Object.freeze(['safe_disabled', 'amazon_read_ready', 'single_run_open']),
  }),
  amazon_read_ready:Object.freeze({
    amazonAdsEnabled:true,
    syncTriggerEnabled:false,
    allowedFrom:Object.freeze(['safe_disabled', 'amazon_read_ready', 'single_run_open']),
  }),
  single_run_open:Object.freeze({
    amazonAdsEnabled:true,
    syncTriggerEnabled:true,
    allowedFrom:Object.freeze(['amazon_read_ready']),
  }),
});

export const PHASE5_IMPLEMENTED_DATASETS = Object.freeze(['search_term_daily']);
export const PHASE5_DEV_D1_BINDINGS = Object.freeze(['CONTROL_DB', 'STORE_01_DB']);

export class Phase5ActivationContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase5ActivationContractError';
    this.code = code;
  }
}

export function validatePhase5LiveReadActivation({ state, nativeConfig, syncConfig }) {
  const activation = requiredObject(state, 'PHASE5_ACTIVATION_STATE_INVALID');
  const native = requiredObject(nativeConfig, 'PHASE5_NATIVE_CONFIG_INVALID');
  const sync = requiredObject(syncConfig, 'PHASE5_SYNC_CONFIG_INVALID');

  if (activation.schemaVersion !== 'phase5-store01-live-read-activation-v1') {
    fail('PHASE5_ACTIVATION_SCHEMA_INVALID');
  }
  if (String(activation.phase) !== '5') fail('PHASE5_ACTIVATION_PHASE_INVALID');
  if (activation.storeId !== 'store-dev-01' || activation.storeCode !== 'DEV01') {
    fail('PHASE5_ACTIVATION_STORE_SCOPE_INVALID');
  }

  const policy = PHASE5_ACTIVATION_STATES[activation.state];
  if (!policy) fail('PHASE5_ACTIVATION_STATE_UNKNOWN');
  if (!policy.allowedFrom.includes(activation.transitionFrom)) {
    fail(`PHASE5_ACTIVATION_TRANSITION_INVALID:${activation.transitionFrom}:${activation.state}`);
  }

  if (activation.amazonAdsEnabled !== policy.amazonAdsEnabled) {
    fail('PHASE5_ACTIVATION_AMAZON_FLAG_STATE_MISMATCH');
  }
  if (activation.syncTriggerEnabled !== policy.syncTriggerEnabled) {
    fail('PHASE5_ACTIVATION_SYNC_FLAG_STATE_MISMATCH');
  }
  if (activation.singleRunOnly !== true) fail('PHASE5_ACTIVATION_SINGLE_RUN_REQUIRED');
  if (activation.amazonMutationAuthorized !== false) fail('PHASE5_AMAZON_MUTATION_FORBIDDEN');
  if (activation.productionMutationAuthorized !== false) fail('PHASE5_PRODUCTION_MUTATION_FORBIDDEN');
  if (activation.productionAmazonAdsEnabled !== false) fail('PHASE5_PRODUCTION_AMAZON_FLAG_FORBIDDEN');
  if (activation.productionSyncTriggerEnabled !== false) fail('PHASE5_PRODUCTION_SYNC_FLAG_FORBIDDEN');

  assertExactStringArray(
    activation.allowedDatasets,
    PHASE5_IMPLEMENTED_DATASETS,
    'PHASE5_ACTIVATION_DATASET_SCOPE_INVALID',
  );

  const nativeDev = requiredObject(native.env?.dev, 'PHASE5_NATIVE_DEV_CONFIG_MISSING');
  const syncDev = requiredObject(sync.env?.dev, 'PHASE5_SYNC_DEV_CONFIG_MISSING');
  const nativeProd = requiredObject(native.env?.production, 'PHASE5_NATIVE_PRODUCTION_CONFIG_MISSING');
  const syncProd = requiredObject(sync.env?.production, 'PHASE5_SYNC_PRODUCTION_CONFIG_MISSING');

  if (nativeDev.name !== 'ads-operations-web-dev') fail('PHASE5_NATIVE_DEV_WORKER_INVALID');
  if (syncDev.name !== 'ads-operations-sync-dev') fail('PHASE5_SYNC_DEV_WORKER_INVALID');
  if (nativeDev.vars?.APP_ENV !== 'development' || syncDev.vars?.APP_ENV !== 'development') {
    fail('PHASE5_DEV_ENVIRONMENT_INVALID');
  }

  assertBooleanText(
    syncDev.vars?.AMAZON_ADS_ENABLED,
    activation.amazonAdsEnabled,
    'PHASE5_SYNC_DEV_AMAZON_FLAG_MISMATCH',
  );
  assertBooleanText(
    nativeDev.vars?.SYNC_TRIGGER_ENABLED,
    activation.syncTriggerEnabled,
    'PHASE5_NATIVE_DEV_SYNC_FLAG_MISMATCH',
  );

  assertExactBindings(nativeDev.d1_databases, PHASE5_DEV_D1_BINDINGS, 'PHASE5_NATIVE_DEV_D1_SCOPE_INVALID');
  assertExactBindings(syncDev.d1_databases, PHASE5_DEV_D1_BINDINGS, 'PHASE5_SYNC_DEV_D1_SCOPE_INVALID');
  assertDevR2(nativeDev.r2_buckets, 'PHASE5_NATIVE_DEV_R2_SCOPE_INVALID');
  assertDevR2(syncDev.r2_buckets, 'PHASE5_SYNC_DEV_R2_SCOPE_INVALID');
  assertNativeWorkflow(nativeDev.workflows);
  assertSyncWorkflow(syncDev.workflows);

  if (nativeProd.vars?.APP_ENV !== 'production' || syncProd.vars?.APP_ENV !== 'production') {
    fail('PHASE5_PRODUCTION_ENVIRONMENT_INVALID');
  }
  assertBooleanText(
    nativeProd.vars?.SYNC_TRIGGER_ENABLED,
    false,
    'PHASE5_PRODUCTION_SYNC_TRIGGER_MUST_REMAIN_FALSE',
  );
  assertBooleanText(
    syncProd.vars?.AMAZON_ADS_ENABLED,
    false,
    'PHASE5_PRODUCTION_AMAZON_ADS_MUST_REMAIN_FALSE',
  );

  return Object.freeze({
    ok:true,
    schemaVersion:activation.schemaVersion,
    state:activation.state,
    transitionFrom:activation.transitionFrom,
    storeId:activation.storeId,
    storeCode:activation.storeCode,
    allowedDatasets:Object.freeze([...activation.allowedDatasets]),
    amazonAdsEnabled:activation.amazonAdsEnabled,
    syncTriggerEnabled:activation.syncTriggerEnabled,
    singleRunOnly:true,
    productionMutationAuthorized:false,
    amazonMutationAuthorized:false,
    devD1Bindings:Object.freeze([...PHASE5_DEV_D1_BINDINGS]),
  });
}

function assertExactBindings(entries, expected, code) {
  if (!Array.isArray(entries)) fail(code);
  const bindings = entries.map((entry) => String(entry?.binding ?? '')).filter(Boolean).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(bindings) !== JSON.stringify(wanted)) fail(code);
}

function assertDevR2(entries, code) {
  if (!Array.isArray(entries) || entries.length !== 1) fail(code);
  const [bucket] = entries;
  if (bucket?.binding !== 'DATA_BUCKET' || bucket?.bucket_name !== 'ads-ops-data-dev') fail(code);
}

function assertNativeWorkflow(entries) {
  if (!Array.isArray(entries) || entries.length !== 1) fail('PHASE5_NATIVE_DEV_WORKFLOW_SCOPE_INVALID');
  const [workflow] = entries;
  if (
    workflow?.name !== 'ads-amazon-sync-dev'
    || workflow?.binding !== 'AMAZON_SYNC_WORKFLOW'
    || workflow?.class_name !== 'AmazonAdsSyncWorkflow'
    || workflow?.script_name !== 'ads-operations-sync-dev'
  ) fail('PHASE5_NATIVE_DEV_WORKFLOW_SCOPE_INVALID');
}

function assertSyncWorkflow(entries) {
  if (!Array.isArray(entries) || entries.length !== 1) fail('PHASE5_SYNC_DEV_WORKFLOW_SCOPE_INVALID');
  const [workflow] = entries;
  if (
    workflow?.name !== 'ads-amazon-sync-dev'
    || workflow?.binding !== 'AMAZON_SYNC_WORKFLOW'
    || workflow?.class_name !== 'AmazonAdsSyncWorkflow'
  ) fail('PHASE5_SYNC_DEV_WORKFLOW_SCOPE_INVALID');
}

function assertBooleanText(actual, expected, code) {
  if (String(actual) !== String(Boolean(expected))) fail(code);
}

function assertExactStringArray(actual, expected, code) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== 'string')) fail(code);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code);
}

function requiredObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function fail(code) {
  throw new Phase5ActivationContractError(code);
}

async function readJson(relativePath) {
  const body = await readFile(resolve(process.cwd(), relativePath), 'utf8');
  return JSON.parse(body);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = validatePhase5LiveReadActivation({
    state:await readJson('docs/operations/PHASE5_STORE01_ACTIVATION_STATE.json'),
    nativeConfig:await readJson('cloudflare/runtime/wrangler.native.jsonc'),
    syncConfig:await readJson('cloudflare/runtime/wrangler.sync.jsonc'),
  });
  console.log(JSON.stringify(result, null, 2));
}
