import { canonicalJson } from './canonical-json.js';

export const CSV_HISTORY_LEDGER_SCHEMA_VERSION = 'csv-history-ledger-v1';
export const CSV_HISTORY_SNAPSHOT_SCHEMA_VERSION = 'csv-history-snapshot-v1';

const CSV_SOURCE_KIND = 'csv_import_set';
const HASH_RE = /^[a-f0-9]{64}$/;
const AUTHORITY = Object.freeze({
  mode: 'local_file_history_ledger_only',
  authoritative: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});
const AUTHORITY_KEYS = new Set([
  'authoritative',
  'canonicalAmazonIdentityResolved',
  'governancePersistenceAllowed',
  'persistenceAuthorized',
  'executionAuthorized',
  'amazonMutationAuthorized',
]);

export async function buildCsvHistorySnapshot(result) {
  await assertJointAnalysis(result);
  const receipts = normalizeReceipts(result.imports);
  const sourceHashes = normalizeHashArray(result.source.contentSha256s, 'CSV_HISTORY_SOURCE_HASH_INVALID');
  assertHashSetsEqual(receipts.map((item) => item.contentSha256), sourceHashes, 'CSV_HISTORY_SOURCE_RECEIPT_MISMATCH');

  const inputSetFingerprint = normalizeHash(result.source.inputSetFingerprint, 'CSV_HISTORY_INPUT_SET_FINGERPRINT_INVALID');
  const recomputedFingerprint = await inputSetFingerprintForReceipts(receipts);
  if (inputSetFingerprint !== recomputedFingerprint) throw historyError('CSV_HISTORY_INPUT_SET_FINGERPRINT_MISMATCH');

  const monthlySnapshots = normalizeMonthlySnapshots(result.periods?.monthlySnapshots || []);
  return deepFreeze({
    schemaVersion: CSV_HISTORY_SNAPSHOT_SCHEMA_VERSION,
    createdFromLocalEvidenceOnly: true,
    sourceKind: CSV_SOURCE_KIND,
    inputSetFingerprint,
    batchCount: receipts.length,
    contentSha256s: Object.freeze([...sourceHashes].sort()),
    sourceReceipts: Object.freeze(receipts),
    reportStartDate: normalizeNullableDate(result.range?.startDate, 'CSV_HISTORY_REPORT_START_DATE_INVALID'),
    reportEndDate: normalizeNullableDate(result.range?.endDate, 'CSV_HISTORY_REPORT_END_DATE_INVALID'),
    qualityState: cleanNullableString(result.dataQuality?.qualityState),
    safeForNaiveAggregation: result.dataQuality?.safeForNaiveAggregation === true,
    contiguousCoverage: result.dataQuality?.contiguousCoverage === true,
    overlapPairCount: nonNegativeInteger(result.dataQuality?.summary?.overlapPairCount, 'CSV_HISTORY_OVERLAP_COUNT_INVALID'),
    gapCount: nonNegativeInteger(result.dataQuality?.summary?.gapCount, 'CSV_HISTORY_GAP_COUNT_INVALID'),
    observedIdentitySummary: normalizeEvidenceObject(result.observedIdentity?.summary || {}),
    periodSummary: normalizeEvidenceObject(result.periods?.summary || {}),
    monthlySnapshots: Object.freeze(monthlySnapshots),
    hierarchySummary: normalizeEvidenceObject(result.hierarchy?.summary || {}),
    authority: AUTHORITY,
  });
}

export async function createCsvHistoryLedger(snapshotOrResult) {
  const snapshot = isHistorySnapshot(snapshotOrResult)
    ? await validateSnapshot(snapshotOrResult)
    : await buildCsvHistorySnapshot(snapshotOrResult);
  return finalizeLedger([snapshot]);
}

export async function mergeCsvHistoryLedger(existingLedger, currentSnapshotOrResult) {
  const existing = await validateCsvHistoryLedger(existingLedger);
  const snapshot = isHistorySnapshot(currentSnapshotOrResult)
    ? await validateSnapshot(currentSnapshotOrResult)
    : await buildCsvHistorySnapshot(currentSnapshotOrResult);
  return finalizeLedger([...existing.snapshots, snapshot]);
}

