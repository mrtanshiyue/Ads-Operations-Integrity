import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const asset = await readFile(new URL('../assets/cloudflare-native-csv-root-lifecycle-usability-v1.js', import.meta.url), 'utf8');
const loader = await readFile(new URL('../assets/generated/inline-script-10.js', import.meta.url), 'utf8');
const allowlist = await readFile(new URL('./enforce-cloudflare-native-asset-allowlist.mjs', import.meta.url), 'utf8');

const taxonomy = [
  'new',
  'emergingWinner',
  'stableWinner',
  'declining',
  'emergingWaste',
  'persistentWaste',
  'recovered',
  'watchlist',
];

assert.match(asset, /CloudflareCsvRootLifecycleUsability/);
assert.match(asset, /VERSION = '1\.0\.2'/);
assert.match(asset, /data-csv-root-intelligence/);
assert.match(asset, /data-csv-lifecycle-workspace/);
assert.match(asset, /Top-3 spend concentration/);
assert.match(asset, /Top-3 sales concentration/);
assert.match(asset, /Winner-linked sales share/);
assert.match(asset, /Waste-exposed spend share/);
assert.match(asset, /Root Priority Focus/);
assert.match(asset, /Backend priority score first; presentation only/);
assert.match(asset, /Current-window concentration only/);
assert.match(asset, /No historical root trend is inferred/);
assert.match(asset, /financiallyComparable === true/);
assert.match(asset, /Suppressed by financial comparability gate/);
assert.match(asset, /Candidate emission blocked by scope/);
assert.match(asset, /candidate linkage blocked by scope/);
assert.match(asset, /Presentation only/);
assert.match(asset, /No lifecycle rows match current presentation filters/);
assert.match(asset, /Attention priority/);
assert.match(asset, /Spend movement/);
assert.match(asset, /Sales movement/);
assert.match(asset, /Order movement/);
assert.match(asset, /Linked root/);
assert.match(asset, /search-term-intelligence/);
assert.match(asset, /state\.observer\?\.disconnect\(\)/);
assert.match(asset, /function observePanel\(\)/);
assert.match(asset, /finally \{\s*observePanel\(\);\s*\}/);

// Fail closed when the host leaves CSV or when backend productization is unavailable.
assert.match(asset, /currentSource\(\) !== 'csv'/);
assert.match(asset, /clearPresentation\(\{ resetFilters: true \}\)/);
assert.match(asset, /function clearPresentation\(/);
assert.match(asset, /data-crlu-root-productization/);
assert.match(asset, /data-crlu-lifecycle-controls/);
assert.match(asset, /data-crlu-root-context/);
assert.match(asset, /data-crlu-lifecycle-linkage/);
assert.match(asset, /function restoreLifecycleRows\(/);
assert.match(asset, /data-crlu-prior-hidden/);
assert.match(asset, /crluPriorHidden/);

// Host intelligence filters must invalidate the cache and be forwarded to the backend.
for (const name of ['q', 'campaignName', 'adGroupName']) {
  assert.match(asset, new RegExp(`['"]${name}['"]`));
  assert.match(asset, new RegExp(`scope\\.${name}`));
}
assert.match(asset, /HOST_SCOPE_CONTROL_NAMES/);
assert.match(asset, /HOST_SCOPE_TEXT_CONTROL_NAMES/);
assert.match(asset, /panel\.addEventListener\('input', handleHostScopeInput\)/);
assert.match(asset, /for \(const name of \['profileId', 'q', 'campaignName', 'adGroupName'\]\)/);
assert.match(asset, /params\.set\(name, scope\[name\]\)/);

assert.doesNotMatch(asset, /localStorage|sessionStorage/);
assert.doesNotMatch(asset, /advisory-reviews|optimization-actions|execution-permits|execution-receipts/);
assert.doesNotMatch(asset, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
assert.doesNotMatch(asset, /amazon(?:ads| mutation| network| oauth| token)/i);

for (const value of taxonomy) {
  assert.match(asset, new RegExp(`['"]${value}['"]`));
}
assert.equal((asset.match(/const LIFECYCLE_STATES = Object\.freeze\(\[/g) || []).length, 1);
assert.match(loader, /cloudflare-native-csv-root-lifecycle-usability-v1\.js\?v=1\.0\.2/);
assert.match(loader, /usability\.addEventListener\('load',loadRootLifecycle/);
assert.match(allowlist, /cloudflare-native-csv-root-lifecycle-usability-v1\.js/);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-root-lifecycle-usability-v1',
  version: '1.0.2',
  taxonomy,
  observerIsolation: 'disconnect-render-reobserve',
  stalePresentationFailClosed: true,
  hostScopeFilters: ['q', 'campaignName', 'adGroupName'],
  persistence: 'none',
  mutation: 'none',
  amazonTransport: 'absent',
}));
