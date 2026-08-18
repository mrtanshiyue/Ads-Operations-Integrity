import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const uiRelative = 'assets/cloudflare-native-csv-provenance-audit-v1.js';
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const periodTag = '<script type="module" src="assets/cloudflare-native-csv-period-ui-v1.js?v=1.0.0"></script>';
const provenanceTag = '<script type="module" src="assets/cloudflare-native-csv-provenance-audit-v1.js?v=1.0.0"></script>';
const exportTag = '<script type="module" src="assets/cloudflare-native-csv-analysis-export-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(provenanceTag).length - 1, 1, 'Provenance audit UI must be injected exactly once');
assert.ok(indexSource.indexOf(periodTag) < indexSource.indexOf(provenanceTag), 'Provenance audit UI must load after period UI');
assert.ok(indexSource.indexOf(provenanceTag) < indexSource.indexOf(exportTag), 'Provenance audit UI must load before analysis export UI');
assert.match(uiSource, /Provenance & Audit Drilldown/);
assert.match(uiSource, /Observed CSV provenance is not canonical Amazon identity/i);
assert.match(uiSource, /does not authorize persistence, execution, or Amazon mutation/i);
assert.match(uiSource, /browser-local evidence/);
assert.match(uiSource, /Input-set fingerprint/);
assert.match(uiSource, /Source receipts/);
assert.match(uiSource, /Overlap evidence/);
assert.match(uiSource, /Gap evidence/);
assert.match(uiSource, /Merged coverage/);
assert.match(uiSource, /Full local audit JSON/);
assert.match(uiSource, /local_operator_audit_only/);
assert.match(uiSource, /CSV_PROVENANCE_AUDIT_AUTHORITY_ESCALATION_BLOCKED/);
assert.match(uiSource, /CSV_PROVENANCE_AUDIT_CONTENT_HASH_INVALID/);

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
const audit = mod.buildCsvProvenanceAudit(result);
assert.equal(audit.schemaVersion, 'csv-provenance-audit-v1');
assert.equal(audit.authority.authoritative, false);
assert.equal(audit.authority.canonicalAmazonIdentityResolved, false);
assert.equal(audit.authority.governancePersistenceAllowed, false);
assert.equal(audit.authority.executionAuthorized, false);
assert.equal(audit.authority.amazonMutationAuthorized, false);
assert.equal(audit.source.inputSetFingerprint, result.source.inputSetFingerprint);
assert.deepEqual(audit.source.contentSha256s, result.source.contentSha256s);
assert.equal(audit.receipts.length, 2);
assert.equal(audit.receipts[0].sourceFileName, 'week-1.csv');
assert.equal(audit.receipts[0].contentSha256, 'b'.repeat(64));
assert.equal(audit.receipts[0].rowCount, 20);
assert.equal(audit.dataQuality.qualityState, 'gap_detected');
assert.equal(audit.dataQuality.safeForNaiveAggregation, true);
assert.equal(audit.dataQuality.contiguousCoverage, false);
assert.equal(audit.dataQuality.gaps.length, 1);
assert.equal(audit.observedIdentity.state, 'csv_observed_only_not_canonical_amazon_identity');
assert.equal(audit.observedIdentity.summary.identityCount, 3);

assert.throws(
  () => mod.buildCsvProvenanceAudit({ ...result, source: { ...result.source, canonicalAmazonIdentityResolved: true } }),
  (error) => error?.code === 'CSV_PROVENANCE_AUDIT_AUTHORITY_ESCALATION_BLOCKED',
  'Audit builder must fail closed if canonical identity authority appears',
);
assert.throws(
  () => mod.buildCsvProvenanceAudit({ ...result, imports: [{ ...result.imports[0], contentSha256: 'invalid' }] }),
  (error) => error?.code === 'CSV_PROVENANCE_AUDIT_CONTENT_HASH_INVALID',
  'Audit builder must reject invalid source receipt hashes',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-provenance-audit-v1',
  sourceReceipts: true,
  fingerprintEvidence: true,
  overlapAndGapEvidence: true,
  observedIdentityNonCanonical: true,
  authorityEscalationBlocked: true,
  remotePersistence: false,
  amazonMutationAuthorized: false,
}, null, 2));

function fixture() {
  const fingerprint = 'a'.repeat(64);
  const firstHash = 'b'.repeat(64);
  const secondHash = 'c'.repeat(64);
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  return {
    source: {
      kind: 'csv_import_set',
      authority: 'non-authoritative',
      batchCount: 2,
      contentSha256s: [firstHash, secondHash],
      inputSetFingerprint: fingerprint,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
    range: { startDate: '2026-08-01', endDate: '2026-08-14' },
    imports: [
      { schemaVersion: 'csv-import-v1', reportType: 'spSearchTerm', sourceFileName: 'week-1.csv', contentSha256: firstHash, reportStartDate: '2026-08-01', reportEndDate: '2026-08-05', rowCount: 20, acceptedRows: 20, rejectedRows: 0, advertiserAccountId: 'observed-account', profileId: 'observed-profile', marketplace: 'US', currencyCode: 'USD' },
      { schemaVersion: 'csv-import-v1', reportType: 'spSearchTerm', sourceFileName: 'week-2.csv', contentSha256: secondHash, reportStartDate: '2026-08-08', reportEndDate: '2026-08-14', rowCount: 30, acceptedRows: 30, rejectedRows: 0, advertiserAccountId: 'observed-account', profileId: 'observed-profile', marketplace: 'US', currencyCode: 'USD' },
    ],
    dataQuality: {
      schemaVersion: 'csv-window-quality-v1', authority,
      qualityState: 'gap_detected', safeForNaiveAggregation: true, contiguousCoverage: false, requiresHumanReview: true,
      summary: { importCount: 2, validWindowCount: 2, invalidWindowCount: 0, overlapPairCount: 0, exactDuplicateWindowCount: 0, gapCount: 1, gapDayCount: 2 },
      windows: [], overlapPairs: [],
      gaps: [{ gapStartDate: '2026-08-06', gapEndDate: '2026-08-07', gapDayCount: 2, requiresHumanReview: true }],
      mergedCoverage: [
        { startDate: '2026-08-01', endDate: '2026-08-05', coveredDayCount: 5, sourceContentSha256s: [firstHash] },
        { startDate: '2026-08-08', endDate: '2026-08-14', coveredDayCount: 7, sourceContentSha256s: [secondHash] },
      ],
    },
    observedIdentity: { summary: { identityCount: 3, resolvedIdCount: 2, ambiguousIdentityCount: 1, searchTermLinkCount: 10 } },
    analysis: { authority }, hierarchy: { authority }, periods: { authority },
  };
}
