import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-cloudflare-native');
const index = await readFile(path.join(dist, 'index.html'), 'utf8');
const asset = await readFile(path.join(dist, 'assets', 'cloudflare-native-imports-console-v1.js'), 'utf8');
const tag = '<script src="assets/cloudflare-native-imports-console-v1.js"></script>';

assert.equal(index.split(tag).length - 1, 1, 'Imports console must be injected exactly once');
assert.match(asset, /CloudflareImportsConsole/, 'Imports console public API missing');
assert.match(asset, /data-csv-import-nav/, 'Operations navigation extension missing');
assert.match(asset, /\/imports\/search-terms/, 'Search Term CSV upload endpoint missing');
assert.match(asset, /content-type': 'text\/csv/, 'Raw CSV upload content type missing');
assert.match(asset, /duplicate report/i, 'Duplicate warning UX missing');
assert.match(asset, /ads\.write/, 'Write permission awareness missing');
assert.match(asset, /ads\.read/, 'Read permission awareness missing');
assert.doesNotMatch(asset, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED/, 'Imports console must not mutate Amazon execution switches');

console.log(JSON.stringify({ ok: true, contract: 'csv-imports-ui-v1' }));
