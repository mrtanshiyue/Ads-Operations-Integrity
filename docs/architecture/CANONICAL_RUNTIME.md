# Canonical Architecture and Runtime

Status: **Phase 0–3 completed implementation history; Phase 4 Project Truth & Productization Reset active.**

Future delivery authority: `docs/architecture/PRODUCT_ROADMAP_V2.md`.

## Canonical product architecture

The target product architecture is Cloudflare Native with centralized governance and physically isolated Amazon store execution planes:

```text
Cloudflare Access
  → Central Web / App Worker
  → application RBAC
  → Control D1
  → store-scoped routing
  → per-store Store D1
  → per-store Sync Worker
  → per-store Workflow
  → per-store credential set
  → per-store R2 boundary
  → Amazon Ads API
```

The historical GitHub Pages / TiDB / `amazon-warehouse-cloud-v4` architecture is migration history only. It is not an active product target.

## Current Dev runtime truth

The currently accepted Dev product plane is:

```text
ads-operations-web-dev
  → CONTROL_DB
  → STORE_01_DB
  → DATA_BUCKET=ads-ops-data-dev
  → AMAZON_SYNC_WORKFLOW=ads-amazon-sync-dev
  → ads-operations-sync-dev
```

Current execution kill switches are closed:

```text
Web:  SYNC_TRIGGER_ENABLED=false
Sync: AMAZON_ADS_ENABLED=false
```

The accepted Web Dev deployment at the Phase 4 reset is:

```text
Deployment: 5fbad8a1-a9e1-47a6-9ab1-b94e53c576b9
Version:    761dc627-385d-44ee-a960-5237fea02703
Traffic:    100%
```

Its immutable correlation evidence remains `docs/architecture/PHASE3_GATE35_DEPLOYMENT_RECEIPT.json`.

## Canonical repository entrypoints

Web runtime:

```text
cloudflare/runtime/wrangler.native.jsonc
  → cloudflare/runtime/web-entry.js
  → cloudflare/runtime/web-worker.js + modular APIs
```

Sync runtime:

```text
cloudflare/runtime/wrangler.sync.jsonc
  → cloudflare/runtime/sync-worker.js
  → durable Amazon report-cycle runtime
```

The repository root has no active `wrangler.jsonc` and no active legacy Warehouse proxy `src/worker.js`.

## Browser/API boundary

```text
Cloudflare Access browser session
  → same-origin /api/v1/*
  → web-entry modular routes
  → application RBAC
  → Control D1 / authorized Store D1 / R2
```

Browser rules remain:

- same-origin Cloudflare Native APIs only;
- Cloudflare Access session, never Warehouse dashboard passwords;
- no browser Amazon Ads API transport;
- no browser deployment control;
- no direct Store D1 bypass around application RBAC;
- Cloud Raw import remains fail-closed as `cloudflare_native_raw_import_not_migrated` until an explicit product phase authorizes it.

## Data and action boundary

Control D1 is the governance plane. Store D1 is the Amazon store-local entity/fact/action plane. R2 stores raw report objects/source evidence.

The Store D1 action ledger is already canonical:

```text
optimization_actions
optimization_action_events
```

Its state machine is:

```text
proposed
  → approved → applying → applied
  → rejected
  → failed
  → reverted
```

New recommendation and approval work must use that ledger instead of creating a parallel action database. See `docs/architecture/OPTIMIZATION_ACTION_API_CONTRACT_V1.md`.

## Amazon read-only activation boundary

Amazon implementation is present but live execution is disabled. Phase 5 is controlled activation, not a fresh Amazon integration project.

The safe activation sequence begins with credential provisioning plus `/health/amazon-credentials` while `AMAZON_ADS_ENABLED=false`. That smoke may refresh an LWA token but must not create/poll/download reports and must not write D1 or R2. Only after that preflight passes may a separately reviewed exact-SHA Sync runtime enable Amazon read execution for Store 01.

No Phase 5 scope authorizes Amazon mutation endpoints. See `docs/architecture/PHASE5_STORE01_LIVE_READ_ACTIVATION.md`.

## Multi-store execution isolation invariant

The `production` stanza in `cloudflare/runtime/wrangler.sync.jsonc` is transitional configuration and **not the authoritative future topology**. It currently models one Sync Worker with STORE_01_DB–STORE_04_DB bindings and a shared Production R2 bucket.

Before Store 02 Amazon credentials are provisioned, the execution plane must be split so each store has its own:

- Store D1 binding boundary;
- Sync Worker;
- Workflow;
- Amazon credential set;
- R2 namespace/bucket boundary.

Central Web and Control D1 remain shared governance components.

## Canonical build and CI

```text
npm run build
  → scripts/build-cloudflare.mjs
  → scripts/build-cloudflare-native.mjs
  → scripts/build-cloudflare-native-copy-all.mjs
  → scripts/enforce-cloudflare-native-asset-allowlist.mjs
  → dist-cloudflare-native/
```

Canonical CI:

```text
.github/workflows/cloudflare-native-canonical-ci.yml
Required context: Static site and security invariants
```

The existing CI retains historical regression names where required for compatibility, but those names do not define the future roadmap. CI remains validation-only and must not mutate live Cloudflare or Amazon state.

## Deployment integrity

Phase 2 deployment integrity remains a frozen implementation invariant:

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

Key identities remain distinct:

```text
repository SHA ≠ deployed runtime version
merge main ≠ deployment
Dev deployment ≠ Production deployment
Production deployment ≠ Amazon activation
```

Direct repository deploy aliases remain fail-closed through `scripts/block-direct-cloudflare-deploy.mjs`.

## Frontend product surface

Current Native operator/browser assets remain valid transition surfaces. Phase 7 modernizes them through a TypeScript + React + Vite strangler. It must preserve same-origin API, Access, RBAC, and store authorization boundaries.

Frontend modernization must not outrun Phase 5/6 business capability: trustworthy real Store 01 data and decision intelligence are higher priority than a broad visual rewrite.

## Production boundary

Production remains NOT READY. Production deployment and read-only launch belong to Phase 10, after Store 01 live-read evidence, decision intelligence, action governance, and multi-store isolation design are established.

## Historical ownership

Active architecture/runtime source remains under:

- `cloudflare/foundation/`
- `cloudflare/runtime/`
- active `assets/cloudflare-native-*`
- `scripts/` validation/build/test helpers
- `docs/architecture/` current contracts and immutable evidence

Historical implementation/configuration under `docs/archive/` is traceability and rollback material only.
