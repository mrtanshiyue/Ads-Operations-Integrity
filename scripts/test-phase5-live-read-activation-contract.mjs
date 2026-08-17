import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  Phase5ActivationContractError,
  validatePhase5LiveReadActivation,
} from './phase5-live-read-activation-contract.mjs';

const state = JSON.parse(await readFile(new URL('../docs/operations/PHASE5_STORE01_ACTIVATION_STATE.json', import.meta.url), 'utf8'));
const nativeConfig = JSON.parse(await readFile(new URL('../cloudflare/runtime/wrangler.native.jsonc', import.meta.url), 'utf8'));
const syncConfig = JSON.parse(await readFile(new URL('../cloudflare/runtime/wrangler.sync.jsonc', import.meta.url), 'utf8'));
const PERMIT_ID = 'phase5.store01.search-term.2026-08-09.seller.v1';
const REPORT_DATE = '2026-08-09';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validate(overrides = {}) {
  return validatePhase5LiveReadActivation({
    state:overrides.state ?? clone(state),
    nativeConfig:overrides.nativeConfig ?? clone(nativeConfig),
    syncConfig:overrides.syncConfig ?? clone(syncConfig),
  });
}

function rejects(code, overrides) {
  assert.throws(
    () => validate(overrides),
    (error) => error instanceof Phase5ActivationContractError && error.code === code,
  );
}

function singleRunState() {
  const next = clone(state);
  next.state = 'single_run_open';
  next.transitionFrom = 'amazon_read_ready';
  next.amazonAdsEnabled = true;
  next.syncTriggerEnabled = true;
  next.singleRunPermit = { permitId:PERMIT_ID, reportDate:REPORT_DATE };
  return next;
}

function singleRunNative() {
  const next = clone(nativeConfig);
  next.env.dev.vars.SYNC_TRIGGER_ENABLED = 'true';
  next.env.dev.vars.PHASE5_SINGLE_RUN_PERMIT_ID = PERMIT_ID;
  next.env.dev.vars.PHASE5_SINGLE_RUN_REPORT_DATE = REPORT_DATE;
  return next;
}

function amazonReadySync() {
  const next = clone(syncConfig);
  next.env.dev.vars.AMAZON_ADS_ENABLED = 'true';
  return next;
}

const baseline = validate();
assert.equal(baseline.ok, true);
assert.equal(baseline.schemaVersion, 'phase5-store01-live-read-activation-v2');
assert.equal(baseline.state, 'safe_disabled');
assert.equal(baseline.amazonAdsEnabled, false);
assert.equal(baseline.syncTriggerEnabled, false);
assert.equal(baseline.singleRunPermit, null);
assert.deepEqual(baseline.allowedDatasets, ['search_term_daily']);
assert.deepEqual(baseline.devD1Bindings, ['CONTROL_DB', 'STORE_01_DB']);

{
  const next = clone(state);
  next.state = 'amazon_read_ready';
  next.transitionFrom = 'safe_disabled';
  next.amazonAdsEnabled = true;
  const accepted = validate({ state:next, syncConfig:amazonReadySync() });
  assert.equal(accepted.state, 'amazon_read_ready');
  assert.equal(accepted.amazonAdsEnabled, true);
  assert.equal(accepted.syncTriggerEnabled, false);
  assert.equal(accepted.singleRunPermit, null);
}

{
  const accepted = validate({
    state:singleRunState(),
    syncConfig:amazonReadySync(),
    nativeConfig:singleRunNative(),
  });
  assert.equal(accepted.state, 'single_run_open');
  assert.equal(accepted.amazonAdsEnabled, true);
  assert.equal(accepted.syncTriggerEnabled, true);
  assert.deepEqual(accepted.singleRunPermit, {
    permitId:PERMIT_ID,
    reportDate:REPORT_DATE,
    accountType:'seller',
  });
}

{
  const emergency = clone(state);
  emergency.state = 'safe_disabled';
  emergency.transitionFrom = 'single_run_open';
  const accepted = validate({ state:emergency });
  assert.equal(accepted.state, 'safe_disabled');
  assert.equal(accepted.amazonAdsEnabled, false);
  assert.equal(accepted.syncTriggerEnabled, false);
  assert.equal(accepted.singleRunPermit, null);
}

