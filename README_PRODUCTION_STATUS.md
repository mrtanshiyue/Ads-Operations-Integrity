# Ads Operations Integrity — Current Platform Status

> Operational truth after CSV / Cloudflare Non-Amazon Final Closure. Long-term product direction remains in `docs/architecture/PRODUCT_ROADMAP_V2.md`; current delivery sequencing is governed by `docs/architecture/CSV_FIRST_OPERATING_DIRECTIVE_2026-08-18.md` while that directive remains active.

## Strategic status

```text
Architecture / Security / Deployment foundation = ACCEPTED
Production Non-Amazon foundation = ACCEPTED
Operational UAT = 31/31 LIVE PASS
Failure Recovery = PASS
Real rollback / restore = LIVE PASS
Temporary execution resources = CLEANED UP
blockers=[]
Current Product Phase = CSV Decision Intelligence Productization
Amazon execution = DISABLED / FROZEN
```

The project is no longer in Production UAT or foundational infrastructure build-out. Do not reopen completed closure work unless a real regression, security issue, availability issue, or data-integrity drift is observed.

## Canonical repository baseline

```text
GitHub main: a90c9158d8afd224e717218827923d4beab593b1
Latest merged change at closure: fix: verify rollback deployment receipts by readback (#211)
Open PRs at closure: 0
Branch protection: enabled
Required context: Static site and security invariants
```

Repository SHA, Workers Build identity, deployment identity, and runtime version remain separate evidence classes. The SHA above is the immutable closure baseline; later CSV productization commits do not change the accepted closure evidence.

## Accepted Production Web baseline

```text
Worker: ads-operations-web-prod
Exact-main build: f4ed6b12-5beb-44f8-944c-061b300c7ec1
Build outcome: success
Build commit: a90c9158d8afd224e717218827923d4beab593b1
Exact-main deployment: 0ccd32ac-0328-4a02-b6f1-7445495a128b
Final runtime version: 44716995-a894-47ee-a9ed-5d371a771e83
Restored active deployment: 67feb2ce-cff5-4a79-bbd0-6b9460edd438
Traffic: 100%
```

Production deployment governance remains **manual exact-main only**. Do not enable automatic Production deployment or bypass branch protection / required CI.

## Operational UAT / Failure Recovery

Strict closure count:

```text
Previously accepted LIVE cases: 21
Service Binding LIVE cases: 9
Real rollback / restore LIVE case: 1
Total: 31/31 LIVE PASS
blockers=[]
```

The real rollback / restore path was:

```text
44716995-a894-47ee-a9ed-5d371a771e83
→ rollback runtime 9007b345-6474-4b6b-8e88-cc79c3bf48fb
→ restore runtime 44716995-a894-47ee-a9ed-5d371a771e83
```

```text
Rollback deployment: b48f4ad6-66c6-4286-a591-485cbc3a1983
Restore deployment: 67feb2ce-cff5-4a79-bbd0-6b9460edd438
```

Canonical rollback verification recorded:

```text
verified=true
preRollbackRuntimeObserved=true
rollbackRuntimeObserved=true
restoreRuntimeObserved=true
restoredInFinally=true
deploymentForceApplied=true
deploymentReceiptVerifiedByReadback=true
amazonExecutionAttempted=false
businessFactPersistenceAttempted=false
```

Do not rerun the accepted 31-case matrix or rollback drill unless later code changes directly affect those contracts.

## Service Binding closure

The Cloudflare Service Binding execution path completed the required CSV, permission, failure-recovery, and rollback runtime-observation cases. Final authorization mode was:

```text
cloudflare_service_binding
```

The permission case used Production `CONTROL_DB` read-only policy simulation. No Production user, temporary membership, permission mutation, or business-fact write was created.

Do not reopen Access Service Token investigation absent a new concrete requirement.

## Cleanup state

Temporary UAT / rollback execution resources have been deleted and verified absent, including temporary controller/build-runner Workers, Queue resources, KV, and temporary rollback build triggers.

The temporary execution branch `ops/operational-uat-service-binding-rollback-20260820` was restored to `main` with:

```text
ahead=0
behind=0
status=identical
```

Do not revive temporary closure infrastructure.

## Amazon state — HARD-OFF

The CSV-first operating directive remains active. Runtime kill switches remain:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

No Amazon Ads API live reads/writes, SP-API, Amazon report acquisition, campaign/bid/keyword/negative/budget mutation, Amazon workflow execution, credential provisioning, or Amazon secret mutation is authorized.

Dormant Amazon integration code remains preserved for a future explicit restart. Code readiness does not lift the freeze.

## Action-control state

Store D1 already owns the canonical lifecycle:

```text
optimization_actions
optimization_action_events
```

with statuses:

```text
proposed / approved / rejected / applying / applied / failed / reverted
```

Do not create a second action database. During CSV-first productization, advisory output remains non-executable:

```text
executionAuthorized=false
amazonMutationAuthorized=false
```

## Current productization direction

Active sequence:

```text
CSV
→ Historical Data
→ Search Term Intelligence
→ Profit / Waste / Root Analysis
→ Evidence-backed Recommendation
→ Human Review
→ Keyword / Negative Library
→ Historical learning
```

The immediate implementation focus is:

1. consolidate Search Term Intelligence into operator-facing business classifications and evidence-backed candidate types;
2. consolidate historical/monthly and period-over-period analytics with lifecycle/trend semantics;
3. connect recommendations into the existing local review / keyword / negative governance flow;
4. modernize high-value product surfaces incrementally with the TypeScript + React + Vite strangler.

UI cosmetics, more Gate numbering, more Operational UAT cases, Access-token research, rollback infrastructure, and already-accepted provenance/dedup/D1 governance are lower priority unless a real blocker/regression appears.

## Production closure authority

The immutable closure summary is:

```text
docs/architecture/FINAL_NON_AMAZON_PRODUCTION_CLOSURE_2026-08-20.md
```

Issue #191 is the mutable release trace and should be closed as completed once this final truth reset is merged.

## Historical architecture compatibility markers

The legacy Architecture Convergence contract still checks several historical evidence strings in this file. They are retained here only so historical CI evidence remains traceable; **none of the following statements overrides the current accepted Production status above**.

```text
Architecture Convergence Phase 0 = COMPLETE + MERGED
```

Historical statement, now superseded by the 2026-08-20 final closure:

> final Cloudflare Native Production deployment contract is **not established yet**

That sentence described the earlier architecture-convergence period; it is **not** current operational truth. The current Non-Amazon Production foundation is accepted.

Historical / migration traceability markers retained for compatibility:

- `docs/archive/legacy-browser-loaders/`
- `assets/cloudflare-native-data-panel-v1.js`
- `cloudflare_native_raw_import_not_migrated`

Repository merge still does not itself authorize a Cloudflare deployment or any Amazon activation.