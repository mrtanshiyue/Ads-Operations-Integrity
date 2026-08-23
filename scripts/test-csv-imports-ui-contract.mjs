import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-cloudflare-native');
const index = await readFile(path.join(dist, 'index.html'), 'utf8');
const asset = await readFile(path.join(dist, 'assets', 'cloudflare-native-imports-console-v1.js'), 'utf8');
const tag = '<script src="assets/cloudflare-native-imports-console-v1.js"></script>';

new vm.Script(asset, { filename: 'cloudflare-native-imports-console-v1.js' });
assert.equal(index.split(tag).length - 1, 1, 'Imports console must be injected exactly once');
assert.match(asset, /const VERSION = '1\.3\.0'/, 'Operational imports UI version must be explicit');
assert.match(asset, /CloudflareImportsConsole/, 'Imports console public API missing');
assert.match(asset, /data-csv-import-nav/, 'Operations navigation extension missing');
assert.match(asset, /\/imports\/search-terms/, 'Search Term CSV upload endpoint missing');
assert.match(asset, /\/imports\/settlements/, 'Settlement CSV endpoint missing');
assert.match(asset, /cfSettlementImportForm/, 'Settlement upload form missing');
assert.match(asset, /MAX_SETTLEMENT_BYTES = 16 \* 1024 \* 1024/, 'Settlement 16 MB UI limit missing');
assert.match(asset, /content-type': 'text\/csv/, 'Raw CSV upload content type missing');
assert.match(asset, /duplicate report/i, 'Duplicate warning UX missing');
assert.match(asset, /ads\.write/, 'Write permission awareness missing');
assert.match(asset, /ads\.read/, 'Read permission awareness missing');

// Every async store-scoped path must be owned by the store scope that started it.
assert.match(asset, /scopeGeneration: 0,\s*refreshSerial: 0,\s*permissionSerial: 0,\s*detailSerial: 0,\s*settlementDetailSerial: 0,/,
  'Imports console must track store-scope generations and independent read ownership');
assert.match(asset, /function currentScope\(\) \{\s*return Object\.freeze\(\{ storeId: state\.storeId, generation: state\.scopeGeneration \}\);\s*\}/,
  'Imports console must capture store and generation together');
assert.match(asset, /function scopeIsCurrent\(scope\) \{\s*return Boolean\(scope && scope\.storeId === state\.storeId && scope\.generation === state\.scopeGeneration\);\s*\}/,
  'late async responses must prove store and generation ownership before updating UI');
assert.match(asset, /state\.scopeGeneration \+= 1;\s*state\.refreshSerial \+= 1;\s*state\.permissionSerial \+= 1;\s*state\.detailSerial \+= 1;\s*state\.settlementDetailSerial \+= 1;\s*state\.loading = false;/,
  'store transition must revoke list, permission, and detail reads and release stale list loading ownership');
assert.match(asset, /const scope = currentScope\(\);\s*const serial = \+\+state\.refreshSerial;\s*state\.loading = true;/,
  'history refresh must capture store scope and its own generation');
assert.match(asset, /if \(serial !== state\.refreshSerial \|\| !scopeIsCurrent\(scope\)\) return;/,
  'late history responses must not overwrite a newly selected store');
assert.match(asset, /const serial = \+\+state\.permissionSerial;/,
  'permission reads must have independent request ownership');
assert.match(asset, /const serial = \+\+state\.detailSerial;/,
  'Search Term detail reads must have independent request ownership');
assert.match(asset, /const serial = \+\+state\.settlementDetailSerial;/,
  'Settlement detail reads must have independent request ownership');
assert.match(asset, /state\.selectedImportId !== id/,
  'Search Term detail responses must also remain bound to the selected import id');
assert.match(asset, /state\.selectedSettlementImportId !== id/,
  'Settlement detail responses must also remain bound to the selected import id');
assert.equal((asset.match(/const scope = currentScope\(\);/g) || []).length, 8,
  'all list, permission, detail, upload, and authority-classification async paths must capture scope');
assert.doesNotMatch(asset, /requestJson\(`\/api\/v1\/stores\/\$\{encodeURIComponent\(state\.storeId\)\}/,
  'store-scoped network requests must never read mutable state.storeId after async work begins');
assert.match(asset, /if \(!scopeIsCurrent\(scope\)\) return;/,
  'write completion must not publish old-store result state into a newly selected store');

// Search Term and Settlement must remain explicitly separated at the operational boundary.
assert.match(asset, /Search Term CSV/, 'Search Term report-type card missing');
assert.match(asset, /Settlement Financial CSV/, 'Settlement report-type card missing');
assert.match(asset, /POST \/imports\/settlements/, 'Settlement endpoint hint missing');
assert.match(asset, /settlementDetail/, 'Settlement detail receipt path missing');
assert.match(asset, /reconciliation/, 'Settlement reconciliation evidence missing');
assert.match(asset, /sourceObject/, 'Settlement exact-source receipt evidence missing');

// Authority remains server-owned and fail-closed; UI may invoke only the audited governed PATCH APIs.
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
assert.match(asset, /method:\s*'PATCH'/, 'Formal authority PATCH control missing');
assert.match(asset, /dataClass:\s*'business'/, 'Business classification request missing');
assert.match(asset, /data-import-authority-business/, 'Search Term authority action missing');
assert.match(asset, /data-settlement-authority-business/, 'Settlement authority action missing');
assert.match(asset, /published/, 'Published gate missing from authority action');
assert.match(asset, /differenceMicros/, 'Settlement difference gate missing from authority action');
assert.match(asset, /mismatchRows/, 'Settlement mismatch gate missing from authority action');
assert.match(asset, /exact_source_object/, 'Exact-source authority gate missing');

// Operational CSV controls must never authorize or toggle Amazon execution.
assert.doesNotMatch(asset, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED/, 'Imports console must not mutate Amazon execution switches');
assert.doesNotMatch(asset, /startSync\s*\(|AMAZON_SYNC_WORKFLOW/, 'Imports console must not introduce Amazon sync execution');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-imports-ui-v3-settlement-operational-authority',
  crossStoreScopeOwnership: true,
}));
