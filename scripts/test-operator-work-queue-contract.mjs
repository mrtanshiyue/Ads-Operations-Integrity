import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  OPERATOR_WORK_QUEUE_AUTHORITY,
  OPERATOR_WORK_QUEUE_SCHEMA_VERSION,
  buildOperatorWorkQueue,
  buildOperatorWorkQueueRow,
} from '../cloudflare/runtime/operator-work-queue.js';

const range = { startDate: '2026-06-01', endDate: '2026-06-02' };
const base = {
  evidenceState: 'available',
  unavailable: false,
  recommendationCandidateCount: 12,
  criticalHighCandidateCount: 12,
  unreviewedCount: 12,
  needsReviewCount: 0,
  acknowledgedCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
  resolvedCount: 0,
  staleReviewEvidenceCount: 0,
  highUnreviewedCount: 12,
  analysisScopeComplete: true,
  financiallyComparable: true,
  candidateEmissionAuthorized: true,
};

assert.equal(OPERATOR_WORK_QUEUE_SCHEMA_VERSION, 'daily-operator-work-queue-v1');
assert.deepEqual(OPERATOR_WORK_QUEUE_AUTHORITY, {
  readOnly: true,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

const operationsHealthSource = await readFile(new URL('../assets/cloudflare-native-operations-health-v1.js', import.meta.url), 'utf8');
assert.match(
  operationsHealthSource,
  /row\.needsReviewCount === 0 && row\.staleReviewEvidenceCount === 0 && row\.highUnreviewedCount === 0 && row\.otherUnreviewedCount === 0/,
  'stale-review-only work queue rows must keep Open Decision Queue actionable',
);
assert.match(
  operationsHealthSource,
  /requestSerial: 0, decisionSerial: 0, auditSerial: 0/,
  'operations health must track audit request ownership independently',
);
assert.match(
  operationsHealthSource,
  /const auditStoreId = state\.storeId;\s*const auditSerial = \+\+state\.auditSerial;/,
  'cross-store refresh must capture the audit store and generation before awaiting',
);
assert.match(
  operationsHealthSource,
  /if \(serial !== state\.auditSerial \|\| storeId !== state\.storeId\) return;/,
  'late audit responses must not overwrite the currently selected store',
);
assert.match(
  operationsHealthSource,
  /querySelector\('#cfOpsDecisionStart'\)\?\.addEventListener\('change', invalidateDecisionScope\)/,
  'changing Work Queue start date must invalidate previously loaded authoritative rows',
);
assert.match(
  operationsHealthSource,
  /querySelector\('#cfOpsDecisionEnd'\)\?\.addEventListener\('change', invalidateDecisionScope\)/,
  'changing Work Queue end date must invalidate previously loaded authoritative rows',
);
assert.match(
  operationsHealthSource,
  /function invalidateDecisionScope\(\) \{[\s\S]*state\.decisionSerial \+= 1;[\s\S]*state\.decisionRows = \[\];[\s\S]*state\.operatorWorkRows = \[\];[\s\S]*state\.decisionRange = null;/,
  'Work Queue date edits must revoke the prior request generation and clear stale rows/range',
);
assert.match(
  operationsHealthSource,
  /function applyDecisionScopeRange\(panel, range\) \{[\s\S]*const changedControls = \[\];[\s\S]*control\.value = nextValue;[\s\S]*for \(const control of changedControls\) control\.dispatchEvent\(new global\.Event\('change', \{ bubbles: true \}\)\);/,
  'Work Queue launcher must propagate explicit dates through the existing Decision scope change lifecycle',
);
assert.match(
  operationsHealthSource,
  /const decisionApi = global\.CloudflareDecisionIntelligence;[\s\S]*typeof decisionApi\.open === 'function'[\s\S]*await decisionApi\.open\(\)/,
  'Work Queue launcher must use the canonical Decision Intelligence open API when available',
);
assert.match(
  operationsHealthSource,
  /panel\.querySelector\('\[data-tab="intelligence"\]'\)\?\.click\(\)/,
  'Open Decision Queue must land on the Intelligence tab rather than preserving a stale Action Inbox tab',
);
assert.doesNotMatch(
  operationsHealthSource,
  /if \(start\) start\.value = state\.decisionRange\.startDate; if \(end\) end\.value = state\.decisionRange\.endDate;/,
  'launcher must not bypass Decision scope-change lifecycle with direct date assignment',
);

const operatorContextSource = await readFile(new URL('../assets/cloudflare-native-operator-context-v1.js', import.meta.url), 'utf8');
assert.match(
  operatorContextSource,
  /let changed = false;\s*let storeChanged = false;/,
  'shared operator context must distinguish store transitions from product and keyword transitions',
);
assert.match(
  operatorContextSource,
  /if \(storeChanged\) syncWorkspaceStore\(next\.storeId\);/,
  'programmatic store navigation must propagate into the canonical Operator Workspace store selector',
);
assert.match(
  operatorContextSource,
  /select\.dispatchEvent\(new global\.Event\('change', \{ bubbles: true \}\)\);/,
  'canonical store propagation must emit the existing workspace store-change lifecycle',
);

const queue = buildOperatorWorkQueue({
  generatedAt: '2026-08-23T00:00:00.000Z',
  dateRange: range,
  stores: [
    { ...base, storeId: 'store-04', storeCode: 'STORE04', unreviewedCount: 0, highUnreviewedCount: 0, recommendationCandidateCount: 0, criticalHighCandidateCount: 0 },
    { ...base, storeId: 'store-03', storeCode: 'STORE03', highUnreviewedCount: 5 },
    { ...base, storeId: 'store-02', storeCode: 'STORE02', staleReviewEvidenceCount: 2, unreviewedCount: 10, highUnreviewedCount: 10 },
    { ...base, storeId: 'store-01', storeCode: 'STORE01', needsReviewCount: 2, unreviewedCount: 10, highUnreviewedCount: 10 },
    { storeId: 'store-05', storeCode: 'STORE05', evidenceState: 'unavailable', unavailable: true, error: { code: 'snapshot_failed' } },
  ],
});

assert.equal(queue.schemaVersion, 'daily-operator-work-queue-v1');
assert.deepEqual(queue.requestedDateRange, range);
assert.deepEqual(queue.authority, OPERATOR_WORK_QUEUE_AUTHORITY);
assert.deepEqual(queue.rows.map((row) => row.queueClass), [
  'authoritative_read_failure',
  'stale_review_evidence',
  'needs_review',
  'high_unreviewed',
  'no_active_queue',
]);
assert.deepEqual(queue.rows.map((row) => row.priority), [1, 2, 2, 3, 5]);
assert.equal(queue.rows[0].recommendationCandidateCount, null, 'unavailable evidence must remain null');
assert.equal(queue.rows[1].otherUnreviewedCount, 0);
assert.equal(queue.rows[2].otherUnreviewedCount, 0);
assert.equal(queue.rows[3].otherUnreviewedCount, 7, 'other count is authoritative unreviewed minus high unreviewed');
assert.equal(queue.rows[0].authority.executionAuthorized, false);
assert.equal(queue.rows[0].authority.amazonMutationAuthorized, false);

const other = buildOperatorWorkQueueRow({
  ...base,
  storeId: 'store-other',
  storeCode: 'STORE06',
  recommendationCandidateCount: 5,
  criticalHighCandidateCount: 0,
  unreviewedCount: 5,
  highUnreviewedCount: 0,
}, range);
assert.equal(other.queueClass, 'other_unreviewed');
assert.equal(other.priority, 4);
assert.equal(other.otherUnreviewedCount, 5);

const acknowledged = buildOperatorWorkQueueRow({
  ...base,
  storeId: 'store-ack',
  storeCode: 'STORE07',
  recommendationCandidateCount: 2,
  criticalHighCandidateCount: 0,
  unreviewedCount: 0,
  highUnreviewedCount: 0,
  acknowledgedCount: 2,
}, range);
assert.equal(acknowledged.queueClass, 'acknowledged_only');
assert.equal(acknowledged.priority, 5);

const resolved = buildOperatorWorkQueueRow({
  ...base,
  storeId: 'store-resolved',
  storeCode: 'STORE07B',
  recommendationCandidateCount: 2,
  criticalHighCandidateCount: 0,
  unreviewedCount: 0,
  highUnreviewedCount: 0,
  approvedCount: 1,
  rejectedCount: 1,
  resolvedCount: 2,
}, range);
assert.equal(resolved.queueClass, 'no_active_queue');
assert.equal(resolved.reasonCode, 'final_disposition_only');
assert.equal(resolved.resolvedCount, 2);
assert.match(resolved.reasonText, /final Human Review dispositions/);

const emissionBlocked = buildOperatorWorkQueueRow({
  ...base,
  storeId: 'store-blocked',
  storeCode: 'STORE08',
  recommendationCandidateCount: 0,
  criticalHighCandidateCount: 0,
  unreviewedCount: 0,
  highUnreviewedCount: 0,
  candidateEmissionAuthorized: false,
}, range);
assert.equal(emissionBlocked.queueClass, 'no_active_queue');
assert.equal(emissionBlocked.reasonCode, 'candidate_emission_not_authorized');
assert.match(emissionBlocked.reasonText, /does not authorize recommendation candidate emission/);

const inconsistent = buildOperatorWorkQueueRow({
  ...base,
  storeId: 'store-gap',
  storeCode: 'STORE09',
  recommendationCandidateCount: 1,
  criticalHighCandidateCount: 1,
  unreviewedCount: 1,
  highUnreviewedCount: 2,
}, range);
assert.equal(inconsistent.queueClass, 'evidence_gap');
assert.equal(inconsistent.priority, 1);
assert.equal(inconsistent.highUnreviewedCount, null, 'inconsistent evidence must fail closed rather than clamp');
assert.equal(inconsistent.financiallyComparable, null);

const missingComparable = buildOperatorWorkQueueRow({
  ...base,
  storeId: 'store-null',
  storeCode: 'STORE10',
  financiallyComparable: null,
}, range);
assert.equal(missingComparable.queueClass, 'evidence_gap');
assert.equal(missingComparable.recommendationCandidateCount, null);

const tie = buildOperatorWorkQueue({
  dateRange: range,
  stores: [
    { ...base, storeId: 'b', storeCode: 'STORE02', needsReviewCount: 1, unreviewedCount: 11, highUnreviewedCount: 11 },
    { ...base, storeId: 'a', storeCode: 'STORE01', needsReviewCount: 3, unreviewedCount: 9, highUnreviewedCount: 9 },
    { ...base, storeId: 'c', storeCode: 'STORE03', staleReviewEvidenceCount: 1 },
  ],
});
assert.deepEqual(tie.rows.map((row) => row.storeCode), ['STORE03', 'STORE01', 'STORE02'],
  'P2 tie-break is stale class first, then salient count descending, then deterministic store code');

console.log('operator work queue contract: PASS');
