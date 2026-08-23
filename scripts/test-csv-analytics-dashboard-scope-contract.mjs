import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-csv-analytics-dashboard-v1.js'), 'utf8');
const drilldownSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-csv-analytics-drilldown-v1.js'), 'utf8');
new vm.Script(source, { filename: 'cloudflare-native-csv-analytics-dashboard-v1.js' });
new vm.Script(drilldownSource, { filename: 'cloudflare-native-csv-analytics-drilldown-v1.js' });

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
assert.match(drillHandler, /if \(!nextKey \|\| nextKey === state\.baseScopeKey\) return;/,
  'drill-down must ignore self-published filter events when the base store/date scope is unchanged');
assert.match(drillHandler, /state\.baseScopeKey = nextKey/,
  'drill-down must claim the new base scope before clearing stale presentation');
assert.match(drillHandler, /state\.requestSeq \+= 1/,
  'base scope changes must revoke in-flight drill-down responses');
assert.match(drillHandler, /state\.loading = false/,
  'base scope changes must release stale drill-down loading state');
assert.match(drillHandler, /renderBusy\(false\)/,
  'base scope changes must clear stale drill-down busy controls');
assert.match(drillHandler, /renderScope\(null, null\)/,
  'base scope changes must clear stale drill-down aggregate cards');
assert.match(drillHandler, /renderTable\(\{ items: \[\], pagination: \{ page: 1, totalItems: 0, totalPages: 0 \} \}\)/,
  'base scope changes must clear stale drill-down rows and pagination');
assert.match(drillHandler, /renderStatus\('Analytics scope changed\. Refresh scope to load hierarchy\.', 'warn'\)/,
  'base scope changes must explicitly require a fresh hierarchy read');
assert.doesNotMatch(drillHandler, /\brefresh\s*\(/,
  'shared base scope changes must not auto-load drill-down data');
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
  drilldownBaseScopeInvalidation: true,
  drilldownSelfEventLoopSuppressed: true,
  autoLoadOnManualDateChange: false,
}));
