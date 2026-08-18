import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const uiRelative = 'assets/cloudflare-native-csv-data-quality-command-center-v1.js';
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const jointTag = '<script type="module" src="assets/cloudflare-native-csv-joint-analysis-v1.js?v=1.0.0"></script>';
const commandCenterTag = '<script type="module" src="assets/cloudflare-native-csv-data-quality-command-center-v1.js?v=1.0.0"></script>';
const hierarchyTag = '<script type="module" src="assets/cloudflare-native-csv-hierarchy-quality-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(commandCenterTag).length - 1, 1, 'Data Quality Command Center must be injected exactly once');
assert.ok(indexSource.indexOf(jointTag) < indexSource.indexOf(commandCenterTag), 'Command Center must load after Joint CSV Analysis');
assert.ok(indexSource.indexOf(commandCenterTag) < indexSource.indexOf(hierarchyTag), 'Command Center must load before detailed hierarchy/quality UI');
assert.match(uiSource, /Data Quality Command Center/);
assert.match(uiSource, /Decision gate matrix/);
assert.match(uiSource, /No overlap ≠ complete coverage/);
assert.match(uiSource, /Observed CSV identity ≠ canonical Amazon identity/);
assert.match(uiSource, /Blocked means analytical decision use is blocked; the evidence remains observable/);
assert.match(uiSource, /receipt\/hash set verified/i);
assert.match(uiSource, /browser_local_decision_gate_only/);
assert.match(uiSource, /CSV_DATA_QUALITY_COMMAND_CENTER_SOURCE_RECEIPT_MISMATCH/);
assert.match(uiSource, /CSV_DATA_QUALITY_COMMAND_CENTER_BATCH_COUNT_MISMATCH/);
assert.match(uiSource, /CSV_DATA_QUALITY_COMMAND_CENTER_DUPLICATE_HASH_EVIDENCE/);
assert.match(uiSource, /CSV_DATA_QUALITY_COMMAND_CENTER_AUTHORITY_ESCALATION_BLOCKED/);

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
]) assert.equal(pattern.test(uiSource), false, `Command Center must remain transport/storage/execution free: ${pattern}`);

const mod = await import(`${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`);
assert.equal(mod.CSV_DATA_QUALITY_COMMAND_CENTER_SCHEMA_VERSION, 'csv-data-quality-command-center-v1');
assert.equal(mod.CSV_DATA_QUALITY_COMMAND_CENTER_UI_VERSION, '1.0.0');
assert.equal(typeof mod.buildCsvDataQualityCommandCenter, 'function');

const clean = mod.buildCsvDataQualityCommandCenter(fixture('clean'));
assert.equal(clean.authority.authoritative, false);
assert.equal(clean.authority.canonicalAmazonIdentityResolved, false);
assert.equal(clean.authority.governancePersistenceAllowed, false);
assert.equal(clean.authority.executionAuthorized, false);
assert.equal(clean.authority.amazonMutationAuthorized, false);
assert.equal(clean.operatorState, 'review_only');
assert.equal(clean.source.receiptHashSetVerified, true);
assert.equal(clean.quality.safeForNaiveAggregation, true);
assert.equal(clean.quality.contiguousCoverage, true);
assert.equal(clean.issueSummary.blockerCount, 0);
assert.equal(clean.issueSummary.constraintCount, 0);
assert.equal(clean.issueSummary.infoCount, 1);
assert.equal(gateState(clean, 'aggregation'), 'review_only');
assert.equal(gateState(clean, 'coverage'), 'complete');
assert.equal(gateState(clean, 'period_comparisons'), 'review_only');
assert.equal(gateState(clean, 'observed_identity'), 'observed_only');

const gapOnly = mod.buildCsvDataQualityCommandCenter(fixture('gap'));
assert.equal(gapOnly.operatorState, 'review_with_constraints');
assert.equal(gapOnly.quality.safeForNaiveAggregation, true, 'Coverage gaps must not automatically block naive aggregation');
assert.equal(gapOnly.quality.contiguousCoverage, false);
assert.equal(gateState(gapOnly, 'aggregation'), 'review_only');
assert.equal(gateState(gapOnly, 'coverage'), 'partial_or_gapped');
assert.equal(gateState(gapOnly, 'hierarchy'), 'review_with_period_gap');
assert.equal(gateState(gapOnly, 'period_comparisons'), 'review_with_constraints');
assert.ok(gapOnly.issues.some((item) => item.code === 'coverage_gap' && item.severity === 'constraint'));
assert.ok(gapOnly.issues.some((item) => item.code === 'period_coverage_incomplete' && item.severity === 'constraint'));

