# Ads Operations Integrity — Current Platform Status

> Operational status summary. Canonical frozen Phase 2 evidence is `docs/architecture/PHASE2_MERGED_CLOSURE.md`. Active next-phase scope is `docs/architecture/PHASE3_OPERATOR_PRODUCT_SURFACE.md`. Immutable deployment receipts remain under `docs/architecture/` and must not be rewritten by later repository commits.

## Strategic status

```text
Architecture Convergence Phase 0 = COMPLETE + MERGED
Security Integrity Phase 1 = COMPLETE + MERGED
Deployment Integrity Phase 2 = COMPLETE + MERGED + POST-MERGE CORRELATED
Phase 3 Operator Product Surface = ACTIVE
Production = NOT READY
Amazon Ads API = DORMANT
```

Phase 2 is frozen. Do not reopen Phase 0–2 implementation unless a real regression or evidence drift is observed.

The frozen Phase 2 post-merge correlation baseline entered `main` through PR #55 with merge commit:

```text
ebcd662c5bc728606f85a750e489cbe2ea5db64c
```

That SHA is repository evidence. It is not the deployed Worker runtime SHA.

## Canonical CI and deployment semantics

Required GitHub context remains:

```text
Static site and security invariants
```

Canonical CI is validation-only. It performs no direct Cloudflare deployment, no historical branch promotion, no Production mutation and no Amazon activation.

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

Therefore:

```text
repository merge ≠ Dev deployment ≠ Production deployment ≠ Amazon activation
```

Historical deployment branch remains frozen rollback/reference evidence only:

```text
__manual_ci_gated_deploy__
ce59e4cc43413338f35a34cb44622a7aa26f9875
```

Workers Builds trigger remains preserved as the exact-SHA executor:

```text
33a47d45-4103-43d7-bca4-7d9096c4abfb
```

Do not delete, repurpose or use branch motion as canonical provenance.

## Accepted Cloudflare Web Dev runtime

Frozen Phase 2 correlated runtime evidence:

```text
Worker: ads-operations-web-dev
Worker immutable tag: ab2b4da6c8be41a5a72223384c32b71c
Active deployment: 46993acd-cc8f-46fb-bd6c-c1a3b7f41bcb
Active version: 1264fc03-c111-4037-9029-e21ba57a84b2
Traffic: 100%
Active version count: 1
workers.dev enabled: true
previews_enabled: false
ACCESS_MODE=enforce
SYNC_TRIGGER_ENABLED=false
```

Immutable Phase 2 receipts:

```text
docs/architecture/PHASE2_GATE24_DEPLOYMENT_RECEIPT.json
docs/architecture/PHASE2_PREVIEW_HARDENING_DEPLOYMENT_RECEIPT.json
```

Later Phase 3 repository commits must not rewrite those receipts or treat their Git SHAs as current repository `main`.

## Canonical runtime

Web runtime:

```text
cloudflare/runtime/wrangler.native.jsonc
→ cloudflare/runtime/web-entry.js
→ cloudflare/runtime/web-worker.js + modular APIs
```

Browser product/runtime clients use same-origin Cloudflare Native APIs under `/api/*` and Cloudflare Access browser sessions.

Active Native browser product assets include:

```text
assets/cloudflare-native-api-v1.js
assets/cloudflare-native-data-panel-v1.js
assets/cloudflare-native-negative-governance-v1.js
assets/cloudflare-native-audit-console-v1.js
assets/cloudflare-native-access-console-v1.js
```

Phase 3 adds operator-facing product surfaces on top of those existing APIs rather than creating another backend architecture.

Retired Warehouse/browser loader implementations remain recoverable only under `docs/archive/legacy-browser-loaders/`; they are archive/reference material and must not re-enter the active Native artifact.

Cloud Raw import remains explicitly fail-closed:

```text
cloudflare_native_raw_import_not_migrated
```

## Amazon state

Amazon Ads API remains DORMANT by repository and runtime contract:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

Historical Sync Dev runtime remains outside Phase 3 implementation scope. No Phase 3 work authorizes:

- Amazon credential provisioning;
- LWA live smoke;
- profile bootstrap;
- Create/Poll/Download Report;
- real Amazon sync;
- `AMAZON_ADS_ENABLED=true`;
- `SYNC_TRIGGER_ENABLED=true`;
- redeployment of `ads-operations-sync-dev`.

## Production state

Production remains **NOT READY**. The final Cloudflare Native Production deployment contract is **not established yet**.

`cloudflare/runtime/wrangler.native.jsonc` still contains unresolved Production placeholders including:

```text
REPLACE_PROD_CONTROL_D1_ID
REPLACE_PROD_STORE_01_D1_ID
REPLACE_PROD_STORE_02_D1_ID
REPLACE_PROD_STORE_03_D1_ID
REPLACE_PROD_STORE_04_D1_ID
https://REPLACE_ME.cloudflareaccess.com
ACCESS_AUD=REPLACE_ME
```

Existing historical Production-named Access resources do not constitute a current Production deployment contract. No Phase 3 operator-surface work authorizes Production DNS, Access, Worker, D1, R2, Workflow or break-glass mutation.

## Active Phase 3 direction

Phase 3 is the product/operator layer:

1. positive keyword governance console;
2. product registry and store mapping console;
3. audit/data-health operator convergence;
4. navigation and visual modernization;
5. Cloud Raw import decision;
6. Dev exact-SHA live acceptance before Phase 3 freeze.

Production readiness and Amazon activation remain separate future phases.
