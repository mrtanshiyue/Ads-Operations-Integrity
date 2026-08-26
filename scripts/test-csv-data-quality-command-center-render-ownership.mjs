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
const periodSource = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-period-ui-v1.js'),
  'utf8',
);
const monthlySource = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-monthly-workspace-v1.js'),
  'utf8',
);
const historyLedgerSource = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-history-ledger-impl-v1.js'),
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

assert.match(
  periodSource,
  /const state = \{ mounted: false, rendering: false, requestSeq: 0, result: null \}/,
  'Period-over-Period must track local refresh generation ownership',
);
const periodRefreshStart = periodSource.indexOf('async function refresh(root, joint)');
const periodRefreshEnd = periodSource.indexOf("\nfunction clear(root, message, kind = '')", periodRefreshStart);
assert(periodRefreshStart >= 0 && periodRefreshEnd > periodRefreshStart, 'Period refresh lifecycle must remain present');
const periodRefresh = periodSource.slice(periodRefreshStart, periodRefreshEnd);
assert.doesNotMatch(periodRefresh, /if \(state\.rendering\) return;/,
  'a newer Period generation must not be dropped solely because an older Promise is still running');
assert.match(periodRefresh, /const seq = \+\+state\.requestSeq;/,
  'each Period refresh must capture a fresh generation');
assert.match(periodRefresh, /const inputs = await Promise\.all[\s\S]*?if \(seq !== state\.requestSeq\) return;/,
  'stale Period file reads must not advance into local recomputation');
assert.match(periodRefresh, /const result = await window\.CloudflareCsvJointAnalysis\.analyzeLocalCsvInputs\(inputs\);\s*if \(seq !== state\.requestSeq\) return;\s*state\.result = result;/,
  'stale Period recomputation must not take result ownership');