export async function validateCsvHistoryLedger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw historyError('CSV_HISTORY_LEDGER_INVALID');
  if (value.schemaVersion !== CSV_HISTORY_LEDGER_SCHEMA_VERSION) throw historyError('CSV_HISTORY_LEDGER_SCHEMA_UNSUPPORTED');
  if (value.createdFromLocalEvidenceOnly !== true) throw historyError('CSV_HISTORY_LOCAL_EVIDENCE_FLAG_REQUIRED');
  assertNoAuthorityEscalation(value);
  assertExactAuthority(value.authority);
  if (!Array.isArray(value.snapshots) || value.snapshots.length === 0) throw historyError('CSV_HISTORY_SNAPSHOTS_REQUIRED');

  const snapshots = [];
  for (const item of value.snapshots) snapshots.push(await validateSnapshot(item));
  assertNoDuplicateEvidence(snapshots);
  const sorted = [...snapshots].sort(compareSnapshot);
  if (sorted.some((item, index) => item.inputSetFingerprint !== snapshots[index].inputSetFingerprint)) {
    throw historyError('CSV_HISTORY_SNAPSHOT_ORDER_INVALID');
  }

  const expectedWindowEvidence = buildHistoryWindowEvidence(snapshots);
  if (stableJson(value.historyWindowEvidence) !== stableJson(expectedWindowEvidence)) {
    throw historyError('CSV_HISTORY_WINDOW_EVIDENCE_MISMATCH');
  }
  const fingerprint = normalizeHash(value.ledgerFingerprint, 'CSV_HISTORY_LEDGER_FINGERPRINT_INVALID');
  const expectedFingerprint = await ledgerFingerprint({
    schemaVersion: CSV_HISTORY_LEDGER_SCHEMA_VERSION,
    createdFromLocalEvidenceOnly: true,
    snapshots,
    historyWindowEvidence: expectedWindowEvidence,
    authority: AUTHORITY,
  });
  if (fingerprint !== expectedFingerprint) throw historyError('CSV_HISTORY_LEDGER_FINGERPRINT_MISMATCH');

  return deepFreeze({
    schemaVersion: CSV_HISTORY_LEDGER_SCHEMA_VERSION,
    ledgerFingerprint: fingerprint,
    createdFromLocalEvidenceOnly: true,
    snapshots: Object.freeze(snapshots),
    historyWindowEvidence: expectedWindowEvidence,
    authority: AUTHORITY,
  });
}

export async function parseCsvHistoryLedger(text) {
  if (typeof text !== 'string' || !text.trim()) throw historyError('CSV_HISTORY_LEDGER_TEXT_REQUIRED');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw historyError('CSV_HISTORY_LEDGER_JSON_INVALID'); }
  return validateCsvHistoryLedger(parsed);
}

export function serializeCsvHistoryLedger(ledger) {
  if (!ledger || ledger.schemaVersion !== CSV_HISTORY_LEDGER_SCHEMA_VERSION) throw historyError('CSV_HISTORY_LEDGER_SCHEMA_UNSUPPORTED');
  return `${stableJson(ledger)}\n`;
}

async function finalizeLedger(items) {
  const snapshots = [];
  for (const item of items) snapshots.push(await validateSnapshot(item));
  assertNoDuplicateEvidence(snapshots);
  snapshots.sort(compareSnapshot);
  const historyWindowEvidence = buildHistoryWindowEvidence(snapshots);
  const base = {
    schemaVersion: CSV_HISTORY_LEDGER_SCHEMA_VERSION,
    createdFromLocalEvidenceOnly: true,
    snapshots: Object.freeze(snapshots),
    historyWindowEvidence,
    authority: AUTHORITY,
  };
  const ledgerFingerprintValue = await ledgerFingerprint(base);
  return deepFreeze({
    schemaVersion: base.schemaVersion,
    ledgerFingerprint: ledgerFingerprintValue,
    createdFromLocalEvidenceOnly: true,
    snapshots: base.snapshots,
    historyWindowEvidence,
    authority: AUTHORITY,
  });
}

