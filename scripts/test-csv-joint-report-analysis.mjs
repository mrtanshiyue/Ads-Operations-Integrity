import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAmazonSearchTermCsv } from '../cloudflare/runtime/csv-search-term-import.js';
import {
  CSV_JOINT_ANALYSIS_SCHEMA_VERSION,
  analyzeCsvImportBatches,
} from '../cloudflare/runtime/csv-joint-report-analysis.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts', 'analyze-search-term-csv-files.mjs');
const header = [
  'Date',
  'Advertiser Account ID',
  'Campaign Name',
  'Ad Group Name',
  'Targeting',
  'Match Type',
  'Customer Search Term',
  'Impressions',
  'Clicks',
  'Spend',
  '7 Day Total Orders',
  '7 Day Total Sales',
  '7 Day Total Units',
  'Marketplace',
  'Profile ID',
  'Currency',
].join(',');

const csv1 = [
  header,
  '2026-08-01,adv-01,Campaign A,Group A,reading glasses,EXACT,Reading Glasses Women,50,5,2.00,2,10.00,2,US,profile-observed-01,USD',
  '2026-08-01,adv-01,Campaign A,Group A,free glasses,PHRASE,Free Glasses Case,70,6,3.00,0,0.00,0,US,profile-observed-01,USD',
].join('\n');
const csv2 = [
  header,
  '2026-08-02,adv-01,Campaign A,Group A,reading glasses,EXACT,Reading Glasses Women,50,5,2.00,2,10.00,2,US,profile-observed-01,USD',
  '2026-08-02,adv-01,Campaign A,Group A,free glasses,PHRASE,Free Glasses Case,70,6,3.00,0,0.00,0,US,profile-observed-01,USD',
  '2026-08-02,adv-01,Campaign B,Group B,free sample,PHRASE,Free Glasses Sample,80,8,4.00,0,0.00,0,US,profile-observed-01,USD',
].join('\n');

const [batch1, batch2] = await Promise.all([
  parseAmazonSearchTermCsv({
    csvText: csv1,
    sourceFileName: 'report-2026-08-01.csv',
    uploadedAt: '2026-08-18T07:30:00.000Z',
  }),
  parseAmazonSearchTermCsv({
    csvText: csv2,
    sourceFileName: 'report-2026-08-02.csv',
    uploadedAt: '2026-08-18T07:30:00.000Z',
  }),
]);
assert.equal(batch1.ok, true, JSON.stringify(batch1.errors));
assert.equal(batch2.ok, true, JSON.stringify(batch2.errors));

const result = await analyzeCsvImportBatches([batch1, batch2], { rules: { targetAcos: 0.35 } });
assert.equal(result.schemaVersion, CSV_JOINT_ANALYSIS_SCHEMA_VERSION);
assert.equal(result.source.kind, 'csv_import_set');
assert.equal(result.source.authority, 'non-authoritative');
assert.equal(result.source.batchCount, 2);
assert.equal(result.source.allImportsAccepted, true);
assert.equal(result.source.duplicateContentDetected, false);
assert.match(result.source.inputSetFingerprint, /^[a-f0-9]{64}$/);
assert.equal(result.source.canonicalAmazonIdentityResolved, false);
assert.equal(result.source.governancePersistenceAllowed, false);
assert.equal(result.source.executionAuthorized, false);
assert.equal(result.source.amazonMutationAuthorized, false);
assert.deepEqual(result.range, { startDate: '2026-08-01', endDate: '2026-08-02' });
assert.equal(result.summary.batchCount, 2);
assert.equal(result.summary.factCount, 5);
assert.equal(result.summary.sourceRowCount, 5);
assert.equal(result.summary.profitTermCount, 1);
assert.equal(result.summary.wasteTermCount, 2);
assert.equal(result.summary.toxicRootCount, 1);
assert.equal(result.summary.exactNegativeCandidateCount, 2);
assert.equal(result.summary.phraseRootReviewCount, 1);
assert.equal(result.summary.harvestCandidateCount, 1);
assert.equal(result.summary.metrics.spendMicros, 14_000_000);
assert.equal(result.summary.metrics.salesMicros, 20_000_000);
assert.equal(result.summary.metrics.acos, 0.7);
assert.deepEqual(
  result.analysis.negativeSuggestions.filter((item) => item.matchScope === 'exact').map((item) => item.value).sort(),
  ['free glasses case', 'free glasses sample'],
);
assert.equal(
  result.analysis.negativeSuggestions.find((item) => item.matchScope === 'phrase_review')?.value,
  'free',
);

const reversed = await analyzeCsvImportBatches([batch2, batch1], { rules: { targetAcos: 0.35 } });
assert.equal(reversed.source.inputSetFingerprint, result.source.inputSetFingerprint, 'input-set fingerprint must be order independent');
assert.deepEqual(reversed.summary, result.summary, 'joint summary must be input-order independent');
assert.deepEqual(reversed.imports, result.imports, 'import receipts must use deterministic content-hash ordering');

await assert.rejects(
  () => analyzeCsvImportBatches([batch1, batch1]),
  (error) => error?.code === 'CSV_JOINT_ANALYSIS_DUPLICATE_CONTENT',
);
await assert.rejects(
  () => analyzeCsvImportBatches([{ ...batch1, ok: false }]),
  (error) => error?.code === 'CSV_JOINT_ANALYSIS_IMPORT_REJECTED',
);

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ads-ops-csv-joint-'));
try {
  const file1 = path.join(tempDir, 'one.csv');
  const file2 = path.join(tempDir, 'two.csv');
  await writeFile(file1, csv1, 'utf8');
  await writeFile(file2, csv2, 'utf8');

  const cliRun = spawnSync(process.execPath, [
    cli,
    file1,
    file2,
    '--target-acos=0.35',
    '--uploaded-at=2026-08-18T07:30:00.000Z',
  ], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(cliRun.status, 0, cliRun.stderr);
  assert.equal(cliRun.stderr, '');
  const cliResult = JSON.parse(cliRun.stdout);
  assert.equal(cliResult.schemaVersion, CSV_JOINT_ANALYSIS_SCHEMA_VERSION);
  assert.equal(cliResult.summary.batchCount, 2);
  assert.equal(cliResult.summary.factCount, 5);
  assert.equal(cliResult.source.inputSetFingerprint, result.source.inputSetFingerprint);
  assert.equal(cliResult.source.amazonMutationAuthorized, false);

  const duplicateRun = spawnSync(process.execPath, [cli, file1, file1], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(duplicateRun.status, 1);
  const duplicateError = JSON.parse(duplicateRun.stderr);
  assert.equal(duplicateError.error, 'CSV_JOINT_ANALYSIS_DUPLICATE_CONTENT');

  const helpRun = spawnSync(process.execPath, [cli, '--help'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(helpRun.status, 0, helpRun.stderr);
  assert.match(helpRun.stdout, /reads local CSV files and writes JSON to stdout only/i);
  assert.match(helpRun.stdout, /does not call Amazon Ads, Cloudflare, D1, R2/i);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-joint-report-analysis-v1',
  batchCount: result.summary.batchCount,
  factCount: result.summary.factCount,
  inputSetFingerprint: result.source.inputSetFingerprint,
  duplicateContentRejected: true,
  inputOrderIndependent: true,
  cliReadOnly: true,
  amazonMutationAuthorized: false,
}, null, 2));
