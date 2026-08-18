import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = await readFile(path.join(root, 'cloudflare/runtime/csv-search-term-intelligence-api.js'), 'utf8');
const entry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');

assert.match(entry, /handleCsvSearchTermIntelligenceApiRoute/, 'CSV intelligence handler is not wired');
assert.match(entry, /const csvResponse = await handleCsvSearchTermIntelligenceApiRoute/, 'CSV source must branch before the Amazon intelligence handler');
assert.match(api, /url\.searchParams\.get\('source'\) !== 'csv'/, 'CSV intelligence must require explicit source=csv');
assert.match(api, /'analytics\.read'/, 'CSV intelligence must remain store-scoped read-only analytics');
assert.match(api, /FROM csv_search_term_daily/, 'CSV intelligence must read canonical imported facts');
assert.match(api, /csv_import_batches/, 'CSV intelligence must validate import provenance');
assert.match(api, /sourceKind: 'csv_import'/, 'CSV source kind must be explicit');
assert.match(api, /csvProvenanceValid/, 'CSV provenance validity must be surfaced');
assert.match(api, /governancePersistenceAllowed: false/, 'CSV recommendations must not be persistable');
assert.match(api, /identityResolutionRequired: true/, 'CSV recommendations must require Amazon identity resolution');
assert.match(api, /authoritative: false/, 'CSV authority must remain non-authoritative');
assert.match(api, /amazonMutationAuthorized: false/, 'CSV intelligence must never authorize Amazon mutation');
assert.doesNotMatch(api, /INSERT\s+INTO\s+optimization_actions|UPDATE\s+optimization_actions|DELETE\s+FROM\s+optimization_actions/i, 'CSV intelligence must not mutate optimization actions');
assert.doesNotMatch(api, /FROM\s+report_jobs|JOIN\s+report_jobs/i, 'CSV intelligence must not masquerade as Amazon report lineage');
assert.doesNotMatch(api, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|execution-permit/i, 'CSV intelligence must not touch Amazon execution controls');

console.log(JSON.stringify({ ok: true, contract: 'csv-real-data-intelligence-v1' }));