async function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw historyError('CSV_HISTORY_SNAPSHOT_INVALID');
  if (value.schemaVersion !== CSV_HISTORY_SNAPSHOT_SCHEMA_VERSION) throw historyError('CSV_HISTORY_SNAPSHOT_SCHEMA_UNSUPPORTED');
  if (value.createdFromLocalEvidenceOnly !== true) throw historyError('CSV_HISTORY_LOCAL_EVIDENCE_FLAG_REQUIRED');
  if (value.sourceKind !== CSV_SOURCE_KIND) throw historyError('CSV_HISTORY_SOURCE_KIND_INVALID');
  assertNoAuthorityEscalation(value);
  assertExactAuthority(value.authority);

  const receipts = normalizeReceipts(value.sourceReceipts);
  const batchCount = nonNegativeInteger(value.batchCount, 'CSV_HISTORY_BATCH_COUNT_INVALID');
  if (batchCount !== receipts.length) throw historyError('CSV_HISTORY_BATCH_COUNT_MISMATCH');
  const hashes = normalizeHashArray(value.contentSha256s, 'CSV_HISTORY_SOURCE_HASH_INVALID');
  assertHashSetsEqual(receipts.map((item) => item.contentSha256), hashes, 'CSV_HISTORY_SOURCE_RECEIPT_MISMATCH');
  const inputSetFingerprint = normalizeHash(value.inputSetFingerprint, 'CSV_HISTORY_INPUT_SET_FINGERPRINT_INVALID');
  if (inputSetFingerprint !== await inputSetFingerprintForReceipts(receipts)) throw historyError('CSV_HISTORY_INPUT_SET_FINGERPRINT_MISMATCH');

  const normalized = {
    schemaVersion: CSV_HISTORY_SNAPSHOT_SCHEMA_VERSION,
    createdFromLocalEvidenceOnly: true,
    sourceKind: CSV_SOURCE_KIND,
    inputSetFingerprint,
    batchCount,
    contentSha256s: Object.freeze([...hashes].sort()),
    sourceReceipts: Object.freeze(receipts),
    reportStartDate: normalizeNullableDate(value.reportStartDate, 'CSV_HISTORY_REPORT_START_DATE_INVALID'),
    reportEndDate: normalizeNullableDate(value.reportEndDate, 'CSV_HISTORY_REPORT_END_DATE_INVALID'),
    qualityState: cleanNullableString(value.qualityState),
    safeForNaiveAggregation: value.safeForNaiveAggregation === true,
    contiguousCoverage: value.contiguousCoverage === true,
    overlapPairCount: nonNegativeInteger(value.overlapPairCount, 'CSV_HISTORY_OVERLAP_COUNT_INVALID'),
    gapCount: nonNegativeInteger(value.gapCount, 'CSV_HISTORY_GAP_COUNT_INVALID'),
    observedIdentitySummary: normalizeEvidenceObject(value.observedIdentitySummary || {}),
    periodSummary: normalizeEvidenceObject(value.periodSummary || {}),
    monthlySnapshots: Object.freeze(normalizeMonthlySnapshots(value.monthlySnapshots || [])),
    hierarchySummary: normalizeEvidenceObject(value.hierarchySummary || {}),
    authority: AUTHORITY,
  };
  if (normalized.reportStartDate && normalized.reportEndDate && normalized.reportEndDate < normalized.reportStartDate) {
    throw historyError('CSV_HISTORY_REPORT_WINDOW_INVERTED');
  }
  return deepFreeze(normalized);
}

async function assertJointAnalysis(result) {
  if (!result || typeof result !== 'object') throw historyError('CSV_HISTORY_JOINT_ANALYSIS_REQUIRED');
  if (result.schemaVersion !== 'csv-joint-report-analysis-v2') throw historyError('CSV_HISTORY_JOINT_ANALYSIS_SCHEMA_UNSUPPORTED');
  if (result.source?.kind !== CSV_SOURCE_KIND) throw historyError('CSV_HISTORY_SOURCE_KIND_INVALID');
  if (!Array.isArray(result.imports) || result.imports.length === 0) throw historyError('CSV_HISTORY_SOURCE_RECEIPTS_REQUIRED');
  if (Number(result.source?.batchCount) !== result.imports.length) throw historyError('CSV_HISTORY_BATCH_COUNT_MISMATCH');
  assertNoAuthorityEscalation(result);
}

