# Phase 11 — Amazon Execution Safety Plane

Status: **IN PROGRESS / DORMANT**

This phase converts an approved governance action into a mutation that can eventually be executed exactly once and verified. It does **not** authorize Amazon Ads mutation by itself.

## Existing control-plane truth

The existing action ledger remains canonical:

`proposed → approved/rejected → applying → applied/failed/reverted`

Phase 11 does not create a parallel recommendation/action lifecycle. `optimization_actions` and `optimization_action_events` remain the governance and lifecycle source of truth.

`Governance Approved != Amazon Executed` remains mandatory.

## Durable execution evidence

Store D1 migration `0016_store_execution_safety_plane.sql` adds:

1. `optimization_execution_permits` — single-use action/profile/entity/fingerprint-bound permits.
2. `optimization_execution_receipts` — immutable external transport receipts.
3. `optimization_execution_verifications` — immutable Amazon read-back verification evidence.

A transport receipt is never sufficient to mark an action `applied`; confirmed read-back is required.

## Deterministic execution contract

`cloudflare/runtime/amazon-action-execution-safety.js` enforces:

- only `approved` actions can form a valid execution plan;
- exact destination scope is frozen before governance approval;
- request, target and execution fingerprints remain stable;
- consumed/expired/revoked/mismatched permits cannot be reused;
- possible post-dispatch ambiguity is never blindly retried;
- Amazon read-back is mandatory before `applied`;
- rollback is not automatic; compensation requires a separately governed action;
- `networkDispatchAuthorized=false` remains hard-coded in the dormant safety plane.

## Official Amazon Unified target contract

The authoritative mapping source is Amazon's own repository:

- repository: `amzn/ads-advanced-tools-docs`
- collection: `postman/Amazon_Ads_Unified_API.postman_collection.json`
- API family: Amazon Ads Unified API
- verified: `2026-08-17`

The official collection defines Create Target as:

`POST /adsApi/v1/create/targets`

with Amazon Ads authentication/account/scope headers and a JSON `targets` array. The same official collection's Sponsored Products target model identifies keyword targets as:

- `adProduct = SPONSORED_PRODUCTS`
- `targetType = KEYWORD`
- `targetLevel = AD_GROUP`
- `targetDetails.keywordTarget.keyword`
- `targetDetails.keywordTarget.matchType`
- `negative = true|false`

The create operation returns HTTP `207` multi-status with `error`, `partialSuccess`, and `success` arrays. Phase 11 therefore parses the single entity result at index `0`; it does not treat a bare HTTP 207 as business success.

## Negative keyword create — mapping verified for newly frozen actions

For `negative_keyword.create`, newly proposed actions freeze:

- `scope = ad_group`
- `campaignId`
- `adGroupId`
- `executionDestinationContract = search-term-ad-group-v1`
- `amazonMutationContract = amazon-ads-unified-target-v1-2026-08-17`

The deterministic mutation body is:

```json
{
  "targets": [
    {
      "adGroupId": "<frozen-ad-group-id>",
      "adProduct": "SPONSORED_PRODUCTS",
      "negative": true,
      "state": "ENABLED",
      "targetDetails": {
        "keywordTarget": {
          "keyword": "<frozen-keyword-text>",
          "matchType": "EXACT|PHRASE"
        }
      },
      "targetType": "KEYWORD"
    }
  ]
}
```

A valid approved negative-keyword action that carries this exact frozen mutation-contract version may report `permitIssuanceReady=true`. This means the deterministic permit binding is ready; it does **not** issue a permit or authorize network dispatch.

## Historical actions are not auto-upgraded

Finding the official endpoint does not expand the authority of actions approved before this contract was frozen.

An older action without `amazonMutationContract=amazon-ads-unified-target-v1-2026-08-17` remains:

- `endpointMappingVerified=false`
- `permitIssuanceReady=false`
- `networkDispatchAuthorized=false`

Do not backfill historical approved actions with current mutable state or a newly discovered API contract. A fresh proposal and fresh operator approval are required.

## Positive keyword create remains blocked

`keyword.create` remains logically allowlisted but execution-blocked because the exact Unified API bid representation for the product's optional `bidMicros` contract has not yet been frozen from authoritative Amazon material.

Current state:

- endpoint family known: `/adsApi/v1/create/targets`
- keyword target shape known
- bid mapping: `positive_keyword_bid_mapping_unverified`
- `permitIssuanceReady=false`
- `networkDispatchAuthorized=false`

Do not silently drop a governed bid or guess a legacy bid field.

## Retry / 207 policy

Before dispatch:

`request_not_dispatched → retry_before_dispatch`

For Unified Create Target HTTP 207:

- entity index 0 in `error` → deterministic rejection / no retry;
- entity index 0 in `partialSuccess` → unknown / read-back required;
- entity index 0 in `success` → transport accepted / read-back still required;
- malformed or missing entity result → unknown / read-back required.

For connection loss, 5xx, or any state where dispatch may have happened:

`readback_required`

No unrestricted automatic retry is allowed after a possible mutation dispatch.

## Applied-state rule

An action may transition to `applied` only when all are true:

1. the action was approved under the frozen execution contract;
2. a valid single-use permit matched request/target/execution fingerprints;
3. immutable transport receipt exists;
4. Amazon read-back was performed;
5. verification result is `confirmed`;
6. receipt, verification and execution-plan fingerprints match.

## Remaining work before Phase 11 COMPLETE

- verify/freeze positive keyword bid mapping or explicitly exclude positive keyword execution from the first release;
- add permit issuance/consumption API with RBAC and explicit execution enablement;
- add dormant negative-keyword transport adapter using the frozen Unified request builder;
- make transport impossible while `AMAZON_ADS_ENABLED=false`;
- write immutable receipt around the external request boundary;
- implement target read-back and reconciliation;
- integrate `applying/applied/failed` transitions only after receipt/read-back invariants are satisfied;
- keep the first real execution to one store, one profile, one action, one permit, one external mutation.
