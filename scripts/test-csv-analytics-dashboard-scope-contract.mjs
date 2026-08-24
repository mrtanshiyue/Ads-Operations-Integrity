import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-csv-analytics-dashboard-v1.js'), 'utf8');
const drilldownSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-csv-analytics-drilldown-v1.js'), 'utf8');
const exportSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-csv-analysis-export-v1.js'), 'utf8');
new vm.Script(source, { filename: 'cloudflare-native-csv-analytics-dashboard-v1.js' });
new vm.Script(drilldownSource, { filename: 'cloudflare-native-csv-analytics-drilldown-v1.js' });
new vm.SourceTextModule(exportSource, { identifier: 'cloudflare-native-csv-analysis-export-v1.js' });

const handlerStart = source.indexOf("for (const id of ['#cfCsvAnalyticsStart', '#cfCsvAnalyticsEnd'])");
const handlerEnd = source.indexOf("root.querySelector('#cfCsvAnalyticsQuery')", handlerStart);
assert(handlerStart >= 0 && handlerEnd > handlerStart, 'manual CSV Analytics date-change handler must remain present');
const handler = source.slice(handlerStart, handlerEnd);

assert.match(handler, /state\.datePreset = 'custom'/, 'manual dates must switch analytics scope to custom');
assert.match(handler, /state\.startDate = String\(root\.querySelector\('#cfCsvAnalyticsStart'\)\?\.value \|\| ''\)\.trim\(\)/,
  'manual date changes must immediately synchronize startDate state');
assert.match(handler, /state\.endDate = String\(root\.querySelector\('#cfCsvAnalyticsEnd'\)\?\.value \|\| ''\)\.trim\(\)/,
  'manual date changes must immediately synchronize endDate state');
assert.match(handler, /state\.requestSeq \+= 1/,
  'manual date changes must invalidate any in-flight analytics response');
assert.match(handler, /state\.loading = false/,
  'manual date changes must release stale loading presentation');
assert.match(handler, /setBusy\(false\)/,
  'manual date changes must clear stale busy controls');
assert.match(handler, /renderEmpty\('Date scope changed\. Click Load to refresh\.'\)/,
  'manual date changes must clear previously rendered analytics');
assert.match(handler, /setStatus\('Date scope changed\. Click Load to refresh\.', 'warn'\)/,
  'manual date changes must explicitly require a fresh Load');
assert.match(handler, /broadcastScope\(\)/,
  'manual date changes must broadcast the synchronized scope');
