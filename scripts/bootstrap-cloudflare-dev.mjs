import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(repoRoot, 'cloudflare/foundation/bootstrap/seed_dev_control.sql.template');
const configArg = 'cloudflare/runtime/wrangler.native.jsonc';
const databaseName = 'ads-ops-control-dev';

if (process.argv.includes('--production') || process.argv.includes('--prod')) {
  throw new Error('This bootstrap is development-only and refuses production targets.');
}

const email = normalizeEmail(process.env.DEV_OWNER_EMAIL);
const displayName = normalizeDisplayName(process.env.DEV_OWNER_NAME || 'Development Owner');
if (!email) {
  throw new Error('DEV_OWNER_EMAIL is required. Example: DEV_OWNER_EMAIL=you@example.com npm run bootstrap:cf-native:dev');
}

const template = await readFile(templatePath, 'utf8');
if (!template.includes('REPLACE_OWNER_EMAIL') || !template.includes('REPLACE_OWNER_NAME')) {
  throw new Error('Dev bootstrap template placeholders are missing; refusing to render an ambiguous template.');
}

const sql = template
  .replaceAll('REPLACE_OWNER_EMAIL', sqlLiteralContent(email))
  .replaceAll('REPLACE_OWNER_NAME', sqlLiteralContent(displayName));

if (/REPLACE_OWNER_(EMAIL|NAME)/.test(sql)) {
  throw new Error('Bootstrap rendering left unresolved owner placeholders.');
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ads-ops-bootstrap-'));
const renderedPath = path.join(tempDir, 'seed-dev-control.sql');

try {
  await writeFile(renderedPath, sql, { encoding: 'utf8', mode: 0o600 });
  runWrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--file', renderedPath,
    '--env', 'dev', '--config', configArg,
  ]);

  runWrangler([
    'd1', 'execute', databaseName,
    '--remote', '--yes',
    '--command', `SELECT user_id,email,status FROM users WHERE user_id='user-dev-owner'; SELECT role_key FROM user_global_roles WHERE user_id='user-dev-owner'; SELECT store_id,store_code,d1_binding_key,status FROM stores WHERE store_id='store-dev-01';`,
    '--env', 'dev', '--config', configArg,
  ]);

  console.log(JSON.stringify({
    ok: true,
    environment: 'dev',
    database: databaseName,
    ownerEmail: redactEmail(email),
    ownerUserId: 'user-dev-owner',
    storeId: 'store-dev-01',
    storeBinding: 'STORE_01_DB',
  }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function runWrangler(args) {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(command, ['wrangler', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`wrangler exited with status ${result.status}`);
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function normalizeDisplayName(value) {
  const name = String(value || '').trim();
  if (!name) return 'Development Owner';
  if (name.length > 120) throw new Error('DEV_OWNER_NAME must be 120 characters or fewer.');
  return name;
}

function sqlLiteralContent(value) {
  return String(value).replaceAll("'", "''");
}

function redactEmail(value) {
  const [local, domain] = value.split('@');
  const visible = local.length <= 2 ? `${local[0] || '*'}*` : `${local.slice(0, 2)}***`;
  return `${visible}@${domain}`;
}
