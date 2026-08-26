import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const forbidden = [
  /\bfetch\s*\(/, /XMLHttpRequest/, /navigator\.sendBeacon/, /\bWebSocket\b/, /\bEventSource\b/,
  /CloudflareNativeAPI/, /\/api\/v1\//, /CONTROL_DB/, /STORE_01_DB/, /DATA_BUCKET/,
  /AMAZON_ADS_ENABLED/, /AMAZON_ADS_CLIENT/, /AMAZON_SYNC_WORKFLOW/, /SYNC_TRIGGER_ENABLED/, /startSync\s*\(/,
  /optimization-actions/, /execution-permits/,
];
const targets = [
  {
    label: 'QoQ Comparison Receipt',
    publicAsset: 'cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-v1.js',
    implAsset: 'cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-impl-v1.js',
    globalName: 'CloudflareCsvHistoryQuarterOverQuarterComparisonReceipt',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalQuarterOverQuarterComparisonReceipt',
  },
  {
    label: 'YoY YTD Comparison',
    publicAsset: 'cloudflare-native-csv-history-year-over-year-ytd-comparison-v1.js',
    implAsset: 'cloudflare-native-csv-history-year-over-year-ytd-comparison-impl-v1.js',
    globalName: 'CloudflareCsvHistoryYearOverYearYtdComparison',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalYearOverYearYtdComparison',
  },
  {
    label: 'Rolling-12 Window Transition Review',
    publicAsset: 'cloudflare-native-csv-history-rolling-12-window-transition-review-v1.js',
    implAsset: 'cloudflare-native-csv-history-rolling-12-window-transition-review-impl-v1.js',
    globalName: 'CloudflareCsvHistoryRolling12WindowTransitionReview',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalRolling12WindowTransitionReview',
  },
  {
    label: 'Rolling-12 Window Transition Receipt',
    publicAsset: 'cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js',
    implAsset: 'cloudflare-native-csv-history-rolling-12-window-transition-receipt-impl-v1.js',
    globalName: 'CloudflareCsvHistoryRolling12WindowTransitionReceipt',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalRolling12WindowTransitionReceipt',
  },
  {
    label: 'Rolling-12 Window Transition Receipt Verification',
    publicAsset: 'cloudflare-native-csv-history-rolling-12-window-transition-receipt-verification-v1.js',
    implAsset: 'cloudflare-native-csv-history-rolling-12-window-transition-receipt-verification-impl-v1.js',
    globalName: 'CloudflareCsvHistoryRolling12WindowTransitionReceiptVerification',
    version: '1.0.0',
    exportedFunction: 'verifyHistoricalRolling12WindowTransitionReceiptAgainstLedgers',
  },
  {
    label: 'Rolling-12 Window Transition Review Board',
    publicAsset: 'cloudflare-native-csv-history-rolling-12-window-transition-review-board-v1.js',
    implAsset: 'cloudflare-native-csv-history-rolling-12-window-transition-review-board-impl-v1.js',
    globalName: 'CloudflareCsvHistoryRolling12WindowTransitionReviewBoard',
    version: '1.0.0',
    exportedFunction: 'buildHistoricalRolling12WindowTransitionReviewBoard',
  },
];

for (const target of targets) await validate(target);
console.log(JSON.stringify({ ok: true, validatedGlobals: targets.map((x) => x.globalName), pageErrorWorkaroundUsed: false, amazonExecutionAuthorized: false }));

async function validate(target) {
  const publicPath = path.join(distRoot, 'assets', target.publicAsset);
  const implPath = path.join(distRoot, 'assets', target.implAsset);
  const [publicSource, implSource] = await Promise.all([readFile(publicPath, 'utf8'), readFile(implPath, 'utf8')]);
  assert.equal(publicSource.includes(`export * from './${target.implAsset}';`), true, `${target.label} wrapper must target canonical implementation`);
  for (const pattern of forbidden) assert.equal(pattern.test(implSource), false, `${target.label} implementation must remain local-only/execution-free: ${pattern}`);
  const anchor = `Object.defineProperty(window, '${target.globalName}'`;
  assert.equal(implSource.split(anchor).length - 1, 1, `${target.label} must register immutable global exactly once in canonical source`);

  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  globalThis.window = {};
  delete globalThis.document;
  try {
    const url = pathToFileURL(publicPath).href;
    const first = await import(`${url}?v=${target.version}&identity=cache-busted`);
    const registered = globalThis.window[target.globalName];
    assert(registered, `${target.label} cache-busted import must register global`);
    assert.equal(registered.version, target.version, `${target.label} global version must remain stable`);
    const second = await import(`${url}?identity=unversioned`);
    assert.strictEqual(globalThis.window[target.globalName], registered, `${target.label} second public identity must reuse global registration`);
    assert.strictEqual(first[target.exportedFunction], second[target.exportedFunction], `${target.label} both public identities must expose same implementation export`);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.window, target.globalName);
    assert.equal(descriptor?.configurable, false, `${target.label} global must remain non-configurable`);
    assert.equal(descriptor?.writable, false, `${target.label} global must remain non-writable`);
  } finally {
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
  }
}
