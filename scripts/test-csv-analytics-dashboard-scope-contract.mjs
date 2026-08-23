import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-csv-analytics-dashboard-v1.js'), 'utf8');
new vm.Script(source, { filename: 'cloudflare-native-csv-analytics-dashboard-v1.js' });

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

console.log(JSON.stringify({
  ok: true,
  csvAnalyticsManualDateScope: true,
  staleResponseInvalidation: true,
  autoLoadOnManualDateChange: false,
}));
