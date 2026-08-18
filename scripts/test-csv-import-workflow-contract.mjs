import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = await readFile(path.join(root, 'cloudflare/runtime/csv-imports-api.js'), 'utf8');
const entry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');

assert.match(entry, /handleCsvImportsApiRoute/, 'CSV imports modular handler is not wired');
assert.match(entry, /CSV_IMPORTS_ROUTE_PATTERN/, 'CSV imports route pattern is not in the strict modular boundary');
assert.match(entry, /strictAccessGuard/, 'Strict Access guard must remain ahead of modular routes');

assert.match(api, /'ads\.write'/, 'Upload must require store-scoped ads.write');
assert.match(api, /'ads\.read'/, 'History and validation reads must require ads.read');
assert.match(api, /STORE_BINDINGS = new Set/, 'Store D1 binding allowlist missing');
assert.match(api, /createD1CsvSearchTermImportRepository/, 'Canonical CSV D1 repository missing');
assert.match(api, /ingestSearchTermCsvOnce/, 'Canonical CSV ingestion orchestrator missing');
assert.match(api, /request\.text\(\)/, 'Upload must consume raw CSV instead of JSON wrapping');
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

// This contract is already executed by the protected canonical CI job. Keep the
// built CSV operator surfaces and local advisory analysis inside that same required
// context instead of allowing syntax-only or un-gated analytics regressions.
await import('./test-csv-imports-ui-contract.mjs');
await import('./test-csv-real-data-intelligence-ui-contract.mjs');
await import('./test-csv-product-ui-navigation-contract.mjs');
await import('./test-csv-term-profitability-analysis.mjs');
await import('./test-csv-joint-report-analysis.mjs');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-import-workflow-v4-required-joint-analysis',
  requiredContracts: [
    'csv-imports-ui-v1',
    'csv-real-data-intelligence-ui-v4-canonical-identity-copy',
    'csv-product-ui-navigation-v3-versioned-load-order',
    'csv-term-profitability-analysis-v2-profit-root-protection',
    'csv-joint-report-analysis-v1',
  ],
  amazonLiveApiCalls: false,
  cloudflareWrites: false,
  d1RemoteWrites: false,
}));