function normalizeReceipts(items) {
  if (!Array.isArray(items) || items.length === 0) throw historyError('CSV_HISTORY_SOURCE_RECEIPTS_REQUIRED');
  const receipts = items.map((item) => {
    if (!item || typeof item !== 'object') throw historyError('CSV_HISTORY_SOURCE_RECEIPT_INVALID');
    const schemaVersion = cleanNullableString(item.schemaVersion);
    const reportType = cleanNullableString(item.reportType);
    if (schemaVersion !== 'csv-import-v1' || reportType !== 'spSearchTerm') throw historyError('CSV_HISTORY_SOURCE_KIND_INVALID');
    return Object.freeze({
      schemaVersion,
      reportType,
      sourceFileName: cleanNullableString(item.sourceFileName),
      contentSha256: normalizeHash(item.contentSha256, 'CSV_HISTORY_CONTENT_HASH_INVALID'),
      reportStartDate: normalizeNullableDate(item.reportStartDate, 'CSV_HISTORY_RECEIPT_START_DATE_INVALID'),
      reportEndDate: normalizeNullableDate(item.reportEndDate, 'CSV_HISTORY_RECEIPT_END_DATE_INVALID'),
      rowCount: nonNegativeInteger(item.rowCount, 'CSV_HISTORY_RECEIPT_ROW_COUNT_INVALID'),
      acceptedRows: nonNegativeInteger(item.acceptedRows, 'CSV_HISTORY_RECEIPT_ACCEPTED_ROWS_INVALID'),
      rejectedRows: nonNegativeInteger(item.rejectedRows, 'CSV_HISTORY_RECEIPT_REJECTED_ROWS_INVALID'),
      advertiserAccountId: cleanNullableString(item.advertiserAccountId),
      profileId: cleanNullableString(item.profileId),
      marketplace: cleanNullableString(item.marketplace),
      currencyCode: cleanNullableString(item.currencyCode),
    });
  }).sort((left, right) => left.contentSha256.localeCompare(right.contentSha256));
  const hashes = receipts.map((item) => item.contentSha256);
  if (new Set(hashes).size !== hashes.length) throw historyError('CSV_HISTORY_DUPLICATE_CONTENT_HASH');
  return receipts;
}

async function inputSetFingerprintForReceipts(receipts) {
  const payload = receipts.map((item) => ({
    schemaVersion: item.schemaVersion,
    reportType: item.reportType,
    contentSha256: item.contentSha256,
    reportStartDate: item.reportStartDate,
    reportEndDate: item.reportEndDate,
    rowCount: item.rowCount,
  }));
  return sha256Hex(canonicalJson(payload));
}

function normalizeMonthlySnapshots(items) {
  if (!Array.isArray(items)) throw historyError('CSV_HISTORY_MONTHLY_SNAPSHOTS_INVALID');
  return items.map((item) => normalizeEvidenceObject(item)).sort((left, right) => String(left.month || left.startDate || '').localeCompare(String(right.month || right.startDate || '')));
}

function assertNoDuplicateEvidence(snapshots) {
  const fingerprints = snapshots.map((item) => item.inputSetFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) throw historyError('CSV_HISTORY_DUPLICATE_INPUT_SET_FINGERPRINT');
  const seenHashes = new Set();
  for (const snapshot of snapshots) {
    for (const hash of snapshot.contentSha256s) {
      if (seenHashes.has(hash)) throw historyError('CSV_HISTORY_DUPLICATE_CONTENT_HASH');
      seenHashes.add(hash);
    }
  }
}

