import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const receiptRelative = 'assets/cloudflare-native-csv-history-rolling-12-transition-chronology-receipt-v1.js';
const receiptSource = await readFile(path.join(repoRoot, receiptRelative), 'utf8');
const receiptDistSource = await readFile(path.join(distRoot, receiptRelative), 'utf8');
const receiptMod = await import(`${pathToFileURL(path.join(distRoot, receiptRelative)).href}?r12ChronologyReceipt=${Date.now()}`);

const {
  CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_SCHEMA_VERSION,
  buildHistoricalRolling12TransitionChronologyReceipt,
  validateHistoricalRolling12TransitionChronologyReceipt,
  parseHistoricalRolling12TransitionChronologyReceipt,
  serializeHistoricalRolling12TransitionChronologyReceipt,
} = receiptMod;

const hex = (character) => character.repeat(64);

function board(previousWindowKey, currentWindowKey, receiptFingerprint, previousLedgerFingerprint, currentLedgerFingerprint, delta, overrides = {}) {
  return {
    schemaVersion: 'csv-history-rolling-12-window-transition-review-board-v1',
    boardPurpose: 'read_only_projection_of_verified_rolling_12_transition_receipt',
    operatorState: 'verified_transition_review_only',
    receiptFingerprint,
    verificationState: 'verified_against_explicit_local_ledgers',
    receiptFingerprintMatch: true,
    receiptSerializationMatch: true,
    transitionAllowed: true,
    interpretationAllowed: true,
    rawEvidenceOnly: false,
    previousLedgerFingerprint,
    currentLedgerFingerprint,
    selection: { previousWindowKey, currentWindowKey, windowSelectionAutoReordered: false },
    decomposition: {
      outgoingQuarterKey: previousWindowKey.replace('-R12', ''),
      incomingQuarterKey: currentWindowKey.replace('-R12', ''),
      sharedQuarterKeys: ['shared-a', 'shared-b', 'shared-c'],
      sharedQuarterCount: 3,
    },
    metrics: [{
      key: 'spendMicros',
      metricKind: 'additive',
      previousRolling12Value: 100,
      currentRolling12Value: 100 + delta,
      rolling12Delta: delta,
      movementDirection: delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'unchanged',
      interpretationAllowed: true,
      outcomeQualityClassification: 'not_assigned',
      recommendationGenerated: false,
      actionGenerated: false,
    }],
    ...overrides,
  };
}

assert.equal(receiptSource, receiptDistSource, 'Canonical build must preserve the chronology receipt source exactly');
assert.equal(CSV_HISTORY_ROLLING_12_TRANSITION_CHRONOLOGY_RECEIPT_SCHEMA_VERSION, 'csv-history-rolling-12-transition-chronology-receipt-v1');

const q1 = hex('1');
const q2 = hex('2');
const q3 = hex('3');
const first = board('2026-Q1-R12', '2026-Q2-R12', hex('a'), q1, q2, 12);
const second = board('2026-Q2-R12', '2026-Q3-R12', hex('b'), q2, q3, -4);

const receiptA = await buildHistoricalRolling12TransitionChronologyReceipt([{ board: first }, { board: second }]);
const receiptB = await buildHistoricalRolling12TransitionChronologyReceipt([{ board: first }, { board: second }]);
assert.equal(receiptA.receiptFingerprint, receiptB.receiptFingerprint);
assert.match(receiptA.receiptFingerprint, /^[a-f0-9]{64}$/);
assert.equal(receiptA.receiptPurpose, 'local_historical_rolling_12_transition_chronology_audit_only');
assert.equal(receiptA.deterministic.generatedTimestampIncluded, false);
assert.equal(receiptA.deterministic.chronologyProjectionReused, true);
assert.equal(receiptA.deterministic.orderedTransitionEvidenceBound, true);
assert.equal(receiptA.deterministic.ledgerContinuityEvidenceBound, true);
assert.equal(receiptA.deterministic.blockedChronologyExportable, true);
assert.equal(receiptA.chronology.chronologyAllowed, true);
assert.equal(receiptA.source.transitionCount, 2);
assert.equal(receiptA.source.transitionBindings[0].receiptFingerprint, hex('a'));
assert.equal(receiptA.source.transitionBindings[1].previousLedgerFingerprint, q2);
assert.equal(receiptA.authority.authoritative, false);
assert.equal(receiptA.authority.executionAuthorized, false);
assert.equal(receiptA.authority.amazonMutationAuthorized, false);
assert.equal(Object.isFrozen(receiptA), true);

