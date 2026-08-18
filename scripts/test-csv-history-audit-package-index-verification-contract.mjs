import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const newRelative = 'assets/cloudflare-native-csv-history-audit-package-index-verification-v1.js';
const source = await readFile(path.join(distRoot, newRelative), 'utf8');
const indexHtml = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const priorTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-verification-v1.js?v=1.0.0"></script>';
const verifierTag = '<script type="module" src="assets/cloudflare-native-csv-history-audit-package-index-verification-v1.js?v=1.0.0"></script>';
const provenanceTag = '<script type="module" src="assets/cloudflare-native-csv-provenance-audit-v1.js?v=1.0.0"></script>';

assert.equal(indexHtml.split(verifierTag).length - 1, 1, 'Audit package index verification must be injected exactly once');
assert.ok(indexHtml.indexOf(priorTag) < indexHtml.indexOf(verifierTag), 'Index verifier must load after package/index builder');
assert.ok(indexHtml.indexOf(verifierTag) < indexHtml.indexOf(provenanceTag), 'Index verifier must load before provenance audit');
assert.match(source, /csv-history-audit-package-index-verification-v1/);
assert.match(source, /Verify index against ZIP set/);
assert.match(source, /fingerprint and deterministic serialization/);
assert.match(source, /Missing, extra, duplicate, tampered, or non-canonical packages fail closed/);
assert.match(source, /replayedFromExplicitLocalZipSet: true/);
assert.match(source, /selectionOrderIndependent: true/);
assert.match(source, /generatedTimestampIncluded: false/);
assert.match(source, /sourceFileNameIncluded: false/);
assert.match(source, /crossPackageAggregationApplied: false/);
assert.match(source, /sameMonthAggregationApplied: false/);

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
  assert.equal(pattern.test(source), false, `Index verification must remain browser-local and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?indexVerifyEngine=${Date.now()}`);
const history = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-history-ledger-v1.js')).href}?indexVerifyHistory=${Date.now()}`);
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-history-comparison-receipt-v1.js')).href}?indexVerifyReceipt=${Date.now()}`);
const packageMod = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-history-comparison-receipt-verification-v1.js')).href}?indexVerifyPackage=${Date.now()}`);
const verifierMod = await import(`${pathToFileURL(path.join(distRoot, newRelative)).href}?indexVerify=${Date.now()}`);
const exportMod = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-analysis-export-v1.js')).href}?indexVerifyZip=${Date.now()}`);

assert.equal(verifierMod.CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_SCHEMA_VERSION, 'csv-history-audit-package-index-verification-v1');
assert.equal(verifierMod.CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_UI_VERSION, '1.0.0');
assert.equal(typeof verifierMod.parseHistoricalAuditPackageIndex, 'function');
assert.equal(typeof verifierMod.verifyHistoricalAuditPackageIndexAgainstZipSet, 'function');

