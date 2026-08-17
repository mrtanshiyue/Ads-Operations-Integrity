# Phase 11 — Amazon Execution Safety Plane

Status: **COMPLETE / DORMANT**

Verified: **2026-08-17**

Phase 11 converts an approved governance action into a deterministic, single-use, externally receipted and read-back-verified execution path. Completion of this phase does **not** authorize Amazon Ads mutation. Real execution remains a separate Phase 12 controlled activation decision.

## Canonical safety invariant

`Governance Approved != Amazon Executed`

The existing action ledger remains canonical:

`proposed → approved/rejected → applying → applied/failed/reverted`

There is no parallel recommendation lifecycle. `optimization_actions` and `optimization_action_events` remain the governance and lifecycle source of truth.

## Completed dormant execution chain

Phase 11 now freezes the following chain:

`approved recommendation`
→ `operator execution readiness`
→ `dry-run execution plan`
→ `frozen destination`
→ `request fingerprint`
→ `target fingerprint`
→ `execution fingerprint`
→ `single-use execution permit`
→ `TTL / fingerprint binding`
→ `one-time permit consumption`
→ `deterministic Amazon Unified mutation envelope`
→ `canonical request SHA-256`
→ `dormant dispatch guard`
→ `HTTP / 207 outcome classification`
→ `immutable execution receipt`
→ `response SHA-256`
→ `Amazon Unified target read-back`
→ `exact logical entity correlation`
→ `target fingerprint verification`
→ `immutable verification`
→ `confirmed-only applied finalization`

Post-dispatch ambiguity is never blindly retried. Read-back confirmation is mandatory before `applied`.

## Durable execution evidence

Store D1 migration `0016_store_execution_safety_plane.sql` provides:

1. `optimization_execution_permits` — single-use action/profile/entity/fingerprint-bound permits.
2. `optimization_execution_receipts` — immutable external transport receipts.
3. `optimization_execution_verifications` — immutable Amazon read-back verification evidence.

Receipts and verifications are immutable. A transport receipt by itself is never sufficient to mark an action `applied`.

## Official Amazon Unified target contract

The authoritative mapping source is Amazon's repository:

- repository: `amzn/ads-advanced-tools-docs`
- collection: `postman/Amazon_Ads_Unified_API.postman_collection.json`
- API family: Amazon Ads Unified API
- operation: `POST /adsApi/v1/create/targets`
- verified: `2026-08-17`

For the currently allowed mutation, the frozen target shape is:

- `adProduct = SPONSORED_PRODUCTS`
- `targetType = KEYWORD`
- `targetLevel = AD_GROUP`
- `negative = true`
- `state = ENABLED`
- keyword text from the frozen action destination
- match type `EXACT` or `PHRASE`

The operation returns HTTP `207` multi-status with `error`, `partialSuccess`, and `success` arrays. Phase 11 classifies the single entity result at index `0`; a bare HTTP 207 is not treated as business success.

## Unified request-ID observability contract

The final Phase 11 blocker was `amazon_unified_request_id_header_unverified`.

Authoritative review of Amazon's Unified `POST /adsApi/v1/create/targets` example establishes the safe contract boundary:

- the official 207 example does not define a request-ID response header;
- the official 207 body does not define a request-ID field;
- therefore there is no authoritative Unified request-ID extractor that can be frozen from the verified material;
- legacy Amazon Ads header names are not transferable evidence for the Unified endpoint and must not be guessed.

The runtime contract is therefore:

- `authoritativeExtractionAvailable=false`
- `authoritativeHeaderName=null`
- `authoritativeBodyField=null`
- `extractionPolicy=explicit_transport_evidence_only`
- `receiptFieldRequired=false`
- `receiptFieldNullable=true`
- `legacyHeaderInferenceAllowed=false`
- `safetyGate=false`

`amazonRequestId` may be persisted only when an upstream transport layer can provide it as explicit authoritative evidence. Otherwise the immutable receipt records `amazon_request_id = NULL`.

This is an observability limitation, not a mutation-integrity gap. Execution identity and reconciliation remain bound by the single-use permit, request/target/execution fingerprints, canonical request SHA-256, immutable response SHA-256, exact Amazon target read-back, and confirmed-only finalization.

If Amazon later publishes an authoritative Unified request-ID contract, it may be added as an observability enhancement without weakening or bypassing the existing safety chain.

## Negative keyword create — frozen execution scope

Current allowed mutation mapping:

- action type: `negative_keyword.create`
- scope: `ad_group`
- endpoint: `POST /adsApi/v1/create/targets`
- contract: `amazon-ads-unified-target-v1-2026-08-17`
- match types: `EXACT`, `PHRASE`

A valid approved action under this exact frozen contract may become permit-issuance-ready. That does not issue a permit and does not authorize network dispatch.

Historical actions are not auto-upgraded. An older approved action that lacks the frozen Amazon mutation contract remains non-executable and requires a fresh proposal and fresh approval.

## Positive keyword remains excluded

`keyword.create` remains execution-blocked:

- blocking reason: `positive_keyword_bid_mapping_unverified`
- `permitIssuanceReady=false`

Phase 11 completion does not require positive keyword execution. Positive keyword support is explicitly outside the first controlled execution scope and must not silently drop or guess bid semantics.

## Retry / 207 policy

Before dispatch:

`request_not_dispatched → retry_before_dispatch`

For Unified Create Target HTTP 207:

- entity index 0 in `error` → deterministic rejection / no retry;
- entity index 0 in `partialSuccess` → unknown / read-back required;
- entity index 0 in `success` → transport accepted / read-back required;
- malformed or missing entity result → unknown / read-back required.

For connection loss, 5xx, or any state where dispatch may have happened:

`readback_required`

There is no unrestricted automatic retry after a possible mutation dispatch.

## Applied-state rule

An action may transition to `applied` only when all required execution invariants are satisfied, including:

1. approved action under the frozen execution contract;
2. valid single-use permit bound to request/target/execution fingerprints;
3. immutable transport receipt;
4. Amazon read-back;
5. verification result `confirmed`;
6. matching receipt, verification and execution-plan fingerprints.

Amazon request ID is not an `applied` gate because the verified Unified contract does not authoritatively expose an extraction field.

## Phase 11 completion audit

The Phase 11 completion audit is PASS for:

- operator execution readiness;
- permit lifecycle and TTL;
- request fingerprint;
- target fingerprint;
- execution fingerprint;
- canonical request SHA-256;
- HTTP 207 classification;
- request-ID no-guessing / nullable observability contract;
- immutable receipt;
- response SHA-256;
- target read-back;
- exact entity verification;
- unknown outcome policy;
- no blind retry;
- confirmed-only finalization;
- positive keyword still blocked;
- network dispatch still dormant.

Therefore:

**Phase 11 = COMPLETE**

## Phase 12 boundary

Phase 12 is **not started by this document**.

Phase 11 completion does not enable `AMAZON_ADS_ENABLED`, does not enable `SYNC_TRIGGER_ENABLED`, does not issue a real permit, and does not perform a real mutation.

The next phase may authorize only the separately governed controlled single-mutation scope: one store, one profile, one campaign, one ad group, one approved `negative_keyword.create` action, one permit, one Amazon mutation request, and one read-back verification.
