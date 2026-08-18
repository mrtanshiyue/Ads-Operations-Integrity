import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const engineRelative = 'assets/csv-analysis-engine/csv-history-ledger.js';
const uiRelative = 'assets/cloudflare-native-csv-history-ledger-v1.js';
const engineSource = await readFile(path.join(distRoot, engineRelative), 'utf8');
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const monthlyTag = '<script type="module" src="assets/cloudflare-native-csv-monthly-workspace-v1.js?v=1.0.0"></script>';
const historyTag = '<script type="module" src="assets/cloudflare-native-csv-history-ledger-v1.js?v=1.1.0"></script>';
const provenanceTag = '<script type="module" src="assets/cloudflare-native-csv-provenance-audit-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(historyTag).length - 1, 1, 'History ledger UI must be injected exactly once');
assert.ok(indexSource.indexOf(monthlyTag) < indexSource.indexOf(historyTag), 'History ledger must load after monthly workspace');
assert.ok(indexSource.indexOf(historyTag) < indexSource.indexOf(provenanceTag), 'History ledger must load before provenance audit');
assert.match(uiSource, /Historical Local-Data Ledger/);
assert.match(uiSource, /Explicit local-file ownership/);
assert.match(uiSource, /Overlap or gaps are recorded, never silently normalized/);
assert.match(uiSource, /Download updated ledger/);
assert.match(uiSource, /Historical Monthly Workspace/);
assert.match(uiSource, /Same-month evidence from multiple snapshots is displayed separately, never cross-snapshot aggregated/);
assert.match(uiSource, /Ad Contribution = Sales - Ad Spend only; it is not Net Profit/);
assert.match(uiSource, /crossSnapshotAggregationApplied: false/);
assert.match(engineSource, /CSV_HISTORY_DUPLICATE_INPUT_SET_FINGERPRINT/);
assert.match(engineSource, /CSV_HISTORY_DUPLICATE_CONTENT_HASH/);
assert.match(engineSource, /CSV_HISTORY_SOURCE_RECEIPT_MISMATCH/);
assert.match(engineSource, /CSV_HISTORY_BATCH_COUNT_MISMATCH/);
assert.match(engineSource, /CSV_HISTORY_AUTHORITY_ESCALATION_BLOCKED/);
assert.match(engineSource, /CSV_HISTORY_SOURCE_KIND_INVALID/);
assert.match(engineSource, /normalizationApplied: false/);
assert.match(engineSource, /businessRowDeduplicationApplied: false/);

for (const pattern of [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /CloudflareNativeAPI/,
  /\/api\/v1\//,
  /CONTROL_DB/,
  /STORE_01_DB/,
  /DATA_BUCKET/,
  /AMAZON_ADS_ENABLED/,
  /optimization-actions/,
  /execution-permits/,
]) {
  assert.equal(pattern.test(`${engineSource}\n${uiSource}`), false, `History ledger must remain transport/storage/execution free: ${pattern}`);
}

const mod = await import(`${pathToFileURL(path.join(distRoot, engineRelative)).href}?contract=${Date.now()}`);
const uiMod = await import(`${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`);
assert.equal(mod.CSV_HISTORY_LEDGER_SCHEMA_VERSION, 'csv-history-ledger-v1');
assert.equal(mod.CSV_HISTORY_SNAPSHOT_SCHEMA_VERSION, 'csv-history-snapshot-v1');
assert.equal(uiMod.CSV_HISTORY_LEDGER_UI_VERSION, '1.1.0');
assert.equal(uiMod.CSV_HISTORY_MONTHLY_WORKSPACE_SCHEMA_VERSION, 'csv-history-monthly-workspace-v1');
assert.equal(typeof uiMod.buildHistoricalMonthlyWorkspace, 'function');

