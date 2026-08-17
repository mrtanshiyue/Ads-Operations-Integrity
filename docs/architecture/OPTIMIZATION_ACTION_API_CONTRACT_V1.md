# Optimization Action API Contract V1

Status: **AUTHORITATIVE CONTRACT FOR PHASE 6/8 IMPLEMENTATION**  
Storage authority: existing per-store `optimization_actions` and `optimization_action_events` tables.

## 1. Purpose

Convert explainable recommendations into governed operational actions without creating a parallel action database or allowing recommendation code to bypass approval.

```text
Store facts
→ recommendation engine
→ proposed optimization_action
→ operator review
→ approved / rejected
→ controlled executor (Phase 11)
→ applied / failed
→ verification
→ learning
```

Phase 4 defines this contract. Phase 6 produces recommendations. Phase 8 implements the Action API and Approval UI. Phase 11 is the first phase authorized to attach Amazon mutation execution.

## 2. Existing ledger is canonical

`optimization_actions` already provides:

```text
action_id
idempotency_key
profile_id
entity_type
entity_id
action_type
source_type
rule_key
before_json
proposed_json
rationale_json
status
created_by
approved_by
external_request_id
applied_at
created_at
updated_at
```

`optimization_action_events` provides append-oriented lifecycle evidence:

```text
event_id
action_id
event_type
actor_id
details_json
occurred_at
```

Allowed persisted states are:

```text
proposed / approved / rejected / applying / applied / failed / reverted
```

No new table is required merely to represent recommendations.

## 3. Ownership and trust boundaries

### Recommendation engine

May:

- read authorized Store D1 facts/entities and Control D1 policy/rules;
- compute recommendation evidence and confidence;
- create or reuse an idempotent `proposed` action.

May not:

- set `approved`, `applying`, `applied`, `failed`, or `reverted` directly;
- call Amazon mutation APIs;
- impersonate an approving human;
- overwrite an existing action when its idempotency fingerprint conflicts.

### Browser/UI

May call same-origin Action APIs after Access/RBAC authorization. It never writes Store D1 directly and never communicates with Amazon Ads directly.

### Action API

Owns transition validation, RBAC, idempotency, audit/event emission, and public action serialization.

### Execution adapter

Does not exist as an authorized live write path until Phase 11. When implemented, it consumes only an `approved` action and must perform before-state validation before Amazon mutation.

## 4. V1 route surface

All routes are store-scoped:

```text
GET  /api/v1/stores/{storeId}/optimization-actions
POST /api/v1/stores/{storeId}/optimization-actions
GET  /api/v1/stores/{storeId}/optimization-actions/{actionId}
POST /api/v1/stores/{storeId}/optimization-actions/{actionId}/approve
POST /api/v1/stores/{storeId}/optimization-actions/{actionId}/reject
```

Reserved for Phase 11 and MUST be fail-closed before then:

```text
POST /api/v1/stores/{storeId}/optimization-actions/{actionId}/apply
POST /api/v1/stores/{storeId}/optimization-actions/{actionId}/revert
```

The API may expose action events in the detail response or through a later read-only events endpoint. Event storage remains `optimization_action_events`.

## 5. Create proposed action

### Request

```http
POST /api/v1/stores/{storeId}/optimization-actions
Idempotency-Key: <recommendation fingerprint or durable client key>
Content-Type: application/json
```

Conceptual body:

```json
{
  "profileId": "...",
  "entityType": "keyword|target|campaign|search_term|...",
  "entityId": "...",
  "actionType": "...",
  "sourceType": "rule|recommendation|operator",
  "ruleKey": "optional rule/model version key",
  "before": {},
  "proposed": {},
  "rationale": {
    "summary": "...",
    "analysisWindow": { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" },
    "metrics": {},
    "confidence": {},
    "evidence": {}
  }
}
```

### Server requirements

- resolve store route through Control D1 and authorized Store D1 binding;
- verify `profileId` belongs to that Store D1 and is currently valid for the recommendation context;
- validate the `entityType` / `entityId` target in that same Store D1 where applicable;
- normalize and validate `actionType` against an explicit server allowlist;
- canonicalize `before`, `proposed`, and `rationale` JSON before persistence;
- require an idempotency key;
- insert only with initial status `proposed`;
- append `action.proposed` event;
- write Control D1 audit event without copying secrets or excessive raw report content.

If the same idempotency key already exists:

- return the existing action when the canonical action fingerprint matches;
- return conflict when the key is reused for different content.

## 6. Recommendation fingerprint

The recommendation engine should derive a deterministic fingerprint from at least:

```text
schema version
store ID
profile ID
entity type + entity ID
action type
canonical before state
canonical proposed state
analysis window
rule/model key
source fact/provenance identity required by that rule
```

The fingerprint must not depend on presentation text, browser locale, or non-deterministic JSON key order.

This fingerprint becomes or deterministically produces the `idempotency_key` so repeated analysis does not create duplicate actions for the same decision state.

## 7. Read contract

### List

`GET /optimization-actions` supports bounded filters such as:

- `status`;
- `actionType`;
- `entityType`;
- `profileId`;
- creation time range;
- cursor/limit.

Default ordering should be newest actionable recommendation first. The response must not expose internal secrets or raw credential material.

### Detail

Returns:

