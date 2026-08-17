import assert from 'node:assert/strict';
import {
  AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
  buildExecutionPlan,
} from '../cloudflare/runtime/amazon-action-execution-safety.js';
import {
  AMAZON_UNIFIED_REQUEST_ID_OBSERVABILITY_CONTRACT,
  buildDormantNegativeKeywordMutationEnvelope,
  buildDormantTransportReceiptEvidence,
  evaluateDormantDispatchGuard,
  normalizeAmazonRequestId,
} from '../cloudflare/runtime/amazon-negative-keyword-mutation-adapter.js';
import {
  consumeSingleUseExecutionPermit,
  issueSingleUseExecutionPermit,
} from '../cloudflare/runtime/optimization-execution-control-plane.js';

class FakePermitDb {
  constructor() {
    this.rows = [];
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async first() {
            if (sql.includes('WHERE permit_id=?1')) {
              return clone(db.rows.find((row) => row.permit_id === args[0]) || null);
            }
            if (sql.includes("WHERE action_id=?1 AND transition='apply' AND state='issued'")) {
              return clone(db.rows.find((row) => row.action_id === args[0] && row.transition === 'apply' && row.state === 'issued') || null);
            }
            throw new Error(`Unsupported fake first SQL: ${sql}`);
          },
          async run() {
            if (sql.includes('INSERT INTO optimization_execution_permits')) {
              const [permitId, actionId, profileId, entityType, entityId, actionType, requestFp, targetFp, executionFp, issuedBy, issuedAt, expiresAt] = args;
              if (db.rows.some((row) => row.action_id === actionId && row.transition === 'apply' && row.state === 'issued')) {
                throw new Error('UNIQUE constraint failed');
              }
              db.rows.push({
                permit_id: permitId,
                action_id: actionId,
                transition: 'apply',
                profile_id: profileId,
                entity_type: entityType,
                entity_id: entityId,
                action_type: actionType,
                request_fingerprint: requestFp,
                target_fingerprint: targetFp,
                execution_fingerprint: executionFp,
                state: 'issued',
                issued_by: issuedBy,
                issued_at: issuedAt,
                expires_at: expiresAt,
                consumed_at: null,
                consumed_by: null,
                revoked_at: null,
                revoked_by: null,
                revoke_reason: null,
                created_at: issuedAt,
              });
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET state='expired'")) {
              let changes = 0;
              for (const row of db.rows) {
                if (row.action_id === args[0] && row.transition === 'apply' && row.state === 'issued' && row.expires_at <= args[1]) {
                  row.state = 'expired';
                  changes += 1;
                }
              }
              return { meta: { changes } };
            }
            if (sql.includes("SET state='consumed'")) {
              const row = db.rows.find((item) => item.permit_id === args[0] && item.state === 'issued' && item.expires_at > args[1]);
              if (!row) return { meta: { changes: 0 } };
              row.state = 'consumed';
              row.consumed_at = args[1];
              row.consumed_by = args[2];
              return { meta: { changes: 1 } };
            }
            throw new Error(`Unsupported fake run SQL: ${sql}`);
          },
        };
      },
    };
  }
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

assert.equal(AMAZON_UNIFIED_REQUEST_ID_OBSERVABILITY_CONTRACT.authoritativeExtractionAvailable, false);
assert.equal(AMAZON_UNIFIED_REQUEST_ID_OBSERVABILITY_CONTRACT.authoritativeHeaderName, null);
assert.equal(AMAZON_UNIFIED_REQUEST_ID_OBSERVABILITY_CONTRACT.authoritativeBodyField, null);
assert.equal(AMAZON_UNIFIED_REQUEST_ID_OBSERVABILITY_CONTRACT.extractionPolicy, 'explicit_transport_evidence_only');
assert.equal(AMAZON_UNIFIED_REQUEST_ID_OBSERVABILITY_CONTRACT.receiptFieldRequired, false);
assert.equal(AMAZON_UNIFIED_REQUEST_ID_OBSERVABILITY_CONTRACT.receiptFieldNullable, true);
assert.equal(AMAZON_UNIFIED_REQUEST_ID_OBSERVABILITY_CONTRACT.legacyHeaderInferenceAllowed, false);
assert.equal(AMAZON_UNIFIED_REQUEST_ID_OBSERVABILITY_CONTRACT.safetyGate, false);
assert.equal(normalizeAmazonRequestId(null), null);
assert.equal(normalizeAmazonRequestId('  request-authoritative-01  '), 'request-authoritative-01');

