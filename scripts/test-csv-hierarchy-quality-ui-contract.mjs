import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const uiRelative = 'assets/cloudflare-native-csv-hierarchy-quality-v1.js';
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const jointTag = '<script type="module" src="assets/cloudflare-native-csv-joint-analysis-v1.js?v=1.0.0"></script>';
const hierarchyTag = '<script type="module" src="assets/cloudflare-native-csv-hierarchy-quality-v1.js?v=1.0.0"></script>';
const reviewTag = '<script type="module" src="assets/cloudflare-native-csv-library-review-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(hierarchyTag).length - 1, 1, 'Hierarchy quality UI must be injected exactly once');
assert.ok(indexSource.indexOf(jointTag) < indexSource.indexOf(hierarchyTag), 'Hierarchy quality UI must load after Joint CSV Analysis');
assert.ok(indexSource.indexOf(hierarchyTag) < indexSource.indexOf(reviewTag), 'Hierarchy quality UI must load before local library review');
assert.match(uiSource, /Data Quality & Hierarchy Analytics/);
assert.match(uiSource, /quality\.safeForNaiveAggregation/);
assert.match(uiSource, /quality\.contiguousCoverage/);
assert.match(uiSource, /quality\.overlapPairs/);
assert.match(uiSource, /quality\.gaps/);
assert.match(uiSource, /hierarchy\.reliability\?\.analyticalDecisionUse/);
assert.match(uiSource, /state\.level === 'campaigns'/);
assert.match(uiSource, /state\.level === 'adGroups'/);
assert.match(uiSource, /targetings/);
assert.match(uiSource, /item\.adContributionMicros/);
assert.match(uiSource, /not net profit/i);
assert.match(uiSource, /canonical Amazon identity unresolved/i);
assert.match(uiSource, /persistence, execution and Amazon mutation remain disabled/i);

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
  assert.equal(pattern.test(uiSource), false, `Hierarchy quality UI must remain browser-local and side-effect free: ${pattern}`);
}

const ui = await import(`${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`);
assert.equal(ui.CSV_HIERARCHY_QUALITY_UI_VERSION, '1.0.0');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-hierarchy-quality-ui-v1',
  qualityEvidenceRendered: true,
  hierarchyLevelsRendered: ['campaigns', 'adGroups', 'targetings'],
  adContributionNotNetProfit: true,
  browserLocal: true,
  persistenceAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));
