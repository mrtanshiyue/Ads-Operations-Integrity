import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const uiRelative = 'assets/cloudflare-native-csv-provenance-audit-v1.js';
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const exportTag = '<script type="module" src="assets/cloudflare-native-csv-analysis-export-v1.js?v=1.0.0"></script>';
const auditTag = '<script type="module" src="assets/cloudflare-native-csv-provenance-audit-v1.js?v=1.0.0"></script>';
const reviewTag = '<script type="module" src="assets/cloudflare-native-csv-library-review-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(auditTag).length - 1, 1, 'Provenance audit UI must be injected exactly once');
assert.ok(indexSource.indexOf(exportTag) < indexSource.indexOf(auditTag), 'Provenance audit UI must load after analysis export UI');
assert.ok(indexSource.indexOf(auditTag) < indexSource.indexOf(reviewTag), 'Provenance audit UI must load before local library review');
assert.match(uiSource, /Provenance \/ Audit Drilldown/);
assert.match(uiSource, /Input-set fingerprint/);
assert.match(uiSource, /Import receipts/);
assert.match(uiSource, /Overlap diagnostics/);
assert.match(uiSource, /Gap diagnostics/);
assert.match(uiSource, /Observed CSV evidence is not canonical Amazon identity/);
assert.match(uiSource, /local_csv_provenance_audit_only/);
assert.match(uiSource, /CSV_PROVENANCE_AUDIT_AUTHORITY_ESCALATION_BLOCKED/);
assert.match(uiSource, /No Amazon request, D1\/R2 write, governance persistence, or execution permit/);

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
]) assert.equal(pattern.test(uiSource), false, `Provenance audit UI must not use remote/storage/execution transport: ${pattern}`);

const mod = await import(`${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`);
assert.equal(mod.CSV_PROVENANCE_AUDIT_SCHEMA_VERSION, 'csv-provenance-audit-v1');
assert.equal(mod.CSV_PROVENANCE_AUDIT_UI_VERSION, '1.0.0');

const result = fixture();
const model = mod.buildCsvProvenanceAuditModel(result);
assert.equal(model.schemaVersion, 'csv-provenance-audit-v1');
assert.equal(model.authority.authoritative, false);
assert.equal(model.authority.canonicalAmazonIdentityResolved, false);
assert.equal(model.authority.governancePersistenceAllowed, false);
assert.equal(model.authority.executionAuthorized, false);
assert.equal(model.authority.amazonMutationAuthorized, false);
assert.equal(model.inputSetFingerprint, result.source.inputSetFingerprint);
assert.equal(model.summary.importCount, 2);
assert.equal(model.summary.factCount, 14);
assert.equal(model.summary.sourceRowCount, 14);
assert.equal(model.summary.qualityState, 'overlap_and_gap_detected');
assert.equal(model.summary.safeForNaiveAggregation, false);
assert.equal(model.summary.contiguousCoverage, false);
assert.equal(model.summary.overlapPairCount, 1);
assert.equal(model.summary.gapCount, 1);
assert.equal(model.summary.gapDayCount, 2);
assert.equal(model.receipts.length, 2);
assert.equal(model.receipts[0].receiptId, `csv-content:${'b'.repeat(64)}`);
assert.equal(model.receipts[0].canonicalAmazonIdentityResolved, false);
assert.equal(model.receipts[0].governancePersistenceAllowed, false);
assert.equal(model.receipts[0].executionAuthorized, false);
assert.equal(model.receipts[0].amazonMutationAuthorized, false);
assert.equal(model.quality.overlapPairs[0].relation, 'partial_overlap');
assert.equal(model.quality.gaps[0].gapDayCount, 2);
assert.equal(model.quality.mergedCoverage.length, 2);

