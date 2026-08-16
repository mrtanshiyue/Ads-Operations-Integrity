import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeConfigs = [
  path.join(repoRoot, 'cloudflare/runtime/wrangler.native.jsonc'),
  path.join(repoRoot, 'cloudflare/runtime/wrangler.sync.jsonc'),
];
const migrationConfigArg = 'cloudflare/runtime/wrangler.native.jsonc';

const RESOURCES = Object.freeze({
  controlDb: 'ads-ops-control-dev',
  storeDb: 'ads-ops-store-dev',
  bucket: 'ads-ops-data-dev',
  location: 'apac',
});

const argv = new Set(process.argv.slice(2));
const applyMigrations = !argv.has('--resources-only');
const dryRun = argv.has('--dry-run');

if (argv.has('--production') || argv.has('--prod')) {
  throw new Error('This script is dev-only and refuses production provisioning.');
}

function npmCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function runWrangler(args, { json = false, allowFailure = false, input } = {}) {
  const printable = `npx wrangler ${args.join(' ')}`;
  if (dryRun) {
    console.log(`[dry-run] ${printable}`);
    return { ok: true, stdout: json ? '[]' : '', stderr: '' };
  }

  const result = spawnSync(npmCommand(), ['wrangler', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 16 * 1024 * 1024,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${printable} failed (${result.status})\n${stdout}\n${stderr}`.trim());
  }
  return { ok: result.status === 0, stdout, stderr };
}

function parseJsonOutput(text, label) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error(`${label} returned empty JSON output`);
  try {
    return JSON.parse(trimmed);
  } catch {
    const startArray = trimmed.indexOf('[');
    const startObject = trimmed.indexOf('{');
    const start = [startArray, startObject].filter((n) => n >= 0).sort((a, b) => a - b)[0];
    if (start === undefined) throw new Error(`${label} returned non-JSON output: ${trimmed}`);
    return JSON.parse(trimmed.slice(start));
  }
}

function normalizeD1List(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.databases)) return payload.databases;
  return [];
}

function databaseUuid(database) {
  return String(database?.uuid || database?.database_id || database?.id || '').trim();
}

function exactDatabase(databases, name) {
  const matches = databases.filter((db) => String(db?.name || '').trim() === name);
  if (matches.length > 1) throw new Error(`Multiple D1 databases have the exact name ${name}`);
  return matches[0] || null;
}

function listD1() {
  const result = runWrangler(['d1', 'list', '--json'], { json: true });
  return normalizeD1List(parseJsonOutput(result.stdout, 'wrangler d1 list --json'));
}

function ensureD1(name) {
  let databases = listD1();
  let db = exactDatabase(databases, name);
  if (!db) {
    console.log(`Creating D1 ${name} in ${RESOURCES.location}...`);
    runWrangler(['d1', 'create', name, `--location=${RESOURCES.location}`]);
    databases = listD1();
    db = exactDatabase(databases, name);
  } else {
    console.log(`Reusing existing D1 ${name}.`);
  }

  if (dryRun) return `DRY_RUN_${name.toUpperCase().replaceAll('-', '_')}_UUID`;
  const uuid = databaseUuid(db);
  if (!uuid) throw new Error(`Could not resolve UUID for D1 ${name}`);
  return uuid;
}

function r2Exists(name) {
  const result = runWrangler(['r2', 'bucket', 'info', name, '--json'], {
    json: true,
    allowFailure: true,
  });
  if (result.ok) return true;

  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const looksMissing = combined.includes('not found') || combined.includes('does not exist') || combined.includes('10006') || combined.includes('404');
  if (!looksMissing) {
    throw new Error(`Unable to inspect R2 bucket ${name}; refusing to guess that it is absent.\n${result.stdout}\n${result.stderr}`.trim());
  }
  return false;
}

function ensureR2(name) {
  if (dryRun) {
    console.log(`[dry-run] inspect/create R2 ${name}`);
    return;
  }
  if (r2Exists(name)) {
    console.log(`Reusing existing R2 bucket ${name}.`);
    return;
  }
  console.log(`Creating R2 bucket ${name} in ${RESOURCES.location}...`);
  runWrangler(['r2', 'bucket', 'create', name, `--location=${RESOURCES.location}`]);
  if (!r2Exists(name)) throw new Error(`R2 bucket ${name} was not visible after creation`);
}

async function updateRuntimeConfig(configPath, controlUuid, storeUuid) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const dev = config?.env?.dev;
  if (!dev) throw new Error(`${path.basename(configPath)} is missing env.dev`);

  const byBinding = new Map((dev.d1_databases || []).map((item) => [item.binding, item]));
  const control = byBinding.get('CONTROL_DB');
  const store = byBinding.get('STORE_01_DB');
  if (!control || !store) {
    throw new Error(`${path.basename(configPath)} env.dev must contain CONTROL_DB and STORE_01_DB`);
  }
  if (control.database_name !== RESOURCES.controlDb || store.database_name !== RESOURCES.storeDb) {
    throw new Error(`${path.basename(configPath)} dev D1 names do not match the fixed provisioning allowlist`);
  }
  if (dev.r2_buckets?.[0]?.bucket_name !== RESOURCES.bucket || dev.r2_buckets?.[0]?.binding !== 'DATA_BUCKET') {
    throw new Error(`${path.basename(configPath)} dev R2 binding/name does not match the fixed provisioning allowlist`);
  }

  control.database_id = controlUuid;
  store.database_id = storeUuid;

  if (dryRun) {
    console.log(`[dry-run] would update dev D1 UUIDs in ${path.relative(repoRoot, configPath)}`);
    return;
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`Updated dev D1 UUIDs in ${path.relative(repoRoot, configPath)}.`);
}

async function writeDevDatabaseIds(controlUuid, storeUuid) {
  for (const configPath of runtimeConfigs) {
    await updateRuntimeConfig(configPath, controlUuid, storeUuid);
  }
}

function applyRemoteMigrations(databaseName) {
  console.log(`Applying remote migrations to ${databaseName}...`);
  runWrangler([
    'd1', 'migrations', 'apply', databaseName,
    '--remote', '--env', 'dev', '--config', migrationConfigArg,
  ], { input: 'y\n' });
}

function remoteForeignKeyCheck(databaseName) {
  const result = runWrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes', '--json',
    '--command', 'PRAGMA foreign_key_check;',
    '--env', 'dev', '--config', migrationConfigArg,
  ], { json: true });
  const payload = parseJsonOutput(result.stdout, `${databaseName} foreign_key_check`);
  const sets = Array.isArray(payload) ? payload : (Array.isArray(payload?.result) ? payload.result : []);
  const rows = sets.flatMap((set) => Array.isArray(set?.results) ? set.results : []);
  if (rows.length) throw new Error(`${databaseName} foreign_key_check returned ${rows.length} row(s)`);
  console.log(`${databaseName}: foreign_key_check passed.`);
}

async function main() {
  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'apply',
    scope: 'development-only',
    resources: RESOURCES,
    applyMigrations,
  }, null, 2));

  if (!dryRun) runWrangler(['--version']);

  const controlUuid = ensureD1(RESOURCES.controlDb);
  const storeUuid = ensureD1(RESOURCES.storeDb);
  ensureR2(RESOURCES.bucket);
  await writeDevDatabaseIds(controlUuid, storeUuid);

  if (applyMigrations) {
    applyRemoteMigrations(RESOURCES.controlDb);
    applyRemoteMigrations(RESOURCES.storeDb);
    remoteForeignKeyCheck(RESOURCES.controlDb);
    remoteForeignKeyCheck(RESOURCES.storeDb);
  }

  console.log(JSON.stringify({
    ok: true,
    environment: 'dev',
    controlDb: RESOURCES.controlDb,
    storeDb: RESOURCES.storeDb,
    dataBucket: RESOURCES.bucket,
    updatedConfigs: runtimeConfigs.map((configPath) => path.relative(repoRoot, configPath)),
    migrationsApplied: applyMigrations,
    nextGate: 'Configure Cloudflare Access values, seed the dev owner, then deploy the web and sync development Workers.',
  }, null, 2));
}

await main();
