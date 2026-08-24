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
const hierarchySource = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-hierarchy-drilldown-v1.js'),
  'utf8',
);
const hierarchyQualitySource = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-hierarchy-quality-v1.js'),
  'utf8',
);
const productUiSource = await readFile(
  path.join(repoRoot, 'assets/cloudflare-native-csv-product-ui-v2.js'),
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

assert.match(hierarchySource, /mounted: false,\s*building: false,\s*buildGeneration: 0,\s*result: null/,
  'Hierarchy Drilldown must track rebuild generation ownership');
const hierarchyBuildStart = hierarchySource.indexOf('async function rebuild(root, joint)');
const hierarchyBuildEnd = hierarchySource.indexOf('\nfunction renderFromState(root)', hierarchyBuildStart);
assert(hierarchyBuildStart >= 0 && hierarchyBuildEnd > hierarchyBuildStart,
  'Hierarchy Drilldown rebuild lifecycle must remain present');
const hierarchyBuild = hierarchySource.slice(hierarchyBuildStart, hierarchyBuildEnd);
assert.match(hierarchyBuild, /const generation = \+\+state\.buildGeneration;/,
  'each Hierarchy Drilldown rebuild must capture a fresh generation');
assert.match(hierarchyBuild, /const inputs = await Promise\.all[\s\S]*?if \(generation !== state\.buildGeneration\) return;/,
  'stale hierarchy file reads must not advance into Joint CSV analysis');
assert.match(hierarchyBuild, /const result = await window\.CloudflareCsvJointAnalysis\.analyzeLocalCsvInputs\(inputs\);\s*if \(generation !== state\.buildGeneration\) return;\s*state\.result = result;/,
  'stale hierarchy analysis results must not take render ownership');
assert.match(hierarchyBuild, /catch \(error\) \{\s*if \(generation !== state\.buildGeneration\) return;/,
  'stale hierarchy failures must not overwrite the current selection state');
assert.match(hierarchyBuild, /finally \{\s*if \(generation !== state\.buildGeneration\) return;\s*state\.building = false;/,
  'stale hierarchy finally blocks must not release a newer generation busy state');

const hierarchyResetStart = hierarchySource.indexOf("function reset(root, message, kind = '')");
const hierarchyResetEnd = hierarchySource.indexOf('\nfunction status(root, message, kind =', hierarchyResetStart);
assert(hierarchyResetStart >= 0 && hierarchyResetEnd > hierarchyResetStart,
  'Hierarchy Drilldown reset lifecycle must remain present');
const hierarchyReset = hierarchySource.slice(hierarchyResetStart, hierarchyResetEnd);
assert.match(hierarchyReset, /state\.buildGeneration \+= 1;\s*state\.building = false;/,
  'CSV selection change and Clear must revoke hierarchy ownership and immediately release stale building state');
assert.match(hierarchyReset, /state\.result = null;/,
  'Hierarchy invalidation must release old result ownership');
assert.match(hierarchyReset, /body\.hidden = true;\s*body\.innerHTML = '';/,
  'Hierarchy invalidation must remove stale rendered evidence');
assert.match(hierarchySource, /data-csv-joint-files[^\n]*addEventListener\('change', \(\) => reset\(/,
  'CSV selection changes must route through hierarchy generation invalidation');
assert.match(hierarchySource, /data-csv-joint-clear[^\n]*addEventListener\('click', \(\) => reset\(/,
  'Clear must route through hierarchy generation invalidation');

assert.match(hierarchyQualitySource, /mounted: false,\s*rendering: false,\s*renderGeneration: 0,\s*result: null/,
  'Hierarchy Quality must track refresh generation ownership');
const hierarchyQualityRefreshStart = hierarchyQualitySource.indexOf('async function refresh(root, joint)');
const hierarchyQualityRefreshEnd = hierarchyQualitySource.indexOf("\nfunction clear(root, message, kind = '')", hierarchyQualityRefreshStart);
assert(hierarchyQualityRefreshStart >= 0 && hierarchyQualityRefreshEnd > hierarchyQualityRefreshStart,
  'Hierarchy Quality refresh lifecycle must remain present');
const hierarchyQualityRefresh = hierarchyQualitySource.slice(hierarchyQualityRefreshStart, hierarchyQualityRefreshEnd);
assert.match(hierarchyQualityRefresh, /const generation = \+\+state\.renderGeneration;/,
  'each Hierarchy Quality refresh must capture a fresh generation');
assert.match(hierarchyQualityRefresh, /const inputs = await Promise\.all[\s\S]*?if \(generation !== state\.renderGeneration\) return;/,
  'stale Hierarchy Quality file reads must not advance into Joint CSV analysis');
assert.match(hierarchyQualityRefresh, /const result = await window\.CloudflareCsvJointAnalysis\.analyzeLocalCsvInputs\(inputs\);\s*if \(generation !== state\.renderGeneration\) return;\s*state\.result = result;/,
  'stale Hierarchy Quality analysis results must not take render ownership');
assert.match(hierarchyQualityRefresh, /catch \(error\) \{\s*if \(generation !== state\.renderGeneration\) return;[\s\S]*?state\.result = null;[\s\S]*?body\.hidden = true;[\s\S]*?body\.innerHTML = '';/,
  'stale Hierarchy Quality failures must not overwrite the active selection, while current-generation failures clear stale evidence');
assert.match(hierarchyQualityRefresh, /finally \{\s*if \(generation !== state\.renderGeneration\) return;\s*state\.rendering = false;/,
  'stale Hierarchy Quality finally blocks must not mutate a newer generation rendering state');

const hierarchyQualityClearStart = hierarchyQualitySource.indexOf("function clear(root, message, kind = '')");
const hierarchyQualityClearEnd = hierarchyQualitySource.indexOf('\nfunction render(root)', hierarchyQualityClearStart);
assert(hierarchyQualityClearStart >= 0 && hierarchyQualityClearEnd > hierarchyQualityClearStart,
  'Hierarchy Quality clear lifecycle must remain present');
const hierarchyQualityClear = hierarchyQualitySource.slice(hierarchyQualityClearStart, hierarchyQualityClearEnd);
assert.match(hierarchyQualityClear, /state\.renderGeneration \+= 1;\s*state\.rendering = false;/,
  'CSV selection change and Clear must revoke Hierarchy Quality ownership and immediately release stale rendering state');
assert.match(hierarchyQualityClear, /state\.result = null;/,
  'Hierarchy Quality invalidation must release old result ownership');
assert.match(hierarchyQualityClear, /body\.hidden = true;\s*body\.innerHTML = '';/,
  'Hierarchy Quality invalidation must remove stale rendered evidence');
assert.match(hierarchyQualitySource, /data-csv-joint-files[^\n]*addEventListener\('change', \(\) => clear\(/,
  'CSV selection changes must route through Hierarchy Quality generation invalidation');
assert.match(hierarchyQualitySource, /data-csv-joint-clear[^\n]*addEventListener\('click', \(\) => clear\(/,
  'Clear must route through Hierarchy Quality generation invalidation');

assert.match(productUiSource, /loading: false,\s*reviewRequestGeneration: 0,/,
  'Advisory Review must track request-generation ownership');
const revokeReviewStart = productUiSource.indexOf('function revokeReviewRequest()');
const revokeReviewEnd = productUiSource.indexOf('\n  function syncStore()', revokeReviewStart);
assert(revokeReviewStart >= 0 && revokeReviewEnd > revokeReviewStart,
  'Advisory Review request revocation lifecycle must remain present');
const revokeReview = productUiSource.slice(revokeReviewStart, revokeReviewEnd);
assert.match(revokeReview, /state\.reviewRequestGeneration \+= 1;\s*state\.loading = false;/,
  'store invalidation must revoke old Advisory Review ownership and release stale loading state');

const syncStoreStart = productUiSource.indexOf('function syncStore()');
const syncStoreEnd = productUiSource.indexOf('\n  function onStoreChange(event)', syncStoreStart);
assert(syncStoreStart >= 0 && syncStoreEnd > syncStoreStart,
  'Advisory Review syncStore lifecycle must remain present');
const productSyncStore = productUiSource.slice(syncStoreStart, syncStoreEnd);
assert.match(productSyncStore, /revokeReviewRequest\(\);\s*state\.storeId = next;/,
  'implicit store synchronization must revoke the old review lifecycle before changing store ownership');

const productStoreChangeStart = productUiSource.indexOf('function onStoreChange(event)');
const productStoreChangeEnd = productUiSource.indexOf('\n  function ensureDataNavigation()', productStoreChangeStart);
assert(productStoreChangeStart >= 0 && productStoreChangeEnd > productStoreChangeStart,
  'Advisory Review explicit store-change lifecycle must remain present');
const productStoreChange = productUiSource.slice(productStoreChangeStart, productStoreChangeEnd);
assert.match(productStoreChange, /revokeReviewRequest\(\);\s*state\.storeId = next;/,
  'explicit store changes must revoke old Advisory Review ownership before changing store state');
assert.match(productStoreChange, /state\.reviews = \[\];[\s\S]*?state\.selectedReviewId = '';[\s\S]*?state\.authority = null;[\s\S]*?state\.message = null;/,
  'store changes must clear stale Advisory Review evidence before reloading the new store');

const productRefreshStart = productUiSource.indexOf('async function refreshAdvisoryReview()');
const productRefreshEnd = productUiSource.indexOf('\n  async function transitionReview(nextState)', productRefreshStart);
assert(productRefreshStart >= 0 && productRefreshEnd > productRefreshStart,
  'Advisory Review refresh lifecycle must remain present');
const productRefresh = productUiSource.slice(productRefreshStart, productRefreshEnd);
assert.match(productRefresh, /const generation = \+\+state\.reviewRequestGeneration;\s*const storeId = state\.storeId;/,
  'each Advisory Review refresh must claim a fresh generation and immutable store snapshot');
assert.doesNotMatch(productRefresh, /state\.loading\) return/,
  'a stale prior store loading flag must not block the new store refresh');
assert.match(productRefresh, /requestJson\(`\/api\/v1\/stores\/\$\{encodeURIComponent\(storeId\)\}\/advisory-reviews/,
  'Advisory Review requests must use the immutable store snapshot');
assert.match(productRefresh, /const payload = await requestJson[\s\S]*?if \(generation !== state\.reviewRequestGeneration \|\| storeId !== state\.storeId\) return;\s*state\.reviews =/,
  'stale cross-store Advisory Review responses must not take result ownership');
assert.match(productRefresh, /catch \(error\) \{\s*if \(generation !== state\.reviewRequestGeneration \|\| storeId !== state\.storeId\) return;/,
  'stale cross-store Advisory Review failures must not overwrite the active store');
assert.match(productRefresh, /finally \{\s*if \(generation !== state\.reviewRequestGeneration \|\| storeId !== state\.storeId\) return;\s*state\.loading = false;/,
  'stale Advisory Review finally blocks must not release a newer store request busy state');

assert.match(source, /authority: 'csv_library_review_local_only'/);
assert.match(source, /persistenceReady: false/);
assert.match(source, /executionReady: false/);
for (const [name, candidate] of [
  ['library-review', source],
  ['local-diagnostics', diagnosticsSource],
  ['hierarchy-drilldown', hierarchySource],
  ['hierarchy-quality', hierarchyQualitySource],
  ['csv-product-ui', productUiSource],
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
assert.match(hierarchySource, /mode: 'browser_local_hierarchy_drilldown_only'/);
assert.match(hierarchySource, /authoritative: false/);
assert.match(hierarchySource, /executionAuthorized: false/);
assert.match(hierarchySource, /amazonMutationAuthorized: false/);
assert.match(hierarchyQualitySource, /authority: 'browser_local_observation_only'/);
assert.match(hierarchyQualitySource, /read-only · advisory/);
assert.match(hierarchyQualitySource, /No persistence or execution authority\./);
assert.match(hierarchyQualitySource, /persistence, execution and Amazon mutation remain disabled\./);
assert.match(productUiSource, /CSV ADVISORY ONLY/);
assert.match(productUiSource, /Amazon execution and mutation disabled/);

console.log(JSON.stringify({
  ok: true,
  libraryReviewBuildGenerationOwned: true,
  localDiagnosticsInvalidScopeGenerationOwned: true,
  hierarchyDrilldownBuildGenerationOwned: true,
  hierarchyQualityRefreshGenerationOwned: true,
  advisoryReviewStoreGenerationOwned: true,
  staleFileReadSuppressed: true,
  staleJointResultSuppressed: true,
  staleBridgeResultSuppressed: true,
  staleHierarchyResultSuppressed: true,
  staleHierarchyQualityResultSuppressed: true,
  staleCrossStoreReviewSuppressed: true,
  staleFailureSuppressed: true,
  selectionChangeRevokesGeneration: true,
  invalidScopeRevokesGeneration: true,
  clearRevokesGeneration: true,
  storeChangeRevokesReviewGeneration: true,
  amazonExecutionAuthorized: false,
}));
