import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-library-review-v1.js'),
  'utf8',
);
const diagnosticsSource = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-local-diagnostics-v1.js'),
  'utf8',
);
const dashboardSource = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-analytics-dashboard-v1.js'),
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

const dashboardDateStart = dashboardSource.indexOf("for (const id of ['#cfCsvAnalyticsStart', '#cfCsvAnalyticsEnd'])");
const dashboardDateEnd = dashboardSource.indexOf("root.querySelector('#cfCsvAnalyticsQuery')", dashboardDateStart);
assert(dashboardDateStart >= 0 && dashboardDateEnd > dashboardDateStart, 'Dashboard manual date lifecycle must remain present');
const dashboardDateChange = dashboardSource.slice(dashboardDateStart, dashboardDateEnd);
assert.match(dashboardDateChange, /state\.startDate = String[\s\S]*?state\.endDate = String/,
  'Dashboard manual date changes must publish the currently edited scope values');
assert.match(dashboardDateChange, /state\.requestSeq \+= 1;/,
  'Dashboard manual date changes must revoke its own old analytics request');
assert.match(dashboardDateChange, /renderEmpty\('Date scope changed\. Click Load to refresh\.'\);/,
  'Dashboard manual date changes must clear stale analytics instead of silently loading');
assert.match(dashboardDateChange, /broadcastScope\(\);/,
  'Dashboard manual date changes must broadcast even when a date input is temporarily incomplete');

const diagnosticsRefreshStart = diagnosticsSource.indexOf('async function refresh()');
const diagnosticsRefreshEnd = diagnosticsSource.indexOf('\n  function generateDiagnostics(input = {})', diagnosticsRefreshStart);
assert(diagnosticsRefreshStart >= 0 && diagnosticsRefreshEnd > diagnosticsRefreshStart, 'Local Diagnostics refresh lifecycle must remain present');
const diagnosticsRefresh = diagnosticsSource.slice(diagnosticsRefreshStart, diagnosticsRefreshEnd);
assert.match(diagnosticsRefresh, /if \(!state\.root\) return;\s*const seq = \+\+state\.requestSeq;\s*const scope = dashboardScope\(\);/,
  'Local Diagnostics must capture a new generation before validating a broadcast scope');
assert.match(diagnosticsRefresh, /if \(!scope\.storeId \|\| !scope\.startDate \|\| !scope\.endDate \|\| scope\.endDate < scope\.startDate\) \{[\s\S]*?state\.loading = false;[\s\S]*?setBusy\(false\);[\s\S]*?renderResult\(null\);/,
  'incomplete or reversed date scope must revoke busy state and clear stale diagnostics without a request');
assert(
  diagnosticsRefresh.indexOf("api().csvAnalytics(scope.storeId, 'diagnostics', common)") > diagnosticsRefresh.indexOf('scope.endDate < scope.startDate'),
  'Diagnostics API access must remain after invalid-scope fail-closed validation',
);
assert.match(diagnosticsRefresh, /const result = await api\(\)\.csvAnalytics\(scope\.storeId, 'diagnostics', common\);\s*if \(seq !== state\.requestSeq\) return;/,
  'an old diagnostics response must not repaint after a newer scope event');
assert.match(diagnosticsRefresh, /catch \(error\) \{\s*if \(seq !== state\.requestSeq\) return;/,
  'an old diagnostics failure must not overwrite the current scope state');
assert.match(diagnosticsRefresh, /finally \{\s*if \(seq === state\.requestSeq\) \{\s*state\.loading = false;\s*setBusy\(false\);/,
  'an old diagnostics finally block must not release a newer request busy state');

assert.match(source, /authority: 'csv_library_review_local_only'/);
assert.match(source, /persistenceReady: false/);
assert.match(source, /executionReady: false/);
for (const [name, candidate] of [
  ['library-review', source],
  ['local-diagnostics', diagnosticsSource],
]) {
  assert.doesNotMatch(
    candidate,
    /AMAZON_ADS_ENABLED|AMAZON_ADS_CLIENT|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/,
    `${name} must remain Amazon-execution free`,
  );
}
assert.match(diagnosticsSource, /authoritative: false/);
assert.match(diagnosticsSource, /recommendationAuthorized: false/);
assert.match(diagnosticsSource, /amazonExecutionAuthorized: false/);

console.log(JSON.stringify({
  ok: true,
  libraryReviewBuildGenerationOwned: true,
  localDiagnosticsInvalidScopeGenerationOwned: true,
  staleFileReadSuppressed: true,
  staleJointResultSuppressed: true,
  staleBridgeResultSuppressed: true,
  staleFailureSuppressed: true,
  selectionChangeRevokesGeneration: true,
  invalidScopeRevokesGeneration: true,
  clearRevokesGeneration: true,
  amazonExecutionAuthorized: false,
}));
