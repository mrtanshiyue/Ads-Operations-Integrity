import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const webEntry = await readFile(new URL('../cloudflare/runtime/web-entry.js', import.meta.url), 'utf8');
const syncApi = await readFile(new URL('../cloudflare/runtime/sync-api.js', import.meta.url), 'utf8');
const webSync = await readFile(new URL('../cloudflare/runtime/web-sync-orchestration.js', import.meta.url), 'utf8');
const syncWorker = await readFile(new URL('../cloudflare/runtime/sync-worker.js', import.meta.url), 'utf8');
const nativeConfig = await readFile(new URL('../cloudflare/runtime/wrangler.native.jsonc', import.meta.url), 'utf8');
const syncConfig = await readFile(new URL('../cloudflare/runtime/wrangler.sync.jsonc', import.meta.url), 'utf8');

assert.match(webEntry, /import \{ handleSyncApiRoute \} from '\.\/sync-api\.js'/);
assert.match(webEntry, /const SYNC_ROUTE_PATTERN =/);
assert.match(webEntry, /\|\| SYNC_ROUTE_PATTERN\.test\(url\.pathname\)/);
const syncDispatch = webEntry.indexOf('await handleSyncApiRoute');
const legacyFallback = webEntry.lastIndexOf('return legacyWebWorker.fetch');
assert(syncDispatch >= 0 && legacyFallback > syncDispatch, 'sync route must be intercepted before legacy fallback');

assert.match(syncApi, /profile_id, trigger_type, scope_key, status, requested_by, intent_fingerprint/);
assert.match(syncApi, /VALUES\(\?1, NULL, \?2, \?3, 'queued', \?4, \?5, CURRENT_TIMESTAMP\)/);
assert.match(syncApi, /IDEMPOTENCY_KEY_REUSE_CONFLICT/);
assert.match(syncApi, /WORKFLOW_TRIGGER_RECEIPT_UNAVAILABLE/);
assert.doesNotMatch(syncApi, /UPDATE sync_runs[\s\S]{0,200}status = 'failed'/);
assert.doesNotMatch(syncApi, /amazon_profiles[\s\S]{0,200}profile_id =/);

assert.match(webSync, /workflow\.createBatch\(/);
assert.doesNotMatch(webSync, /workflow\.create\(/);

assert.match(syncWorker, /prepareWorkflowExecution/);
assert.match(syncWorker, /load durable sync intent receipt/);
assert.match(syncWorker, /amazonAdsExecutionEnabled\(this\.env\)/);
assert.match(syncWorker, /assertProducerIntentSupported\(execution\.intent\)/);
assert.match(syncWorker, /createAmazonAdsAccessTokenProviderFromEnv\(this\.env\)/);
assert.match(syncWorker, /prepareAmazonAdsProducerRuntime\(\{/);
assert.match(syncWorker, /advanceAmazonAdsReportCycle\(\{/);
assert.doesNotMatch(syncWorker, /amazon_profile_adapter_not_implemented/);
assert.doesNotMatch(syncWorker, /amazon_ads_adapter_not_implemented/);
assert.doesNotMatch(syncWorker, /reportConfigVersion/);
assert.doesNotMatch(syncWorker, /validate Amazon profile/);
assert.doesNotMatch(syncWorker, /build report plan/);
assert.doesNotMatch(syncWorker, /payload\?\.profileId|payload\.profileId|input\.profileId/);

const killSwitchIndex = syncWorker.indexOf('!amazonAdsExecutionEnabled(this.env)');
const capabilityIndex = syncWorker.indexOf('assertProducerIntentSupported(execution.intent)');
const credentialProviderIndex = syncWorker.indexOf('createAmazonAdsAccessTokenProviderFromEnv(this.env)');
const bootstrapIndex = syncWorker.indexOf('prepareAmazonAdsProducerRuntime({');
const reportCycleIndex = syncWorker.indexOf('advanceAmazonAdsReportCycle({');
assert(killSwitchIndex >= 0 && capabilityIndex > killSwitchIndex, 'kill switch must precede producer capability preflight');
assert(credentialProviderIndex > capabilityIndex, 'producer capability preflight must precede Amazon credential construction');
assert(bootstrapIndex > credentialProviderIndex, 'credentials must be available before concrete producer bootstrap');
assert(reportCycleIndex > bootstrapIndex, 'durable producer bootstrap must precede report-cycle execution');

assert.match(nativeConfig, /"SYNC_TRIGGER_ENABLED": "false"/);
assert.match(syncConfig, /"AMAZON_ADS_ENABLED": "false"/);

console.log(JSON.stringify({
  ok: true,
  modularSyncRoutePrecedesLegacy: true,
  callerProfileAuthorityRemovedFromActivePath: true,
  deterministicWorkflowCreateBatch: true,
  durableIntentReceiptFirst: true,
  killSwitchBeforeCapabilityAndCredentials: true,
  concreteAmazonProducerComposition: true,
  placeholderAdaptersRemoved: true,
  killSwitchesRemainFalse: true,
}, null, 2));
