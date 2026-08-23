# Phase 3 — Operator Product Surface

Status: ACTIVE — Gate 3.0 repository implementation in progress

Phase 3 starts from the frozen Phase 2 post-merge correlated baseline. It does not reopen Architecture Convergence, Security Integrity, Deployment Integrity, Preview Hardening, immutable deployment receipts, the historical deployment branch, or the exact-SHA Workers Builds executor.

## Objective

Turn the already-existing Cloudflare Native product/governance APIs into a coherent operator-facing product surface before any Production readiness work or Amazon Ads API activation.

The repository already contains canonical APIs for:

- global product registry;
- global keyword library;
- product-keyword mappings;
- global negative-keyword library;
- store/product negative-keyword scopes;
- store product identity;
- analytics and data health;
- audit events;
- Access/user/store-role governance.

Phase 3 therefore prioritizes operator workflows and UI convergence rather than adding another backend architecture layer.

## Hard boundaries

Phase 3 MUST keep:

```text
Production = NOT READY
Amazon Ads API = DORMANT
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
ACCESS_MODE=enforce
Web preview_urls=false
```

Phase 3 MUST NOT:

- provision or mutate Production Worker/D1/R2/Workflow/Access/DNS resources;
- replace Production placeholders in `cloudflare/runtime/wrangler.native.jsonc`;
- provision Amazon credentials;
- run LWA live smoke;
- bootstrap Amazon profiles;
- Create/Poll/Download Amazon reports;
- enable real Amazon sync;
- deploy `ads-operations-sync-dev`;
- delete or move `__manual_ci_gated_deploy__`;
- delete or repurpose Workers Builds trigger `33a47d45-4103-43d7-bca4-7d9096c4abfb`;
- weaken Cloudflare Access, application RBAC, audit logging, or deployment provenance.

## Product-surface rule

Browser operator features must use:

```text
Cloudflare Access browser session
→ same-origin CloudflareNativeAPI
→ /api/v1/*
→ application RBAC
→ Control D1 / Store D1 / R2
```

They must not introduce direct browser credentials, Warehouse proxy transport, cross-origin Amazon calls, direct Worker deployment controls, or Sync activation controls.

## Gate model

### Gate 3.0 — Positive Keyword Governance Console

Goal: make the existing global keyword library and product-keyword mapping APIs operable from the canonical Cloudflare Native UI.

Required repository contract:

- a separately versioned Native keyword governance browser asset;
- global keyword list/search/filter;
- keyword creation;
- keyword lifecycle management (`active`, `watch`, `retired`);
- active product selection;
- product-keyword mapping list;
- map/unmap keyword to product;
- primary-keyword toggle while preserving mapping metadata;
- read-only fallback when governance permissions are absent;
- all transport delegated to `CloudflareNativeAPI`;
- no Amazon/Sync/direct-deploy transport;
- explicit deployment-asset allowlist entry;
- build injects the console exactly once;
- dedicated deterministic contract test;
- Canonical CI coverage.

Gate 3.0 repository completion does not itself imply a live Dev deployment. If deployed, Phase 2 exact-SHA deployment provenance rules remain authoritative.

### Gate 3.1 — Product Registry and Store Mapping Console

Expose product registry lifecycle and store product identity mapping through the same operator model. Preserve store-scoped RBAC and Amazon identity provenance rules.

### Gate 3.2 — Audit and Data-Health Operator Convergence

Make governance writes, data-health evidence, audit events, and source provenance discoverable from one operator workflow without weakening source-readiness fail-closed behavior.

### Gate 3.3 — Navigation and Visual Modernization

Converge the legacy large-page presentation into a deliberate operator information architecture. This is a UI/UX phase, not an excuse to change runtime identity, data provenance, or deployment semantics.

### Gate 3.4 — Cloud Raw Import Decision

Either migrate Cloud Raw import into a first-class Native ingestion path with explicit provenance or keep it fail-closed. Do not silently re-enable the retired Warehouse loader.

### Gate 3.5 — Dev Live Acceptance and Phase Freeze

After repository implementation is complete and canonical CI passes, perform an explicitly correlated Dev Web deployment/acceptance through the exact-SHA Workers Builds path. Freeze Phase 3 only after repository + runtime evidence agree.

## Gate 3.0 implementation surface

Canonical files introduced/changed by Gate 3.0 are expected to be limited to:

```text
assets/cloudflare-native-keyword-governance-v1.js
scripts/test-keyword-governance-console-contract.mjs
scripts/build-cloudflare-native-copy-all.mjs
scripts/enforce-cloudflare-native-asset-allowlist.mjs
package.json
docs/architecture/PHASE3_OPERATOR_PRODUCT_SURFACE.md
README_PRODUCTION_STATUS.md
docs/architecture/CANONICAL_RUNTIME.md
```

No Phase 2 immutable receipt is modified.

## Deployment semantics remain unchanged

Canonical deployment provenance remains:

```text
Canonical CI SUCCESS
→ exact Git SHA
→ Workers Builds trigger called with exact commit_hash
→ build UUID
→ immutable Worker version
→ deployment
→ runtime version acceptance
→ immutable receipt/evidence
```

Repository SHA is repository truth. Deployed Worker version/deployment is runtime truth. A merge to `main` is not a deployment.

## Phase status

```text
Phase 0 = COMPLETE + MERGED
Phase 1 = COMPLETE + MERGED
Phase 2 = COMPLETE + MERGED + POST-MERGE CORRELATED
Phase 3 = ACTIVE
Gate 3.0 = IN PROGRESS
Production = NOT READY
Amazon Ads API = DORMANT
```
