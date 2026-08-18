import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const uiRelative = 'assets/cloudflare-native-csv-analysis-export-v1.js';
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const periodTag = '<script type="module" src="assets/cloudflare-native-csv-period-ui-v1.js?v=1.0.0"></script>';
const exportTag = '<script type="module" src="assets/cloudflare-native-csv-analysis-export-v1.js?v=1.0.0"></script>';
const reviewTag = '<script type="module" src="assets/cloudflare-native-csv-library-review-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(exportTag).length - 1, 1, 'Analysis export UI must be injected exactly once');
assert.ok(indexSource.indexOf(periodTag) < indexSource.indexOf(exportTag), 'Analysis export UI must load after period UI');
assert.ok(indexSource.indexOf(exportTag) < indexSource.indexOf(reviewTag), 'Analysis export UI must load before local library review');
assert.match(uiSource, /Operator package ZIP/);
assert.match(uiSource, /Full advisory JSON/);
assert.match(uiSource, /Candidate review CSV/);
assert.match(uiSource, /Hierarchy CSV/);
assert.match(uiSource, /Period CSV/);
assert.match(uiSource, /local_operator_export_only/);
assert.match(uiSource, /local_operator_package_only/);
assert.match(uiSource, /csv-operator-package-v1/);
assert.match(uiSource, /zip_store_utf8/);
assert.match(uiSource, /CRC32/i);
assert.match(uiSource, /CSV_ANALYSIS_EXPORT_AUTHORITY_ESCALATION_BLOCKED/);
assert.match(uiSource, /not net profit/i);
assert.match(uiSource, /Remote persistence and Amazon mutation remain disabled/);

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
]) assert.equal(pattern.test(uiSource), false, `Analysis export UI must not use remote/storage/execution transport: ${pattern}`);

const mod = await import(`${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`);
assert.equal(mod.CSV_ANALYSIS_EXPORT_SCHEMA_VERSION, 'csv-analysis-export-v1');
assert.equal(mod.CSV_ANALYSIS_EXPORT_UI_VERSION, '1.0.0');
assert.equal(mod.CSV_OPERATOR_PACKAGE_SCHEMA_VERSION, 'csv-operator-package-v1');
assert.equal(typeof mod.buildCsvOperatorPackageFiles, 'function');
assert.equal(typeof mod.buildStoredZip, 'function');

const result = fixture();
const bundle = mod.buildCsvAnalysisExportBundle(result);
assert.equal(bundle.exportSchemaVersion, 'csv-analysis-export-v1');
assert.equal(bundle.authority.authoritative, false);
assert.equal(bundle.authority.canonicalAmazonIdentityResolved, false);
assert.equal(bundle.authority.governancePersistenceAllowed, false);
assert.equal(bundle.authority.executionAuthorized, false);
assert.equal(bundle.authority.amazonMutationAuthorized, false);
assert.equal(bundle.source.inputSetFingerprint, result.source.inputSetFingerprint);
assert.equal(bundle.jointAnalysis, result);

const candidates = mod.buildCandidateReviewCsv(result);
assert.match(candidates, /^candidate_type,destination,value,match_intent,/);
assert.match(candidates, /negative_exact,negative_keyword_library,cheap readers,EXACT/);
assert.match(candidates, /negative_phrase_review,negative_keyword_library,cheap,PHRASE_REVIEW/);
assert.match(candidates, /keyword_harvest,keyword_library,reading glasses women,EXACT_REVIEW/);
assert.match(candidates, /,false,false,false,/);
assert.equal(candidates.split('\n').length, 4);

const hierarchy = mod.buildHierarchyCsv(result);
assert.match(hierarchy, /^level,campaign_id,campaign_name,/);
assert.match(hierarchy, /campaign,c1,Core Readers/);
assert.match(hierarchy, /targeting,c1,Core Readers,g1,Core,t1,reading glasses,EXACT/);
assert.match(hierarchy, /sales_minus_ad_spend_only_not_net_profit/);
assert.match(hierarchy, /observed_only,false/);

const periods = mod.buildPeriodCsv(result);
assert.match(periods, /^row_type,label,start_date,end_date,/);
assert.match(periods, /trailing_7d_current,7d current,2026-08-08,2026-08-14/);
assert.match(periods, /trailing_7d_previous,7d previous,2026-08-01,2026-08-07/);
assert.match(periods, /calendar_month,2026-08,2026-08-01,2026-08-31/);
assert.match(periods, /sales_minus_ad_spend_only_not_net_profit/);

