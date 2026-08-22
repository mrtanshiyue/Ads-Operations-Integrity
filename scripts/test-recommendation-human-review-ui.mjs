import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = await readFile(new URL('../assets/cloudflare-native-csv-recommendation-human-review-v1.js', import.meta.url), 'utf8');
const loader = await readFile(new URL('../assets/generated/inline-script-01.js', import.meta.url), 'utf8');
const inbox = await readFile(new URL('../assets/cloudflare-native-csv-recommendation-inbox-v1.js', import.meta.url), 'utf8');
const usability = await readFile(new URL('../assets/cloudflare-native-csv-recommendation-inbox-usability-v1.js', import.meta.url), 'utf8');
const allowlist = await readFile(new URL('./enforce-cloudflare-native-asset-allowlist.mjs', import.meta.url), 'utf8');

assert.match(ui, /const VERSION = '1\.0\.0'/, 'Human Review UI version contract is missing');
assert.match(ui, /const CONTRACT_VERSION = 'csv-recommendation-human-review-v1'/, 'Human Review server contract version is missing');
assert.match(ui, /const DURABLE_STATES = new Set\(\['acknowledged', 'needs_review'\]\)/,
  'Human Review UI must expose only the two schema-backed durable states');
assert.match(ui, /reviewContract: CONTRACT_VERSION/, 'Human Review requests must select the dedicated #230 persistence route');
assert.match(ui, /\/api\/v1\/stores\/\$\{encodeURIComponent\(scope\.storeId\)\}\/advisory-reviews\?\$\{params\}/,
  'Human Review requests must remain store-scoped and same-origin');
assert.match(ui, /if \(!\['GET', 'POST'\]\.includes\(method\)\)/,
  'Human Review UI transport must fail closed to GET/POST only');
assert.doesNotMatch(ui, /method\s*:\s*['"](?:PUT|PATCH|DELETE)['"]/i,
  'Human Review UI must not expose generic mutation verbs');

assert.match(ui, /data-cfhr-set="needs_review"/, 'Needs-review durable action is missing');
assert.match(ui, /data-cfhr-set="acknowledged"/, 'Acknowledgement durable action is missing');
assert.doesNotMatch(ui, /data-cfhr-set="(?:approved|rejected)"/,
  'Approved/rejected must remain fail-closed and have no UI action');
assert.match(ui, /persistenceAuthorized !== true/, 'Client controls must remain gated by server persistence authorization');
assert.match(ui, /await loadSnapshot\(scope, \{ force: true \}\)/,
  'POST success must be followed by a fresh server read');
assert.match(ui, /human_review_read_after_write_mismatch/,
  'UI must fail closed if read-after-write does not confirm requested durable state');
assert.match(ui, /No optimistic review state is shown/, 'UI must explicitly reject optimistic durable presentation');

assert.match(ui, /state\.observer\?\.disconnect\(\)/, 'Human Review UI must isolate its own DOM mutations from MutationObserver feedback');
assert.match(ui, /function mutatePresentation\(callback\)/, 'Observer-isolated presentation mutation helper is missing');
assert.match(ui, /clearPresentation\(\)/, 'Human Review UI must clear stale overlay when scope/source changes');
assert.match(ui, /human_review_scope_changed_during_write/, 'A store/scope change during a write must fail closed in presentation');
assert.match(ui, /REQUEST_TIMEOUT_MS = 30000/, 'GET/POST requests must have a bounded timeout');

assert.match(ui, /data-cfri-filter="reviewState"/, 'Human Review layer must explicitly handle the legacy session-only review filter');
assert.match(ui, /control\.value = ''/, 'Legacy session-only review filter must be cleared before durable presentation');
assert.match(ui, /label\.hidden = true/, 'Legacy review filter must be hidden rather than misrepresent durable filter support');
assert.match(ui, /Viewed is session-only; approved\/rejected remain fail-closed\./,
  'Operator copy must preserve session-vs-durable and unsupported-state boundaries');

assert.match(ui, /=== 'Inbox item ID'/,
  'Evidence drawer durable state must bind through the unique Inbox item ID rather than candidate title text');
assert.match(ui, /state\.reviews\.get\(inboxItemId\)/,
  'Evidence drawer must resolve the server review snapshot by Inbox item ID');
assert.doesNotMatch(ui, /rows\.find\([\s\S]*cfriDrawerTitle/,
  'Evidence drawer must not infer durable identity from a potentially duplicated candidate title');

assert.doesNotMatch(ui, /localStorage|sessionStorage/, 'Durable review truth must not be stored in browser persistence');
assert.doesNotMatch(ui, /optimization-actions|optimization_action_events|execution-permits|amazon-ads-api|sp-api/i,
  'Human Review UI must not expose Optimization Action, execution permit, or Amazon transport endpoints');
assert.doesNotMatch(ui, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|PHASE5_SINGLE_RUN/i,
  'Human Review UI must not touch Amazon/sync enablement controls');

// Existing Inbox browsing/usability layers remain read-only. All write capability is isolated to the new layer.
for (const source of [inbox, usability]) {
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i,
    'Existing Recommendation Inbox layers must remain read-only');
}

assert.match(loader, /CloudflareCsvRecommendationInboxUsability/, 'Human Review loader must wait for the existing Inbox usability layer');
assert.match(loader, /cloudflare-native-csv-recommendation-human-review-v1\.js\?v=1\.0\.0/,
  'Human Review operator asset loader is missing');
assert.match(loader, /attempts>=200/, 'Independent Human Review loader must be bounded rather than polling forever');
assert.match(loader, /event\.target\?\.name\|\|''\)!=='profileId'/,
  'Profile changes must invalidate the legacy Inbox cache path used by Human Review presentation');
assert.match(loader, /CloudflareCsvRecommendationInboxUi\?\.refresh\?\.\(\)/,
  'Profile changes must force a fresh Recommendation Inbox read');
assert.match(loader, /CloudflareCsvRecommendationHumanReviewUi\?\.refresh\?\.\(\)/,
  'Profile changes must force a fresh durable Human Review snapshot');
assert.match(allowlist, /'cloudflare-native-csv-recommendation-human-review-v1\.js'/,
  'Human Review operator asset must be explicitly deployment-allowlisted');

console.log('recommendation human review operator UI contract: PASS');
