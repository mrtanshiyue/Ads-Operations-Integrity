# Ads Operations Integrity — Current Platform Status

> Current operator-facing truth. Historical closure, UAT, acceptance, rollback, and release evidence remains immutable history and must not be treated as active delivery work.

## Current stage

```text
Project mode = Stable Operations / Maintenance Mode
Non-Amazon Production foundation = COMPLETE / ACCEPTED
Current product surfaces = COMPLETE / OPERATING
Repository Hygiene = ACTIVE under Issue #278
Formal Final Closure = COMPLETE / FROZEN
Operational UAT = COMPLETE / FROZEN
Historical Browser Acceptance = COMPLETE / FROZEN
Amazon execution = HARD-OFF / FROZEN
```

The project is not in a feature-development or productization phase. New work should be limited to maintenance, security, data integrity, observability, recovery, repository hygiene, and concrete defect/regression fixes unless a new product requirement is explicitly authorized.

Do not reopen completed Formal Closure, Browser Acceptance, Operational UAT, rollback drills, rationale acceptance, or historical release investigations unless a real regression, security incident, availability issue, or data-integrity drift requires it.

## Repository authority

Protected `main` is the canonical repository authority.

```text
Branch protection = enabled
Required context = Static site and security invariants
Direct Cloudflare deploy aliases = blocked / fail-closed
```

Do not hard-code the current `main` SHA into long-lived operator documentation. Read it from GitHub at execution time.

Repository SHA, Workers Build identity, deployment identity, runtime version, and Amazon execution authority are separate evidence classes:

```text
repository merge ≠ Dev deployment ≠ Production deployment ≠ Amazon activation
```

## Runtime deployment truth

Repository Hygiene can advance `main` without automatically proving that Development or Production is running that new SHA.

The last Production Web runtime explicitly verified before Repository Hygiene v1 began was:

```text
Worker = ads-operations-web-prod
Source SHA = 67b1a1daf403b971006bdd8aa66d6336a5e56832
Deployment = 33bf0672-3cef-40f6-9310-cbede556c9fb
Version = 390403b0-46fe-467d-984a-822e8099f638
Traffic = 100%
ACCESS_MODE = enforce
SYNC_TRIGGER_ENABLED = false
PHASE5_SINGLE_RUN_PERMIT_ID = ""
PHASE5_SINGLE_RUN_REPORT_DATE = ""
Schedules = []
```

The last Development Web runtime explicitly verified before Repository Hygiene v1 began was:

```text
Worker = ads-operations-web-dev
Deployment = 2ca0f620-9054-4118-a9d8-fea7cec12916
Version = bd3fcb2d-f4a7-4f04-afb3-b6287c17d32a
Traffic = 100%
ACCESS_MODE = off
SYNC_TRIGGER_ENABLED = false
PHASE5_SINGLE_RUN_PERMIT_ID = ""
PHASE5_SINGLE_RUN_REPORT_DATE = ""
Schedules = []
```

Repository Hygiene PRs that alter runtime/build surfaces must obtain fresh exact-main Development and Production evidence through the controlled Cloudflare deployment/release path before the maintenance batch is declared fully promoted. Until that evidence exists, do not describe the newer repository SHA as the active Production source.

`Cloudflare Release Trace` remains a Maintenance Mode evidence asset for proving exact-main runtime identity. `Production Drift Receipt` remains a reusable read-only safety asset.

## Production Sync — protected invariant

Repository Hygiene must not modify or activate Production Sync.

Last verified Production Sync baseline before Repository Hygiene v1:

```text
Worker = ads-operations-sync-prod
Deployment = cf0b0adf-96dc-437d-8298-15af58f992ce
Version = 295df84e-2103-4858-9895-49f67d4b10b4
Traffic = 100%
Schedules = []
AMAZON_ADS_ENABLED = false
```

Any change that enables schedules, turns on Amazon execution, provisions Amazon credentials, or mutates Amazon-facing execution state is outside Repository Hygiene authority.

## Current product surfaces — KEEP

The following operator/product surfaces are current Maintenance Mode capabilities and must not be retired as historical assets:

- Recommendation Inbox
- Human Review
- Recommendation Decision Packet
- Governed Candidate Library
- Historical Review Learning
- Four-Store Decision Queue Summary
- Daily Operator Work Queue
- Operator Workspace
- Root / Lifecycle usability
- Operations Health
- CSV analytics, history, provenance, data-quality, and import surfaces required by those workflows

Human Review append-only governance and all D1 integrity/migration contracts remain protected.

## Safety / maintenance assets — KEEP by default

Keep unless a complete dependency audit proves a superior replacement:

- direct-deploy blockers
- Runtime Observability
- Production Drift Receipt
- Cloudflare Release Trace
- break-glass recovery
- provenance / audit
- privacy / RBAC / store-isolation guards
- Amazon HARD-OFF regression tests
- all D1 migrations and integrity triggers

Production Drift Receipt is evidence computation, not a Production mutation surface.

## Repository Hygiene v1

Issue `#278` governs the current cleanup program.

Cleanup classification:

```text
KEEP         current runtime/governance/security/recovery/data-integrity/maintenance value
ARCHIVE      completed but still valuable for audit, incident, or historical evidence
DELETE_SAFE  no current dependency or governance value and safe to recover through Git history
NEEDS_REVIEW deletion safety is not yet proven
```

Deletion decisions must be based on actual imports/loaders/build/package/CI/workflow/runtime/deployment/audit dependencies, not filenames or age.

Repository Hygiene is complete only when dead runtime assets, dead loaders, completed-phase active control planes, temporary acceptance harnesses, stale operator-facing truth, and safely removable workflow noise are gone without current capability regression.

## Amazon state — permanent HARD-OFF for this maintenance program

Required closed state:

```text
AMAZON_ADS_ENABLED=false
SYNC_TRIGGER_ENABLED=false
Production Sync schedules=[]
Production Web schedules=[]
PHASE5_SINGLE_RUN_PERMIT_ID=""
PHASE5_SINGLE_RUN_REPORT_DATE=""
```

Repository Hygiene does not authorize:

- Amazon Ads / Advertising API calls
- SP-API calls
- Amazon API report acquisition
- campaign / bid / keyword / negative / budget mutation
- Optimization Action execution
- Amazon network requests
- Amazon credential or secret mutation
- sync activation

Dormant Amazon code may remain where it is part of intentional future capability or HARD-OFF regression coverage. Its presence never implies execution authority.

## Historical closure evidence

The accepted historical Non-Amazon closure remains preserved at:

```text
docs/architecture/FINAL_NON_AMAZON_PRODUCTION_CLOSURE_2026-08-20.md
```

Historical UAT, Browser Acceptance, rollback, release, and closure artifacts are evidence, not active operating instructions.

Legacy architecture and loader evidence remains under `docs/archive/`, including `docs/archive/legacy-browser-loaders/`. Current build/runtime code must not depend on obsolete status text merely to preserve compatibility.

## Operating rule

Maintenance changes must remain small, reviewable, CI-gated, recoverable, and evidence-backed.

For runtime/build changes:

```text
canonical CI
→ controlled Development exact-main evidence
→ focused runtime/UI/API/RBAC/store-isolation validation
→ controlled Production exact-main evidence
→ schedules / Sync / Amazon HARD-OFF re-verification
```

For documentation-only or inactive-control-plane cleanup, Production deployment is not required unless the change also affects a runtime/build/deployment contract.