for (const text of [candidates, hierarchy, periods]) {
  assert.doesNotMatch(text, /true,true,true/);
  assert.match(text, new RegExp(result.source.inputSetFingerprint));
}

const packageFiles = mod.buildCsvOperatorPackageFiles(result);
assert.deepEqual(packageFiles.map((file) => file.name), [
  'manifest.json',
  'README.txt',
  'advisory.json',
  'candidate-review.csv',
  'hierarchy.csv',
  'periods.csv',
]);
assert.ok(packageFiles.every((file) => file.bytes instanceof Uint8Array));
assert.ok(packageFiles.every((file) => file.byteLength === file.bytes.length));
assert.ok(packageFiles.every((file) => /^[0-9a-f]{8}$/.test(file.crc32)));
const manifest = JSON.parse(packageFiles[0].text);
assert.equal(manifest.schemaVersion, 'csv-operator-package-v1');
assert.equal(manifest.authority.authoritative, false);
assert.equal(manifest.authority.canonicalAmazonIdentityResolved, false);
assert.equal(manifest.authority.governancePersistenceAllowed, false);
assert.equal(manifest.authority.executionAuthorized, false);
assert.equal(manifest.authority.amazonMutationAuthorized, false);
assert.equal(manifest.source.inputSetFingerprint, result.source.inputSetFingerprint);
assert.equal(manifest.source.shortFingerprint, result.source.inputSetFingerprint.slice(0, 12));
assert.equal(manifest.package.archiveFormat, 'zip_store_utf8');
assert.equal(manifest.package.deterministicTimestamp, '1980-01-01T00:00:00Z');
assert.equal(manifest.package.reportFileCount, 5);
assert.deepEqual(manifest.package.files.map((file) => file.name), packageFiles.slice(1).map((file) => file.name));
assert.ok(manifest.package.files.every((file) => Number.isInteger(file.byteLength) && file.byteLength > 0));
assert.ok(manifest.package.files.every((file) => /^[0-9a-f]{8}$/.test(file.crc32)));
const readme = packageFiles.find((file) => file.name === 'README.txt').text;
assert.match(readme, /Observed CSV identity is not canonical Amazon identity/);
assert.match(readme, /Governance persistence is disabled/);
assert.match(readme, /Execution is disabled/);
assert.match(readme, /Amazon mutation is disabled/);
assert.match(readme, /not net profit/i);

const zip = mod.buildStoredZip(packageFiles);
assert.ok(zip instanceof Uint8Array);
assert.ok(zip.length > packageFiles.reduce((sum, file) => sum + file.byteLength, 0));
const startView = new DataView(zip.buffer, zip.byteOffset, 4);
assert.equal(startView.getUint32(0, true), 0x04034b50, 'ZIP must start with a local file header');
const endOffset = zip.length - 22;
const endView = new DataView(zip.buffer, zip.byteOffset + endOffset, 22);
assert.equal(endView.getUint32(0, true), 0x06054b50, 'ZIP must end with EOCD');
assert.equal(endView.getUint16(8, true), packageFiles.length, 'EOCD entry count must match package files');
assert.equal(endView.getUint16(10, true), packageFiles.length, 'EOCD total entry count must match package files');
const zipText = new TextDecoder().decode(zip);
for (const file of packageFiles) assert.match(zipText, new RegExp(file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
const zipAgain = mod.buildStoredZip(mod.buildCsvOperatorPackageFiles(result));
assert.deepEqual(zipAgain, zip, 'Operator package ZIP must be byte-deterministic for identical advisory input');
assert.throws(
  () => mod.buildStoredZip([{ name: '../escape.txt', text: 'bad' }]),
  (error) => error?.code === 'CSV_OPERATOR_PACKAGE_ENTRY_NAME_INVALID',
  'ZIP builder must reject path traversal entry names',
);
assert.throws(
  () => mod.buildStoredZip([{ name: 'duplicate.txt', text: 'one' }, { name: 'duplicate.txt', text: 'two' }]),
  (error) => error?.code === 'CSV_OPERATOR_PACKAGE_ENTRY_NAME_INVALID',
  'ZIP builder must reject duplicate entry names',
);

assert.throws(
  () => mod.buildCsvAnalysisExportBundle({ ...result, source: { ...result.source, amazonMutationAuthorized: true } }),
  (error) => error?.code === 'CSV_ANALYSIS_EXPORT_AUTHORITY_ESCALATION_BLOCKED',
  'Export builder must fail closed if mutation authority appears',
);
assert.throws(
  () => mod.buildCsvOperatorPackageFiles({ ...result, source: { ...result.source, executionAuthorized: true } }),
  (error) => error?.code === 'CSV_ANALYSIS_EXPORT_AUTHORITY_ESCALATION_BLOCKED',
  'Operator package builder must fail closed if execution authority appears',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-analysis-export-v1',
  fullAdvisoryJson: true,
  candidateReviewCsv: true,
  hierarchyCsv: true,
  periodCsv: true,
  operatorPackageZip: true,
  operatorPackageManifest: true,
  deterministicZip: true,
  entryPathTraversalBlocked: true,
  authorityEscalationBlocked: true,
  remotePersistence: false,
  amazonMutationAuthorized: false,
}, null, 2));

