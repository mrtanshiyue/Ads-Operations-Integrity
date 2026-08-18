import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-cloudflare-native');
const index = await readFile(path.join(dist, 'index.html'), 'utf8');
const asset = await readFile(path.join(dist, 'assets', 'cloudflare-native-csv-intelligence-v1.js'), 'utf8');
const tag = '<script src="assets/cloudflare-native-csv-intelligence-v1.js"></script>';

assert.equal(index.split(tag).length - 1, 1, 'CSV Intelligence extension must be injected exactly once');
assert.match(asset, /CloudflareCsvIntelligence/, 'CSV Intelligence public marker missing');
assert.match(asset, /name="dataSource"/, 'Decision Intelligence data-source switch missing');
assert.match(asset, /Imported CSV/, 'Imported CSV source option missing');
assert.match(asset, /source:\s*'csv'/, 'CSV intelligence request must carry source=csv');
assert.match(asset, /data-csv-evidence-index/, 'CSV evidence drilldown missing');
assert.match(asset, /Governance persistence disabled/, 'CSV persistence safety notice missing');
assert.match(asset, /Amazon identity unresolved/, 'Identity-resolution warning missing');
assert.doesNotMatch(asset, /method:\s*'POST'|optimization-actions|data-propose|data-dry-run/, 'CSV intelligence extension must remain read-only');
assert.doesNotMatch(asset, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|execution-permit/i, 'CSV intelligence UI must not touch Amazon execution controls');

console.log(JSON.stringify({ ok: true, contract: 'csv-real-data-intelligence-ui-v1' }));