const august = await fixture({ hashChar: 'b', startDate: '2026-08-01', endDate: '2026-08-14', month: '2026-08' });
const september = await fixture({ hashChar: 'c', startDate: '2026-09-01', endDate: '2026-09-30', month: '2026-09' });
const snapshot = await mod.buildCsvHistorySnapshot(august);
assert.equal(snapshot.sourceKind, 'csv_import_set');
assert.equal(snapshot.createdFromLocalEvidenceOnly, true);
assert.equal(snapshot.safeForNaiveAggregation, true);
assert.equal(snapshot.contiguousCoverage, true);
assert.equal(snapshot.authority.authoritative, false);
assert.equal(snapshot.authority.canonicalAmazonIdentityResolved, false);
assert.equal(snapshot.authority.governancePersistenceAllowed, false);
assert.equal(snapshot.authority.executionAuthorized, false);
assert.equal(snapshot.authority.amazonMutationAuthorized, false);
assert.equal(snapshot.monthlySnapshots[0].profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.equal(snapshot.monthlySnapshots[0].adContributionMicros, 6000000);

const one = await mod.createCsvHistoryLedger(august);
assert.equal(one.snapshots.length, 1);
assert.match(one.ledgerFingerprint, /^[a-f0-9]{64}$/);
assert.equal(one.historyWindowEvidence.normalizationApplied, false);
assert.equal(one.historyWindowEvidence.businessRowDeduplicationApplied, false);
const oneSerialized = mod.serializeCsvHistoryLedger(one);
assert.equal(mod.serializeCsvHistoryLedger(one), oneSerialized, 'Ledger serialization must be deterministic');
assert.deepEqual(await mod.parseCsvHistoryLedger(oneSerialized), one, 'Serialized ledger must round-trip through full validation');

const two = await mod.mergeCsvHistoryLedger(one, september);
assert.equal(two.snapshots.length, 2);
assert.deepEqual(two.snapshots.map((item) => item.reportStartDate), ['2026-08-01', '2026-09-01']);
assert.equal(two.historyWindowEvidence.overlapPairCount, 0);
assert.equal(two.historyWindowEvidence.gapCount, 1, 'Historical gap must be preserved as evidence');
assert.notEqual(two.ledgerFingerprint, one.ledgerFingerprint);

const monthlyWorkspace = uiMod.buildHistoricalMonthlyWorkspace(two);
assert.equal(monthlyWorkspace.schemaVersion, 'csv-history-monthly-workspace-v1');
assert.equal(monthlyWorkspace.rowCount, 2);
assert.equal(monthlyWorkspace.distinctMonthCount, 2);
assert.equal(monthlyWorkspace.multiEvidenceMonthCount, 0);
assert.equal(monthlyWorkspace.crossSnapshotAggregationApplied, false);
assert.equal(monthlyWorkspace.normalizationApplied, false);
assert.equal(monthlyWorkspace.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
assert.deepEqual(monthlyWorkspace.rows.map((item) => item.month), ['2026-08', '2026-09']);
assert.deepEqual(monthlyWorkspace.rows.map((item) => item.sourceInputSetFingerprint), two.snapshots.map((item) => item.inputSetFingerprint));
assert.ok(monthlyWorkspace.rows.every((item) => item.adContributionMicros === item.salesMicros - item.spendMicros));
assert.ok(monthlyWorkspace.rows.every((item) => item.profitabilityBasis === 'sales_minus_ad_spend_only_not_net_profit'));
assert.ok(monthlyWorkspace.rows.every((item) => item.decisionState === 'partial_coverage_review'));
assert.equal(monthlyWorkspace.authority.authoritative, false);
assert.equal(monthlyWorkspace.authority.canonicalAmazonIdentityResolved, false);
assert.equal(monthlyWorkspace.authority.governancePersistenceAllowed, false);
assert.equal(monthlyWorkspace.authority.executionAuthorized, false);
assert.equal(monthlyWorkspace.authority.amazonMutationAuthorized, false);

const overlapping = await fixture({ hashChar: 'd', startDate: '2026-08-10', endDate: '2026-08-20', month: '2026-08' });
const withOverlap = await mod.mergeCsvHistoryLedger(one, overlapping);
assert.equal(withOverlap.historyWindowEvidence.overlapPairCount, 1);
assert.equal(withOverlap.historyWindowEvidence.overlapDetected, true);
assert.equal(withOverlap.historyWindowEvidence.normalizationApplied, false);
assert.equal(withOverlap.snapshots.length, 2, 'Overlapping snapshots must remain separate evidence records');
const sameMonthWorkspace = uiMod.buildHistoricalMonthlyWorkspace(withOverlap);
assert.equal(sameMonthWorkspace.rowCount, 2);
assert.equal(sameMonthWorkspace.distinctMonthCount, 1);
assert.equal(sameMonthWorkspace.multiEvidenceMonthCount, 1);
assert.equal(sameMonthWorkspace.crossSnapshotAggregationApplied, false);
assert.ok(sameMonthWorkspace.rows.every((item) => item.sameMonthEvidenceCount === 2));
assert.ok(sameMonthWorkspace.rows.every((item) => item.sameMonthMultipleSnapshots === true));
assert.ok(sameMonthWorkspace.rows.every((item) => item.crossSnapshotAggregationApplied === false));
assert.notEqual(sameMonthWorkspace.rows[0].sourceInputSetFingerprint, sameMonthWorkspace.rows[1].sourceInputSetFingerprint);

await assert.rejects(
  () => mod.mergeCsvHistoryLedger(one, august),
  (error) => error?.code === 'CSV_HISTORY_DUPLICATE_INPUT_SET_FINGERPRINT',
  'Duplicate input-set fingerprints must fail closed',
);

const duplicateHashDifferentWindow = await fixture({ hashChar: 'b', startDate: '2026-08-15', endDate: '2026-08-31', month: '2026-08' });
await assert.rejects(
  () => mod.mergeCsvHistoryLedger(one, duplicateHashDifferentWindow),
  (error) => error?.code === 'CSV_HISTORY_DUPLICATE_CONTENT_HASH',
  'Duplicate source SHA-256 across snapshots must fail closed',
);

await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, kind: 'amazon_api' } }),
  (error) => error?.code === 'CSV_HISTORY_SOURCE_KIND_INVALID',
);
await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, batchCount: 2 } }),
  (error) => error?.code === 'CSV_HISTORY_BATCH_COUNT_MISMATCH',
);
await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, contentSha256s: ['e'.repeat(64)] } }),
  (error) => error?.code === 'CSV_HISTORY_SOURCE_RECEIPT_MISMATCH',
);
await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, executionAuthorized: true } }),
  (error) => error?.code === 'CSV_HISTORY_AUTHORITY_ESCALATION_BLOCKED',
);
await assert.rejects(
  () => mod.buildCsvHistorySnapshot({ ...august, source: { ...august.source, inputSetFingerprint: 'x'.repeat(64) } }),
  (error) => error?.code === 'CSV_HISTORY_INPUT_SET_FINGERPRINT_INVALID',
);

