import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = await readFile(path.join(root, 'cloudflare/runtime/csv-imports-api.js'), 'utf8');
const settlementApi = await readFile(path.join(root, 'cloudflare/runtime/settlement-imports-api.js'), 'utf8');
const entry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');

assert.match(entry, /handleCsvImportsApiRoute/, 'CSV imports modular handler is not wired');
assert.match(entry, /CSV_IMPORTS_ROUTE_PATTERN/, 'CSV imports route pattern is not in the strict modular boundary');
assert.match(entry, /strictAccessGuard/, 'Strict Access guard must remain ahead of modular routes');

assert.match(api, /'ads\.write'/, 'Upload must require store-scoped ads.write');
assert.match(api, /'ads\.read'/, 'History and validation reads must require ads.read');
assert.match(api, /STORE_BINDINGS = new Set/, 'Store D1 binding allowlist missing');
assert.match(api, /createD1CsvSearchTermImportRepository/, 'Canonical CSV D1 repository missing');
assert.match(api, /ingestSearchTermCsvOnce/, 'Canonical CSV ingestion orchestrator missing');
assert.match(api, /request\.arrayBuffer\(\)/, 'Upload must preserve exact request bytes before text decoding');
assert.doesNotMatch(api, /request\.text\(\)/, 'CSV provenance must not depend on text re-encoding');
assert.match(api, /createCsvImportSourceObjectStore/, 'Immutable R2 CSV source store missing');
assert.match(api, /sourceBytes/, 'Exact source bytes must flow into canonical ingestion');
assert.match(api, /sourceObjectKey/, 'Audit metadata must correlate the immutable R2 object');
assert.match(api, /MAX_CSV_BYTES = 10 \* 1024 \* 1024/, '10 MB boundary missing');
assert.match(api, /resource === 'search-terms'/, 'Search Term upload resource missing');
assert.match(api, /csv_import\.published/, 'Published import audit event missing');
assert.match(api, /csv_import\.duplicate/, 'Duplicate import audit event missing');
assert.match(api, /csv_import\.rejected/, 'Rejected import audit event missing');
assert.match(api, /CSV_IMPORT_PARSE_FAILED/, 'Parser failures must be classified explicitly');
assert.match(api, /return json\(request, \{ error: 'csv_import_failed' \}, 500\)/, 'Internal import failures must fail closed as 500');
assert.match(api, /safeParserErrorCode/, 'Parser error responses must be allowlisted');
assert.doesNotMatch(api, /sourceCode\.startsWith\('CSV_'\)/, 'Internal CSV-prefixed repository errors must not be downgraded to 400');
assert.doesNotMatch(api, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|execution-permit/i, 'CSV import API must not open Amazon execution');

assert.match(entry, /handleSettlementImportsApiRoute/, 'Settlement imports modular handler is not wired');
const settlementDispatch = entry.indexOf('handleSettlementImportsApiRoute');
const genericDispatch = entry.indexOf('handleCsvImportsApiRoute({ request, env, actor, url })');
assert.ok(settlementDispatch >= 0 && genericDispatch >= 0 && settlementDispatch < genericDispatch,
  'Settlement route must be dispatched before the generic Search Term import handler');
assert.match(settlementApi, /\/imports\\\/settlements/, 'Settlement import route missing');
assert.match(settlementApi, /request\.arrayBuffer\(\)/, 'Settlement upload must preserve exact source bytes');
assert.match(settlementApi, /parseAmazonSettlementCsv/, 'Settlement parser is not wired');
assert.match(settlementApi, /createSettlementImportSourceObjectStore/, 'Settlement R2 source store is not wired');
assert.match(settlementApi, /createD1SettlementImportRepository/, 'Settlement D1 repository is not wired');
assert.match(settlementApi, /settlement_import\.published/, 'Settlement published audit event missing');
assert.match(settlementApi, /sourceObjectReusableOnRetry:true/, 'R2-before-D1 failure must be declared retry-safe');
assert.match(settlementApi, /reconciliationStatus/, 'Settlement audit evidence must include reconciliation status');
assert.doesNotMatch(settlementApi, /orderCity|orderState|orderPostal/, 'Settlement API must not expose order location fields');
assert.doesNotMatch(settlementApi, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|execution-permit/i, 'Settlement CSV API must not open Amazon execution');

await import('./test-csv-persistent-source-objects.mjs');
await import('./test-csv-imports-ui-contract.mjs');
await import('./test-csv-real-data-intelligence-ui-contract.mjs');
await import('./test-csv-product-ui-navigation-contract.mjs');
await import('./test-csv-term-profitability-analysis.mjs');
await import('./test-csv-observed-targeting-identity.mjs');
await import('./test-csv-joint-report-analysis.mjs');
await import('./test-settlement-csv-import.mjs');
await import('./test-settlement-source-object.mjs');
execFileSync('python3', [path.join(root, 'scripts/test-settlement-csv-foundation.py')], { stdio:'inherit' });

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-import-workflow-v7-settlement-exact-source',
  requiredContracts: [
    'csv-persistent-source-objects-v1',
    'csv-imports-ui-v1',
    'csv-real-data-intelligence-ui-v4-canonical-identity-copy',
    'csv-product-ui-navigation-v3-versioned-load-order',
    'csv-term-profitability-analysis-v2-profit-root-protection',
    'csv-observed-targeting-identity-v1',
    'csv-joint-report-analysis-v2-observed-identity',
    'settlement-csv-import-v1',
    'settlement-r2-retry-recovery-v1',
    'settlement-d1-foundation-v1',
  ],
  amazonLiveApiCalls: false,
  cloudflareWrites: false,
  d1RemoteWrites: false,
}));
