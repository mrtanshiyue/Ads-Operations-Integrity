import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  Phase5ActivationContractError,
  validatePhase5LiveReadActivation,
} from './phase5-live-read-activation-contract.mjs';

const state = JSON.parse(await readFile(new URL('../docs/operations/PHASE5_STORE01_ACTIVATION_STATE.json', import.meta.url), 'utf8'));
const nativeConfig = JSON.parse(await readFile(new URL('../cloudflare/runtime/wrangler.native.jsonc', import.meta.url), 'utf8'));
const syncConfig = JSON.parse(await readFile(new URL('../cloudflare/runtime/wrangler.sync.jsonc', import.meta.url), 'utf8'));

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

const baseline = validate();
assert.equal(baseline.ok, true);
assert.equal(baseline.state, 'safe_disabled');
assert.equal(baseline.amazonAdsEnabled, false);
assert.equal(baseline.syncTriggerEnabled, false);
assert.deepEqual(baseline.allowedDatasets, ['search_term_daily']);
assert.deepEqual(baseline.devD1Bindings, ['CONTROL_DB', 'STORE_01_DB']);

{
  const next = clone(state);
  next.state = 'amazon_read_ready';
  next.transitionFrom = 'safe_disabled';
  next.amazonAdsEnabled = true;
  const nextSync = clone(syncConfig);
  nextSync.env.dev.vars.AMAZON_ADS_ENABLED = 'true';
  const accepted = validate({ state:next, syncConfig:nextSync });
  assert.equal(accepted.state, 'amazon_read_ready');
  assert.equal(accepted.amazonAdsEnabled, true);
  assert.equal(accepted.syncTriggerEnabled, false);
}

{
  const next = clone(state);
  next.state = 'single_run_open';
  next.transitionFrom = 'amazon_read_ready';
  next.amazonAdsEnabled = true;
  next.syncTriggerEnabled = true;
  const nextSync = clone(syncConfig);
  nextSync.env.dev.vars.AMAZON_ADS_ENABLED = 'true';
  const nextNative = clone(nativeConfig);
  nextNative.env.dev.vars.SYNC_TRIGGER_ENABLED = 'true';
  const accepted = validate({ state:next, syncConfig:nextSync, nativeConfig:nextNative });
  assert.equal(accepted.state, 'single_run_open');
  assert.equal(accepted.amazonAdsEnabled, true);
  assert.equal(accepted.syncTriggerEnabled, true);
}

{
  const emergency = clone(state);
  emergency.state = 'safe_disabled';
  emergency.transitionFrom = 'single_run_open';
  const accepted = validate({ state:emergency });
  assert.equal(accepted.state, 'safe_disabled');
  assert.equal(accepted.amazonAdsEnabled, false);
  assert.equal(accepted.syncTriggerEnabled, false);
}

{
  const bad = clone(state);
  bad.state = 'single_run_open';
  bad.transitionFrom = 'safe_disabled';
  bad.amazonAdsEnabled = true;
  bad.syncTriggerEnabled = true;
  const badSync = clone(syncConfig);
  badSync.env.dev.vars.AMAZON_ADS_ENABLED = 'true';
  const badNative = clone(nativeConfig);
  badNative.env.dev.vars.SYNC_TRIGGER_ENABLED = 'true';
  rejects('PHASE5_ACTIVATION_TRANSITION_INVALID:safe_disabled:single_run_open', {
    state:bad,
    syncConfig:badSync,
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
  contract:'phase5-store01-live-read-activation-v1',
  currentState:'safe_disabled',
  validStates:['safe_disabled', 'amazon_read_ready', 'single_run_open'],
  emergencyShutdownFromSingleRun:true,
  productionAlwaysDisabled:true,
  store01Only:true,
  implementedDatasetOnly:'search_term_daily',
  amazonMutationAuthorized:false,
}, null, 2));