assert.doesNotMatch(handler, /\brefresh\s*\(/,
  'manual date changes must not auto-load analytics');

const startSync = handler.indexOf('state.startDate =');
const endSync = handler.indexOf('state.endDate =');
const invalidation = handler.indexOf('state.requestSeq += 1');
const clearing = handler.indexOf("renderEmpty('Date scope changed. Click Load to refresh.')");
const broadcast = handler.lastIndexOf('broadcastScope()');
assert(startSync >= 0 && endSync > startSync && invalidation > endSync && clearing > invalidation && broadcast > clearing,
  'manual date scope must synchronize, invalidate, clear, then broadcast in that order');

assert.match(source, /if \(seq !== state\.requestSeq\) return;/,
  'analytics responses must remain generation-owned');
assert.doesNotMatch(source, /AMAZON_ADS_ENABLED|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/,
  'CSV Analytics dashboard must remain read-only and Amazon-execution free');

assert.match(exportSource, /const state = \{ mounted: false, busy: false, exportGeneration: 0 \};/,
  'local analysis export must track generation ownership');
const exportSelectionStart = exportSource.indexOf("joint.querySelector('[data-csv-joint-files]')?.addEventListener('change'");
const exportSelectionEnd = exportSource.indexOf("joint.querySelector('[data-csv-joint-clear]')", exportSelectionStart);
assert(exportSelectionStart >= 0 && exportSelectionEnd > exportSelectionStart,
  'local analysis export file-selection invalidation handler must remain present');
const exportSelectionHandler = exportSource.slice(exportSelectionStart, exportSelectionEnd);
assert.match(exportSelectionHandler, /state\.exportGeneration \+= 1;\s*state\.busy = false;\s*setEnabled\(root, false\)/,
  'file selection changes must revoke stale export ownership and release stale busy state before disabling exports');

const exportClearStart = exportSource.indexOf("joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click'");
const exportClearEnd = exportSource.indexOf('state.mounted = true;', exportClearStart);
assert(exportClearStart >= 0 && exportClearEnd > exportClearStart,
  'local analysis export Clear invalidation handler must remain present');
const exportClearHandler = exportSource.slice(exportClearStart, exportClearEnd);
assert.match(exportClearHandler, /state\.exportGeneration \+= 1;\s*state\.busy = false;\s*setEnabled\(root, false\)/,
  'Clear must revoke stale export ownership and release stale busy state before disabling exports');

const exportCurrentStart = exportSource.indexOf('async function exportCurrent(root, joint, kind)');
const exportCurrentEnd = exportSource.indexOf('function assertAdvisoryOnly(result)', exportCurrentStart);
assert(exportCurrentStart >= 0 && exportCurrentEnd > exportCurrentStart,
  'local analysis export async workflow must remain present');
const exportCurrent = exportSource.slice(exportCurrentStart, exportCurrentEnd);
assert.match(exportCurrent, /const generation = \+\+state\.exportGeneration;/,
  'fresh local exports must claim a new generation');
const exportOwnershipChecks = exportCurrent.match(/if \(generation !== state\.exportGeneration\) return;/g) || [];
assert(exportOwnershipChecks.length >= 4,
  'local export must gate file-read completion, analysis completion, stale errors, and stale finally by generation');
const inputRead = exportCurrent.indexOf('const inputs = await Promise.all');
const firstOwnershipGate = exportCurrent.indexOf('if (generation !== state.exportGeneration) return;', inputRead);
const analysisRead = exportCurrent.indexOf('await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs)', firstOwnershipGate);
const downloadOwnershipGate = exportCurrent.indexOf('if (generation !== state.exportGeneration) return;', analysisRead);
const firstDownload = Math.min(
  ...['downloadBytes(', 'downloadText(']
    .map((needle) => exportCurrent.indexOf(needle, downloadOwnershipGate))
    .filter((index) => index >= 0),
);
assert(inputRead >= 0 && firstOwnershipGate > inputRead && analysisRead > firstOwnershipGate && downloadOwnershipGate > analysisRead && firstDownload > downloadOwnershipGate,
  'stale file reads and analysis results must lose ownership before any download can start');
assert.match(exportCurrent, /catch \(error\) \{\s*if \(generation !== state\.exportGeneration\) return;\s*status\(/,
  'stale export errors must not overwrite the active scope status');
assert.match(exportCurrent, /finally \{\s*if \(generation !== state\.exportGeneration\) return;\s*state\.busy = false;\s*setEnabled\(root, true\);/,
  'stale export finally blocks must not release the active generation busy controls');
assert.doesNotMatch(exportSource, /AMAZON_ADS_ENABLED|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/,
  'local analysis export must remain browser-local and Amazon-execution free');

assert.match(drilldownSource,
  /global\.addEventListener\?\.\('cloudflare-csv-analytics-scope-change', handleSharedScopeChange\)/,
  'analytics drill-down must consume shared dashboard scope changes');
assert.match(drilldownSource,
  /state\.baseScopeKey = baseScopeKey\(dashboardScope\(\)\)/,
  'analytics drill-down must initialize base scope ownership before publishing its own shared scope');
assert.match(drilldownSource,
  /const storeId = String\(scope\.storeId \|\| scope\.store \|\| ''\)\.trim\(\)/,
  'drill-down base scope ownership must accept both internal storeId and shared dashboard store');

const drillHandlerStart = drilldownSource.indexOf('function handleSharedScopeChange(event)');
const drillHandlerEnd = drilldownSource.indexOf('async function refresh()', drillHandlerStart);
assert(drillHandlerStart >= 0 && drillHandlerEnd > drillHandlerStart,
  'analytics drill-down shared-scope invalidation handler must remain present');
const drillHandler = drilldownSource.slice(drillHandlerStart, drillHandlerEnd);
assert.match(drillHandler, /const nextQuery = String\(detail\.q \|\| ''\)\.trim\(\)\.slice\(0, 200\)/,
  'drill-down must consume the dashboard shared query scope');
assert.match(drillHandler, /const baseChanged = Boolean\(nextKey && nextKey !== state\.baseScopeKey\)/,
  'drill-down must detect base store/date scope changes independently');
assert.match(drillHandler, /const queryChanged = nextQuery !== state\.q/,
  'drill-down must detect dashboard query changes independently');
assert.match(drillHandler, /if \(!nextKey \|\| \(!baseChanged && !queryChanged\)\) return;/,
  'drill-down must ignore self-published events when both base scope and query are unchanged');
assert.match(drillHandler, /state\.baseScopeKey = nextKey/,
  'drill-down must claim the new base scope before clearing stale presentation');
assert.match(drillHandler, /state\.q = nextQuery/,
  'dashboard query changes must synchronize into drill-down state');
assert.match(drillHandler, /querySelector\('\[data-cfdd-search\]'\)/,
  'dashboard query changes must synchronize the visible drill-down search control');
assert.match(drillHandler, /search\.value = state\.q/,
  'drill-down search presentation must match synchronized shared query state');
assert.match(drillHandler, /state\.requestSeq \+= 1/,
  'shared base/query scope changes must revoke in-flight drill-down responses');
assert.match(drillHandler, /state\.loading = false/,
  'shared scope changes must release stale drill-down loading state');
assert.match(drillHandler, /renderBusy\(false\)/,
  'shared scope changes must clear stale drill-down busy controls');
assert.match(drillHandler, /renderScope\(null, null\)/,
  'shared scope changes must clear stale drill-down aggregate cards');
assert.match(drillHandler, /renderTable\(\{ items: \[\], pagination: \{ page: 1, totalItems: 0, totalPages: 0 \} \}\)/,
  'shared scope changes must clear stale drill-down rows and pagination');
assert.match(drillHandler, /renderStatus\('Analytics scope changed\. Refresh scope to load hierarchy\.', 'warn'\)/,
  'shared scope changes must explicitly require a fresh hierarchy read');
assert.doesNotMatch(drillHandler, /\brefresh\s*\(/,
  'shared scope changes must not auto-load drill-down data');
assert.match(drilldownSource, /state\.baseScopeKey = scopeKey;\s*const seq = \+\+state\.requestSeq;/,
  'fresh drill-down reads must bind response ownership to the active base scope before request generation');
assert.match(drilldownSource, /if \(seq !== state\.requestSeq\) return;/,
  'drill-down responses must remain generation-owned after scope invalidation');
assert.doesNotMatch(drilldownSource, /AMAZON_ADS_ENABLED|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(/,
  'CSV Analytics drill-down must remain read-only and Amazon-execution free');

console.log(JSON.stringify({
  ok: true,
  csvAnalyticsManualDateScope: true,
  staleResponseInvalidation: true,
  analysisExportGenerationOwnership: true,
  staleAnalysisExportDownloadSuppressed: true,
  staleAnalysisExportFinalizationSuppressed: true,
  drilldownBaseScopeInvalidation: true,
  drilldownDashboardQuerySync: true,
  drilldownSelfEventLoopSuppressed: true,
  autoLoadOnManualDateChange: false,
}));
