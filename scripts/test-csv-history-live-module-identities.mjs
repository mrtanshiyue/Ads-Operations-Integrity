import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');

const forbiddenImplementationPatterns = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /CloudflareNativeAPI/,
  /\/api\/v1\//,
  /CONTROL_DB/,
  /STORE_01_DB/,
  /DATA_BUCKET/,
  /AMAZON_ADS_ENABLED/,
  /optimization-actions/,
  /execution-permits/,
  /AMAZON_ADS_CLIENT/,
  /AMAZON_SYNC_WORKFLOW/,
  /SYNC_TRIGGER_ENABLED/,
  /startSync\s*\(/,
];

const targets = [
  {
    label: 'Quarter-over-Quarter Comparison',
    publicAsset: 'cloudflare-native-csv-history-quarter-over-quarter-comparison-v1.js',
    implementationAsset: 'cloudflare-native-csv-history-quarter-over-quarter-comparison-impl-v1.js',
    globalName: 'CloudflareCsvHistoryQuarterOverQuarterComparison',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalQuarterOverQuarterComparison',
  },
  {
    label: 'Year-to-Date Operating Review',
    publicAsset: 'cloudflare-native-csv-history-year-to-date-operating-review-v1.js',
    implementationAsset: 'cloudflare-native-csv-history-year-to-date-operating-review-impl-v1.js',
    globalName: 'CloudflareCsvHistoryYearToDateOperatingReview',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalYearToDateOperatingReview',
  },
  {
    label: 'Rolling-12 Operating Review',
    publicAsset: 'cloudflare-native-csv-history-rolling-12-operating-review-v1.js',
    implementationAsset: 'cloudflare-native-csv-history-rolling-12-operating-review-impl-v1.js',
    globalName: 'CloudflareCsvHistoryRolling12OperatingReview',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalRolling12OperatingReview',
  },
  {
    label: 'Comparison Receipt Verification',
    publicAsset: 'cloudflare-native-csv-history-comparison-receipt-verification-v1.js',
    implementationAsset: 'cloudflare-native-csv-history-comparison-receipt-verification-impl-v1.js',
    globalName: 'CloudflareCsvHistoryComparisonReceiptVerification',
    version: '1.0.0',
    exportedFunction: 'verifyHistoricalComparisonReceiptAgainstLedger',
  },
];

for (const target of targets) await validateIdentityConvergence(target);

console.log(JSON.stringify({
  ok: true,
  validatedGlobals: targets.map((target) => target.globalName),
  implementationLocalOnlyExecutionFreeVerified: true,
  cacheBustedAndUnversionedModuleIdentityConverged: true,
  immutableGlobalRegistrationPreserved: true,
  amazonExecutionAuthorized: false,
}));

async function validateIdentityConvergence(target) {
  const publicPath = path.join(distRoot, 'assets', target.publicAsset);
  const implementationPath = path.join(distRoot, 'assets', target.implementationAsset);
  const [publicSource, implementationSource] = await Promise.all([
    readFile(publicPath, 'utf8'),
    readFile(implementationPath, 'utf8'),
  ]);

  assert.equal(
    publicSource.includes(`export * from './${target.implementationAsset}';`),
    true,
    `${target.label} public module must converge all URL identities on one implementation module`,
  );

  for (const pattern of forbiddenImplementationPatterns) {
    assert.equal(
      pattern.test(implementationSource),
      false,
      `${target.label} canonical implementation must remain local-only and execution-free: ${pattern}`,
    );
  }

  const registrationAnchor = `Object.defineProperty(window, '${target.globalName}'`;
  assert.equal(
    implementationSource.split(registrationAnchor).length - 1,
    1,
    `${target.label} canonical implementation must register ${target.globalName} exactly once in source`,
  );

  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  globalThis.window = {};
  delete globalThis.document;
  try {
    const publicUrl = pathToFileURL(publicPath).href;
    const cacheBustedModule = await import(`${publicUrl}?v=${target.version}&identity=cache-busted`);
    const registered = globalThis.window[target.globalName];
    assert(registered, `cache-busted ${target.label} load must install ${target.globalName}`);
    assert.equal(registered.version, target.version, `${target.label} browser global version must remain unchanged`);

    const unversionedModule = await import(`${publicUrl}?identity=unversioned`);
    assert.strictEqual(
      globalThis.window[target.globalName],
      registered,
      `${target.label} second public URL identity must reuse the canonical implementation registration`,
    );
    assert.strictEqual(
      cacheBustedModule[target.exportedFunction],
      unversionedModule[target.exportedFunction],
      `${target.label} both public URL identities must expose the same implementation export`,
    );

    const descriptor = Object.getOwnPropertyDescriptor(globalThis.window, target.globalName);
    assert.equal(descriptor?.configurable, false, `${target.label} global must remain non-configurable`);
    assert.equal(descriptor?.writable, false, `${target.label} global must remain non-writable`);
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
}
