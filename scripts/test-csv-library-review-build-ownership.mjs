import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-library-review-v1.js'),
  'utf8',
);

assert.match(source, /mounted: false,\s*building: false,\s*requestSeq: 0,\s*queue: null/,
  'CSV Library Review must track build generation ownership');

const buildStart = source.indexOf('async function build(root)');
const buildEnd = source.indexOf("\nfunction reset(root, message, kind = '')", buildStart);
assert(buildStart >= 0 && buildEnd > buildStart, 'Library Review build lifecycle must remain present');
const build = source.slice(buildStart, buildEnd);

assert.match(build, /const seq = \+\+state\.requestSeq;/,
  'each Library Review build must capture a fresh generation');
assert.match(build, /const inputs = await Promise\.all[\s\S]*?if \(seq !== state\.requestSeq\) return;/,
  'stale Library Review file reads must not advance into Joint CSV analysis');
assert.match(build, /const joint = await window\.CloudflareCsvJointAnalysis\.analyzeLocalCsvInputs\(inputs\);\s*if \(seq !== state\.requestSeq\) return;/,
  'stale Joint CSV results must not advance into Library Review bridge construction');
assert.match(build, /const queue = await buildCsvLibraryReviewBridge\(joint\);\s*if \(seq !== state\.requestSeq\) return;\s*state\.queue = queue;/,
  'stale Library Review bridge results must not take queue ownership');
assert.match(build, /catch \(error\) \{\s*if \(seq !== state\.requestSeq\) return;/,
  'stale Library Review failures must not overwrite the current selection state');
assert.match(build, /finally \{\s*if \(seq !== state\.requestSeq\) return;\s*state\.building = false;/,
  'stale Library Review finally blocks must not mutate a newer generation busy state');

const resetStart = source.indexOf("function reset(root, message, kind = '')");
const resetEnd = source.indexOf('\nfunction resetViewControls(root)', resetStart);
assert(resetStart >= 0 && resetEnd > resetStart, 'Library Review reset lifecycle must remain present');
const reset = source.slice(resetStart, resetEnd);
assert.match(reset, /state\.requestSeq \+= 1;/,
  'CSV selection change and Clear must revoke the active Library Review generation');
assert.match(reset, /state\.building = false;/,
  'Library Review invalidation must allow an immediate build for the new selection');
assert.match(reset, /state\.queue = null;/,
  'Library Review invalidation must release old queue ownership');
assert.match(reset, /body\.hidden = true;/,
  'Library Review invalidation must hide stale queue evidence');
assert.match(reset, /body\.innerHTML = '';/,
  'Library Review invalidation must remove stale queue markup');
assert.match(reset, /querySelector\('\[data-cflr-build\]'\)\.disabled = false;/,
  'Library Review invalidation must immediately release the Build control');

assert.match(source, /authority: 'csv_library_review_local_only'/);
assert.match(source, /persistenceReady: false/);
assert.match(source, /executionReady: false/);
assert.doesNotMatch(
  source,
  /AMAZON_ADS_ENABLED|AMAZON_ADS_CLIENT|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/,
  'CSV Library Review must remain Amazon-execution free',
);

console.log(JSON.stringify({
  ok: true,
  libraryReviewBuildGenerationOwned: true,
  staleFileReadSuppressed: true,
  staleJointResultSuppressed: true,
  staleBridgeResultSuppressed: true,
  staleFailureSuppressed: true,
  selectionChangeRevokesGeneration: true,
  clearRevokesGeneration: true,
  amazonExecutionAuthorized: false,
}));