const serializedA = serializeHistoricalRolling12TransitionChronologyReceipt(receiptA);
const serializedB = serializeHistoricalRolling12TransitionChronologyReceipt(receiptB);
assert.equal(serializedA, serializedB);
assert.equal(serializedA.includes('generatedAt'), false);
assert.equal(serializedA.includes('timestamp'), false);

const validated = await validateHistoricalRolling12TransitionChronologyReceipt(receiptA);
assert.equal(validated.receiptFingerprint, receiptA.receiptFingerprint);
const parsed = await parseHistoricalRolling12TransitionChronologyReceipt(serializedA);
assert.equal(parsed.receiptFingerprint, receiptA.receiptFingerprint);

const sourceTampered = structuredClone(receiptA);
sourceTampered.source.transitionBindings[1].previousLedgerFingerprint = hex('f');
await assert.rejects(
  () => validateHistoricalRolling12TransitionChronologyReceipt(sourceTampered),
  (error) => error?.code === 'CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_SOURCE_BINDING_MISMATCH',
);

const chronologyTampered = structuredClone(receiptA);
chronologyTampered.chronology.automaticTrendInferenceApplied = true;
await assert.rejects(
  () => validateHistoricalRolling12TransitionChronologyReceipt(chronologyTampered),
  (error) => error?.code === 'CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_INTEGRITY_BOUNDARY_INVALID',
);

const fingerprintTampered = structuredClone(receiptA);
fingerprintTampered.receiptFingerprint = hex('f');
await assert.rejects(
  () => validateHistoricalRolling12TransitionChronologyReceipt(fingerprintTampered),
  (error) => error?.code === 'CSV_HISTORY_R12_CHRONOLOGY_RECEIPT_FINGERPRINT_MISMATCH',
);

const blockedSecond = board('2026-Q2-R12', '2026-Q3-R12', hex('c'), q2, q3, 7, { receiptFingerprintMatch: false });
const blockedReceipt = await buildHistoricalRolling12TransitionChronologyReceipt([{ board: first }, { board: blockedSecond }]);
assert.equal(blockedReceipt.chronology.chronologyAllowed, false);
assert.equal(blockedReceipt.chronology.rawEvidenceOnly, true);
assert.equal(blockedReceipt.chronology.transitions[0].metrics[0].rolling12Delta, null);
assert.equal(blockedReceipt.chronology.transitions[1].metrics[0].movementDirection, 'withheld_not_comparable');
assert.equal(blockedReceipt.deterministic.blockedChronologyExportable, true);
await validateHistoricalRolling12TransitionChronologyReceipt(blockedReceipt);

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
]) assert.equal(pattern.test(receiptSource), false, `Chronology receipt must remain explicit-local and execution-free: ${pattern}`);

assert.match(receiptSource, /fingerprintDeterministicReceiptPayload/);
assert.match(receiptSource, /serializeDeterministicReceiptJson/);
assert.match(receiptSource, /generatedTimestampIncluded: false/);
assert.match(receiptSource, /orderedTransitionEvidenceBound: true/);
assert.match(receiptSource, /ledgerContinuityEvidenceBound: true/);
assert.match(receiptSource, /automaticTrendInferenceApplied: false/);
assert.match(receiptSource, /recommendationGenerated: false/);
assert.match(receiptSource, /actionGenerated: false/);
assert.doesNotMatch(receiptSource, /\.sort\s*\(/);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-history-rolling-12-transition-chronology-receipt-v1',
  deterministicReceiptFingerprint: true,
  deterministicSerialization: true,
  generatedTimestampIncluded: false,
  orderedTransitionEvidenceBound: true,
  ledgerContinuityEvidenceBound: true,
  blockedChronologyExportable: true,
  sourceTamperingBlocked: true,
  chronologyBoundaryTamperingBlocked: true,
  receiptFingerprintTamperingBlocked: true,
  crossWindowAggregationApplied: false,
  automaticTrendInferenceApplied: false,
  outcomeQualityJudgmentApplied: false,
  recommendationGenerated: false,
  actionGenerated: false,
  amazonLiveApiCalls: false,
  cloudflareWrites: false,
  d1RemoteWrites: false,
}, null, 2));
