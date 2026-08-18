import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const uiRelative = 'assets/cloudflare-native-csv-joint-analysis-v1.js';
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const moduleTag = '<script type="module" src="assets/cloudflare-native-csv-joint-analysis-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(moduleTag).length - 1, 1, 'Joint CSV UI module must be injected exactly once');
assert.match(uiSource, /parseAmazonSearchTermCsv/);
assert.match(uiSource, /analyzeCsvImportBatches/);
assert.match(uiSource, /Browser-local/);
assert.match(uiSource, /Advisory only/);
assert.match(uiSource, /Amazon mutation disabled/);
assert.match(uiSource, /canonical Amazon identity remains unresolved/i);
assert.match(uiSource, /data-csv-joint-summary/);
assert.match(uiSource, /sectionBlock\('Advisory Candidates', suggestionTable\(analysis, currency\), 'candidates'\)/);
assert.match(uiSource, /sectionBlock\('Observed Targeting Identity', identityTable\(identity\.identities \|\| \[\]\), 'identity'\)/);
assert.match(uiSource, /sectionBlock\('Source Imports & Provenance', importsTable\(result\.imports \|\| \[\]\), 'imports'\)/);
assert.match(uiSource, /data-csv-joint-\$\{key\}/);

const forbiddenUiPatterns = [
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
  /AMAZON_SYNC_WORKFLOW/,
  /optimization-actions/,
  /execution-permits/,
  /wrangler\s+deploy/i,
];
for (const pattern of forbiddenUiPatterns) {
  assert.equal(pattern.test(uiSource), false, `Joint CSV UI must remain browser-local and side-effect free: ${pattern}`);
}

const engineFiles = [
  'amazon-numeric.js',
  'canonical-json.js',
  'decision-intelligence.js',
  'csv-search-term-import.js',
  'csv-term-profitability-analysis.js',
  'csv-observed-targeting-identity.js',
  'csv-joint-report-analysis.js',
];
for (const file of engineFiles) {
  const source = await readFile(path.join(repoRoot, 'cloudflare/runtime', file), 'utf8');
  const built = await readFile(path.join(distRoot, 'assets/csv-analysis-engine', file), 'utf8');
  assert.equal(built, source, `Built browser engine must be byte-identical to canonical runtime source: ${file}`);
}

const moduleUrl = `${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`;
const ui = await import(moduleUrl);
assert.equal(ui.CSV_JOINT_ANALYSIS_UI_VERSION, '1.0.0');
assert.equal(typeof ui.analyzeLocalCsvInputs, 'function');

const header = [
  'Date', 'Advertiser Account Id', 'Profile Id', 'Marketplace', 'Currency',
  'Campaign Id', 'Campaign Name', 'Ad Group Id', 'Ad Group Name',
  'Targeting Id', 'Targeting', 'Match Type', 'Customer Search Term',
  'Impressions', 'Clicks', 'Spend', '7 Day Total Orders', '7 Day Total Sales', '7 Day Total Units',
];
const fileA = csv(header, [
  ['2026-07-01', 'adv-1', 'profile-1', 'US', 'USD', 'campaign-1', 'Readers Core', 'adgroup-1', 'Core', 'target-profit', 'reading glasses', 'BROAD', 'reading glasses women', '1000', '10', '1.00', '3', '10.00', '3'],
  ['2026-07-01', 'adv-1', 'profile-1', 'US', 'USD', 'campaign-1', 'Readers Core', 'adgroup-1', 'Core', 'target-cheap', 'cheap readers', 'BROAD', 'cheap blue readers', '800', '10', '2.00', '0', '0.00', '0'],
]);
const fileB = csv(header, [
  ['2026-07-02', 'adv-1', 'profile-1', 'US', 'USD', 'campaign-1', 'Readers Core', 'adgroup-1', 'Core', 'target-profit', 'reading glasses', 'BROAD', 'reading glasses men', '900', '9', '1.00', '3', '10.00', '3'],
  ['2026-07-02', 'adv-1', 'profile-1', 'US', 'USD', 'campaign-1', 'Readers Core', 'adgroup-1', 'Core', 'target-cheap', 'cheap reading glasses', 'BROAD', 'cheap plastic readers', '700', '10', '2.00', '0', '0.00', '0'],
]);
const inputs = [
  { name: 'search-term-2026-07-01.csv', text: fileA },
  { name: 'search-term-2026-07-02.csv', text: fileB },
];
const options = { uploadedAt: '2026-08-18T08:00:00.000Z' };
const result = await ui.analyzeLocalCsvInputs(inputs, options);

