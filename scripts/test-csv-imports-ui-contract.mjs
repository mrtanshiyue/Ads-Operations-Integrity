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
assert.match(asset, /const VERSION = '1\.2\.0'/, 'Authority UI version must be explicit');
assert.match(asset, /CloudflareImportsConsole/, 'Imports console public API missing');
assert.match(asset, /data-csv-import-nav/, 'Operations navigation extension missing');
assert.match(asset, /\/imports\/search-terms/, 'Search Term CSV upload endpoint missing');
assert.match(asset, /content-type': 'text\/csv/, 'Raw CSV upload content type missing');
assert.match(asset, /duplicate report/i, 'Duplicate warning UX missing');
assert.match(asset, /ads\.write/, 'Write permission awareness missing');
assert.match(asset, /ads\.read/, 'Read permission awareness missing');

// 0022 authority must be visible in both import history and detail without inventing UI-side authority.
assert.match(asset, /item\.importAuthority/, 'Import history must consume server importAuthority');
assert.match(asset, /batch\.importAuthority/, 'Import detail must consume server importAuthority');
assert.match(asset, /Data class|数据分类/, 'Data classification label missing');
assert.match(asset, /Provenance|来源证明/, 'Provenance label missing');
assert.match(asset, /legacy_batch_only/, 'Legacy provenance visibility missing');
assert.match(asset, /exact_source_object/, 'Exact-source provenance visibility missing');
assert.match(asset, /reconciled_exact_source/, 'Reconciled provenance visibility missing');
assert.match(asset, /Analytics|经营分析/, 'Analytics authority gate missing');
assert.match(asset, /Recommendation|建议/, 'Recommendation authority gate missing');
assert.match(asset, /Review|治理审核/, 'Review authority gate missing');
assert.match(asset, /fail closed/i, 'Fail-closed explanation missing');
assert.match(asset, /validation-only|仅用于验收\/验证/, 'Acceptance-only explanation missing');
assert.match(asset, /recommendations and review remain blocked|建议与审核继续阻断/, 'Legacy provenance block explanation missing');
assert.match(asset, /does not authorize Amazon execution|不代表允许向 Amazon 执行写入/, 'Governed visibility must not imply Amazon execution');

// This UI release is visibility-only. Authority mutation remains an audited API capability, not a UI control.
assert.doesNotMatch(asset, /method:\s*'PATCH'/, 'Import authority mutation UI must not be introduced in visibility-only release');
assert.doesNotMatch(asset, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED/, 'Imports console must not mutate Amazon execution switches');

console.log(JSON.stringify({ ok: true, contract: 'csv-imports-ui-v2-authority-visibility' }));