function fixture() {
  const fingerprint = 'a'.repeat(64);
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  const metrics = { spendMicros: 2_000_000, salesMicros: 10_000_000, orders: 2, acos: 0.2, roas: 5, cvr: 0.1, cpcMicros: 100_000 };
  const hierarchyItem = {
    identity: { campaign: { id: 'c1', name: 'Core Readers' }, adGroup: null, targeting: null, canonicalAmazonIdentityResolved: false },
    metrics,
    adContributionMicros: 8_000_000,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    performanceBand: 'at_or_below_target_acos',
    observedIdentity: { state: 'observed_id', confidence: 'observed_only', ambiguous: false, conflictCodes: [] },
    reliability: { state: 'observed', analyticalDecisionUse: 'review_only' },
    requiresHumanReview: true,
  };
  const targetingItem = {
    ...hierarchyItem,
    identity: { campaign: { id: 'c1', name: 'Core Readers' }, adGroup: { id: 'g1', name: 'Core' }, targeting: { id: 't1', text: 'reading glasses', matchType: 'EXACT' }, canonicalAmazonIdentityResolved: false },
  };
  const current = { startDate: '2026-08-08', endDate: '2026-08-14', coverage: { expectedDayCount: 7, coveredDayCount: 7, coverageRatio: 1 }, metrics, adContributionMicros: 8_000_000, profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit', reliability: { state: 'observed', analyticalDecisionUse: 'review_only' } };
  const previous = { ...current, startDate: '2026-08-01', endDate: '2026-08-07' };
  const month = { ...current, month: '2026-08', startDate: '2026-08-01', endDate: '2026-08-31', coverage: { expectedDayCount: 31, coveredDayCount: 14, coverageRatio: 0.4516 }, reliability: { state: 'incomplete_coverage', analyticalDecisionUse: 'review_with_partial_coverage' } };
  return {
    source: { kind: 'csv_import_set', inputSetFingerprint: fingerprint, contentSha256s: ['b'.repeat(64)], canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false },
    range: { startDate: '2026-08-01', endDate: '2026-08-14' },
    summary: { factCount: 3 },
    imports: [{ sourceFileName: 'fixture.csv', contentSha256: 'b'.repeat(64) }],
    analysis: {
      authority,
      negativeSuggestions: [
        { value: 'cheap readers', matchScope: 'exact', rationaleCode: 'waste_term', priorityScore: 9, metrics: { spendMicros: 2_000_000, salesMicros: 0, orders: 0, acos: null }, requiresHumanReview: true },
        { value: 'cheap', matchScope: 'phrase_review', rationaleCode: 'toxic_root', priorityScore: 8, metrics: { spendMicros: 4_000_000, salesMicros: 0, orders: 0, acos: null }, requiresHumanReview: true },
      ],
      harvestSuggestions: [{ value: 'reading glasses women', matchScope: 'exact_review', rationaleCode: 'profit_term', priorityScore: 10, metrics, requiresHumanReview: true }],
    },
    hierarchy: { authority, campaigns: [hierarchyItem], adGroups: [], targetings: [targetingItem] },
    periods: { authority, trailingComparisons: [{ days: 7, current, previous, reliability: { state: 'observed', analyticalDecisionUse: 'review_only' } }], monthlySnapshots: [month] },
  };
}