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
assert.doesNotMatch(asset, /localStorage|sessionStorage/);
assert.doesNotMatch(asset, /advisory-reviews|optimization-actions|execution-permits|execution-receipts/);
assert.doesNotMatch(asset, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
assert.doesNotMatch(asset, /amazon(?:ads| mutation| network| oauth| token)/i);

for (const value of taxonomy) {
  assert.match(asset, new RegExp(`['"]${value}['"]`));
}
assert.equal((asset.match(/const LIFECYCLE_STATES = Object\.freeze\(\[/g) || []).length, 1);
assert.match(loader, /cloudflare-native-csv-root-lifecycle-usability-v1\.js\?v=1\.0\.0/);
assert.match(loader, /usability\.addEventListener\('load',loadRootLifecycle/);
assert.match(allowlist, /cloudflare-native-csv-root-lifecycle-usability-v1\.js/);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-root-lifecycle-usability-v1',
  taxonomy,
  persistence: 'none',
  mutation: 'none',
  amazonTransport: 'absent',
}));
