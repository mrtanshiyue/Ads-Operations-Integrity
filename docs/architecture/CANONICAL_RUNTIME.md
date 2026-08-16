# Canonical Architecture and Runtime

Status: Phase 0–2 frozen; Phase 3 Operator Product Surface active

## Canonical product architecture

The active product architecture is Cloudflare Native:

```text
Cloudflare Access
  → Web Worker
  → application RBAC
  → Control D1
  → store-scoped D1
  → R2 raw objects
  → Workflows
  → Sync Worker
  → Amazon Ads API (dormant until a later explicitly authorized phase)
```

The historical GitHub Pages / TiDB / `amazon-warehouse-cloud-v4` architecture is migration history only. It is not an active deployment target.

## Canonical runtime entrypoints

Web runtime:

```text
cloudflare/runtime/wrangler.native.jsonc
  → cloudflare/runtime/web-entry.js
  → cloudflare/runtime/web-worker.js + modular APIs
```

Dormant Sync runtime:

```text
cloudflare/runtime/wrangler.sync.jsonc
  → cloudflare/runtime/sync-worker.js
```

There is no active root `wrangler.jsonc` and no active `src/worker.js` Warehouse proxy.

## Canonical browser API path

```text
Cloudflare Access browser session
  → assets/cloudflare-native-api-v1.js
  → same-origin /api/v1/*
  → web-entry modular routes
  → application RBAC
  → Control D1 / Store D1 / R2
```

Browser transport rules:

- same-origin Cloudflare Native APIs only;
- Cloudflare Access session, never Warehouse dashboard passwords;
- no `X-Dashboard-Password`;
- no session-stored Warehouse credential;
- no browser request to `amazon-warehouse-cloud-v4`;
- no browser Amazon Ads API transport;
- no browser deployment control;
- Cloud Raw import remains fail-closed with `cloudflare_native_raw_import_not_migrated` until a dedicated Native ingestion phase resolves it.

## Canonical operator product surfaces

Existing Native operator assets include:

```text
assets/cloudflare-native-api-v1.js
assets/cloudflare-native-data-panel-v1.js
assets/cloudflare-native-negative-governance-v1.js
assets/cloudflare-native-audit-console-v1.js
assets/cloudflare-native-access-console-v1.js
```

Phase 3 adds operator-facing product workflows on top of the existing canonical APIs. Gate 3.0 introduces:

```text
assets/cloudflare-native-keyword-governance-v1.js
```

The Phase 3 keyword console is limited to global keyword-library governance and product-keyword mapping through `CloudflareNativeAPI`. It must not contain Amazon, Sync or direct deployment transports.

## Canonical build

```text
npm run build
  → scripts/build-cloudflare.mjs
  → scripts/build-cloudflare-native.mjs
  → scripts/build-cloudflare-native-copy-all.mjs
  → scripts/enforce-cloudflare-native-asset-allowlist.mjs
  → dist-cloudflare-native/
```

The final Native artifact is constrained by an explicit file allowlist. The build strips retired Warehouse/cloud-loader script tags from the deployment artifact, injects canonical Native browser clients exactly once and enforces `connect-src 'self'`.

## Canonical CI

The active repository CI topology is:

```text
.github/workflows/cloudflare-native-canonical-ci.yml
Required context: Static site and security invariants
```

It covers, at minimum:

- Architecture Convergence boundaries;
- Security Integrity regressions;
- Deployment Integrity invariants;
- Native runtime/build/UI regressions;
- Native cloud-loader strangler boundary;
- foundation schema/migration regressions;
- Phase E producer/ingestion regressions;
- R2 provenance contracts;
- Access/user/global-role governance;
- local D1 security transactions;
- Access JWT request pipeline;
- dormant Amazon transport regressions without deployment;
- Phase 3 operator-surface contracts as they are added.

Canonical CI is validation-only. It must not perform a live Cloudflare mutation.

## Deployment integrity

Phase 2 is frozen as:

```text
Phase 2 = COMPLETE + MERGED + POST-MERGE CORRELATED
```

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

Key invariants:

```text
repository SHA ≠ deployed runtime SHA
merge main ≠ deployment
Dev deployment ≠ Production deployment
Production deployment ≠ Amazon activation
```

Historical deployment branch remains frozen rollback/reference evidence only:

```text
__manual_ci_gated_deploy__
ce59e4cc43413338f35a34cb44622a7aa26f9875
```

Workers Builds trigger `33a47d45-4103-43d7-bca4-7d9096c4abfb` remains preserved as the exact-SHA executor. Historical branch motion is not canonical provenance.

Direct repository deploy aliases remain fail-closed through `scripts/block-direct-cloudflare-deploy.mjs`.

## Accepted Web Dev security/runtime state

The frozen Phase 2 correlated state is:

```text
Worker: ads-operations-web-dev
Worker immutable tag: ab2b4da6c8be41a5a72223384c32b71c
Active deployment: 46993acd-cc8f-46fb-bd6c-c1a3b7f41bcb
Active version: 1264fc03-c111-4037-9029-e21ba57a84b2
Traffic: 100%
workers.dev enabled: true
previews_enabled: false
ACCESS_MODE=enforce
SYNC_TRIGGER_ENABLED=false
```

Phase 3 repository changes do not alter this runtime state until a later exact-SHA Dev deployment is explicitly executed and correlated.

## Amazon boundary

Amazon Ads API remains DORMANT:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

Dormant Amazon helper implementations remain in the repository for deterministic regression coverage and later resumption. Phase 3 does not authorize credential provisioning, live LWA smoke, profile bootstrap, report transport execution, Sync Worker redeployment or real Amazon sync.

## Production boundary

Production remains NOT READY. Production D1 IDs and Access values in `cloudflare/runtime/wrangler.native.jsonc` remain unresolved placeholders.

Phase 3 operator-product work must not provision or mutate Production DNS, Access, Worker, D1, R2 or Workflow resources.

## Repository ownership

Active architecture/runtime source:

- `cloudflare/foundation/`
- `cloudflare/runtime/`
- active `assets/cloudflare-native-*`
- active query/governance assets required by the deployment allowlist
- `scripts/` validation/build/test helpers
- `docs/architecture/` canonical phase contracts and immutable evidence

Historical implementation/configuration remains recoverable under `docs/archive/` but does not define current runtime behavior.

## Active phase

See:

```text
docs/architecture/PHASE3_OPERATOR_PRODUCT_SURFACE.md
```

Phase 3 prioritizes operator workflow/product convergence before Production readiness or Amazon activation.
