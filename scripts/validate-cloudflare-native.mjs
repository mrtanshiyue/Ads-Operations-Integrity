import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validatePhase5LiveReadActivation,
} from './phase5-live-read-activation-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webConfigPath = path.join(repoRoot, 'cloudflare/runtime/wrangler.native.jsonc');
const syncConfigPath = path.join(repoRoot, 'cloudflare/runtime/wrangler.sync.jsonc');
const runtimeObservedEntryPath = path.join(repoRoot, 'cloudflare/runtime/runtime-observed-entry.js');
const webEntryPath = path.join(repoRoot, 'cloudflare/runtime/web-entry.js');
const syncWorkerPath = path.join(repoRoot, 'cloudflare/runtime/sync-worker.js');
const activationStatePath = path.join(repoRoot, 'docs/operations/PHASE5_STORE01_ACTIVATION_STATE.json');
const args = new Set(process.argv.slice(2));
const envArgIndex = process.argv.indexOf('--env');
const envName = envArgIndex >= 0 ? process.argv[envArgIndex + 1] : 'dev';
const requireReady = args.has('--require-ready');

if (!['dev', 'production'].includes(envName)) {
  throw new Error(`Unsupported environment: ${envName}`);
}

const [webConfig, syncConfig, runtimeObservedEntrySource, webEntrySource, syncWorkerSource, activationState] = await Promise.all([
  readConfig(webConfigPath),
  readConfig(syncConfigPath),
  readFile(runtimeObservedEntryPath, 'utf8'),
  readFile(webEntryPath, 'utf8'),
  readFile(syncWorkerPath, 'utf8'),
  readConfig(activationStatePath),
]);
const webEnv = webConfig.env?.[envName];
const syncEnv = syncConfig.env?.[envName];
if (!webEnv) throw new Error(`Missing env.${envName} in wrangler.native.jsonc`);
if (!syncEnv) throw new Error(`Missing env.${envName} in wrangler.sync.jsonc`);

const errors = [];
const warnings = [];
const unresolved = [];
let phase5Activation = null;
const expectedStoreBindings = envName === 'production'
  ? ['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']
  : ['STORE_01_DB'];
const expectedD1Count = envName === 'production' ? 5 : 2;
const expectedWorkflowName = envName === 'production' ? 'ads-amazon-sync-prod' : 'ads-amazon-sync-dev';
const expectedSyncScriptName = envName === 'production' ? 'ads-operations-sync-prod' : 'ads-operations-sync-dev';

validateWebRuntime();
validateSyncRuntime();
validateSharedResources();
validatePhase5Activation();
validateReadiness();

if (unresolved.length) {
  const msg = `Unresolved runtime values: ${unresolved.join(', ')}`;
  if (requireReady) errors.push(msg);
  else warnings.push(msg);
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, env: envName, errors, warnings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  env: envName,
  requireReady,
  phase5Activation,
  web: {
    main: webConfig.main,
    canonicalApplicationEntry: './web-entry.js',
    runtimeEvidenceWrapper: true,
    d1Bindings: bindingNames(webEnv.d1_databases),
    r2Bindings: bindingNames(webEnv.r2_buckets),
    workflows: bindingNames(webEnv.workflows),
    accessMode: webEnv.vars?.ACCESS_MODE,
    devReadOnlyAccessBypass: envName === 'dev' && webEnv.vars?.ACCESS_MODE === 'off',
    syncTriggerEnabled: webEnv.vars?.SYNC_TRIGGER_ENABLED,
  },
  sync: {
    d1Bindings: bindingNames(syncEnv.d1_databases),
    r2Bindings: bindingNames(syncEnv.r2_buckets),
    workflows: bindingNames(syncEnv.workflows),
    amazonAdsEnabled: syncEnv.vars?.AMAZON_ADS_ENABLED,
  },
  warnings,
}, null, 2));

async function readConfig(configPath) {
  return JSON.parse(await readFile(configPath, 'utf8'));
}

