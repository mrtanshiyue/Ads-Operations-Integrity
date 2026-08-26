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
    label: 'Quarterly Operating Review',
    publicAsset: 'cloudflare-native-csv-history-quarterly-operating-review-v1.js',
    implementationAsset: 'cloudflare-native-csv-history-quarterly-operating-review-impl-v1.js',
    globalName: 'CloudflareCsvHistoryQuarterlyOperatingReview',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalQuarterlyOperatingReview',
    requiredAnchors: [
      'csv-history-quarterly-operating-review-v1',
      'Quarterly Operating Review',
      'all three exact calendar months pass the evidence gate',
      'same-month duplicate evidence',
      'Raw monthly evidence remains visible',
      'Ad Contribution = Sales - Ad Spend only; it is not Net Profit',
      'crossQuarterAggregationApplied: false',
      'sameMonthAggregationApplied: false',
      'businessRowDeduplicationApplied: false',
      'overlapCollapseApplied: false',
      'gapRepairApplied: false',
      'partialPeriodsHidden: false',
      'missingMonthsHidden: false',
    ],
  },
  {
    label: 'Historical Comparison Receipt',
    publicAsset: 'cloudflare-native-csv-history-comparison-receipt-v1.js',
    implementationAsset: 'cloudflare-native-csv-history-comparison-receipt-impl-v1.js',
    globalName: 'CloudflareCsvHistoryComparisonReceipt',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalComparisonReceipt',
    requiredAnchors: [
      'Historical Comparison Receipt',
      'local replay · deterministic',
      'Blocked comparisons remain exportable as raw-evidence-only receipts with deltas withheld',
      'Ad Contribution = Sales - Ad Spend only; it is not Net Profit',
      'generatedTimestampIncluded: false',
      'comparisonRecomputedFromLedger: true',
    ],
  },
];

for (const target of targets) await validateIdentityConvergence(target);

console.log(JSON.stringify({
  ok: true,
  validatedGlobals: targets.map((target) => target.globalName),
  implementationSourceContractsVerified: true,
  localOnlyExecutionFreeVerified: true,
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
    `${target.label} public module must converge every URL identity on one implementation module`,
  );

  for (const anchor of target.requiredAnchors) {
    assert.equal(
      implementationSource.includes(anchor),
      true,
      `${target.label} canonical implementation must retain source-contract anchor: ${anchor}`,
    );
  }

  for (const pattern of forbiddenImplementationPatterns) {
    assert.equal(
      pattern.test(implementationSource),
      false,
      `${target.label} canonical implementation must remain explicit-local and execution-free: ${pattern}`,
    );
  }

  const registrationAnchor = `Object.defineProperty(window, '${target.globalName}'`;
  assert.equal(
    implementationSource.split(registrationAnchor).length - 1,
    1,
    `${target.label} canonical implementation must register ${target.globalName} exactly once in source`,
  );
  assert.doesNotMatch(
    publicSource,
    /AMAZON_ADS_ENABLED|AMAZON_ADS_CLIENT|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/,
    `${target.label} module-identity wrapper must not create Amazon execution authority`,
  );

  const priorWindow = globalThis.window;
  globalThis.window = {};
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
      `${target.label} second public module identity must reuse the canonical implementation registration`,
    );
    assert.strictEqual(
      cacheBustedModule[target.exportedFunction],
      unversionedModule[target.exportedFunction],
      `${target.label} cache-busted and unversioned wrappers must expose the same implementation export`,
    );

    const descriptor = Object.getOwnPropertyDescriptor(globalThis.window, target.globalName);
    assert.equal(descriptor?.configurable, false, `${target.label} global must remain non-configurable`);
    assert.equal(descriptor?.writable, false, `${target.label} global must remain non-writable`);
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
}
