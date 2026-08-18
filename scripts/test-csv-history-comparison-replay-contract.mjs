import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from '../cloudflare/runtime/canonical-json.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const replayRelative = 'assets/cloudflare-native-csv-history-comparison-replay-v1.js';
const replaySource = await readFile(path.join(distRoot, replayRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const receiptTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-receipt-v1.js?v=1.0.0"></script>';
const replayTag = '<script type="module" src="assets/cloudflare-native-csv-history-comparison-replay-v1.js?v=1.0.0"></script>';
const provenanceTag = '<script type="module" src="assets/cloudflare-native-csv-provenance-audit-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(replayTag).length - 1, 1, 'Historical comparison replay asset must be injected exactly once');
assert.ok(indexSource.indexOf(receiptTag) < indexSource.indexOf(replayTag), 'Replay verifier must load after comparison receipt capability');
assert.ok(indexSource.indexOf(replayTag) < indexSource.indexOf(provenanceTag), 'Replay verifier must load before provenance audit');
assert.match(replaySource, /Historical Comparison Receipt Replay/);
assert.match(replaySource, /A receipt fingerprint is not a digital signature/);
assert.match(replaySource, /comparisonRecomputedFromLedger: true/);
assert.match(replaySource, /receiptFingerprintReproduced: true/);
assert.match(replaySource, /cryptographicSignatureVerified: false/);

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
  assert.equal(pattern.test(replaySource), false, `Replay verifier must remain local-only and execution-free: ${pattern}`);
}

const engine = await import(`${pathToFileURL(path.join(distRoot, 'assets/csv-analysis-engine/csv-history-ledger.js')).href}?replayEngine=${Date.now()}`);
const history = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-history-ledger-v1.js')).href}?replayHistory=${Date.now()}`);
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-history-comparison-receipt-v1.js')).href}?replayReceipt=${Date.now()}`);
const replayMod = await import(`${pathToFileURL(path.join(distRoot, replayRelative)).href}?replay=${Date.now()}`);

assert.equal(replayMod.CSV_HISTORY_COMPARISON_REPLAY_SCHEMA_VERSION, 'csv-history-comparison-replay-v1');
assert.equal(replayMod.CSV_HISTORY_COMPARISON_REPLAY_UI_VERSION, '1.0.0');
assert.equal(typeof replayMod.verifyHistoricalComparisonReceiptAgainstLedger, 'function');

const completeA = await fixture({
  hashChar: 'a', month: '2026-06', startDate: '2026-06-01', endDate: '2026-06-30', expectedDayCount: 30, coveredDayCount: 30,
  metrics: { spendMicros: 4_000_000, salesMicros: 10_000_000, orders: 3, acos: 0.4, roas: 2.5 },
});
const completeB = await fixture({
  hashChar: 'b', month: '2026-07', startDate: '2026-07-01', endDate: '2026-07-31', expectedDayCount: 31, coveredDayCount: 31,
  metrics: { spendMicros: 5_000_000, salesMicros: 12_000_000, orders: 5, acos: 5 / 12, roas: 2.4 },
});
const completeLedger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(completeA), completeB);
const completeRows = history.buildHistoricalMonthlyWorkspace(completeLedger).rows;
const allowedReceipt = await receiptMod.buildHistoricalComparisonReceipt(completeLedger, select(completeRows[0]), select(completeRows[1]));
const allowedReplay = await replayMod.verifyHistoricalComparisonReceiptAgainstLedger(completeLedger, allowedReceipt);
assert.equal(allowedReplay.schemaVersion, 'csv-history-comparison-replay-v1');
assert.equal(allowedReplay.verificationPurpose, 'local_receipt_vs_immutable_ledger_replay_only');
assert.equal(allowedReplay.verified, true);
assert.equal(allowedReplay.ledgerFingerprint, completeLedger.ledgerFingerprint);
assert.equal(allowedReplay.receiptFingerprint, allowedReceipt.receiptFingerprint);
assert.equal(allowedReplay.comparisonAllowed, true);
assert.equal(allowedReplay.rawEvidenceOnly, false);
assert.equal(allowedReplay.replay.comparisonRecomputedFromLedger, true);
assert.equal(allowedReplay.replay.receiptFingerprintReproduced, true);
assert.equal(allowedReplay.replay.generatedTimestampIncluded, false);
assert.equal(allowedReplay.replay.cryptographicSignatureVerified, false);
assertAuthorityFalse(allowedReplay.authority);
assert.equal(Object.isFrozen(allowedReplay), true);

