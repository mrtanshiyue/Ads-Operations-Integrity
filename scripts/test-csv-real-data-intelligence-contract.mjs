import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import('../cloudflare/runtime/csv-productization-api.js');
const api = await readFile(path.join(root, 'cloudflare/runtime/csv-search-term-intelligence-api.js'), 'utf8');
const productization = await readFile(path.join(root, 'cloudflare/runtime/csv-productization-api.js'), 'utf8');
const advisoryMigration = await readFile(path.join(root, 'cloudflare/foundation/migrations/store/0019_store_advisory_review_workflow.sql'), 'utf8');
const authorityMigration = await readFile(path.join(root, 'cloudflare/foundation/migrations/store/0022_store_csv_import_authority.sql'), 'utf8');
const entry = await readFile(path.join(root, 'cloudflare/runtime/web-entry.js'), 'utf8');

assert.match(entry, /handleCsvSearchTermIntelligenceApiRoute/, 'CSV intelligence handler is not wired');
assert.match(entry, /const csvResponse = await handleCsvSearchTermIntelligenceApiRoute/, 'CSV source must branch before the Amazon intelligence handler');
assert.match(entry, /handleCsvProductizationApiRoute/, 'CSV productization layer is not wired');
assert.match(entry, /CSV_ADVISORY_REVIEWS_ROUTE_PATTERN/, 'Advisory review route is not inside the strict modular boundary');
assert.match(api, /url\.searchParams\.get\('source'\) !== 'csv'/, 'CSV intelligence must require explicit source=csv');
assert.match(api, /'analytics\.read'/, 'CSV intelligence must remain store-scoped read-only analytics');
assert.match(api, /FROM csv_search_term_daily/, 'CSV intelligence must read canonical imported facts');
assert.match(api, /JOIN csv_import_authority a ON a\.import_id=f\.source_import_id AND a\.data_class='business'/, 'Business analytics must fail closed on import data classification');
assert.match(api, /a\.provenance_class NOT IN \('exact_source_object','reconciled_exact_source'\)/, 'Recommendation candidates must require governed provenance');
assert.match(api, /csv_import_batches/, 'CSV intelligence must validate import provenance');
assert.match(api, /sourceKind: 'csv_import'/, 'CSV source kind must be explicit');
assert.match(api, /dataClass: 'business'/, 'CSV business data class must be surfaced');
assert.match(api, /provenanceClasses/, 'CSV provenance classes must be surfaced');
assert.match(api, /csvProvenanceValid/, 'CSV provenance validity must be surfaced');
assert.match(api, /csv_import_authority_not_governed/, 'Ungoverned CSV recommendation suppression must be explicit');
assert.match(api, /suppressStale:\s*false/, 'Historical CSV advisory analysis must keep stale evidence without hard-suppressing candidates');
assert.match(api, /confidenceFactor:\s*state === 'fresh' \? 1 : \(state === 'aging' \? 0\.8 : 0\.5\)/, 'Historical CSV freshness must still penalize recommendation confidence');
assert.match(api, /governancePersistenceAllowed: false/, 'CSV recommendations must not be persistable as optimization actions');
assert.match(api, /identityResolutionRequired: true/, 'CSV recommendations must require Amazon identity resolution');
assert.match(api, /authoritative: false/, 'CSV authority must remain non-authoritative for Amazon mutation');
assert.match(api, /amazonMutationAuthorized: false/, 'CSV intelligence must never authorize Amazon mutation');
assert.doesNotMatch(api, /INSERT\s+INTO\s+optimization_actions|UPDATE\s+optimization_actions|DELETE\s+FROM\s+optimization_actions/i, 'CSV intelligence must not mutate optimization actions');
assert.doesNotMatch(api, /FROM\s+report_jobs|JOIN\s+report_jobs/i, 'CSV intelligence must not masquerade as Amazon report lineage');
assert.doesNotMatch(api, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|execution-permit/i, 'CSV intelligence must not touch Amazon execution controls');

assert.match(productization, /request\.method\.toUpperCase\(\) === 'PATCH'/, 'Explicit import authority mutation route missing');
assert.match(productization, /initial_import_authority_requires_both_classes/, 'Legacy imports must require explicit initial classification and provenance');
assert.match(productization, /csv_import\.authority_changed/, 'Import authority mutation audit event missing');
assert.match(productization, /importAuthority: publicImportAuthority/, 'Import list/detail must surface classification/provenance authority');
assert.match(productization, /advisory_import_authority_not_governed/, 'Direct advisory review path must reject ungoverned imports');
assert.match(productization, /GOVERNED_PROVENANCE/, 'Application review gate must share exact/reconciled provenance policy');
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

assert.match(advisoryMigration, /CREATE TABLE advisory_review_records/, 'Advisory review table missing');
assert.match(advisoryMigration, /state IN \('open','acknowledged','dismissed','snoozed'\)/, 'Advisory state machine is not locked');
assert.match(advisoryMigration, /source_evidence_sha256/, 'Immutable source evidence hash missing');
assert.match(advisoryMigration, /ADVISORY_REVIEW_BINDING_IMMUTABLE/, 'Advisory evidence immutability guard missing');
assert.match(advisoryMigration, /ADVISORY_REVIEW_DELETE_FORBIDDEN/, 'Advisory history delete guard missing');
assert.doesNotMatch(advisoryMigration, /optimization_actions/i, 'Advisory review storage must be source-neutral and separate from optimization actions');

assert.match(authorityMigration, /CREATE TABLE csv_import_authority /, 'Current CSV import authority table missing');
assert.match(authorityMigration, /CREATE TABLE csv_import_authority_events /, 'Append-only CSV import authority audit table missing');
assert.match(authorityMigration, /data_class IN \('unclassified','business','acceptance'\)/, 'Data classification enum missing');
assert.match(authorityMigration, /provenance_class IN \('legacy_batch_only','exact_source_object','reconciled_exact_source'\)/, 'Provenance classification enum missing');
assert.match(authorityMigration, /CSV_IMPORT_PROVENANCE_TRANSITION_INVALID/, 'Monotonic provenance transition guard missing');
assert.match(authorityMigration, /CSV_IMPORT_AUTHORITY_EVENT_IMMUTABLE/, 'Authority event append-only guard missing');
assert.match(authorityMigration, /CREATE VIEW csv_business_search_term_daily/, 'Business analytics authority view missing');
assert.match(authorityMigration, /CREATE VIEW csv_governed_search_term_daily/, 'Governed recommendation/review authority view missing');
assert.match(authorityMigration, /CSV_ADVISORY_REVIEW_AUTHORITY_REQUIRED/, 'Database-level direct review gate missing');
assert.match(authorityMigration, /json_type\(NEW\.source_evidence_json, '\$\.sourceImportIds'\) IS NOT 'array'/, 'Missing review import evidence must fail closed');
assert.doesNotMatch(authorityMigration, /202606|csv-import-0a2cb4a8|csv-import-00be434e/, 'Migration must not hard-code environment-specific imports');

// These contracts are intentionally imported here (not merely syntax-checked by the workflow),
// so the required CSV intelligence gate executes the built UI semantics on every canonical CI run.
await import('./test-csv-imports-ui-contract.mjs');
await import('./test-csv-real-data-intelligence-ui-contract.mjs');
await import('./test-csv-analytics-foundation.mjs');
await import('./test-csv-analytics-dashboard.mjs');
await import('./test-csv-analytics-quality.mjs');

console.log(JSON.stringify({ ok: true, contract: 'csv-real-data-intelligence-v7-with-analytics-quality' }));
