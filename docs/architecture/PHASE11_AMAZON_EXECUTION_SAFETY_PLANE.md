# Phase 11 — Amazon Execution Safety Plane

Status: **IN PROGRESS / DORMANT**

This phase converts an approved governance action into a mutation that can eventually be executed exactly once and verified. It does **not** authorize Amazon Ads mutation by itself.

## Existing control-plane truth

The existing action ledger remains canonical:

`proposed → approved/rejected → applying → applied/failed/reverted`

Phase 11 does not create a parallel recommendation/action lifecycle. `optimization_actions` and `optimization_action_events` remain the governance and lifecycle source of truth.

`Governance Approved != Amazon Executed` remains mandatory.

## New execution evidence

Store D1 migration `0016_store_execution_safety_plane.sql` adds three independent evidence classes:

1. `optimization_execution_permits`
   - single-use permit identity
   - exact action/profile/entity/action-type binding
   - request, target and execution fingerprints
   - issued/consumed/expired/revoked lifecycle
   - at most one `issued` permit per action + transition
   - binding fields cannot be modified after issuance
   - permit rows cannot be deleted

2. `optimization_execution_receipts`
   - exactly one transport receipt per permit
   - request/response content hashes instead of credentials or secret-bearing headers
   - external request ID when available
   - transport outcome and retry disposition
   - immutable after insert

3. `optimization_execution_verifications`
   - Amazon read-back evidence
   - expected versus observed execution fingerprint
   - confirmed/mismatch/not-found/unknown result
   - immutable after insert

A transport receipt is not sufficient to mark an action `applied`. A confirmed read-back verification is required.

## Deterministic execution contract

`cloudflare/runtime/amazon-action-execution-safety.js` enforces:

- only `approved` actions can form a valid execution plan;
- actions with existing external execution markers fail closed;
- only explicitly allowlisted logical mutation types are considered;
- exact destination scope must already be frozen in the approved action snapshot;
- request, target and execution fingerprints must remain stable;
- a consumed/expired/revoked/mismatched permit cannot be reused;
- an external request that may have been dispatched is never blindly retried;
- a successful HTTP transport response still requires Amazon read-back confirmation;
- rollback is never automatic: compensation requires a separately governed action.

## Current logical allowlist

The safety plane recognizes the product's two current recommendation actions:

- `negative_keyword.create`
- `keyword.create`

This is a **logical allowlist only**. It is not yet a network endpoint allowlist.

## Endpoint mapping remains blocking

The current public Amazon Ads material confirms Sponsored Products keyword and negative-targeting concepts, but the exact current API reference schema for the keyword/negative-keyword mutation operations has not been verified from an authoritative reference document in this implementation batch.

Therefore the safety plane intentionally keeps:

- `endpointPath = null`
- `endpointMappingVerified = false`
- `permitIssuanceReady = false`
- `networkDispatchAuthorized = false`

Do not guess a legacy endpoint or request schema to accelerate this phase.

## Destination-scope gap

Current recommendation snapshots created before the execution-safety update contain the proposed keyword text/match type but do not necessarily freeze `campaignId`, `adGroupId`, and mutation scope into the approved action payload.

Those actions are **not executable** and must fail with `destination_scope_not_frozen`.

Do not backfill existing approved actions from mutable current entity state. A future executable action must be proposed and approved with the exact destination scope already frozen into its immutable request fingerprint.

## Retry policy

Before dispatch:

`request_not_dispatched → retry_before_dispatch`

After any possible dispatch:

`accepted / 5xx / connection-loss-after-dispatch → readback_required`

A deterministic client rejection may be classified as `not_retryable`.

No unrestricted automatic retry is allowed for a mutation with an unknown external outcome.

## Applied-state rule

An action may transition to `applied` only when all of the following are true:

1. action was approved;
2. valid single-use permit matched the frozen execution fingerprints;
3. transport receipt was durably recorded;
4. Amazon read-back was performed;
5. verification result is `confirmed`;
6. receipt, verification, and execution-plan fingerprints match.

## Remaining work before Phase 11 COMPLETE

- freeze campaign/ad-group execution destination into newly proposed recommendation actions;
- verify the current Amazon Ads mutation endpoint and request/response schemas from authoritative Amazon API reference material;
- freeze `actionType → Amazon capability/endpoint/schema` mapping;
- add permit issuance/consumption APIs with RBAC and explicit execution enablement;
- add mutation transport that is impossible to call while `AMAZON_ADS_ENABLED=false`;
- add durable receipt recording around the external request boundary;
- add read-back adapter and reconciliation path;
- integrate `applying/applied/failed` transitions only after the above contracts are satisfied;
- keep the first real execution limited to one store, one profile, one action, one permit, one external mutation.