const requestFingerprint = 'a'.repeat(64);
const action = {
  action_id: 'act_phase11_test',
  profile_id: 'profile-test-01',
  entity_type: 'search_term',
  entity_id: 'search-term-row-01',
  action_type: 'negative_keyword.create',
  status: 'approved',
  external_request_id: null,
  applied_at: null,
  proposed_json: JSON.stringify({
    keywordText: 'blue light reading glasses',
    matchType: 'EXACT',
    scope: 'ad_group',
    campaignId: 'campaign-01',
    adGroupId: 'ad-group-01',
    executionDestinationContract: 'search-term-ad-group-v1',
    amazonMutationContract: AMAZON_UNIFIED_TARGET_CONTRACT_VERSION,
  }),
  rationale_json: JSON.stringify({ governance: { requestFingerprint } }),
};

const plan = await buildExecutionPlan({ storeId: 'store-test-01', action });
assert.equal(plan.valid, true);
assert.equal(plan.action.actionType, 'negative_keyword.create');
assert.equal(plan.mutation.endpointMappingVerified, true);
assert.equal(plan.permitIssuanceReady, true);
assert.equal(plan.networkDispatchAuthorized, false);
assert.equal(plan.targetFingerprint.length, 64);
assert.equal(plan.executionFingerprint.length, 64);

const envelope = await buildDormantNegativeKeywordMutationEnvelope(plan);
assert.equal(envelope.ready, true);
assert.equal(envelope.method, 'POST');
assert.equal(envelope.endpointPath, '/adsApi/v1/create/targets');
assert.equal(envelope.requestBodySha256.length, 64);
assert.equal(envelope.body.targets.length, 1);
assert.equal(envelope.body.targets[0].negative, true);
assert.equal(envelope.body.targets[0].adProduct, 'SPONSORED_PRODUCTS');
assert.equal(envelope.body.targets[0].targetType, 'KEYWORD');
assert.equal(envelope.body.targets[0].targetDetails.keywordTarget.matchType, 'EXACT');
assert.equal(envelope.networkDispatchAuthorized, false);

const guardDisabled = evaluateDormantDispatchGuard({ env: { AMAZON_ADS_ENABLED: 'false' }, envelope });
assert.equal(guardDisabled.allowed, false);
assert.ok(guardDisabled.errors.includes('amazon_ads_disabled'));
assert.ok(guardDisabled.errors.includes('phase11_network_dispatch_dormant'));

const guardEvenIfFlagTrue = evaluateDormantDispatchGuard({
  env: { AMAZON_ADS_ENABLED: 'true' },
  envelope,
  permitConsumption: { consumed: true, permit: { state: 'consumed' } },
});
assert.equal(guardEvenIfFlagTrue.allowed, false);
assert.ok(guardEvenIfFlagTrue.errors.includes('phase11_network_dispatch_dormant'));

const successEvidence = await buildDormantTransportReceiptEvidence({
  dispatched: true,
  httpStatus: 207,
  amazonRequestId: 'request-01',
  responseBody: JSON.stringify({ error: [], partialSuccess: [], success: [{ index: 0, targetId: 'target-01' }] }),
});
assert.equal(successEvidence.transportOutcome, 'accepted');
assert.equal(successEvidence.retryDisposition, 'readback_required');
assert.equal(successEvidence.readbackRequired, true);
assert.equal(successEvidence.amazonRequestId, 'request-01');
assert.equal(successEvidence.responseBodySha256.length, 64);

const successWithoutAuthoritativeRequestId = await buildDormantTransportReceiptEvidence({
  dispatched: true,
  httpStatus: 207,
  responseBody: JSON.stringify({ error: [], partialSuccess: [], success: [{ index: 0, targetId: 'target-01' }] }),
});
assert.equal(successWithoutAuthoritativeRequestId.amazonRequestId, null);
assert.equal(successWithoutAuthoritativeRequestId.transportOutcome, 'accepted');
assert.equal(successWithoutAuthoritativeRequestId.retryDisposition, 'readback_required');
assert.equal(successWithoutAuthoritativeRequestId.readbackRequired, true);

