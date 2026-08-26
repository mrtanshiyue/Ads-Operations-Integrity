import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const publicPath = path.join(distRoot, 'assets/cloudflare-native-csv-history-ledger-v1.js');
const implementationPath = path.join(distRoot, 'assets/cloudflare-native-csv-history-ledger-impl-v1.js');
const indexPath = path.join(distRoot, 'index.html');

const [publicSource, implementationSource, indexSource] = await Promise.all([
  readFile(publicPath, 'utf8'),
  readFile(implementationPath, 'utf8'),
  readFile(indexPath, 'utf8'),
]);

assert.match(
  publicSource,
  /export \* from '\.\/cloudflare-native-csv-history-ledger-impl-v1\.js';/,
  'public History Ledger module must converge every URL identity on one implementation module',
);
assert.match(
  indexSource,
  /assets\/cloudflare-native-csv-history-ledger-v1\.js\?v=1\.4\.0/,
  'canonical page must continue loading the public cache-busted History Ledger URL',
);
assert.match(
  implementationSource,
  /Object\.defineProperty\(window, 'CloudflareCsvHistoryLedger'/,
  'canonical implementation must retain the immutable browser global registration',
);
assert.equal(
  (implementationSource.match(/Object\.defineProperty\(window, 'CloudflareCsvHistoryLedger'/g) || []).length,
  1,
  'canonical implementation must register CloudflareCsvHistoryLedger exactly once in source',
);
assert.doesNotMatch(
  publicSource,
  /AMAZON_ADS_ENABLED|AMAZON_ADS_CLIENT|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/,
  'module-identity wrapper must not create Amazon execution authority',
);

const priorWindow = globalThis.window;
globalThis.window = {};
try {
  const publicUrl = pathToFileURL(publicPath).href;
  const cacheBustedModule = await import(`${publicUrl}?v=1.4.0&identity=cache-busted`);
  const registered = globalThis.window.CloudflareCsvHistoryLedger;
  assert(registered, 'cache-busted History Ledger load must install the browser global');
  assert.equal(registered.version, '1.4.0');

  const unversionedModule = await import(`${publicUrl}?identity=unversioned`);
  assert.strictEqual(
    globalThis.window.CloudflareCsvHistoryLedger,
    registered,
    'second public module identity must reuse the one canonical implementation registration',
  );
  assert.strictEqual(
    cacheBustedModule.buildHistoricalMonthlyWorkspace,
    unversionedModule.buildHistoricalMonthlyWorkspace,
    'cache-busted and unversioned wrappers must expose the same implementation exports',
  );

  const descriptor = Object.getOwnPropertyDescriptor(globalThis.window, 'CloudflareCsvHistoryLedger');
  assert.equal(descriptor?.configurable, false, 'History Ledger global must remain non-configurable');
  assert.equal(descriptor?.writable, false, 'History Ledger global must remain non-writable');
} finally {
  if (priorWindow === undefined) delete globalThis.window;
  else globalThis.window = priorWindow;
}

console.log(JSON.stringify({
  ok: true,
  cacheBustedAndUnversionedModuleIdentityConverged: true,
  immutableGlobalRegistrationPreserved: true,
  amazonExecutionAuthorized: false,
}));
