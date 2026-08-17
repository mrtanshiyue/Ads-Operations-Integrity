# Ads Operations Integrity

Amazon Ads Operations OS — Cloudflare Native control plane, governed store data planes, decision intelligence, recommendation approval, and controlled Amazon execution.

> **Current phase: Phase 4 — Project Truth & Productization Reset.** Phase 0–3 are completed implementation history. Future delivery authority is `docs/architecture/PRODUCT_ROADMAP_V2.md`; historical Gate documents remain evidence, not the future roadmap.

## Product objective

The product must close this business loop:

```text
trusted real Amazon data
→ decision intelligence
→ recommendation
→ approval
→ controlled action
→ verification
→ learning
```

The immediate priority is **Store 01 real Amazon read-only data**, followed by Search Term Intelligence and a recommendation engine. New provenance/Gate work is not a product objective unless a real architecture, security, or data-integrity risk requires it.

## Canonical architecture

Central governance remains shared. Amazon execution becomes physically store-isolated before multi-store expansion:

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
Per-store Sync Worker + Workflow
        ↓
Per-store credential set
        ↓
Per-store R2 boundary
        ↓
Amazon Ads API
```

Store 01 may proceed through controlled read-only activation using the existing Dev execution plane. **Store 02 must not receive Amazon credentials until the per-store Worker / Workflow / credential / R2 isolation contract is implemented.**

## Current platform truth

### Control D1

Central governance already covers users/RBAC, stores, products and store mappings, keyword library and product-keyword mappings, store keyword policy, negative governance, optimization rules, rollups, audit, and operator governance.

### Store D1

Store-local data already covers Amazon profiles/entities, report and sync state, campaign/keyword/target/search-term/product/placement daily facts, ingestion state, R2/source provenance, and the optimization action ledger.

`optimization_actions` and `optimization_action_events` already provide the action lifecycle. Do not redesign the action database; build recommendation, API, approval, execution, and verification around it.

### Amazon read pipeline

The repository already contains credential handling, LWA credential smoke, profile bootstrap, entity mirror, Create/Poll/Download Report transport, R2 materialization, report-cycle orchestration, Store D1 ingestion, and Search Term fact publication.

Runtime kill switches remain intentionally closed until Phase 5 controlled activation:

```text
AMAZON_ADS_ENABLED=false
SYNC_TRIGGER_ENABLED=false
```

This means **live execution is disabled**, not that Amazon integration must be rebuilt.

## Canonical runtime entrypoints

- Web runtime: `cloudflare/runtime/web-entry.js`
- Web Worker config: `cloudflare/runtime/wrangler.native.jsonc`
- Sync runtime: `cloudflare/runtime/sync-worker.js`
- Current Sync config: `cloudflare/runtime/wrangler.sync.jsonc`
- Native build entrypoint: `scripts/build-cloudflare-native.mjs`
- Native artifact: `dist-cloudflare-native/`
- Canonical CI: `.github/workflows/cloudflare-native-canonical-ci.yml`
- Required context: `Static site and security invariants`

The `production` stanza in `wrangler.sync.jsonc` is a **transitional template**, not the approved multi-store production topology: it still models one Sync Worker with STORE_01_DB–STORE_04_DB bindings. Phase 9 replaces that topology before Store 02 Amazon activation.

## Frontend direction

The current browser product remains a migration-era Native UI on same-origin `/api/*` APIs. Modernization uses a TypeScript + React + Vite strangler, not a big-bang rewrite. Product intelligence and action contracts take priority over cosmetic rewrites.

## Delivery authority

Future phases are:

1. Phase 4 — Project Truth & Productization Reset
2. Phase 5 — Store 01 Real Amazon Read-Only Pipeline
3. Phase 6 — Decision Intelligence MVP
4. Phase 7 — Ads Intelligence Native UI / React-Vite strangler
5. Phase 8 — Recommendation Approval / Action Control Plane
6. Phase 9 — Multi-Store Execution Isolation
7. Phase 10 — Production Read-Only Launch
8. Phase 11 — Controlled Amazon Execution
9. Phase 12 — Closed-loop Optimization

See `docs/architecture/PRODUCT_ROADMAP_V2.md` for authoritative scope, capability gaps, phase exits, and sequencing.

## Safety boundaries

- Canonical CI validates; it does not imply deployment or Amazon activation.
- Repository merge ≠ Dev deployment ≠ Production deployment ≠ Amazon activation.
- Amazon mutation is unauthorized until Phase 11.
- Production remains out of the immediate critical path.
- Historical GitHub Pages / TiDB / Warehouse material under `docs/archive/` remains traceability/rollback history only.
- The repository root intentionally has no implicit `wrangler.jsonc` deployment target; direct deployment aliases remain fail-closed.

See `docs/architecture/CANONICAL_RUNTIME.md` for runtime truth and `README_PRODUCTION_STATUS.md` for current operational state.