- public action fields;
- parsed `before`, `proposed`, `rationale`;
- transition eligibility for the current actor;
- ordered action events;
- current target snapshot or a clearly marked snapshot-freshness result when needed for safe approval.

## 8. Approval and rejection transitions

### Approve

Valid transition:

```text
proposed → approved
```

Requirements:

- actor must hold the existing domain-appropriate RBAC permission; do not add a broad bypass permission merely for the action API;
- target Store/profile must still be authorized;
- action must still be `proposed` at commit time;
- approval must use a conditional transaction/update so two reviewers cannot produce conflicting terminal decisions;
- set `approved_by` to the authenticated actor;
- append `action.approved` event;
- write Control D1 audit.

Approval is **not execution**. Before Phase 11, approved actions remain queued governance records with no Amazon mutation side effect.

### Reject

Valid transition:

```text
proposed → rejected
```

Requirements mirror approval concurrency/RBAC rules. Rejection should accept an optional bounded reason and append `action.rejected` event.

### No reopen by silent update

`rejected` and later lifecycle states must not be changed back to `proposed` by editing the same row. A materially changed recommendation creates a new idempotent proposed action linked through rationale/evidence if lineage is useful.

## 9. Execution transitions — Phase 11 only

The executor may perform:

```text
approved → applying → applied
approved → applying → failed
applied → reverted     (only when a supported safe compensating action exists)
```

### Before `applying`

The executor must:

- reload the action from Store D1;
- confirm status is `approved`;
- resolve the canonical Amazon profile/store execution plane;
- re-read current Amazon/entity state where required;
- compare current state with `before_json` and reject stale/conflicting actions rather than blindly applying;
- reserve execution idempotently before issuing the external write.

### External request identity

`external_request_id` records the stable external/idempotency receipt where Amazon API semantics provide one. It must never be fabricated solely to make an action appear applied.

### After mutation

The executor must verify the resulting state through a read path before setting `applied`. An HTTP success alone is not sufficient.

## 10. Initial recommendation/action families

Phase 6/8 may define proposed actions for high-value intelligence workflows, with execution still disabled:

### Search Term negative candidate

```text
entity_type: search_term or targeting context
action_type: negative_keyword.create
```

Evidence should include spend/clicks/orders/sales, analysis window, current targeting context, existing-negative collision check, and rule thresholds.

### Keyword harvesting candidate

```text
entity_type: search_term
action_type: keyword.create
```

Evidence should include converting search term performance, destination campaign/ad group policy, duplicate keyword/target check, proposed match type, and proposed bid only when a governed bid source exists.

### Bid recommendation

```text
entity_type: keyword|target
action_type: bid.set
```

Evidence must contain current bid source/timestamp, proposed bid, metric window, objective/thresholds, and stale-state guard.

Additional action families require explicit contract tests before they can be executed in Phase 11.

## 11. RBAC mapping principle

Reuse existing least-privilege permissions where semantically correct:

- negative governance actions require the negative-management capability;
- keyword create/bid actions require keyword-management/ads-write capability as appropriate;
- read-only list/detail requires relevant ads/analytics read capability;
- execution is server-side and additionally protected by the Phase 11 execution feature flag/allowlist.

Do not grant approval because a user can merely read recommendations.

## 12. Event contract

Every accepted lifecycle transition appends exactly one canonical event in the same logical transaction boundary as the state change where D1 semantics allow it.

Recommended event types:

```text
action.proposed
action.approved
action.rejected
action.applying
action.applied
action.failed
action.reverted
```

`details_json` may record bounded transition metadata, reason codes, verified before/after summaries, and execution receipts. It must not contain Amazon refresh tokens, access tokens, Cloudflare secrets, or unnecessarily duplicated raw source reports.

## 13. Concurrency and integrity

All mutations must fail closed on stale state. Conceptually:

```sql
UPDATE optimization_actions
SET status = 'approved', approved_by = ?, updated_at = CURRENT_TIMESTAMP
WHERE action_id = ? AND status = 'proposed';
```

The implementation must verify exactly one row transitioned before appending success/audit semantics. Equivalent transactional patterns are acceptable.

The API must also enforce:

- store route ownership;
- profile ownership;
- action ID format/length limits;
- body size limits;
- JSON object requirements;
- status/action allowlists;
- idempotency conflict detection;
- no direct arbitrary SQL/query payloads from clients.

## 14. Failure semantics

Use explicit public error codes rather than ambiguous 200 responses. Minimum classes:

```text
forbidden
store_not_found
store_db_unavailable
action_not_found
action_validation_failed
idempotency_key_required
idempotency_key_reuse_conflict
action_transition_conflict
action_target_stale
action_execution_disabled
action_type_not_executable
```

Unexpected internal errors must not leak D1 SQL, credentials, Amazon tokens, or secret binding names beyond what the operator already needs to know.

## 15. Phase boundaries

### Phase 6

May generate deterministic recommendations and persist `proposed` actions through a server-side contract.

### Phase 8

Must implement list/detail/create-proposed/approve/reject with RBAC, audit, events, idempotency, and concurrency tests.

### Phase 11

May implement apply/revert for an explicit allowlist after per-store execution isolation and Production/read-only maturity requirements are met.

Until Phase 11, any `/apply` or `/revert` route must be absent or return fail-closed `action_execution_disabled` without Amazon mutation.