const allowed = await buildAuditZip({
  left: { hashChar: 'a', month: '2026-04', startDate: '2026-04-01', endDate: '2026-04-30', expectedDayCount: 30, coveredDayCount: 30 },
  right: { hashChar: 'b', month: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31', expectedDayCount: 31, coveredDayCount: 31 },
});
const blocked = await buildAuditZip({
  left: { hashChar: 'c', month: '2026-06', startDate: '2026-06-01', endDate: '2026-06-15', expectedDayCount: 30, coveredDayCount: 15 },
  right: { hashChar: 'd', month: '2026-07', startDate: '2026-07-01', endDate: '2026-07-15', expectedDayCount: 31, coveredDayCount: 15 },
});

assert.equal(allowed.receipt.comparison.comparisonAllowed, true);
assert.equal(blocked.receipt.comparison.comparisonAllowed, false);
assert.equal(blocked.receipt.comparison.rawEvidenceOnly, true);

const index = await packageMod.buildHistoricalAuditPackageIndex([allowed.zip, blocked.zip], exportMod.buildStoredZip);
const indexText = packageMod.serializeHistoricalAuditPackageIndex(index);
const parsed = await verifierMod.parseHistoricalAuditPackageIndex(indexText);
assert.equal(parsed.indexFingerprint, index.indexFingerprint);

const verificationA = await verifierMod.verifyHistoricalAuditPackageIndexAgainstZipSet(indexText, [allowed.zip, blocked.zip], exportMod.buildStoredZip);
const verificationB = await verifierMod.verifyHistoricalAuditPackageIndexAgainstZipSet(indexText, [blocked.zip, allowed.zip], exportMod.buildStoredZip);
for (const verification of [verificationA, verificationB]) {
  assert.equal(verification.schemaVersion, 'csv-history-audit-package-index-verification-v1');
  assert.equal(verification.verificationState, 'audit_package_index_verified_against_local_zip_set');
  assert.equal(verification.indexSchemaVersion, 'csv-history-audit-package-index-v1');
  assert.equal(verification.indexFingerprint, index.indexFingerprint);
  assert.equal(verification.recomputedIndexFingerprint, index.indexFingerprint);
  assert.equal(verification.packageCount, 2);
  assert.deepEqual(verification.packageFingerprints, index.packages.map((item) => item.packageFingerprint));
  assert.equal(verification.indexFingerprintMatch, true);
  assert.equal(verification.indexSerializationMatch, true);
  assert.equal(verification.archiveSetMatch, true);
  assert.equal(verification.replayedFromExplicitLocalZipSet, true);
  assert.equal(verification.selectionOrderIndependent, true);
  assert.equal(verification.generatedTimestampIncluded, false);
  assert.equal(verification.sourceFileNameIncluded, false);
  assert.equal(verification.crossPackageAggregationApplied, false);
  assert.equal(verification.normalizationApplied, false);
  assert.equal(verification.deduplicationApplied, false);
  assert.equal(verification.sameMonthAggregationApplied, false);
  assert.equal(verification.profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');
  assertAuthorityFalse(verification.authority);
  assert.equal(Object.isFrozen(verification), true);
}
assert.deepEqual(verificationA, verificationB, 'ZIP selection order must not affect successful verification evidence');

await assert.rejects(
  () => verifierMod.parseHistoricalAuditPackageIndex(`${indexText} `),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_SERIALIZATION_MISMATCH',
  'Whitespace or byte-level serialization drift must fail standalone index parsing',
);

const fingerprintTamper = JSON.parse(indexText);
fingerprintTamper.indexFingerprint = '9'.repeat(64);
await assert.rejects(
  () => verifierMod.parseHistoricalAuditPackageIndex(serializeSorted(fingerprintTamper)),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_FINGERPRINT_MISMATCH',
  'Tampered index fingerprint must fail before ZIP replay',
);

const authorityTamper = JSON.parse(indexText);
authorityTamper.authority.executionAuthorized = true;
await assert.rejects(
  () => verifierMod.parseHistoricalAuditPackageIndex(serializeSorted(authorityTamper)),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_AUTHORITY_ESCALATION_BLOCKED',
  'Index authority escalation must fail before ZIP replay',
);

const stateTamper = JSON.parse(indexText);
const blockedEntry = stateTamper.packages.find((item) => item.rawEvidenceOnly);
blockedEntry.comparisonAllowed = true;
await assert.rejects(
  () => verifierMod.parseHistoricalAuditPackageIndex(serializeSorted(stateTamper)),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_COMPARISON_STATE_INVALID',
  'Downloaded index must not upgrade blocked/raw-only package state',
);

await assert.rejects(
  () => verifierMod.verifyHistoricalAuditPackageIndexAgainstZipSet(indexText, [allowed.zip], exportMod.buildStoredZip),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_REPLAY_FINGERPRINT_MISMATCH',
  'Missing ZIPs must fail replay fingerprint equality',
);

await assert.rejects(
  () => verifierMod.verifyHistoricalAuditPackageIndexAgainstZipSet(indexText, [allowed.zip, blocked.zip, allowed.zip], exportMod.buildStoredZip),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_DUPLICATE_PACKAGE_FINGERPRINT',
  'Duplicate/extra ZIP inputs must fail instead of being silently ignored',
);

await assert.rejects(
  () => verifierMod.verifyHistoricalAuditPackageIndexAgainstZipSet(indexText, [], exportMod.buildStoredZip),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_ZIPS_REQUIRED',
  'Verification requires explicit local ZIP inputs',
);

const tamperedZip = Uint8Array.from(allowed.zip);
tamperedZip[tamperedZip.length - 3] ^= 0x01;
await assert.rejects(
  () => verifierMod.verifyHistoricalAuditPackageIndexAgainstZipSet(indexText, [tamperedZip, blocked.zip], exportMod.buildStoredZip),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_ZIP_CANONICAL_BYTES_MISMATCH',
  'A non-canonical/tampered ZIP must fail before index comparison',
);

const unrelated = exportMod.buildStoredZip([{ name: 'unrelated.json', text: '{}\n' }]);
await assert.rejects(
  () => verifierMod.verifyHistoricalAuditPackageIndexAgainstZipSet(indexText, [allowed.zip, unrelated], exportMod.buildStoredZip),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_ZIP_REQUIRED_ENTRY_MISSING',
  'Unrelated ZIPs must never satisfy index verification',
);

const changed = await buildAuditZip({
  left: { hashChar: 'e', month: '2026-08', startDate: '2026-08-01', endDate: '2026-08-31', expectedDayCount: 31, coveredDayCount: 31 },
  right: { hashChar: 'f', month: '2026-09', startDate: '2026-09-01', endDate: '2026-09-30', expectedDayCount: 30, coveredDayCount: 30 },
});
await assert.rejects(
  () => verifierMod.verifyHistoricalAuditPackageIndexAgainstZipSet(indexText, [allowed.zip, changed.zip], exportMod.buildStoredZip),
  (error) => error?.code === 'CSV_HISTORY_AUDIT_PACKAGE_INDEX_REPLAY_FINGERPRINT_MISMATCH',
  'A different valid ZIP set must not verify against the downloaded index',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-audit-package-index-verification-v1',
  priorPackageIndexContractReused: true,
  standaloneIndexFingerprintValidated: true,
  standaloneIndexSerializationValidated: true,
  everyZipIndependentlyReplayed: true,
  exactZipSetRequired: true,
  replayFingerprintMatchRequired: true,
  replaySerializationMatchRequired: true,
  selectionOrderIndependent: true,
  missingZipBlocked: true,
  duplicateZipBlocked: true,
  differentValidZipSetBlocked: true,
  tamperedZipBlocked: true,
  unrelatedZipBlocked: true,
  blockedRawEvidenceStateCannotUpgrade: true,
  generatedTimestampIncluded: false,
  sourceFileNameIncluded: false,
  crossPackageAggregationApplied: false,
  normalizationApplied: false,
  deduplicationApplied: false,
  sameMonthAggregationApplied: false,
  profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

async function buildAuditZip({ left, right }) {
  const leftAnalysis = await fixture(left);
  const rightAnalysis = await fixture(right);
  const ledger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(leftAnalysis), rightAnalysis);
  const rows = history.buildHistoricalMonthlyWorkspace(ledger).rows;
  const receipt = await receiptMod.buildHistoricalComparisonReceipt(ledger, select(rows[0]), select(rows[1]));
  const audit = await packageMod.buildHistoricalAuditPackage(ledger, receipt);
  const zipFiles = await packageMod.buildHistoricalAuditPackageZipFiles(audit);
  return { ledger, receipt, audit, zip: exportMod.buildStoredZip(zipFiles) };
}

function select(row) {
  return {
    ledgerFingerprint: row.ledgerFingerprint,
    sourceInputSetFingerprint: row.sourceInputSetFingerprint,
    month: row.month,
  };
}

function assertAuthorityFalse(authority) {
  assert.equal(authority.authoritative, false);
  assert.equal(authority.canonicalAmazonIdentityResolved, false);
  assert.equal(authority.governancePersistenceAllowed, false);
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.amazonMutationAuthorized, false);
}

function serializeSorted(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
  return out;
}

async function fixture({
  hashChar,
  month,
  startDate,
  endDate,
  expectedDayCount,
  coveredDayCount,
  metrics = { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
}) {
  const contentSha256 = hashChar.repeat(64);
  const sourceReceipt = {
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
    schemaVersion: sourceReceipt.schemaVersion,
    reportType: sourceReceipt.reportType,
    contentSha256: sourceReceipt.contentSha256,
    reportStartDate: sourceReceipt.reportStartDate,
    reportEndDate: sourceReceipt.reportEndDate,
    rowCount: sourceReceipt.rowCount,
  }];
  const inputSetFingerprint = await sha256Hex(canonicalJson(fingerprintPayload));
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  const complete = coveredDayCount === expectedDayCount;
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: {
      kind: 'csv_import_set', batchCount: 1, contentSha256s: [contentSha256], inputSetFingerprint,
      canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false,
    },
    range: { startDate, endDate },
    imports: [sourceReceipt],
    dataQuality: {
      authority, qualityState: 'single_window', safeForNaiveAggregation: true, contiguousCoverage: true,
      summary: { overlapPairCount: 0, gapCount: 0 },
    },
    observedIdentity: { authority, summary: { identityCount: 3, ambiguousIdentityCount: 0, canonicalAmazonIdentityResolved: false } },
    hierarchy: { authority, summary: { campaignCount: 1, adGroupCount: 1, targetingCount: 2, ambiguousTargetingCount: 0 } },
    periods: {
      authority,
      summary: { monthlySnapshotCount: 1, aggregationSafe: true, canonicalAmazonIdentityResolved: false, executionAuthorized: false, amazonMutationAuthorized: false },
      monthlySnapshots: [{
        periodRole: 'calendar_month', month, startDate, endDate, expectedDayCount, coveredDayCount, factCount: 10,
        metrics,
        adContributionMicros: metrics.salesMicros - metrics.spendMicros,
        profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
        coverage: { expectedDayCount, coveredDayCount, coverageRatio: coveredDayCount / expectedDayCount, complete },
        reliability: { state: complete ? 'complete_coverage' : 'incomplete_coverage', aggregationSafe: true, coverageComplete: complete, analyticalDecisionUse: complete ? 'observed_review_only' : 'review_with_partial_coverage' },
        requiresHumanReview: true, persistenceAuthorized: false, executionAuthorized: false, amazonMutationAuthorized: false,
      }],
    },
    analysis: { authority },
  };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
