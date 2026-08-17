# Ads Operations Integrity — Current Platform Status

> Operational truth for the Productization Roadmap V2 reset. Phase 0–3 documents and immutable deployment receipts remain historical implementation evidence. Future scope authority is `docs/architecture/PRODUCT_ROADMAP_V2.md`.

## Strategic status

```text
Architecture Convergence Phase 0 = COMPLETE + MERGED
Security Integrity Phase 1 = COMPLETE + MERGED
Deployment Integrity Phase 2 = COMPLETE + MERGED + POST-MERGE CORRELATED
Operator Product Surface Phase 3 = COMPLETE + MERGED + EXACT-SHA LIVE ACCEPTED
Phase 4 Project Truth & Productization Reset = ACTIVE
Production = NOT READY
Amazon implementation = READY FOR CONTROLLED STORE 01 LIVE-READ PREFLIGHT
Amazon live execution = DISABLED
```

Do not reopen Phase 0–3 unless a real regression, source-of-truth conflict, or security/data-integrity drift is observed. The old Gate sequence is no longer the future delivery roadmap.

## Repository baseline at Phase 4 reset

The reset started from canonical `main`:

```text
SHA: 7e77565ece9a1328e7348c8c534bac9895f410b2
Tree: c884171a88c79027d26e2c147f12628e9d9866b1
Required context: Static site and security invariants
Branch protection: enabled
```

That baseline merged PR #62 and preserves the Gate 3.5 immutable deployment receipt. Repository SHA and live Worker version remain separate identities.

## Canonical CI and deployment semantics

Canonical CI is validation-only. It does not directly deploy Cloudflare resources, promote historical branches, mutate Production, provision Amazon credentials, or activate Amazon execution.

Canonical deployment provenance remains:

```text
Canonical CI SUCCESS
→ exact Git SHA
→ Workers Builds exact commit_hash
→ build UUID
→ immutable Worker version
→ deployment
→ runtime acceptance
→ immutable receipt
```

Therefore:

```text
repository merge ≠ Dev deployment ≠ Production deployment ≠ Amazon activation
```

The historical deployment branch and historical receipts remain evidence only; future product work must not rewrite immutable receipts.

## Accepted Web Dev runtime

The latest accepted Phase 3.5 Dev runtime is:

```text
Worker: ads-operations-web-dev
Active deployment: 5fbad8a1-a9e1-47a6-9ab1-b94e53c576b9
Active version: 761dc627-385d-44ee-a960-5237fea02703
Traffic: 100%
ACCESS_MODE=enforce
SYNC_TRIGGER_ENABLED=false
Control D1: bound
Store 01 D1: bound
R2: ads-ops-data-dev
Workflow: ads-amazon-sync-dev → ads-operations-sync-dev
```

The immutable receipt is:

```text
docs/architecture/PHASE3_GATE35_DEPLOYMENT_RECEIPT.json
```

## Current Sync Dev runtime

Current Cloudflare account inventory contains `ads-operations-sync-dev`; no Production sync Worker is treated as deployed runtime truth for this phase.

The Dev Sync Worker currently has:

```text
APP_ENV=development
AMAZON_ADS_ENABLED=false
CONTROL_DB=bound
STORE_01_DB=bound
DATA_BUCKET=ads-ops-data-dev
AMAZON_SYNC_WORKFLOW=ads-amazon-sync-dev
```

This is sufficient topology for **Store 01 controlled read-only activation preflight**. It is not sufficient evidence for multi-store production isolation.

## Amazon state

Amazon integration is no longer classified as “future implementation.” The repository already contains:

- credential provider and LWA token refresh smoke;
- canonical profile bootstrap;
- campaign/ad group/keyword/target/product-ad entity mirror;
- Create Report / Poll Report / Download Report transport;
- report-cycle orchestration and durable sync receipts;
- R2 raw object materialization;
- Store D1 ingestion and Search Term fact publication.

Live execution is still fail-closed:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

The credential smoke endpoint is specifically designed to run with `AMAZON_ADS_ENABLED=false` and to perform no Create/Poll/Download Report, Store D1 write, or R2 write. That is the first live credential preflight for Phase 5.

## Action control state

Store D1 already owns:

```text
optimization_actions
optimization_action_events
```

with statuses:

```text
proposed / approved / rejected / applying / applied / failed / reverted
```

Phase 4 does not replace this schema. Phase 6 creates recommendations; Phase 8 exposes governed action APIs and approval UX; Phase 11 adds the Amazon mutation adapter.

## Multi-store isolation gap

`cloudflare/runtime/wrangler.sync.jsonc` still contains a transitional `production` template where one `ads-operations-sync-prod` would bind STORE_01_DB–STORE_04_DB and one shared Production R2 bucket. This is **not** the approved future execution topology.

Before Store 02 receives Amazon credentials, the architecture must converge to:

```text
Central Web / Control D1
→ per-store Store D1
→ per-store Sync Worker
→ per-store Workflow
→ per-store credential set
→ per-store R2 boundary
```

Store 01 read-only work may proceed before Phase 9 because the current Dev Sync Worker is already Store-01-only at the D1 binding layer.

## Production state

Production remains **NOT READY**. The final Cloudflare Native Production deployment contract is **not established yet**.

Production placeholders remain in Native configuration, and the current multi-store Sync production template is explicitly non-authoritative. No Phase 4 or Phase 5 task authorizes Production DNS, Access, Worker, D1, R2, Workflow, or Amazon mutation changes.

Retired Warehouse/browser loaders remain archive-only under `docs/archive/legacy-browser-loaders/`; active Native UI continues to use `assets/cloudflare-native-data-panel-v1.js`. Cloud Raw import remains fail-closed as `cloudflare_native_raw_import_not_migrated` until a dedicated product requirement justifies migration.

## Active direction

Current execution order is:

```text
Phase 4 truth reset
→ Phase 5 Store 01 real Amazon read-only
→ Phase 6 Search Term / recommendation intelligence
→ Phase 7 Native UI modernization
→ Phase 8 approval/action control plane
→ Phase 9 multi-store execution isolation
→ Phase 10 production read-only
→ Phase 11 controlled Amazon writes
→ Phase 12 closed-loop learning
```

The first business milestone is not Production. It is a trustworthy Store 01 dataset that can support Search Term Intelligence and explainable recommendations.