const partialA = await fixture({
  hashChar: 'c', month: '2026-08', startDate: '2026-08-01', endDate: '2026-08-14', expectedDayCount: 31, coveredDayCount: 14,
});
const partialB = await fixture({
  hashChar: 'd', month: '2026-09', startDate: '2026-09-01', endDate: '2026-09-15', expectedDayCount: 30, coveredDayCount: 15,
});
const partialLedger = await engine.mergeCsvHistoryLedger(await engine.createCsvHistoryLedger(partialA), partialB);
const partialRows = history.buildHistoricalMonthlyWorkspace(partialLedger).rows;
const blockedReceipt = await receiptMod.buildHistoricalComparisonReceipt(partialLedger, select(partialRows[0]), select(partialRows[1]));
const blockedReplay = await replayMod.verifyHistoricalComparisonReceiptAgainstLedger(partialLedger, blockedReceipt);
assert.equal(blockedReplay.verified, true);
assert.equal(blockedReplay.comparisonAllowed, false);
assert.equal(blockedReplay.rawEvidenceOnly, true);
assert.equal(blockedReceipt.comparison.interpretationAllowed, false);
for (const metric of Object.values(blockedReceipt.comparison.metrics)) assert.equal(metric.delta, null);

const differentLedger = await engine.createCsvHistoryLedger(await fixture({
  hashChar: 'e', month: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31', expectedDayCount: 31, coveredDayCount: 31,
}));
await assert.rejects(
  () => replayMod.verifyHistoricalComparisonReceiptAgainstLedger(differentLedger, allowedReceipt),
  (error) => error?.code === 'CSV_HISTORY_COMPARISON_REPLAY_LEDGER_FINGERPRINT_MISMATCH',
  'Receipt must be replayed only against its exact immutable ledger',
);

const selfConsistentButFalse = JSON.parse(receiptMod.serializeHistoricalComparisonReceipt(allowedReceipt));
selfConsistentButFalse.comparison.metrics.salesMicros.periodBValue += 1;
selfConsistentButFalse.receiptFingerprint = await refingerprint(selfConsistentButFalse);
await receiptMod.validateHistoricalComparisonReceipt(selfConsistentButFalse);
await assert.rejects(
  () => replayMod.verifyHistoricalComparisonReceiptAgainstLedger(completeLedger, selfConsistentButFalse),
  (error) => error?.code === 'CSV_HISTORY_COMPARISON_REPLAY_RESULT_MISMATCH',
  'A re-fingerprinted but ledger-inconsistent receipt must fail replay verification',
);

const fingerprintTampered = JSON.parse(receiptMod.serializeHistoricalComparisonReceipt(allowedReceipt));
fingerprintTampered.receiptFingerprint = 'f'.repeat(64);
await assert.rejects(
  () => replayMod.verifyHistoricalComparisonReceiptAgainstLedger(completeLedger, fingerprintTampered),
  (error) => error?.code === 'CSV_HISTORY_COMPARISON_RECEIPT_FINGERPRINT_MISMATCH',
  'Receipt fingerprint validation must still fail before replay',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-comparison-replay-v1',
  originalLedgerRequired: true,
  exactLedgerFingerprintRequired: true,
  comparisonRecomputedFromLedger: true,
  receiptFingerprintReproduced: true,
  refingerprintedFalseReceiptRejected: true,
  blockedReceiptReplayable: true,
  cryptographicSignatureVerified: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}, null, 2));

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

async function refingerprint(receipt) {
  const payload = structuredClone(receipt);
  delete payload.receiptFingerprint;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(projectNumbers(payload))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function projectNumbers(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return { $csvHistoryNumber: Object.is(value, -0) ? '0' : String(value) };
  if (Array.isArray(value)) return value.map(projectNumbers);
  const out = {};
  for (const key of Object.keys(value)) out[key] = projectNumbers(value[key]);
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
  const complete = coveredDayCount === expectedDayCount;
  return {
    schemaVersion: 'csv-joint-report-analysis-v2',
    source: {
      kind: 'csv_import_set', batchCount: 1, contentSha256s: [contentSha256], inputSetFingerprint,
      canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false,
    },
    range: { startDate, endDate },
    imports: [receipt],
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
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
