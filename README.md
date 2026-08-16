# Ads Operations Integrity

Amazon Ads Operations OS — Cloudflare Native control plane, governed data plane, decision intelligence, and controlled execution.

> Repository architecture is currently in **Architecture Convergence Phase 0**. Historical Gate/Phase documentation remains useful implementation history, but it is not the authority for the future architecture.

## Canonical architecture

```text
Cloudflare Access
        ↓
Web / App Worker
        ↓
Application RBAC
        ↓
Control D1
        ↓
Store-scoped routing
        ↓
Store D1
        ↓
R2 immutable raw objects
        ↓
Cloudflare Workflows
        ↓
Sync Worker
        ↓
Amazon Ads API
```

The long-term production model keeps governance centralized while physically isolating each Amazon store's execution plane with its own Store D1, sync Worker, Workflow, credential set, and preferably raw-object boundary.

## Canonical runtime entrypoints

- Web runtime: `cloudflare/runtime/web-entry.js`
- Web Worker config: `cloudflare/runtime/wrangler.native.jsonc`
- Sync runtime: `cloudflare/runtime/sync-worker.js`
- Sync Worker config: `cloudflare/runtime/wrangler.sync.jsonc`
- Native build entrypoint: `scripts/build-cloudflare-native.mjs`
- Native artifact: `dist-cloudflare-native/`
- Canonical convergence CI: `.github/workflows/cloudflare-native-canonical-ci.yml`

The repository root intentionally has **no implicit `wrangler.jsonc` deployment target**. Worker operations must name the intended Native configuration explicitly until Deployment Integrity replaces direct deployment with exact-SHA Workers Builds API promotion.

## Repository rules during convergence

- `main` is not to be moved until the consolidation branch is green and reviewed.
- Production resources are not changed during Phase 0.
- The historical physical deployment branch is not the future deployment model and is not advanced by repository canonicalization.
- Legacy GitHub Pages / TiDB / Warehouse implementation is archive and rollback material, not the canonical product architecture.
- Legacy code is not deleted merely because it is old; runtime/build references are removed and proven first.
- Native deployment assets are constrained by an explicit allowlist. Adding a file under `assets/` does not automatically make it deployable.

See `docs/architecture/CANONICAL_RUNTIME.md` for the convergence boundary and archive map.

## Transitional frontend compatibility

The current UI is still the migration-era monolith. Cloudflare Native injects a same-origin API client and a D1-backed `PrivateCloudQuery` compatibility bridge so existing modules can operate while the frontend is migrated incrementally.

`assets/private-cloud-warehouse-v4.js` is still present as an explicitly declared compatibility asset because it owns remaining legacy private-cloud UI behavior. It is **not** the target data architecture. `private-cloud-query-v1.js` and Warehouse V3 are forbidden from the final Native build artifact.

Frontend modernization will use a strangler migration toward TypeScript + React + Vite rather than a big-bang rewrite.

## Data architecture

### Control D1

Central governance and product-control data, including users, RBAC, product/keyword/negative governance, audit, and rollups.

### Store D1

Store-local Amazon entities, facts, report state, ingestion state, and source provenance.

### R2

Immutable/raw report objects and source evidence used by ingestion and replay.

### Workflows + Sync Worker

Asynchronous Amazon acquisition and ingestion orchestration. Amazon remains a dormant subsystem during Architecture Convergence; Phase 0 does not activate credentials, scheduled sync, report acquisition, or Amazon mutation.

## Product direction

The product is not a warehouse UI. Its primary business loop is:

```text
trusted data
→ waste detection
→ opportunity detection
→ recommendation
→ explanation
→ approval
→ action
→ verification
→ learning
```

Priority product modules are Search Term Intelligence, Negative Keyword Intelligence, Keyword Harvesting, Bid Intelligence, Budget Intelligence, ACoS/ROAS diagnostics, and governed actions.

## Delivery order

1. Architecture Convergence
2. Security Integrity
3. Deployment Integrity
4. Unified Dev exact-SHA live baseline
5. Frontend Platform modernization
6. Amazon Store 01 read-only pipeline
7. Decision Intelligence
8. Governed Amazon execution
9. Multi-store expansion

No Amazon write path is authorized merely because transport code exists.

## Historical material

Legacy GitHub Pages / TiDB / Warehouse documentation, workflows, configs, and builders are preserved under `docs/archive/` and in Git history. They are retained for traceability and rollback investigation only.
