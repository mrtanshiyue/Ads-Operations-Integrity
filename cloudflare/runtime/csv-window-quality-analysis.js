export const CSV_WINDOW_QUALITY_SCHEMA_VERSION = 'csv-window-quality-v1';

const DAY_MS = 86_400_000;
const NON_AUTHORITY = Object.freeze({
  mode: 'csv_window_quality_observation_only',
  authoritative: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function analyzeCsvWindowQuality(imports) {
  if (!Array.isArray(imports) || imports.length === 0) throw qualityError('CSV_WINDOW_QUALITY_IMPORTS_REQUIRED');

  const windows = imports.map(normalizeImportWindow).sort(compareWindow);
  const validWindows = windows.filter((item) => item.validDateRange);
  const invalidWindows = windows.filter((item) => !item.validDateRange);
  const overlapPairs = buildOverlapPairs(validWindows);
  const exactDuplicateWindows = overlapPairs.filter((item) => item.relation === 'exact_duplicate_window');
  const mergedCoverage = mergeCoverage(validWindows);
  const gaps = buildGaps(mergedCoverage);
  const reportedWindowDayCount = validWindows.reduce((sum, item) => sum + item.windowDayCount, 0);
  const uniqueCoveredDayCount = mergedCoverage.reduce((sum, item) => sum + daysInclusive(item.startDay, item.endDay), 0);
  const overlapExcessDayCount = Math.max(0, reportedWindowDayCount - uniqueCoveredDayCount);
  const coverageStartDate = mergedCoverage[0]?.startDate || null;
  const coverageEndDate = mergedCoverage[mergedCoverage.length - 1]?.endDate || null;
  const coverageSpanDayCount = coverageStartDate && coverageEndDate
    ? daysInclusive(parseDate(coverageStartDate), parseDate(coverageEndDate))
    : 0;
  const gapDayCount = gaps.reduce((sum, item) => sum + item.gapDayCount, 0);
  const safeForNaiveAggregation = invalidWindows.length === 0 && overlapPairs.length === 0;
  const contiguousCoverage = invalidWindows.length === 0 && gaps.length === 0;
  const qualityState = deriveQualityState({ windows, invalidWindows, overlapPairs, gaps });

  return Object.freeze({
    schemaVersion: CSV_WINDOW_QUALITY_SCHEMA_VERSION,
    authority: NON_AUTHORITY,
    qualityState,
    safeForNaiveAggregation,
    contiguousCoverage,
    requiresHumanReview: invalidWindows.length > 0 || overlapPairs.length > 0 || gaps.length > 0,
    summary: Object.freeze({
      importCount: windows.length,
      validWindowCount: validWindows.length,
      invalidWindowCount: invalidWindows.length,
      overlapPairCount: overlapPairs.length,
      exactDuplicateWindowCount: exactDuplicateWindows.length,
      gapCount: gaps.length,
      gapDayCount,
      reportedWindowDayCount,
      uniqueCoveredDayCount,
      overlapExcessDayCount,
      coverageSpanDayCount,
      coverageStartDate,
      coverageEndDate,
    }),
    windows: Object.freeze(windows),
    overlapPairs: Object.freeze(overlapPairs),
    gaps: Object.freeze(gaps),
    mergedCoverage: Object.freeze(mergedCoverage),
  });
}

function normalizeImportWindow(item) {
  if (!item || typeof item !== 'object') throw qualityError('CSV_WINDOW_QUALITY_IMPORT_INVALID');
  const contentSha256 = clean(item.contentSha256)?.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentSha256 || '')) throw qualityError('CSV_WINDOW_QUALITY_CONTENT_HASH_INVALID');
  const sourceFileName = clean(item.sourceFileName) || null;
  const startDate = clean(item.reportStartDate);
  const endDate = clean(item.reportEndDate);
  const startDay = parseDate(startDate);
  const endDay = parseDate(endDate);
  let issueCode = null;
  if (startDate === null || endDate === null) issueCode = 'missing_date_range';
  else if (startDay === null || endDay === null) issueCode = 'invalid_date_format';
  else if (endDay < startDay) issueCode = 'inverted_date_range';
  const validDateRange = issueCode === null;

  return Object.freeze({
    contentSha256,
    sourceFileName,
    reportStartDate: startDate,
    reportEndDate: endDate,
    validDateRange,
    issueCode,
    windowDayCount: validDateRange ? daysInclusive(startDay, endDay) : 0,
    startDay: validDateRange ? startDay : null,
    endDay: validDateRange ? endDay : null,
  });
}

