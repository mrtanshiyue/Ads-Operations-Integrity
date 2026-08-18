import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-cloudflare-native');
const index = await readFile(path.join(dist, 'index.html'), 'utf8');
const asset = await readFile(path.join(dist, 'assets', 'cloudflare-native-csv-intelligence-v1.js'), 'utf8');
const tag = '<script src="assets/cloudflare-native-csv-intelligence-v1.js?v=1.0.3"></script>';

assert.equal(index.split(tag).length - 1, 1, 'CSV Intelligence extension must be injected exactly once with cache-busting version');
assert.doesNotMatch(index, /<script src="assets\/cloudflare-native-csv-intelligence-v1\.js"><\/script>/, 'Unversioned CSV Intelligence script tag must not survive the canonical build');
assert.match(asset, /CloudflareCsvIntelligence/, 'CSV Intelligence public marker missing');
assert.match(asset, /VERSION\s*=\s*'1\.0\.3'/, 'CSV Intelligence runtime version must advance after watchdog hardening');
assert.match(asset, /csvIntelligenceVersion = VERSION/, 'Runtime version must be exposed on the decision panel for authenticated acceptance diagnostics');
assert.match(asset, /name="dataSource"/, 'Decision Intelligence data-source switch missing');
assert.match(asset, /Imported CSV/, 'Imported CSV source option missing');
assert.match(asset, /source:\s*'csv'/, 'CSV intelligence request must carry source=csv');
assert.match(asset, /profile\.value = ''/, 'CSV mode must not silently reuse the persisted Amazon profile scope');
assert.match(asset, /state\.amazonProfileId/, 'Amazon profile scope must be restorable after leaving CSV mode');
assert.match(asset, /data-csv-evidence-index/, 'CSV evidence drilldown missing');
assert.match(asset, /Governance persistence disabled/, 'CSV persistence safety notice missing');
assert.match(asset, /Amazon identity unresolved/, 'Identity-resolution warning missing');

assert.match(asset, /REQUEST_TIMEOUT_MS\s*=\s*30000/, 'CSV intelligence must bound pending requests');
assert.match(asset, /TIMEOUT_ERROR_CODE\s*=\s*'CSV_INTELLIGENCE_TIMEOUT'/, 'CSV intelligence must classify watchdog timeouts deterministically');
assert.match(asset, /new AbortController\(\)/, 'CSV intelligence must support request cancellation');
assert.match(asset, /signal:\s*controller\.signal/, 'CSV intelligence fetch must receive the abort signal');
assert.match(asset, /Promise\.race\(\[/, 'CSV intelligence must use an independent watchdog race rather than rely only on fetch abort rejection');
assert.match(asset, /timeoutPromise/, 'CSV intelligence must maintain an explicit watchdog promise');
assert.match(asset, /reject\(error\)/, 'Watchdog timeout must independently reject the pending UI operation');
assert.match(asset, /state\.requestController/, 'CSV intelligence must track its active request');
assert.match(asset, /state\.requestId/, 'CSV intelligence must reject stale responses');
assert.match(asset, /if \(state\.requestController\) return/, 'CSV intelligence must prevent duplicate concurrent runs');
assert.match(asset, /run\.disabled = Boolean\(pending\)/, 'Run Preview must be disabled while a CSV request is pending');
assert.match(asset, /aria-busy/, 'Pending CSV intelligence requests must expose busy state');
assert.match(asset, /cancelActiveRequest\(\)/, 'CSV intelligence must cancel work on context changes');
assert.match(asset, /timed out after 30 seconds/, 'CSV intelligence must surface an explicit timeout instead of hanging forever');
assert.match(asset, /No data was changed/, 'Timeout copy must preserve the read-only safety boundary');
assert.match(asset, /finally\s*\{[\s\S]*setRunPending\(panel, false\)/, 'CSV intelligence must restore Run Preview after completion');
assert.match(asset, /credentials:\s*'same-origin'/, 'CSV intelligence must preserve same-origin Access credentials');

assert.doesNotMatch(asset, /method:\s*'POST'|optimization-actions|data-propose|data-dry-run/, 'CSV intelligence extension must remain read-only');
assert.doesNotMatch(asset, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|execution-permit/i, 'CSV intelligence UI must not touch Amazon execution controls');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-real-data-intelligence-ui-v3-independent-watchdog',
  runtimeVersion: '1.0.3',
  requestTimeoutMs: 30000,
  independentWatchdog: true,
  cacheBustedAsset: true,
  duplicateRunsBlocked: true,
  staleResponsesRejected: true,
  amazonMutationControls: false,
}));