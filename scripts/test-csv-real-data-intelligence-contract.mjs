import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import('../cloudflare/runtime/csv-productization-api.js');
const api = await readFile(path.join(root, 'cloudflare/runtime/csv-search-term-intelligence-api.js'), 'utf8');
const productization = await readFile(path.join(root, 'cloudflare/runtime/csv-productization-api.js'), 'utf8');
const migration = await readFile(path.join(root, 'cloudflare/foundation/migrations/store/0019_store_advisory_review_workflow.sql'), 'utf8');
const entry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');

assert.match(entry, /handleCsvSearchTermIntelligenceApiRoute/, 'CSV intelligence handler is not wired');
assert.match(entry, /const csvResponse = await handleCsvSearchTermIntelligenceApiRoute/, 'CSV source must branch before the Amazon intelligence handler');
assert.match(entry, /handleCsvProductizationApiRoute/, 'CSV productization layer is not wired');
assert.match(entry, /CSV_ADVISORY_REVIEWS_ROUTE_PATTERN/, 'Advisory review route is not inside the strict modular boundary');
assert.match(api, /url\.searchParams\.get\('source'\) !== 'csv'/, 'CSV intelligence must require explicit source=csv');
assert.match(api, /'analytics\.read'/, 'CSV intelligence must remain store-scoped read-only analytics');
assert.match(api, /FROM csv_search_term_daily/, 'CSV intelligence must read canonical imported facts');
assert.match(api, /csv_import_batches/, 'CSV intelligence must validate import provenance');
assert.match(api, /sourceKind: 'csv_import'/, 'CSV source kind must be explicit');
assert.match(api, /csvProvenanceValid/, 'CSV provenance validity must be surfaced');
assert.match(api, /suppressStale:\s*false/, 'Historical CSV advisory analysis must keep stale evidence without hard-suppressing candidates');
assert.match(api, /confidenceFactor:\s*state === 'fresh' \? 1 : \(state === 'aging' \? 0\.8 : 0\.5\)/, 'Historical CSV freshness must still penalize recommendation confidence');
assert.match(api, /governancePersistenceAllowed: false/, 'CSV recommendations must not be persistable');
assert.match(api, /identityResolutionRequired: true/, 'CSV recommendations must require Amazon identity resolution');
assert.match(api, /authoritative: false/, 'CSV authority must remain non-authoritative');
assert.match(api, /amazonMutationAuthorized: false/, 'CSV intelligence must never authorize Amazon mutation');
assert.doesNotMatch(api, /INSERT\s+INTO\s+optimization_actions|UPDATE\s+optimization_actions|DELETE\s+FROM\s+optimization_actions/i, 'CSV intelligence must not mutate optimization actions');
assert.doesNotMatch(api, /FROM\s+report_jobs|JOIN\s+report_jobs/i, 'CSV intelligence must not masquerade as Amazon report lineage');
assert.doesNotMatch(api, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|execution-permit/i, 'CSV intelligence must not touch Amazon execution controls');

assert.match(productization, /advertiserAccountId/, 'Persisted advertiser account ID must be exposed');
assert.match(productization, /campaignId: row\.campaign_id/, 'Observed CSV campaign ID must be propagated');
assert.match(productization, /adGroupId: row\.ad_group_id/, 'Observed CSV ad-group ID must be propagated');
assert.match(productization, /targetingId: row\.targeting_id/, 'Observed CSV targeting ID must be propagated into evidence');
assert.match(productization, /targetingIdentityState/, 'CSV targeting identity state must be propagated');
assert.match(productization, /identityResolved: false/, 'Observed CSV IDs must not imply canonical Amazon identity resolution');
assert.match(productization, /optimizationActionPersistenceAuthorized: false/, 'Advisory review plane must not persist optimization actions');
assert.match(productization, /executionAuthorized: false/, 'Advisory review plane must remain non-executing');
assert.match(productization, /amazonMutationAuthorized: false/, 'Advisory review plane must never authorize Amazon mutation');
assert.doesNotMatch(productization, /INSERT\s+INTO\s+optimization_actions|UPDATE\s+optimization_actions|DELETE\s+FROM\s+optimization_actions/i, 'Advisory reviews must remain isolated from optimization actions');
assert.doesNotMatch(productization, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED/, 'Productization layer must not activate Amazon sync');

assert.match(migration, /CREATE TABLE advisory_review_records/, 'Advisory review table missing');
assert.match(migration, /state IN \('open','acknowledged','dismissed','snoozed'\)/, 'Advisory state machine is not locked');
assert.match(migration, /source_evidence_sha256/, 'Immutable source evidence hash missing');
assert.match(migration, /ADVISORY_REVIEW_BINDING_IMMUTABLE/, 'Advisory evidence immutability guard missing');
assert.match(migration, /ADVISORY_REVIEW_DELETE_FORBIDDEN/, 'Advisory history delete guard missing');
assert.doesNotMatch(migration, /optimization_actions/i, 'Advisory review storage must be source-neutral and separate from optimization actions');

console.log(JSON.stringify({ ok: true, contract: 'csv-real-data-intelligence-v2-productization' }));
