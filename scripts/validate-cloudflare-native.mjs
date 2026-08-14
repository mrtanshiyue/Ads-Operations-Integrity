import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(repoRoot, 'cloudflare/runtime/wrangler.native.jsonc');
const args = new Set(process.argv.slice(2));
const envArgIndex = process.argv.indexOf('--env');
const envName = envArgIndex >= 0 ? process.argv[envArgIndex + 1] : 'dev';
const requireReady = args.has('--require-ready');

if (!['dev', 'production'].includes(envName)) {
  throw new Error(`Unsupported environment: ${envName}`);
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
const env = config.env?.[envName];
if (!env) throw new Error(`Missing env.${envName} in wrangler.native.jsonc`);

const errors = [];
const warnings = [];
const expectedStoreBindings = envName === 'production'
  ? ['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']
  : ['STORE_01_DB'];

if (config.main !== './web-worker.js') errors.push('main must be ./web-worker.js');
if (config.assets?.binding !== 'ASSETS') errors.push('assets.binding must be ASSETS');
if (config.assets?.not_found_handling !== 'single-page-application') {
  errors.push('assets.not_found_handling must be single-page-application');
}
if (JSON.stringify(config.assets?.run_worker_first) !== JSON.stringify(['/api/*'])) {
  errors.push('assets.run_worker_first must contain only /api/*');
}

const d1 = Array.isArray(env.d1_databases) ? env.d1_databases : [];
const bindings = d1.map((item) => item.binding);
const bindingSet = new Set(bindings);
if (bindingSet.size !== bindings.length) errors.push('D1 binding names must be unique');
if (!bindingSet.has('CONTROL_DB')) errors.push('CONTROL_DB binding is required');
for (const binding of expectedStoreBindings) {
  if (!bindingSet.has(binding)) errors.push(`${binding} binding is required for ${envName}`);
}

const expectedD1Count = envName === 'production' ? 5 : 2;
if (d1.length !== expectedD1Count) {
  errors.push(`${envName} must define exactly ${expectedD1Count} D1 bindings; found ${d1.length}`);
}

const r2 = Array.isArray(env.r2_buckets) ? env.r2_buckets : [];
if (r2.length !== 1 || r2[0]?.binding !== 'DATA_BUCKET') {
  errors.push(`${envName} must define exactly one DATA_BUCKET R2 binding`);
}

if (envName === 'production' && env.vars?.ACCESS_MODE !== 'enforce') {
  errors.push('production ACCESS_MODE must be enforce');
}
if (envName === 'dev' && !['observe', 'enforce'].includes(env.vars?.ACCESS_MODE)) {
  errors.push('dev ACCESS_MODE must be observe or enforce');
}

const unresolved = [];
for (const db of d1) {
  if (!db.database_id || /REPLACE/i.test(db.database_id)) unresolved.push(`${db.binding}.database_id`);
}
for (const key of ['TEAM_DOMAIN', 'ACCESS_AUD']) {
  const value = String(env.vars?.[key] || '');
  if (!value || /REPLACE/i.test(value)) unresolved.push(`vars.${key}`);
}
if (r2.some((bucket) => !bucket.bucket_name)) unresolved.push('DATA_BUCKET.bucket_name');

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
  d1Bindings: bindings,
  r2Bindings: r2.map((item) => item.binding),
  warnings,
}, null, 2));