assert.match(periodRefresh, /catch \(error\) \{\s*if \(seq !== state\.requestSeq\) return;/,
  'stale Period failures must not overwrite the active generation');
assert.match(periodRefresh, /finally \{\s*if \(seq === state\.requestSeq\) state\.rendering = false;/,
  'stale Period finally blocks must not release a newer generation busy state');

const periodClearStart = periodSource.indexOf("function clear(root, message, kind = '')");
const periodClearEnd = periodSource.indexOf('\nfunction render(root)', periodClearStart);
assert(periodClearStart >= 0 && periodClearEnd > periodClearStart, 'Period clear lifecycle must remain present');
const periodClear = periodSource.slice(periodClearStart, periodClearEnd);
assert.match(periodClear, /state\.requestSeq \+= 1;/,
  'Period file change, Clear, and failed Joint Analysis must revoke the active generation');
assert.match(periodClear, /state\.rendering = false;/,
  'Period invalidation must allow the next valid Joint success to refresh immediately');
assert.match(periodClear, /state\.result = null;/,
  'Period invalidation must release old local result ownership');
assert.match(periodClear, /body\.hidden = true;/,
  'Period invalidation must hide stale comparison evidence');
assert.match(periodClear, /body\.innerHTML = '';/,
  'Period invalidation must remove stale comparison markup');

assert.match(
  monthlySource,
  /const state = \{ mounted: false, busy: false, requestSeq: 0, workspace: null \}/,
  'Monthly Workspace must track local refresh generation ownership',
);
const monthlyRefreshStart = monthlySource.indexOf('async function refresh(root, joint)');
const monthlyRefreshEnd = monthlySource.indexOf('\nfunction populateMonthSelect(root)', monthlyRefreshStart);
assert(monthlyRefreshStart >= 0 && monthlyRefreshEnd > monthlyRefreshStart, 'Monthly Workspace refresh lifecycle must remain present');
const monthlyRefresh = monthlySource.slice(monthlyRefreshStart, monthlyRefreshEnd);
assert.doesNotMatch(monthlyRefresh, /if \(state\.busy\) return;/,
  'a newer Monthly Workspace generation must not be dropped solely because an older Promise is still running');
assert.match(monthlyRefresh, /const seq = \+\+state\.requestSeq;/,
  'each Monthly Workspace refresh must capture a fresh generation');
assert.match(monthlyRefresh, /const inputs = await Promise\.all[\s\S]*?if \(seq !== state\.requestSeq\) return;/,
  'stale Monthly Workspace file reads must not advance into local recomputation');
assert.match(monthlyRefresh, /const result = await window\.CloudflareCsvJointAnalysis\.analyzeLocalCsvInputs\(inputs\);\s*if \(seq !== state\.requestSeq\) return;\s*state\.workspace = buildCsvMonthlyOperatingWorkspace\(result\);/,
  'stale Monthly Workspace recomputation must not take workspace ownership');
assert.match(monthlyRefresh, /catch \(error\) \{\s*if \(seq !== state\.requestSeq\) return;/,
  'stale Monthly Workspace failures must not overwrite the active generation');
assert.match(monthlyRefresh, /finally \{\s*if \(seq !== state\.requestSeq\) return;\s*state\.busy = false;/,
  'stale Monthly Workspace finally blocks must not release a newer generation busy state');

const monthlyResetStart = monthlySource.indexOf('function reset(root, message)');
const monthlyResetEnd = monthlySource.indexOf('\nfunction status(root, message, kind = \'\')', monthlyResetStart);
assert(monthlyResetStart >= 0 && monthlyResetEnd > monthlyResetStart, 'Monthly Workspace reset lifecycle must remain present');
const monthlyReset = monthlySource.slice(monthlyResetStart, monthlyResetEnd);
assert.match(monthlyReset, /state\.requestSeq \+= 1;/,
  'Monthly Workspace file change and Clear must revoke the active generation');
assert.match(monthlyReset, /state\.busy = false;/,
  'Monthly Workspace invalidation must allow the next valid Joint success to refresh immediately');
assert.match(monthlyReset, /state\.workspace = null;/,
  'Monthly Workspace invalidation must release old local workspace ownership');
assert.match(monthlyReset, /body\.hidden = true;/,
  'Monthly Workspace invalidation must hide stale monthly evidence');
assert.match(monthlyReset, /body\.innerHTML = '';/,
  'Monthly Workspace invalidation must remove stale monthly markup');

assert.match(historyLedgerSource, /busy: false,\s*evidenceSeq: 0,\s*comparisonSeq: 0,/,
  'Historical Ledger must track independent evidence and comparison interaction generations');
const historyEvidenceStart = historyLedgerSource.indexOf('async function selectHistoricalEvidence(body, ledger, trigger)');
const historyEvidenceEnd = historyLedgerSource.indexOf('\nasync function renderComparisonState(body, ledger)', historyEvidenceStart);
assert(historyEvidenceStart >= 0 && historyEvidenceEnd > historyEvidenceStart, 'Historical evidence selection lifecycle must remain present');
const historyEvidence = historyLedgerSource.slice(historyEvidenceStart, historyEvidenceEnd);
assert.match(historyEvidence, /const seq = \+\+state\.evidenceSeq;/,
  'each Historical Evidence selection must capture a fresh generation');
assert.match(historyEvidence, /const evidence = await buildHistoricalEvidenceDrilldown[\s\S]*?if \(seq !== state\.evidenceSeq\) return;/,
  'older Historical Evidence promises must not repaint a newer selection');
assert.match(historyEvidence, /catch \(error\) \{\s*if \(seq !== state\.evidenceSeq\) return;/,
  'older Historical Evidence failures must not overwrite a newer selection');

const historyComparisonStart = historyLedgerSource.indexOf('async function renderComparisonState(body, ledger)');
const historyComparisonEnd = historyLedgerSource.indexOf('\nfunction renderSelectedEvidence(evidence)', historyComparisonStart);
assert(historyComparisonStart >= 0 && historyComparisonEnd > historyComparisonStart, 'Historical Period Comparison lifecycle must remain present');
const historyComparison = historyLedgerSource.slice(historyComparisonStart, historyComparisonEnd);
assert.match(historyComparison, /const seq = \+\+state\.comparisonSeq;/,
  'each Historical Period Comparison render must capture a fresh generation');
assert.match(historyComparison, /const comparison = await buildHistoricalPeriodComparison[\s\S]*?if \(seq !== state\.comparisonSeq\) return;/,
  'older Historical Period Comparison promises must not repaint newer selections');
assert.match(historyComparison, /catch \(error\) \{\s*if \(seq !== state\.comparisonSeq\) return;/,
  'older Historical Period Comparison failures must not overwrite newer selections');

const historyClearStart = historyLedgerSource.indexOf('function clearLedger(root)');
const historyClearEnd = historyLedgerSource.indexOf('\nfunction renderLedger(root, ledger)', historyClearStart);
assert(historyClearStart >= 0 && historyClearEnd > historyClearStart, 'Historical Ledger clear lifecycle must remain present');
const historyClear = historyLedgerSource.slice(historyClearStart, historyClearEnd);
assert.match(historyClear, /state\.evidenceSeq \+= 1;/,
  'clearing the Historical Ledger must revoke any old evidence selection');
assert.match(historyClear, /state\.comparisonSeq \+= 1;/,
  'clearing the Historical Ledger must revoke any old period comparison');

const historyRenderStart = historyLedgerSource.indexOf('function renderLedger(root, ledger)');
const historyRenderEnd = historyLedgerSource.indexOf('\nfunction renderMonthlyWorkspace(workspace)', historyRenderStart);
assert(historyRenderStart >= 0 && historyRenderEnd > historyRenderStart, 'Historical Ledger render lifecycle must remain present');
const historyRender = historyLedgerSource.slice(historyRenderStart, historyRenderEnd);
assert.match(historyRender, /state\.evidenceSeq \+= 1;/,
  'rendering a new Historical Ledger must revoke old evidence selection ownership');
assert.match(historyRender, /state\.comparisonSeq \+= 1;/,
  'rendering a new Historical Ledger must revoke old comparison ownership');

for (const [name, candidate] of [
  ['data-quality', source],
  ['joint-analysis', jointSource],
  ['period-over-period', periodSource],
  ['monthly-workspace', monthlySource],
  ['history-ledger', historyLedgerSource],
]) {
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
assert.match(periodSource, /authority: 'browser_local_observation_only'/);
assert.match(monthlySource, /authority: 'browser_local_monthly_workspace_only'/);
assert.match(monthlySource, /governancePersistenceAllowed: false/);
assert.match(monthlySource, /executionAuthorized: false/);
assert.match(monthlySource, /amazonMutationAuthorized: false/);
assert.match(historyLedgerSource, /authority: 'local_file_history_ledger_only'/);
assert.match(historyLedgerSource, /governancePersistenceAllowed: false/);
assert.match(historyLedgerSource, /executionAuthorized: false/);
assert.match(historyLedgerSource, /amazonMutationAuthorized: false/);

console.log(JSON.stringify({
  ok: true,
  localRenderGenerationOwned: true,
  jointRunGenerationOwned: true,
  periodRefreshGenerationOwned: true,
  monthlyWorkspaceRefreshGenerationOwned: true,
  historyLedgerInteractionGenerationOwned: true,
  staleFileReadSuppressed: true,
  staleAnalysisResultSuppressed: true,
  staleFailureSuppressed: true,
  selectionChangeRevokesGeneration: true,
  clearRevokesGeneration: true,
  amazonExecutionAuthorized: false,
}));
