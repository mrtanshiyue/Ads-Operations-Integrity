# Ads Operations Integrity

Amazon Ads Operations OS — Cloudflare Native control plane, governed store data planes, CSV decision intelligence, recommendation review, and controlled future Amazon execution.

> **Current project stage: Stable Operations / Maintenance Mode.** The Non-Amazon Production foundation and current operator product surfaces are complete. Repository Hygiene v1 is the active maintenance program under Issue `#278`. Historical Formal Closure, Browser Acceptance, Operational UAT, rollback drills, and rationale acceptance are complete/frozen. Amazon remains **HARD-OFF / FROZEN**.

## Maintenance objective

The repository is no longer in feature-productization mode. Current work should improve operational safety and maintainability without reopening completed product design:

```text
protect current capability
→ reduce dead/duplicate control surfaces
→ preserve data/security invariants
→ keep operator-facing truth current
→ prove runtime changes through controlled exact-main evidence
```

Do not create new features merely to keep development active. New product work requires an explicit new requirement.

## Current operator loop — KEEP

```text
trusted CSV / historical reports
→ decision intelligence
→ explainable recommendation
→ human review
→ governed keyword / negative candidate library
→ historical learning
→ operator decision
```

Current operator surfaces include Recommendation Inbox, Human Review, Recommendation Decision Packet, Governed Candidate Library, Historical Review Learning, Four-Store Decision Queue Summary, Daily Operator Work Queue, Operator Workspace, Root / Lifecycle usability, Operations Health, and their supporting CSV analytics/provenance/data-quality surfaces.

## Canonical architecture

```text
Cloudflare Access
        ↓
Central Web / App Worker
        ↓
Application RBAC
        ↓
Control D1
        ↓
store-scoped routing
        ↓
Per-store Store D1
        ↓
CSV / local evidence
        ↓
Decision intelligence
        ↓
Human review
```

Central governance and store isolation remain mandatory. All D1 migrations and integrity triggers are protected assets unless a dedicated migration/governance change explicitly requires modification.

## Repository authority vs runtime authority

Protected `main` is the canonical repository authority. Branch protection requires:

```text
Static site and security invariants
```

Repository merge, Cloudflare runtime promotion, and Amazon execution authority are separate events:

```text
repository merge ≠ Dev deployment ≠ Production deployment ≠ Amazon activation
```

Direct Cloudflare deployment aliases remain fail-closed. Runtime/build maintenance changes require controlled Development exact-main evidence and then controlled Production exact-main evidence before the batch is considered fully promoted.

See `README_PRODUCTION_STATUS.md` for current deployment/evidence truth. Do not infer that the newest repository SHA is already running in Production without Release Trace or equivalent control-plane evidence.

## Canonical runtime entrypoints

- Web runtime: `cloudflare/runtime/web-entry.js`
- Observed runtime wrapper: `cloudflare/runtime/runtime-observed-entry.js`
- Web Worker config: `cloudflare/runtime/wrangler.native.jsonc`
- Sync runtime: `cloudflare/runtime/sync-worker.js`
- Sync config: `cloudflare/runtime/wrangler.sync.jsonc`
- Native build entrypoint: `scripts/build-cloudflare-native.mjs`
- Native artifact: `dist-cloudflare-native/`
- Canonical CI: `.github/workflows/cloudflare-native-canonical-ci.yml`
- Required context: `Static site and security invariants`

Maintenance evidence assets include Runtime Observability, Production Drift Receipt, Cloudflare Release Trace, break-glass recovery, provenance/audit, privacy/RBAC/store-isolation guards, and Amazon HARD-OFF regressions.

## Repository Hygiene v1

Issue `#278` governs the active repository cleanup.

Every asset should converge to one of:

```text
KEEP
ARCHIVE
DELETE_SAFE
NEEDS_REVIEW
```

Classification must be based on runtime imports/loaders, build pipeline, package scripts, canonical CI, Workflow invocation, D1 migration dependency, Cloudflare Worker routes, operator UI dependencies, and audit/provenance value — never only on age or naming.

Priority cleanup targets include completed-phase active control planes, historical acceptance harnesses still entering runtime/build output, dead source loaders, duplicate focused CI, stale operator documentation, orphan scripts, and obsolete branches/PRs.

Historical evidence should be archived or retained through immutable Git/Actions history where appropriate; it should not remain executable merely for traceability.

## Amazon state — HARD-OFF

Required closed state remains:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
Production Sync schedules=[]
Production Web schedules=[]
PHASE5_SINGLE_RUN_PERMIT_ID=""
PHASE5_SINGLE_RUN_REPORT_DATE=""
```

Repository Hygiene does not authorize:

- Amazon Ads / Advertising API live reads or writes
- SP-API
- Amazon API report acquisition
- campaign / bid / keyword / negative / budget mutation
- Optimization Action execution
- Amazon network requests
- Amazon credential or secret mutation
- sync activation

Dormant Amazon integration code may remain when it supports a deliberate future capability or HARD-OFF regression coverage. Code readiness never lifts the freeze.

## Historical authority

The immutable accepted Non-Amazon closure record remains:

`docs/architecture/FINAL_NON_AMAZON_PRODUCTION_CLOSURE_2026-08-20.md`

Historical Gate/UAT/rollback/closure documents and Actions artifacts are evidence, not active delivery work. Material under `docs/archive/` is traceability/rollback history unless explicitly documented otherwise.

## Operating rules

- Do not reopen completed architecture, Formal Closure, Browser Acceptance, Operational UAT, rollback, rationale acceptance, or release investigations without a concrete regression or incident.
- Do not bypass protected `main` or the required canonical CI context.
- Do not replace controlled deployment with direct `wrangler deploy` aliases.
- Do not weaken privacy, RBAC, store isolation, D1 integrity, provenance, audit, recovery, or Amazon HARD-OFF controls during cleanup.
- Prefer small logical cleanup PRs so regression sources remain attributable.
- Repository Hygiene is successful when the repository has less dead/duplicate execution surface and current Production capability remains intact — not when deletion count is maximized.