{
  const bad = singleRunState();
  bad.transitionFrom = 'safe_disabled';
  rejects('PHASE5_ACTIVATION_TRANSITION_INVALID:safe_disabled:single_run_open', {
    state:bad,
    syncConfig:amazonReadySync(),
    nativeConfig:singleRunNative(),
  });
}

{
  const bad = singleRunState();
  bad.singleRunPermit = null;
  rejects('PHASE5_SINGLE_RUN_PERMIT_REQUIRED', {
    state:bad,
    syncConfig:amazonReadySync(),
    nativeConfig:singleRunNative(),
  });
}

{
  const bad = singleRunState();
  bad.singleRunPermit.reportDate = '2026-08-08';
  rejects('PHASE5_SINGLE_RUN_PERMIT_DATE_MISMATCH', {
    state:bad,
    syncConfig:amazonReadySync(),
    nativeConfig:singleRunNative(),
  });
}

{
  const badNative = singleRunNative();
  badNative.env.dev.vars.PHASE5_SINGLE_RUN_PERMIT_ID = 'phase5.store01.search-term.2026-08-09.vendor.v1';
  rejects('PHASE5_SINGLE_RUN_RUNTIME_PERMIT_MISMATCH', {
    state:singleRunState(),
    syncConfig:amazonReadySync(),
    nativeConfig:badNative,
  });
}

{
  const bad = clone(state);
  bad.allowedDatasets.push('campaign_daily');
  rejects('PHASE5_ACTIVATION_DATASET_SCOPE_INVALID', { state:bad });
}

{
  const bad = clone(nativeConfig);
  bad.env.dev.d1_databases.push({
    binding:'STORE_02_DB',
    database_name:'forbidden-store-02',
    database_id:'forbidden',
  });
  rejects('PHASE5_NATIVE_DEV_D1_SCOPE_INVALID', { nativeConfig:bad });
}

{
  const bad = clone(syncConfig);
  bad.env.dev.d1_databases.push({
    binding:'STORE_02_DB',
    database_name:'forbidden-store-02',
    database_id:'forbidden',
  });
  rejects('PHASE5_SYNC_DEV_D1_SCOPE_INVALID', { syncConfig:bad });
}

{
  const bad = clone(syncConfig);
  bad.env.production.vars.AMAZON_ADS_ENABLED = 'true';
  rejects('PHASE5_PRODUCTION_AMAZON_ADS_MUST_REMAIN_FALSE', { syncConfig:bad });
}

{
  const bad = clone(nativeConfig);
  bad.env.production.vars.SYNC_TRIGGER_ENABLED = 'true';
  rejects('PHASE5_PRODUCTION_SYNC_TRIGGER_MUST_REMAIN_FALSE', { nativeConfig:bad });
}

{
  const bad = clone(nativeConfig);
  bad.env.production.vars.PHASE5_SINGLE_RUN_PERMIT_ID = PERMIT_ID;
  rejects('PHASE5_PRODUCTION_SINGLE_RUN_PERMIT_FORBIDDEN', { nativeConfig:bad });
}

{
  const bad = clone(state);
  bad.amazonMutationAuthorized = true;
  rejects('PHASE5_AMAZON_MUTATION_FORBIDDEN', { state:bad });
}

{
  const bad = clone(state);
  bad.productionMutationAuthorized = true;
  rejects('PHASE5_PRODUCTION_MUTATION_FORBIDDEN', { state:bad });
}

console.log(JSON.stringify({
  ok:true,
  contract:'phase5-store01-live-read-activation-v2',
  currentState:'safe_disabled',
  validStates:['safe_disabled', 'amazon_read_ready', 'single_run_open'],
  exactSingleRunPermit:true,
  emergencyShutdownFromSingleRun:true,
  productionAlwaysDisabled:true,
  store01Only:true,
  implementedDatasetOnly:'search_term_daily',
  amazonMutationAuthorized:false,
}, null, 2));
