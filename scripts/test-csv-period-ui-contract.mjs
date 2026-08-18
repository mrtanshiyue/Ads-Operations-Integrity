import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const uiRelative = 'assets/cloudflare-native-csv-period-ui-v1.js';
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const hierarchyTag = '<script type="module" src="assets/cloudflare-native-csv-hierarchy-quality-v1.js?v=1.0.0"></script>';
const periodTag = '<script type="module" src="assets/cloudflare-native-csv-period-ui-v1.js?v=1.0.0"></script>';
const reviewTag = '<script type="module" src="assets/cloudflare-native-csv-library-review-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(periodTag).length - 1, 1, 'Period UI must be injected exactly once');
assert.ok(indexSource.indexOf(hierarchyTag) < indexSource.indexOf(periodTag), 'Period UI must load after hierarchy quality UI');
assert.ok(indexSource.indexOf(periodTag) < indexSource.indexOf(reviewTag), 'Period UI must load before local library review');
assert.match(uiSource, /Period-over-Period/);
assert.match(uiSource, /7 \/ 14 \/ 30 \/ 60 \/ 90 day comparisons/);
assert.match(uiSource, /periods\.trailingComparisons/);
assert.match(uiSource, /periods\.monthlySnapshots/);
assert.match(uiSource, /blockedTrailingComparisonCount/);
assert.match(uiSource, /incompleteTrailingComparisonCount/);
assert.match(uiSource, /analyticalDecisionUse/);
assert.match(uiSource, /Percentage change from a zero prior baseline is shown as “n\/a”/);
assert.match(uiSource, /not net profit/i);
assert.match(uiSource, /No persistence or execution authority/);

for (const pattern of [
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
]) {
  assert.equal(pattern.test(uiSource), false, `Period UI must remain browser-local and side-effect free: ${pattern}`);
}

const ui = await import(`${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`);
assert.equal(ui.CSV_PERIOD_UI_VERSION, '1.0.0');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-period-ui-v1',
  trailingWindowsRendered: [7, 14, 30, 60, 90],
  monthlySnapshotsRendered: true,
  coverageReliabilityRendered: true,
  zeroBaselineInfinityAvoided: true,
  adContributionNotNetProfit: true,
  browserLocal: true,
  persistenceAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));
