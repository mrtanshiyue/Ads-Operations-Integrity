import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-cloudflare-native');
const index = await readFile(path.join(dist, 'index.html'), 'utf8');
const asset = await readFile(path.join(dist, 'assets', 'cloudflare-native-csv-intelligence-v1.js'), 'utf8');
const tag = '<script src="assets/cloudflare-native-csv-intelligence-v1.js?v=1.0.7"></script>';

assert.equal(index.split(tag).length - 1, 1, 'CSV Intelligence extension must be injected exactly once with cache-busting version');
assert.doesNotMatch(index, /<script src="assets\/cloudflare-native-csv-intelligence-v1\.js"><\/script>/, 'Unversioned CSV Intelligence script tag must not survive the canonical build');
assert.match(asset, /CloudflareCsvIntelligence/, 'CSV Intelligence public marker missing');
assert.match(asset, /VERSION\s*=\s*'1\.0\.7'/, 'CSV Intelligence runtime version must advance for Lifecycle workspace productization');
assert.match(asset, /csvIntelligenceVersion = VERSION/, 'Runtime version must be exposed on the decision panel for authenticated acceptance diagnostics');
assert.match(asset, /name="dataSource"/, 'Decision Intelligence data-source switch missing');
assert.match(asset, /Imported CSV/, 'Imported CSV source option missing');
assert.match(asset, /source:\s*'csv'/, 'CSV intelligence request must carry source=csv');
assert.match(asset, /profile\.value = ''/, 'CSV mode must not silently reuse the persisted Amazon profile scope');
assert.match(asset, /state\.amazonProfileId/, 'Amazon profile scope must be restorable after leaving CSV mode');
assert.match(asset, /data-csv-evidence-index/, 'CSV evidence drilldown missing');
assert.match(asset, /Governance persistence disabled/, 'CSV persistence safety notice missing');
assert.match(asset, /Canonical Amazon identity unverified/, 'Canonical identity verification warning missing');
assert.match(asset, /Observed advertiser account ID/, 'Observed CSV advertiser account evidence must be visible');
assert.match(asset, /Observed campaign ID/, 'Observed CSV campaign ID evidence must be visible');
assert.match(asset, /Observed ad group ID/, 'Observed CSV ad-group ID evidence must be visible');
assert.match(asset, /Observed targeting ID/, 'Observed CSV targeting ID evidence must be visible');
assert.match(asset, /Observed CSV IDs alone do not authorize persistence or Amazon mutation/, 'Observed IDs must not be presented as canonical authorization');
assert.doesNotMatch(asset, /campaign\/ad-group\/keyword IDs are unresolved/, 'UI must not falsely claim observed CSV entity IDs are absent');

