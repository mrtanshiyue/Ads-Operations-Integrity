import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-data-quality-command-center-v1.js'),
  'utf8',
);
const jointSource = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-joint-analysis-v1.js'),
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

assert.match(jointSource, /mounted: false,\s*requestSeq: 0,\s*result: null/,
  'Joint CSV Analysis must track browser render generation ownership');
const inputHandlerStart = jointSource.indexOf("input.addEventListener('change', () => {");
const inputHandlerEnd = jointSource.indexOf("run.addEventListener('click'", inputHandlerStart);
assert(inputHandlerStart >= 0 && inputHandlerEnd > inputHandlerStart, 'Joint CSV file-change lifecycle must remain present');
const inputHandler = jointSource.slice(inputHandlerStart, inputHandlerEnd);
assert.match(inputHandler, /revokeAnalysis\(section\);/,
  'changing selected CSV files must immediately revoke any old Joint Analysis run');
assert.match(inputHandler, /run\.disabled = count === 0 \|\| count > MAX_FILES/,
  'new valid file selection must be runnable without waiting for a revoked old run');

const runStart = jointSource.indexOf('async function runAnalysis(section)');
const runEnd = jointSource.indexOf('\nfunction revokeAnalysis(section)', runStart);
assert(runStart >= 0 && runEnd > runStart, 'Joint CSV run lifecycle must remain present');
const runAnalysis = jointSource.slice(runStart, runEnd);
assert.match(runAnalysis, /const seq = \+\+browserState\.requestSeq;/,
  'each Joint CSV Analysis run must capture a fresh generation');
assert.match(runAnalysis, /const inputs = await Promise\.all[\s\S]*?if \(seq !== browserState\.requestSeq\) return;/,
  'stale file reads must not advance into Joint CSV parsing');
assert.match(runAnalysis, /analyzeLocalCsvInputs\(inputs\);\s*if \(seq !== browserState\.requestSeq\) return;/,
  'stale Joint CSV results must not repaint success output');
assert.match(runAnalysis, /catch \(error\) \{\s*if \(seq !== browserState\.requestSeq\) return;/,
  'stale Joint CSV errors must not overwrite the active selection state');
assert.match(runAnalysis, /finally \{\s*if \(seq !== browserState\.requestSeq\) return;/,
  'stale Joint CSV finally blocks must not mutate a newer run busy state');

const revokeStart = jointSource.indexOf('function revokeAnalysis(section)');
const revokeEnd = jointSource.indexOf('\nfunction clearAnalysis(section)', revokeStart);
assert(revokeStart >= 0 && revokeEnd > revokeStart, 'Joint CSV revoke lifecycle must remain present');
const revoke = jointSource.slice(revokeStart, revokeEnd);
assert.match(revoke, /browserState\.requestSeq \+= 1;/,
  'file changes and Clear must revoke the active Joint CSV generation');
assert.match(revoke, /browserState\.result = null;/,
  'file changes and Clear must release old Joint CSV result ownership');
assert.match(revoke, /results\.hidden = true;/,
  'file changes and Clear must hide stale Joint CSV output');
assert.match(revoke, /results\.innerHTML = '';/,
  'file changes and Clear must remove stale Joint CSV markup');
assert.match(revoke, /removeAttribute\('aria-busy'\)/,
  'revoking an old run must release its stale busy presentation');
assert.match(jointSource, /function clearAnalysis\(section\) \{\s*revokeAnalysis\(section\);/,
  'explicit Clear must use the same generation revocation path');

for (const [name, candidate] of [['data-quality', source], ['joint-analysis', jointSource]]) {
  assert.doesNotMatch(
    candidate,
    /AMAZON_ADS_ENABLED|AMAZON_ADS_CLIENT|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/,
    `${name} browser-local UI must remain Amazon-execution free`,
  );
}
assert.match(source, /authoritative: false/);
assert.match(source, /governancePersistenceAllowed: false/);
assert.match(source, /executionAuthorized: false/);
assert.match(source, /amazonMutationAuthorized: false/);
assert.match(jointSource, /authority: 'csv_advisory_only'/);
assert.match(jointSource, /No upload, D1 write, Amazon request, persistence, or execution is performed\./);

console.log(JSON.stringify({
  ok: true,
  localRenderGenerationOwned: true,
  jointRunGenerationOwned: true,
  staleFileReadSuppressed: true,
  staleAnalysisResultSuppressed: true,
  staleFailureSuppressed: true,
  selectionChangeRevokesGeneration: true,
  clearRevokesGeneration: true,
  amazonExecutionAuthorized: false,
}));