function buildOverlapPairs(windows) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < windows.length; leftIndex += 1) {
    const left = windows[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < windows.length; rightIndex += 1) {
      const right = windows[rightIndex];
      if (right.startDay > left.endDay && left.startDay <= right.startDay) break;
      const overlapStart = Math.max(left.startDay, right.startDay);
      const overlapEnd = Math.min(left.endDay, right.endDay);
      if (overlapStart > overlapEnd) continue;
      const relation = overlapRelation(left, right);
      pairs.push(Object.freeze({
        relation,
        left: windowRef(left),
        right: windowRef(right),
        overlapStartDate: formatDate(overlapStart),
        overlapEndDate: formatDate(overlapEnd),
        overlapDayCount: daysInclusive(overlapStart, overlapEnd),
        doubleCountRisk: true,
        requiresHumanReview: true,
      }));
    }
  }
  return pairs.sort(compareOverlapPair);
}

function overlapRelation(left, right) {
  if (left.startDay === right.startDay && left.endDay === right.endDay) return 'exact_duplicate_window';
  if (left.startDay <= right.startDay && left.endDay >= right.endDay) return 'right_contained_in_left';
  if (right.startDay <= left.startDay && right.endDay >= left.endDay) return 'left_contained_in_right';
  return 'partial_overlap';
}

function mergeCoverage(windows) {
  if (!windows.length) return [];
  const merged = [];
  let current = { startDay: windows[0].startDay, endDay: windows[0].endDay, sourceHashes: [windows[0].contentSha256] };
  for (const next of windows.slice(1)) {
    if (next.startDay <= current.endDay + DAY_MS) {
      current.endDay = Math.max(current.endDay, next.endDay);
      current.sourceHashes.push(next.contentSha256);
      continue;
    }
    merged.push(finalizeCoverage(current));
    current = { startDay: next.startDay, endDay: next.endDay, sourceHashes: [next.contentSha256] };
  }
  merged.push(finalizeCoverage(current));
  return merged;
}

function buildGaps(coverage) {
  const gaps = [];
  for (let index = 1; index < coverage.length; index += 1) {
    const previous = coverage[index - 1];
    const next = coverage[index];
    const startDay = parseDate(previous.endDate) + DAY_MS;
    const endDay = parseDate(next.startDate) - DAY_MS;
    if (startDay > endDay) continue;
    gaps.push(Object.freeze({
      gapStartDate: formatDate(startDay),
      gapEndDate: formatDate(endDay),
      gapDayCount: daysInclusive(startDay, endDay),
      previousCoverageEndDate: previous.endDate,
      nextCoverageStartDate: next.startDate,
      requiresHumanReview: true,
    }));
  }
  return gaps;
}

function finalizeCoverage(value) {
  return Object.freeze({
    startDate: formatDate(value.startDay),
    endDate: formatDate(value.endDay),
    coveredDayCount: daysInclusive(value.startDay, value.endDay),
    sourceContentSha256s: Object.freeze([...new Set(value.sourceHashes)].sort()),
  });
}

function deriveQualityState({ windows, invalidWindows, overlapPairs, gaps }) {
  if (invalidWindows.length > 0) return 'incomplete_date_evidence';
  if (overlapPairs.length > 0 && gaps.length > 0) return 'overlap_and_gap_detected';
  if (overlapPairs.length > 0) return 'overlap_detected';
  if (gaps.length > 0) return 'gap_detected';
  return windows.length === 1 ? 'single_window' : 'clean_contiguous';
}

function windowRef(item) {
  return Object.freeze({
    contentSha256: item.contentSha256,
    sourceFileName: item.sourceFileName,
    reportStartDate: item.reportStartDate,
    reportEndDate: item.reportEndDate,
    windowDayCount: item.windowDayCount,
  });
}

function compareWindow(left, right) {
  if (left.validDateRange !== right.validDateRange) return left.validDateRange ? -1 : 1;
  if (left.validDateRange && right.validDateRange) {
    return left.startDay - right.startDay || left.endDay - right.endDay || left.contentSha256.localeCompare(right.contentSha256);
  }
  return left.contentSha256.localeCompare(right.contentSha256);
}

function compareOverlapPair(left, right) {
  return left.overlapStartDate.localeCompare(right.overlapStartDate)
    || left.overlapEndDate.localeCompare(right.overlapEndDate)
    || left.left.contentSha256.localeCompare(right.left.contentSha256)
    || left.right.contentSha256.localeCompare(right.right.contentSha256);
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

function formatDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function daysInclusive(startDay, endDay) {
  return Math.floor((endDay - startDay) / DAY_MS) + 1;
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function qualityError(code) {
  const error = new Error(code);
  error.name = 'CsvWindowQualityError';
  error.code = code;
  return error;
}