assert.equal(result.source.kind, 'csv_import_set');
assert.equal(result.source.canonicalAmazonIdentityResolved, false);
assert.equal(result.source.governancePersistenceAllowed, false);
assert.equal(result.source.executionAuthorized, false);
assert.equal(result.source.amazonMutationAuthorized, false);
assert.equal(result.summary.batchCount, 2);
assert.equal(result.summary.factCount, 4);
assert.equal(result.range.startDate, '2026-07-01');
assert.equal(result.range.endDate, '2026-07-02');
assert.equal(result.analysis.profitTerms.length, 2);
assert.equal(result.analysis.wasteTerms.length, 2);
assert.ok(result.analysis.toxicRoots.some((item) => item.root === 'cheap'), 'cheap must be detected as a toxic root');
assert.ok(result.analysis.protectedRoots.some((item) => item.root === 'reading'), 'profit-bearing reading root must be protected');
assert.equal(result.analysis.negativeSuggestions.filter((item) => item.matchScope === 'exact').length, 2);
assert.ok(result.analysis.negativeSuggestions.some((item) => item.matchScope === 'phrase_review' && item.value === 'cheap'));
assert.equal(result.analysis.harvestSuggestions.length, 2);
for (const item of [...result.analysis.negativeSuggestions, ...result.analysis.harvestSuggestions]) {
  assert.equal(item.requiresHumanReview, true);
  assert.equal(item.persistenceAuthorized, false);
  assert.equal(item.executionAuthorized, false);
  assert.equal(item.amazonMutationAuthorized, false);
}
assert.ok(result.observedIdentity.summary.identityCount >= 2);
assert.ok(result.observedIdentity.summary.ambiguousIdentityCount >= 1, 'conflicting text for one observed targeting ID must block identity confidence');
assert.ok(result.observedIdentity.identities.some((item) => item.confidence.band === 'blocked'));
assert.match(result.source.inputSetFingerprint, /^[a-f0-9]{64}$/);
assert.ok(result.imports.every((item) => /^[a-f0-9]{64}$/.test(item.contentSha256)));

const reversed = await ui.analyzeLocalCsvInputs([...inputs].reverse(), options);
assert.equal(reversed.source.inputSetFingerprint, result.source.inputSetFingerprint, 'input-set fingerprint must be order independent');
assert.deepEqual(reversed.imports.map((item) => item.contentSha256), result.imports.map((item) => item.contentSha256), 'import receipts must be deterministically ordered');

await assert.rejects(
  ui.analyzeLocalCsvInputs([inputs[0], { ...inputs[0], name: 'duplicate-content.csv' }], options),
  (error) => error?.code === 'CSV_JOINT_ANALYSIS_DUPLICATE_CONTENT',
  'duplicate CSV content must be rejected by the canonical joint engine',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-joint-analysis-ui-v1',
  browserLocal: true,
  canonicalEngineSourceFidelity: true,
  batchCount: result.summary.batchCount,
  profitTerms: result.summary.profitTermCount,
  wasteTerms: result.summary.wasteTermCount,
  toxicRoots: result.summary.toxicRootCount,
  ambiguousObservedIdentities: result.summary.ambiguousObservedIdentityCount,
  inputSetFingerprint: result.source.inputSetFingerprint,
}, null, 2));

function csv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\n');
}
function cell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