assert.match(asset, /payload\?\.productization/, 'Operator Workspace must progressively consume payload.productization');
assert.match(asset, /data-csv-operator-workspace/, 'Search Term Intelligence Operator Workspace surface missing');
assert.match(asset, /data-csv-product-overview/, 'Product overview summary missing');
for (const label of ['Profit Winners', 'Scale Opportunities', 'Waste Terms', 'Watchlist', 'Candidate Count', 'Root Count', 'Lifecycle Count']) {
  assert.ok(asset.includes(label), `Operator Workspace overview must expose ${label}`);
}
assert.match(asset, /data-csv-scope-health/, 'Analysis Scope health surface missing');
for (const label of ['Universe Complete?', 'Financially Comparable?', 'Candidate Emission Authorized?', 'Observed Search Term Count', 'Hard Cap', 'Scope Reasons']) {
  assert.ok(asset.includes(label), `Analysis Scope must expose ${label}`);
}
assert.match(asset, /incomplete-universe data cannot emit Negative, Harvest, or Scale candidates/, 'Incomplete universe must fail closed in operator copy');
assert.match(asset, /Financial comparability gate blocked/, 'Financial comparability gate must be explicit');
assert.match(asset, /financialValue\(/, 'Financial values must pass through a comparability suppression helper');
assert.match(asset, /scope\?\.financiallyComparable === true/, 'Financial display must require explicit comparability');
assert.match(asset, /data-csv-product-term/, 'Product intelligence evidence drilldown missing');
assert.match(asset, /function buildRootMap\(roots\)/, 'Search-term rows must map back to concrete root records');
assert.match(asset, /root\.searchTerms/, 'Root intelligence must retain root-to-search-term membership for drilldown and candidate visibility');
assert.match(asset, /candidate\?\.matchScope === 'phrase_review'/, 'Phrase-negative review candidates must be mapped through their root membership');
assert.match(asset, /kv\('Roots', join\(rootNames\)\)/, 'Product evidence must expose concrete root names separately from root states');
assert.match(asset, /Human review boundary/, 'Operator Workspace must preserve the human-review boundary');
assert.match(asset, /Amazon mutation disabled/, 'Product evidence must retain Amazon mutation disabled copy');
assert.match(asset, /data-csv-productization-fallback/, 'Older payloads must fall back to the compatibility view instead of being treated as complete product intelligence');

assert.match(asset, /data-csv-root-intelligence/, 'Dedicated Root Intelligence workspace missing');
for (const label of ['Root Intelligence', 'Winner Terms', 'Waste Terms', 'Search Terms']) {
  assert.ok(asset.includes(label), `Root Intelligence workspace must expose ${label}`);
}
assert.match(asset, /data-csv-root=/, 'Root-to-search-term drilldown control missing');
assert.match(asset, /function renderRootEvidence\(rootName, payload\)/, 'Root evidence drawer missing');
assert.match(asset, /not in current root payload/, 'Root trend must explicitly disclose that the current payload does not provide it');
assert.match(asset, /does not infer one from term-level lifecycle states/, 'Root trend must not be fabricated from term-level lifecycle');
assert.match(asset, /function candidatesForRoot\(root, candidates\)/, 'Direct root candidate visibility helper missing');
assert.match(asset, /function candidatesForRootMembers\(root, candidates\)/, 'Root member candidate visibility helper missing');
assert.match(asset, /Root review boundary/, 'Root Intelligence must preserve the human-review-only boundary');
assert.match(asset, /cannot execute a phrase negative, change a bid, or write to Amazon/, 'Root Intelligence must explicitly deny mutation authority');

assert.match(asset, /data-csv-lifecycle-workspace/, 'Dedicated Lifecycle workspace missing');
assert.match(asset, /data-csv-lifecycle-summary/, 'Lifecycle state summary missing');
for (const label of ['New', 'Emerging Winner', 'Stable Winner', 'Declining', 'Emerging Waste', 'Persistent Waste', 'Recovered']) {
  assert.ok(asset.includes(label), `Lifecycle workspace must expose ${label}`);
}
assert.match(asset, /Previous performance/, 'Lifecycle workspace must expose previous-period performance');
assert.match(asset, /Current performance/, 'Lifecycle workspace must expose current-period performance');
assert.match(asset, /data-csv-lifecycle-term/, 'Lifecycle evidence drilldown missing');
assert.match(asset, /function renderLifecycleEvidence\(searchTerm, payload\)/, 'Lifecycle evidence drawer missing');
assert.match(asset, /lifecycle\.currentMetrics/, 'Lifecycle evidence must use backend currentMetrics');
assert.match(asset, /lifecycle\.previousMetrics/, 'Lifecycle evidence must use backend previousMetrics');
assert.match(asset, /lifecycle\.change/, 'Lifecycle evidence must use backend period-over-period change');
assert.match(asset, /lifecycle\.currentWindow/, 'Lifecycle evidence must expose current window');
assert.match(asset, /lifecycle\.previousWindow/, 'Lifecycle evidence must expose previous window');
assert.match(asset, /Financial metrics suppressed/, 'Lifecycle financial metrics must fail closed when financial comparability is false');
assert.match(asset, /A lifecycle state is a diagnostic signal, not an execution authorization/, 'Lifecycle state must not be treated as action authorization');
assert.match(asset, /Only candidates already emitted through the governed business-intelligence gate are shown for review/, 'Lifecycle candidate visibility must reuse the governed business candidate plane');
assert.match(asset, /function signedRatioPp\(value\)/, 'Lifecycle ratio deltas must convert ACoS/CVR ratios to percentage points explicitly');

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
  contract: 'csv-real-data-intelligence-ui-v7-lifecycle-workspace',
  runtimeVersion: '1.0.7',
  requestTimeoutMs: 30000,
  independentWatchdog: true,
  cacheBustedAsset: true,
  operatorWorkspace: true,
  completeUniverseScopeVisible: true,
  financialComparabilityFailClosed: true,
  rootMembershipVisible: true,
  rootWorkspace: true,
  rootTrendNotInferred: true,
  lifecycleWorkspace: true,
  lifecycleUsesBackendPeriodComparison: true,
  lifecycleDoesNotAuthorizeExecution: true,
  phraseReviewMappedThroughRoots: true,
  humanReviewOnly: true,
  duplicateRunsBlocked: true,
  staleResponsesRejected: true,
  observedCsvIdsAreNotCanonicalAuthority: true,
  amazonMutationControls: false,
}));