function validateWebRuntime() {
  if (webConfig.main !== './runtime-observed-entry.js') {
    errors.push('web main must be ./runtime-observed-entry.js');
  }
  if (!/import\s+application\s+from\s+['"]\.\/web-entry\.js['"]/.test(runtimeObservedEntrySource)) {
    errors.push('runtime evidence wrapper must import canonical ./web-entry.js application entry');
  }
  if (/src\/worker\.js/.test(runtimeObservedEntrySource)) {
    errors.push('runtime evidence wrapper must not reference legacy src/worker.js');
  }
  if (!runtimeObservedEntrySource.includes('runtime_request_evidence')) {
    errors.push('runtime evidence wrapper must emit runtime_request_evidence');
  }
  if (!runtimeObservedEntrySource.includes('CF_VERSION_METADATA')) {
    errors.push('runtime evidence wrapper must bind runtime version metadata');
  }
  if (webConfig.assets?.binding !== 'ASSETS') errors.push('web assets.binding must be ASSETS');
  if (webConfig.assets?.not_found_handling !== 'single-page-application') {
    errors.push('web assets.not_found_handling must be single-page-application');
  }
  if (JSON.stringify(webConfig.assets?.run_worker_first) !== JSON.stringify(['/api/*'])) {
    errors.push('web assets.run_worker_first must contain only /api/*');
  }
  validateDataBindings('web', webEnv);

  const accessMode = String(webEnv.vars?.ACCESS_MODE || '').trim().toLowerCase();
  if (envName === 'production') {
    if (webEnv.vars?.APP_ENV !== 'production') errors.push('production web APP_ENV must be production');
    if (accessMode !== 'enforce') errors.push('production web ACCESS_MODE must be enforce');
  }
  if (envName === 'dev') {
    if (webEnv.vars?.APP_ENV !== 'development') errors.push('dev web APP_ENV must be development');
    if (!['off', 'observe', 'enforce'].includes(accessMode)) {
      errors.push('dev web ACCESS_MODE must be off, observe, or enforce');
    }
    if (accessMode === 'off') validateDevReadOnlyAccessBypass();
  }
  if (envName === 'production' && webEnv.vars?.SYNC_TRIGGER_ENABLED !== 'false') {
    errors.push('production SYNC_TRIGGER_ENABLED must remain false during Phase 5');
  }

  const workflows = Array.isArray(webEnv.workflows) ? webEnv.workflows : [];
  if (workflows.length !== 1) {
    errors.push(`${envName} web runtime must define exactly one cross-script Workflow binding`);
  } else {
    const workflow = workflows[0];
    if (workflow.binding !== 'AMAZON_SYNC_WORKFLOW') errors.push('web Workflow binding must be AMAZON_SYNC_WORKFLOW');
    if (workflow.class_name !== 'AmazonAdsSyncWorkflow') errors.push('web Workflow class_name must be AmazonAdsSyncWorkflow');
    if (workflow.name !== expectedWorkflowName) errors.push(`web Workflow name must be ${expectedWorkflowName}`);
    if (workflow.script_name !== expectedSyncScriptName) errors.push(`web Workflow script_name must be ${expectedSyncScriptName}`);
  }
}

function validateDevReadOnlyAccessBypass() {
  if (webEnv.vars?.SYNC_TRIGGER_ENABLED !== 'false') {
    errors.push('dev ACCESS_MODE off requires SYNC_TRIGGER_ENABLED=false');
  }

  const requiredMarkers = [
    "DEV_READ_ONLY_BYPASS_ACTOR_ID = 'user-dev-owner'",
    "DEV_READ_ONLY_BYPASS_METHODS = new Set(['GET', 'HEAD'])",
    'guardDevReadOnlyAccessBypass',
    'isDevReadOnlyAccessBypassRoute',
    'isDevReadOnlyAccessBypassRequest',
    'resolveDevReadOnlyBypassActor',
    'dev_read_only_bypass_write_blocked',
    'dev_read_only_bypass_route_blocked',
    'if (!devReadOnlyBypass)',
  ];
  for (const marker of requiredMarkers) {
    if (!webEntrySource.includes(marker)) {
      errors.push(`dev ACCESS_MODE off requires read-only bypass marker: ${marker}`);
    }
  }
}

function validateSyncRuntime() {
  if (syncConfig.main !== './sync-worker.js') errors.push('sync main must be ./sync-worker.js');
  if (syncConfig.observability?.enabled !== true) errors.push('sync observability must be enabled');
  validateDataBindings('sync', syncEnv);

  if (!/import\s*\{\s*NonRetryableError\s*\}\s*from\s*['"]cloudflare:workflows['"]/.test(syncWorkerSource)) {
    errors.push('sync Worker must import NonRetryableError from cloudflare:workflows');
  }
  if (/import\s*\{[^}]*NonRetryableError[^}]*\}\s*from\s*['"]cloudflare:workers['"]/.test(syncWorkerSource)) {
    errors.push('sync Worker must not import NonRetryableError from cloudflare:workers');
  }

  const workflows = Array.isArray(syncEnv.workflows) ? syncEnv.workflows : [];
  if (workflows.length !== 1) {
    errors.push(`${envName} sync runtime must define exactly one Workflow binding`);
  } else {
    const workflow = workflows[0];
    if (workflow.binding !== 'AMAZON_SYNC_WORKFLOW') errors.push('sync Workflow binding must be AMAZON_SYNC_WORKFLOW');
    if (workflow.class_name !== 'AmazonAdsSyncWorkflow') errors.push('sync Workflow class_name must be AmazonAdsSyncWorkflow');
    if (workflow.name !== expectedWorkflowName) errors.push(`sync Workflow name must be ${expectedWorkflowName}`);
    if (Array.isArray(workflow.schedules) && workflow.schedules.length) {
      errors.push('sync Workflow schedules must remain disabled during controlled Phase 5 live-read activation');
    }
  }

  if (envName === 'production' && syncEnv.vars?.AMAZON_ADS_ENABLED !== 'false') {
    errors.push('production AMAZON_ADS_ENABLED must remain false during Phase 5');
  }
}

function validateDataBindings(label, env) {
  const d1 = Array.isArray(env.d1_databases) ? env.d1_databases : [];
  const names = bindingNames(d1);
  const bindingSet = new Set(names);
  if (bindingSet.size !== names.length) errors.push(`${label} D1 binding names must be unique`);
  if (!bindingSet.has('CONTROL_DB')) errors.push(`${label} CONTROL_DB binding is required`);
  for (const binding of expectedStoreBindings) {
    if (!bindingSet.has(binding)) errors.push(`${label} ${binding} binding is required for ${envName}`);
  }
  if (d1.length !== expectedD1Count) {
    errors.push(`${label} ${envName} must define exactly ${expectedD1Count} D1 bindings; found ${d1.length}`);
  }

  const r2 = Array.isArray(env.r2_buckets) ? env.r2_buckets : [];
  if (r2.length !== 1 || r2[0]?.binding !== 'DATA_BUCKET') {
    errors.push(`${label} ${envName} must define exactly one DATA_BUCKET R2 binding`);
  }
}

function validateSharedResources() {
  const webD1 = byBinding(webEnv.d1_databases);
  const syncD1 = byBinding(syncEnv.d1_databases);
  const allD1Bindings = ['CONTROL_DB', ...expectedStoreBindings];
  for (const binding of allD1Bindings) {
    const web = webD1.get(binding);
    const sync = syncD1.get(binding);
    if (!web || !sync) continue;
    if (web.database_name !== sync.database_name) {
      errors.push(`${binding} database_name differs between web and sync runtimes`);
    }
    if (String(web.database_id || '') !== String(sync.database_id || '')) {
      errors.push(`${binding} database_id differs between web and sync runtimes`);
    }
    if (web.migrations_dir !== sync.migrations_dir) {
      errors.push(`${binding} migrations_dir differs between web and sync runtimes`);
    }
  }

  const webBucket = webEnv.r2_buckets?.[0];
  const syncBucket = syncEnv.r2_buckets?.[0];
  if (webBucket?.bucket_name !== syncBucket?.bucket_name) {
    errors.push('DATA_BUCKET bucket_name differs between web and sync runtimes');
  }

  const webWorkflow = webEnv.workflows?.[0];
  const syncWorkflow = syncEnv.workflows?.[0];
  if (webWorkflow?.name !== syncWorkflow?.name) {
    errors.push('web and sync Workflow names do not match');
  }
  if (webWorkflow?.class_name !== syncWorkflow?.class_name) {
    errors.push('web and sync Workflow class names do not match');
  }
  if (webWorkflow?.script_name !== syncEnv.name) {
    errors.push('web Workflow script_name does not match the sync Worker environment name');
  }
}

function validatePhase5Activation() {
  try {
    phase5Activation = validatePhase5LiveReadActivation({
      state:activationState,
      nativeConfig:webConfig,
      syncConfig,
    });
  } catch (error) {
    errors.push(`Phase 5 activation contract failed: ${String(error?.code || error?.message || 'unknown')}`);
  }
}

function validateReadiness() {
  for (const [label, env] of [['web', webEnv], ['sync', syncEnv]]) {
    for (const db of env.d1_databases || []) {
      if (!db.database_id || /REPLACE/i.test(db.database_id)) {
        unresolved.push(`${label}.${db.binding}.database_id`);
      }
    }
    for (const bucket of env.r2_buckets || []) {
      if (!bucket.bucket_name) unresolved.push(`${label}.DATA_BUCKET.bucket_name`);
    }
  }

  for (const key of ['TEAM_DOMAIN', 'ACCESS_AUD']) {
    const value = String(webEnv.vars?.[key] || '');
    if (!value || /REPLACE/i.test(value)) unresolved.push(`web.vars.${key}`);
  }
}

function bindingNames(items) {
  return (Array.isArray(items) ? items : []).map((item) => item.binding);
}

function byBinding(items) {
  return new Map((Array.isArray(items) ? items : []).map((item) => [item.binding, item]));
}