const tampered = JSON.parse(oneSerialized);
tampered.ledgerFingerprint = 'f'.repeat(64);
await assert.rejects(
  () => mod.validateCsvHistoryLedger(tampered),
  (error) => error?.code === 'CSV_HISTORY_LEDGER_FINGERPRINT_MISMATCH',
  'Imported ledger fingerprint drift must fail closed',
);
const escalated = JSON.parse(oneSerialized);
escalated.authority.executionAuthorized = true;
await assert.rejects(
  () => mod.validateCsvHistoryLedger(escalated),
  (error) => error?.code === 'CSV_HISTORY_AUTHORITY_ESCALATION_BLOCKED',
  'Imported authority escalation must fail closed',
);

const contributionMismatch = JSON.parse(mod.serializeCsvHistoryLedger(one));
contributionMismatch.snapshots[0].monthlySnapshots[0].adContributionMicros += 1;
assert.throws(
  () => uiMod.buildHistoricalMonthlyWorkspace(contributionMismatch),
  (error) => error?.code === 'CSV_HISTORY_MONTHLY_CONTRIBUTION_MISMATCH',
  'Monthly workspace must reject Ad Contribution drift',
);
const monthlyEscalation = JSON.parse(mod.serializeCsvHistoryLedger(one));
monthlyEscalation.authority.executionAuthorized = true;
assert.throws(
  () => uiMod.buildHistoricalMonthlyWorkspace(monthlyEscalation),
  (error) => error?.code === 'CSV_HISTORY_MONTHLY_AUTHORITY_ESCALATION_BLOCKED',
  'Monthly workspace must reject authority escalation',
);
const invalidMonthlySource = JSON.parse(mod.serializeCsvHistoryLedger(one));
invalidMonthlySource.snapshots[0].inputSetFingerprint = 'x'.repeat(64);
assert.throws(
  () => uiMod.buildHistoricalMonthlyWorkspace(invalidMonthlySource),
  (error) => error?.code === 'CSV_HISTORY_MONTHLY_SOURCE_FINGERPRINT_INVALID',
  'Monthly workspace must keep every row bound to a valid input-set fingerprint',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-ledger-v1',
  deterministicLedgerFingerprint: true,
  explicitLocalFileOwnership: true,
  duplicateInputSetBlocked: true,
  duplicateSourceHashBlocked: true,
  sourceReceiptHashSetVerified: true,
  batchCountVerified: true,
  overlapPreservedAsEvidence: true,
  gapPreservedAsEvidence: true,
  historicalMonthlyWorkspace: true,
  sameMonthEvidenceSeparated: true,
  crossSnapshotAggregationApplied: false,
  adContributionBasisVerified: true,
  normalizationApplied: false,
  businessRowDeduplicationApplied: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

async function fixture({ hashChar, startDate, endDate, month }) {
  const contentSha256 = hashChar.repeat(64);
  const receipt = {
    schemaVersion: 'csv-import-v1',
    reportType: 'spSearchTerm',
    sourceFileName: `${month}.csv`,
    contentSha256,
    reportStartDate: startDate,
    reportEndDate: endDate,
    rowCount: 10,
    acceptedRows: 10,
    rejectedRows: 0,
    advertiserAccountId: null,
    profileId: null,
    marketplace: 'US',
    currencyCode: 'USD',
  };
  const fingerprintPayload = [{
    schemaVersion: receipt.schemaVersion,
    reportType: receipt.reportType,
    contentSha256: receipt.contentSha256,
    reportStartDate: receipt.reportStartDate,
    reportEndDate: receipt.reportEndDate,
    rowCount: receipt.rowCount,
  }];
  const inputSetFingerprint = await sha256Hex(canonicalJson(fingerprintPayload));
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: {
      kind: 'csv_import_set',
      batchCount: 1,
      contentSha256s: [contentSha256],
      inputSetFingerprint,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
    range: { startDate, endDate },
    imports: [receipt],
    dataQuality: {
      authority,
      qualityState: 'single_window',
      safeForNaiveAggregation: true,
      contiguousCoverage: true,
      summary: { overlapPairCount: 0, gapCount: 0 },
    },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount: 0, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: {
      authority,
      summary: { monthlySnapshotCount: 1, aggregationSafe: true, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false },
      monthlySnapshots: [{
        periodRole: 'calendar_month', month, startDate, endDate,
        expectedDayCount: 31, coveredDayCount: 14, factCount: 10,
        metrics: { spendMicros: 4000000, salesMicros: 10000000, orders: 3, acos: 0.4, roas: 2.5 },
        adContributionMicros: 6000000,
        profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
        coverage: { expectedDayCount: 31, coveredDayCount: 14, coverageRatio: 0.4516, complete: false },
        reliability: { state: 'incomplete_coverage', aggregationSafe: true, coverageComplete: false, analyticalDecisionUse: 'review_with_partial_coverage' },
        requiresHumanReview: true,
        persistenceAuthorized: false,
        executionAuthorized: false,
        amazonMutationAuthorized: false,
      }],
    },
    analysis: { authority },
  };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