function buildHistoryWindowEvidence(snapshots) {
  const valid = snapshots.filter((item) => item.reportStartDate && item.reportEndDate).map((item) => ({
    inputSetFingerprint: item.inputSetFingerprint,
    startDate: item.reportStartDate,
    endDate: item.reportEndDate,
  })).sort((left, right) => left.startDate.localeCompare(right.startDate) || left.endDate.localeCompare(right.endDate) || left.inputSetFingerprint.localeCompare(right.inputSetFingerprint));
  const overlapPairs = [];
  const gaps = [];
  for (let index = 0; index < valid.length; index += 1) {
    const left = valid[index];
    for (let rightIndex = index + 1; rightIndex < valid.length; rightIndex += 1) {
      const right = valid[rightIndex];
      if (right.startDate > left.endDate) break;
      overlapPairs.push(Object.freeze({
        leftInputSetFingerprint: left.inputSetFingerprint,
        rightInputSetFingerprint: right.inputSetFingerprint,
        overlapDetected: true,
      }));
    }
    const next = valid[index + 1];
    if (next && daysBetween(left.endDate, next.startDate) > 1) {
      gaps.push(Object.freeze({
        previousInputSetFingerprint: left.inputSetFingerprint,
        nextInputSetFingerprint: next.inputSetFingerprint,
        gapDetected: true,
      }));
    }
  }
  return deepFreeze({
    snapshotCount: snapshots.length,
    validWindowCount: valid.length,
    incompleteWindowCount: snapshots.length - valid.length,
    overlapPairCount: overlapPairs.length,
    gapCount: gaps.length,
    overlapDetected: overlapPairs.length > 0,
    gapDetected: gaps.length > 0,
    normalizationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapPairs: Object.freeze(overlapPairs),
    gaps: Object.freeze(gaps),
  });
}

function compareSnapshot(left, right) {
  return String(left.reportStartDate || '').localeCompare(String(right.reportStartDate || ''))
    || String(left.reportEndDate || '').localeCompare(String(right.reportEndDate || ''))
    || left.inputSetFingerprint.localeCompare(right.inputSetFingerprint);
}

async function ledgerFingerprint(base) {
  return sha256Hex(stableJson(base));
}

function assertHashSetsEqual(left, right, code) {
  const a = [...left].sort();
  const b = [...right].sort();
  if (a.length !== b.length || a.some((item, index) => item !== b[index])) throw historyError(code);
}

function normalizeHashArray(values, invalidCode) {
  if (!Array.isArray(values) || values.length === 0) throw historyError(invalidCode);
  const hashes = values.map((value) => normalizeHash(value, invalidCode));
  if (new Set(hashes).size !== hashes.length) throw historyError('CSV_HISTORY_DUPLICATE_CONTENT_HASH');
  return hashes;
}

function normalizeHash(value, code) {
  const hash = String(value || '').toLowerCase();
  if (!HASH_RE.test(hash)) throw historyError(code);
  return hash;
}

function normalizeNullableDate(value, code) {
  if (value == null || value === '') return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw historyError(code);
  const parsed = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== text) throw historyError(code);
  return text;
}

function nonNegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw historyError(code);
  return number;
}

function cleanNullableString(value) {
  if (value == null || value === '') return null;
  return String(value).trim() || null;
}

function normalizeEvidenceObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw historyError('CSV_HISTORY_EVIDENCE_OBJECT_INVALID');
  return deepFreeze(normalizeJsonValue(value));
}

function normalizeJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw historyError('CSV_HISTORY_NON_FINITE_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw historyError('CSV_HISTORY_UNDEFINED_VALUE');
      out[key] = normalizeJsonValue(value[key]);
    }
    return out;
  }
  throw historyError('CSV_HISTORY_VALUE_TYPE_UNSUPPORTED');
}

function stableJson(value) {
  return JSON.stringify(normalizeJsonValue(value));
}

function assertNoAuthorityEscalation(value) {
  visit(value);
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    for (const [key, item] of Object.entries(node)) {
      if (AUTHORITY_KEYS.has(key) && item === true) throw historyError('CSV_HISTORY_AUTHORITY_ESCALATION_BLOCKED');
      visit(item);
    }
  }
}

function assertExactAuthority(value) {
  if (!value || typeof value !== 'object') throw historyError('CSV_HISTORY_AUTHORITY_INVALID');
  for (const [key, expected] of Object.entries(AUTHORITY)) {
    if (value[key] !== expected) throw historyError('CSV_HISTORY_AUTHORITY_ESCALATION_BLOCKED');
  }
}

function daysBetween(left, right) {
  return Math.round((Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`)) / 86_400_000);
}

function isHistorySnapshot(value) {
  return value?.schemaVersion === CSV_HISTORY_SNAPSHOT_SCHEMA_VERSION;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function historyError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryLedgerError';
  error.code = code;
  return error;
}