const overlap = mod.buildCsvDataQualityCommandCenter(fixture('overlap'));
assert.equal(overlap.operatorState, 'blocked');
assert.equal(overlap.quality.safeForNaiveAggregation, false);
assert.equal(gateState(overlap, 'aggregation'), 'blocked');
assert.equal(gateState(overlap, 'period_comparisons'), 'blocked');
assert.ok(overlap.issues.some((item) => item.code === 'overlap_double_count_risk' && item.severity === 'blocker'));
assert.ok(overlap.issues.some((item) => item.code === 'period_comparison_blocked' && item.severity === 'blocker'));

const identityConflict = mod.buildCsvDataQualityCommandCenter(fixture('identity'));
assert.equal(identityConflict.operatorState, 'review_with_constraints');
assert.equal(identityConflict.quality.safeForNaiveAggregation, true);
assert.equal(identityConflict.quality.contiguousCoverage, true);
assert.equal(gateState(identityConflict, 'observed_identity'), 'blocked_conflicts_present');
assert.ok(identityConflict.issues.some((item) => item.code === 'observed_identity_conflict' && item.severity === 'constraint'));
assert.equal(identityConflict.identity.canonicalAmazonIdentityResolved, false);

const invalid = mod.buildCsvDataQualityCommandCenter(fixture('invalid'));
assert.equal(invalid.operatorState, 'blocked');
assert.ok(invalid.issues.some((item) => item.code === 'invalid_date_evidence' && item.severity === 'blocker'));

