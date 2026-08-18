import { canonicalJson } from './canonical-json.js';
import { buildCsvObservedTargetingIdentity } from './csv-observed-targeting-identity.js';
import { analyzeCsvTermProfitability } from './csv-term-profitability-analysis.js';
import { analyzeCsvWindowQuality } from './csv-window-quality-analysis.js';

export const CSV_JOINT_ANALYSIS_SCHEMA_VERSION = 'csv-joint-report-analysis-v2';

export async function analyzeCsvImportBatches(batches, options = {}) {
  if (!Array.isArray(batches) || batches.length === 0) {
    throw jointAnalysisError('CSV_JOINT_ANALYSIS_BATCHES_REQUIRED');
  }

  const normalized = batches.map(validateBatch);
  const hashes = normalized.map((batch) => batch.contentSha256);
  if (new Set(hashes).size !== hashes.length) {
    throw jointAnalysisError('CSV_JOINT_ANALYSIS_DUPLICATE_CONTENT');
  }

  const imports = normalized
    .map(importReceipt)
    .sort((left, right) => left.contentSha256.localeCompare(right.contentSha256));
  const dataQuality = analyzeCsvWindowQuality(imports);
  const facts = [];
  for (const batch of normalized) {
    const sourceImportId = `csv-content:${batch.contentSha256}`;
    for (const row of batch.rows) {
      facts.push(Object.freeze({
        ...row.fact,
        sourceImportId,
      }));
    }
  }

  const [analysis, observedIdentity] = await Promise.all([
    Promise.resolve(analyzeCsvTermProfitability(facts, options)),
    buildCsvObservedTargetingIdentity(facts),
  ]);
  const inputSetFingerprint = await sha256Hex(canonicalJson(imports.map((item) => ({
    schemaVersion: item.schemaVersion,
    reportType: item.reportType,
    contentSha256: item.contentSha256,
    reportStartDate: item.reportStartDate,
    reportEndDate: item.reportEndDate,
    rowCount: item.rowCount,
  }))));
  const reportDates = imports.flatMap((item) => [item.reportStartDate, item.reportEndDate]).filter(Boolean).sort();

  return Object.freeze({
    schemaVersion: CSV_JOINT_ANALYSIS_SCHEMA_VERSION,
    source: Object.freeze({
      kind: 'csv_import_set',
      authority: 'non-authoritative',
      batchCount: imports.length,
      contentSha256s: Object.freeze(imports.map((item) => item.contentSha256)),
      inputSetFingerprint,
      allImportsAccepted: true,
      duplicateContentDetected: false,
      overlappingDateWindowsDetected: dataQuality.summary.overlapPairCount > 0,
      dateCoverageGapDetected: dataQuality.summary.gapCount > 0,
      naiveAggregationSafe: dataQuality.safeForNaiveAggregation,
      canonicalAmazonIdentityResolved: false,
      observedTargetingIdentityAvailable: observedIdentity.summary.identityCount > 0,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    range: Object.freeze({
      startDate: reportDates[0] || null,
      endDate: reportDates[reportDates.length - 1] || null,
    }),
    summary: Object.freeze({
      batchCount: imports.length,
      factCount: facts.length,
      sourceRowCount: imports.reduce((sum, item) => sum + item.rowCount, 0),
      analyzedTermCount: analysis.summary.analyzedTermCount,
      profitTermCount: analysis.summary.profitTermCount,
      wasteTermCount: analysis.summary.wasteTermCount,
      toxicRootCount: analysis.summary.toxicRootCount,
      exactNegativeCandidateCount: analysis.summary.exactNegativeCandidateCount,
      phraseRootReviewCount: analysis.summary.phraseRootReviewCount,
      harvestCandidateCount: analysis.summary.harvestCandidateCount,
      observedIdentityCount: observedIdentity.summary.identityCount,
      observedResolvedIdCount: observedIdentity.summary.resolvedIdCount,
      ambiguousObservedIdentityCount: observedIdentity.summary.ambiguousIdentityCount,
      searchTermIdentityLinkCount: observedIdentity.summary.searchTermLinkCount,
      overlapPairCount: dataQuality.summary.overlapPairCount,
      exactDuplicateWindowCount: dataQuality.summary.exactDuplicateWindowCount,
      dateGapCount: dataQuality.summary.gapCount,
      dateGapDayCount: dataQuality.summary.gapDayCount,
      reportedWindowDayCount: dataQuality.summary.reportedWindowDayCount,
      uniqueCoveredDayCount: dataQuality.summary.uniqueCoveredDayCount,
      overlapExcessDayCount: dataQuality.summary.overlapExcessDayCount,
      metrics: analysis.summary.metrics,
    }),
    imports: Object.freeze(imports),
    dataQuality,
    observedIdentity,
    analysis,
  });
}

function validateBatch(batch) {
  if (!batch || typeof batch !== 'object') throw jointAnalysisError('CSV_JOINT_ANALYSIS_BATCH_INVALID');
  if (batch.ok !== true) throw jointAnalysisError('CSV_JOINT_ANALYSIS_IMPORT_REJECTED');
  if (batch.schemaVersion !== 'csv-import-v1') throw jointAnalysisError('CSV_JOINT_ANALYSIS_SCHEMA_UNSUPPORTED');
  if (batch.reportType !== 'spSearchTerm') throw jointAnalysisError('CSV_JOINT_ANALYSIS_REPORT_TYPE_UNSUPPORTED');
  if (!/^[a-f0-9]{64}$/i.test(String(batch.contentSha256 || ''))) {
    throw jointAnalysisError('CSV_JOINT_ANALYSIS_CONTENT_HASH_INVALID');
  }
  if (!Array.isArray(batch.rows) || batch.rows.length === 0) {
    throw jointAnalysisError('CSV_JOINT_ANALYSIS_ROWS_REQUIRED');
  }
  if (Number(batch.acceptedRows) !== Number(batch.rowCount) || Number(batch.rejectedRows) !== 0) {
    throw jointAnalysisError('CSV_JOINT_ANALYSIS_IMPORT_NOT_FULLY_ACCEPTED');
  }
  for (const row of batch.rows) {
    if (!row?.fact || !row?.logicalRowKey || !row?.canonicalRowJson) {
      throw jointAnalysisError('CSV_JOINT_ANALYSIS_CANONICAL_ROW_INVALID');
    }
  }
  return batch;
}

function importReceipt(batch) {
  return Object.freeze({
    schemaVersion: batch.schemaVersion,
    reportType: batch.reportType,
    sourceFileName: batch.sourceFileName,
    contentSha256: String(batch.contentSha256).toLowerCase(),
    reportStartDate: batch.reportStartDate || null,
    reportEndDate: batch.reportEndDate || null,
    rowCount: Number(batch.rowCount || 0),
    acceptedRows: Number(batch.acceptedRows || 0),
    rejectedRows: Number(batch.rejectedRows || 0),
    advertiserAccountId: batch.advertiserAccountId || null,
    profileId: batch.profileId || null,
    marketplace: batch.marketplace || null,
    currencyCode: batch.currencyCode || null,
  });
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function jointAnalysisError(code) {
  const error = new Error(code);
  error.name = 'CsvJointReportAnalysisError';
  error.code = code;
  return error;
}