const partialEvidence = await buildDormantTransportReceiptEvidence({
  dispatched: true,
  httpStatus: 207,
  responseBody: JSON.stringify({ error: [], partialSuccess: [{ index: 0 }], success: [] }),
});
assert.equal(partialEvidence.transportOutcome, 'unknown');
assert.equal(partialEvidence.retryDisposition, 'readback_required');

const errorEvidence = await buildDormantTransportReceiptEvidence({
  dispatched: true,
  httpStatus: 207,
  responseBody: JSON.stringify({ error: [{ index: 0, errors: [{ code: 'INVALID' }] }], partialSuccess: [], success: [] }),
});
assert.equal(errorEvidence.transportOutcome, 'rejected');
assert.equal(errorEvidence.retryDisposition, 'not_retryable');
assert.equal(errorEvidence.readbackRequired, false);

const db = new FakePermitDb();
const now = new Date('2026-08-17T09:10:00.000Z');
const firstIssue = await issueSingleUseExecutionPermit({
  db,
  actorId: 'user-owner',
  action,
  plan,
  now,
});
assert.equal(firstIssue.issued, true);
assert.equal(firstIssue.idempotentReuse, false);
assert.equal(firstIssue.permit.state, 'issued');
assert.equal(firstIssue.permit.singleUse, true);
assert.equal(firstIssue.permit.networkDispatchAuthorized, false);
assert.equal(Date.parse(firstIssue.permit.expiresAt) - Date.parse(firstIssue.permit.issuedAt), 300_000);

const secondIssue = await issueSingleUseExecutionPermit({
  db,
  actorId: 'user-owner',
  action,
  plan,
  now: new Date('2026-08-17T09:11:00.000Z'),
});
assert.equal(secondIssue.issued, true);
assert.equal(secondIssue.idempotentReuse, true);
assert.equal(secondIssue.permit.permitId, firstIssue.permit.permitId);

const driftedPlan = { ...plan, executionFingerprint: 'b'.repeat(64) };
const driftedIssue = await issueSingleUseExecutionPermit({
  db,
  actorId: 'user-owner',
  action,
  plan: driftedPlan,
  now: new Date('2026-08-17T09:11:30.000Z'),
});
assert.equal(driftedIssue.issued, false);
assert.deepEqual(driftedIssue.errors, ['issued_permit_binding_conflict']);

const consumed = await consumeSingleUseExecutionPermit({
  db,
  actorId: 'user-owner',
  permitId: firstIssue.permit.permitId,
  plan,
  now: new Date('2026-08-17T09:12:00.000Z'),
});
assert.equal(consumed.consumed, true);
assert.equal(consumed.permit.state, 'consumed');
assert.equal(consumed.networkDispatchAuthorized, false);

const consumedAgain = await consumeSingleUseExecutionPermit({
  db,
  actorId: 'user-owner',
  permitId: firstIssue.permit.permitId,
  plan,
  now: new Date('2026-08-17T09:12:10.000Z'),
});
assert.equal(consumedAgain.consumed, false);
assert.ok(consumedAgain.errors.includes('permit_not_issued'));

const keywordAction = {
  ...action,
  action_id: 'act_positive_keyword_test',
  action_type: 'keyword.create',
  proposed_json: JSON.stringify({
    keywordText: 'reading glasses',
    matchType: 'EXACT',
    bidMicros: 2500000,
    scope: 'ad_group',
    campaignId: 'campaign-01',
    adGroupId: 'ad-group-01',
    executionDestinationContract: 'search-term-ad-group-v1',
  }),
};
const keywordPlan = await buildExecutionPlan({ storeId: 'store-test-01', action: keywordAction });
assert.equal(keywordPlan.permitIssuanceReady, false);
assert.equal(keywordPlan.mutation.blockingReason, 'positive_keyword_bid_mapping_unverified');

console.log(JSON.stringify({
  ok: true,
  contract: 'phase11-execution-safety-v1',
  negativeKeywordUnifiedRequest: true,
  requestBodySha256: true,
  http207Classification: true,
  requestIdObservabilityContract: 'authoritative_extraction_unavailable_no_guessing',
  requestIdReceiptFieldNullable: true,
  singleUsePermitIssuance: true,
  singleUsePermitConsumption: true,
  fingerprintDriftFailsClosed: true,
  positiveKeywordExecutionBlocked: true,
  networkDispatchAuthorized: false,
}, null, 2));