assert.throws(
  () => mod.buildCsvProvenanceAuditModel({ ...result, source: { ...result.source, executionAuthorized: true } }),
  (error) => error?.code === 'CSV_PROVENANCE_AUDIT_AUTHORITY_ESCALATION_BLOCKED',
  'Audit builder must fail closed if execution authority appears',
);
assert.throws(
  () => mod.buildCsvProvenanceAuditModel({ ...result, source: { ...result.source, contentSha256s: ['d'.repeat(64)] } }),
  (error) => error?.code === 'CSV_PROVENANCE_AUDIT_SOURCE_HASH_MISMATCH',
  'Audit builder must reject source/import hash drift',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-provenance-audit-v1',
  provenanceReceipts: true,
  fingerprintTrace: true,
  overlapDiagnostics: true,
  gapDiagnostics: true,
  authorityEscalationBlocked: true,
  remotePersistence: false,
  amazonMutationAuthorized: false,
}, null, 2));

function fixture() {
  const fingerprint = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const hashC = 'c'.repeat(64);
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  return {
    source: {
      kind: 'csv_import_set',
      authority: 'non-authoritative',
      inputSetFingerprint: fingerprint,
      contentSha256s: [hashC, hashB],
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
    range: { startDate: '2026-08-01', endDate: '2026-08-20' },
    summary: { factCount: 14, sourceRowCount: 14 },
    imports: [
      { schemaVersion: 'csv-import-v1', reportType: 'spSearchTerm', sourceFileName: 'week-a.csv', contentSha256: hashB, reportStartDate: '2026-08-01', reportEndDate: '2026-08-07', rowCount: 7, acceptedRows: 7, rejectedRows: 0, advertiserAccountId: 'adv-observed', profileId: 'profile-observed', marketplace: 'US', currencyCode: 'USD' },
      { schemaVersion: 'csv-import-v1', reportType: 'spSearchTerm', sourceFileName: 'week-b.csv', contentSha256: hashC, reportStartDate: '2026-08-05', reportEndDate: '2026-08-11', rowCount: 7, acceptedRows: 7, rejectedRows: 0, advertiserAccountId: 'adv-observed', profileId: 'profile-observed', marketplace: 'US', currencyCode: 'USD' },
    ],
    dataQuality: {
      schemaVersion: 'csv-window-quality-v1',
      authority,
      qualityState: 'overlap_and_gap_detected',
      safeForNaiveAggregation: false,
      contiguousCoverage: false,
      requiresHumanReview: true,
      summary: { overlapPairCount: 1, gapCount: 1, gapDayCount: 2, uniqueCoveredDayCount: 14, overlapExcessDayCount: 3 },
      windows: [
        { sourceFileName: 'week-a.csv', contentSha256: hashB, reportStartDate: '2026-08-01', reportEndDate: '2026-08-07', validDateRange: true, windowDayCount: 7 },
        { sourceFileName: 'week-b.csv', contentSha256: hashC, reportStartDate: '2026-08-05', reportEndDate: '2026-08-11', validDateRange: true, windowDayCount: 7 },
      ],
      overlapPairs: [{ relation: 'partial_overlap', left: { sourceFileName: 'week-a.csv', contentSha256: hashB }, right: { sourceFileName: 'week-b.csv', contentSha256: hashC }, overlapStartDate: '2026-08-05', overlapEndDate: '2026-08-07', overlapDayCount: 3, requiresHumanReview: true }],
      gaps: [{ gapStartDate: '2026-08-12', gapEndDate: '2026-08-13', gapDayCount: 2, previousCoverageEndDate: '2026-08-11', nextCoverageStartDate: '2026-08-14', requiresHumanReview: true }],
      mergedCoverage: [
        { startDate: '2026-08-01', endDate: '2026-08-11', coveredDayCount: 11, sourceContentSha256s: [hashB, hashC] },
        { startDate: '2026-08-14', endDate: '2026-08-16', coveredDayCount: 3, sourceContentSha256s: [hashC] },
      ],
    },
    analysis: { authority },
    hierarchy: { authority },
    periods: { authority },
  };
}