const base = fixture('clean');
assert.throws(
  () => mod.buildCsvDataQualityCommandCenter({ ...base, source: { ...base.source, executionAuthorized: true } }),
  (error) => error?.code === 'CSV_DATA_QUALITY_COMMAND_CENTER_AUTHORITY_ESCALATION_BLOCKED',
  'Command Center must fail closed if execution authority appears',
);
assert.throws(
  () => mod.buildCsvDataQualityCommandCenter({ ...base, source: { ...base.source, kind: 'amazon_api' } }),
  (error) => error?.code === 'CSV_DATA_QUALITY_COMMAND_CENTER_SOURCE_KIND_INVALID',
  'Command Center must reject non-CSV source kinds',
);
assert.throws(
  () => mod.buildCsvDataQualityCommandCenter({ ...base, source: { ...base.source, contentSha256s: ['e'.repeat(64), base.source.contentSha256s[1]] } }),
  (error) => error?.code === 'CSV_DATA_QUALITY_COMMAND_CENTER_SOURCE_RECEIPT_MISMATCH',
  'Command Center must reject source/receipt hash drift',
);
assert.throws(
  () => mod.buildCsvDataQualityCommandCenter({ ...base, source: { ...base.source, batchCount: 3 } }),
  (error) => error?.code === 'CSV_DATA_QUALITY_COMMAND_CENTER_BATCH_COUNT_MISMATCH',
  'Command Center must reject batch-count drift',
);
assert.throws(
  () => mod.buildCsvDataQualityCommandCenter({
    ...base,
    source: { ...base.source, contentSha256s: [base.source.contentSha256s[0], base.source.contentSha256s[0]] },
    imports: [base.imports[0], { ...base.imports[1], contentSha256: base.imports[0].contentSha256 }],
  }),
  (error) => error?.code === 'CSV_DATA_QUALITY_COMMAND_CENTER_DUPLICATE_HASH_EVIDENCE',
  'Command Center must reject duplicate hash evidence',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-data-quality-command-center-v1',
  aggregationAndCoverageSeparated: true,
  overlapBlocksAggregation: true,
  gapsConstrainCoverage: true,
  identityConflictsConstrainFollowUp: true,
  periodCoverageScoped: true,
  receiptHashSetVerified: true,
  canonicalAmazonIdentityResolved: false,
  persistenceAuthorized: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

function gateState(model, scope) {
  return model.gates.find((item) => item.scope === scope)?.state;
}

function fixture(mode) {
  const firstHash = 'b'.repeat(64);
  const secondHash = 'c'.repeat(64);
  const authority = Object.freeze({ authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false });
  const quality = {
    schemaVersion: 'csv-window-quality-v1',
    authority,
    qualityState: 'clean_contiguous',
    safeForNaiveAggregation: true,
    contiguousCoverage: true,
    summary: {
      importCount: 2,
      validWindowCount: 2,
      invalidWindowCount: 0,
      overlapPairCount: 0,
      exactDuplicateWindowCount: 0,
      gapCount: 0,
      gapDayCount: 0,
      reportedWindowDayCount: 14,
      uniqueCoveredDayCount: 14,
      overlapExcessDayCount: 0,
      coverageSpanDayCount: 14,
    },
  };
  const hierarchy = {
    authority,
    reliability: { state: 'observed', aggregationSafe: true, periodComplete: true, analyticalDecisionUse: 'review_only' },
    summary: { ambiguousCampaignCount: 0, ambiguousAdGroupCount: 0, ambiguousTargetingCount: 0 },
  };
  const periods = {
    authority,
    summary: { fullyCoveredTrailingComparisonCount: 5, incompleteTrailingComparisonCount: 0, blockedTrailingComparisonCount: 0 },
  };
  const observedIdentity = {
    authority,
    summary: { identityCount: 4, resolvedIdCount: 4, ambiguousIdentityCount: 0, canonicalAmazonIdentityResolved: false },
  };

  if (mode === 'gap') {
    quality.qualityState = 'gap_detected';
    quality.contiguousCoverage = false;
    quality.summary.gapCount = 1;
    quality.summary.gapDayCount = 3;
    quality.summary.coverageSpanDayCount = 17;
    hierarchy.reliability = { state: 'incomplete_period', aggregationSafe: true, periodComplete: false, analyticalDecisionUse: 'review_with_period_gap' };
    periods.summary = { fullyCoveredTrailingComparisonCount: 3, incompleteTrailingComparisonCount: 2, blockedTrailingComparisonCount: 0 };
  }
  if (mode === 'overlap') {
    quality.qualityState = 'overlap_detected';
    quality.safeForNaiveAggregation = false;
    quality.summary.overlapPairCount = 1;
    quality.summary.exactDuplicateWindowCount = 1;
    quality.summary.reportedWindowDayCount = 14;
    quality.summary.uniqueCoveredDayCount = 7;
    quality.summary.overlapExcessDayCount = 7;
    hierarchy.reliability = { state: 'blocked_overlap_or_invalid_window', aggregationSafe: false, periodComplete: true, analyticalDecisionUse: 'blocked' };
    periods.summary = { fullyCoveredTrailingComparisonCount: 0, incompleteTrailingComparisonCount: 0, blockedTrailingComparisonCount: 5 };
  }
  if (mode === 'identity') {
    observedIdentity.summary.ambiguousIdentityCount = 1;
    hierarchy.summary.ambiguousTargetingCount = 1;
  }
  if (mode === 'invalid') {
    quality.qualityState = 'incomplete_date_evidence';
    quality.safeForNaiveAggregation = false;
    quality.contiguousCoverage = false;
    quality.summary.invalidWindowCount = 1;
    hierarchy.reliability = { state: 'blocked_overlap_or_invalid_window', aggregationSafe: false, periodComplete: false, analyticalDecisionUse: 'blocked' };
    periods.summary = { fullyCoveredTrailingComparisonCount: 0, incompleteTrailingComparisonCount: 0, blockedTrailingComparisonCount: 5 };
  }

  return {
    source: {
      kind: 'csv_import_set',
      batchCount: 2,
      inputSetFingerprint: 'a'.repeat(64),
      contentSha256s: [firstHash, secondHash],
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
    range: { startDate: '2026-08-01', endDate: '2026-08-14' },
    imports: [
      { sourceFileName: 'a.csv', contentSha256: firstHash, reportStartDate: '2026-08-01', reportEndDate: '2026-08-07' },
      { sourceFileName: 'b.csv', contentSha256: secondHash, reportStartDate: '2026-08-08', reportEndDate: '2026-08-14' },
    ],
    dataQuality: quality,
    analysis: { authority },
    hierarchy,
    periods,
    observedIdentity,
  };
}
