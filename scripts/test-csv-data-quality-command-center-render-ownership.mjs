import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-data-quality-command-center-v1.js'),
  'utf8',
);

assert.match(
  source,
  /const state = \{ mounted: false, rendering: false, requestSeq: 0, model: null \}/,
  'Data Quality Command Center must track local render generation ownership',
);

const refreshStart = source.indexOf('async function refresh(root, joint)');
const refreshEnd = source.indexOf('\nfunction clear(root, message, kind = \'\')', refreshStart);
assert(refreshStart >= 0 && refreshEnd > refreshStart, 'local refresh lifecycle must remain present');
const refresh = source.slice(refreshStart, refreshEnd);

assert.match(refresh, /const seq = \+\+state\.requestSeq;/,
  'each local analysis render must capture a fresh generation');
assert.match(refresh, /const inputs = await Promise\.all[\s\S]*?if \(seq !== state\.requestSeq\) return;/,
  'file reads must not advance into stale local analysis after source invalidation');
assert.match(refresh, /analyzeLocalCsvInputs\(inputs\);\s*if \(seq !== state\.requestSeq\) return;/,
  'completed old-generation local analysis must not repaint stale evidence');
assert.match(refresh, /catch \(error\) \{\s*if \(seq !== state\.requestSeq\) return;/,
  'old-generation failures must not overwrite the current command-center state');
assert.match(refresh, /finally \{\s*if \(seq === state\.requestSeq\) state\.rendering = false;/,
  'old-generation finally blocks must not release a newer render lock');

const clearStart = source.indexOf("function clear(root, message, kind = '')");
const clearEnd = source.indexOf('\nfunction render(root, model)', clearStart);
assert(clearStart >= 0 && clearEnd > clearStart, 'clear lifecycle must remain present');
const clear = source.slice(clearStart, clearEnd);
assert.match(clear, /state\.requestSeq \+= 1;/,
  'file change, explicit clear, and failed Joint Analysis must revoke the active generation');
assert.match(clear, /state\.rendering = false;/,
  'source invalidation must allow the next valid Joint Analysis success to render immediately');
assert.match(clear, /state\.model = null;/,
  'source invalidation must clear stale decision-gate model state');
assert.match(clear, /body\.hidden = true;/,
  'source invalidation must hide stale decision-gate evidence');
assert.match(clear, /body\.innerHTML = '';/,
  'source invalidation must remove stale decision-gate markup');

assert.doesNotMatch(
  source,
  /AMAZON_ADS_ENABLED|AMAZON_ADS_CLIENT|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/,
  'browser-local data-quality command center must remain Amazon-execution free',
);
assert.match(source, /authoritative: false/);
assert.match(source, /governancePersistenceAllowed: false/);
assert.match(source, /executionAuthorized: false/);
assert.match(source, /amazonMutationAuthorized: false/);

console.log(JSON.stringify({
  ok: true,
  localRenderGenerationOwned: true,
  staleFileReadSuppressed: true,
  staleAnalysisResultSuppressed: true,
  staleFailureSuppressed: true,
  clearRevokesGeneration: true,
  amazonExecutionAuthorized: false,
}));
