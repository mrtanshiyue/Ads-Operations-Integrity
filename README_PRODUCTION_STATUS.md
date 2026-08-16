# Ads Operations Integrity — Current Platform Status

> Operational status summary only. Canonical architecture truth is `docs/architecture/PHASE2_DEPLOYMENT_INTEGRITY.md`; immutable Gate 2.4 evidence is `docs/architecture/PHASE2_GATE24_DEPLOYMENT_RECEIPT.json`.

## Repository status

Architecture Convergence Phase 0 remains COMPLETE + MERGED. Security Integrity Phase 1 remains COMPLETE + MERGED.

```text
Canonical main: d644ab22706d3b722ced1fc1bc92509a44600926
Phase 2 branch: deployment-integrity-phase2
Gate 2.4 accepted SHA: 27da62ee2b064c685df35bf76dc395f349f68aba

Phase 0 = COMPLETE + MERGED
Phase 1 = COMPLETE + MERGED
Phase 2 = FOUNDATION PASS / DEV LIVE DEPLOYMENT INTEGRITY PASS
          POST-ACCEPTANCE GOVERNANCE IN PROGRESS
          NOT MERGED TO MAIN

Gate 2.0 = PASS
Gate 2.1 = PASS — IMPLEMENTED + LIVE
Gate 2.2 = PASS
Gate 2.3 = PASS — LIVE READ-ONLY DISCOVERY COMPLETE
Gate 2.4 = COMPLETE
Gate 2.5 = PREFLIGHT COMPLETE / RETIREMENT DESIGN IN PROGRESS
```

`deployment-integrity-phase2` is a forward-only branch from current main; Phase 2 is mergeable in principle but must not merge main until post-acceptance governance is complete and separately authorized.

## Canonical CI

```text
Workflow: Cloudflare Native Canonical CI
Required context: Static site and security invariants
Gate 2.4 Run: 31938209069
Gate 2.4 head SHA: 27da62ee2b064c685df35bf76dc395f349f68aba
Result: SUCCESS
```

Canonical CI is validation-only. It performs no `wrangler deploy`, no live Cloudflare mutation, no historical branch promotion and no Amazon activation.

## Gate 2.4 live Cloudflare state

```text
Account: 19cd528b5c32e8da423da3cf66a9f05d
Worker: ads-operations-web-dev
Worker immutable tag: ab2b4da6c8be41a5a72223384c32b71c
Workers Builds trigger: 33a47d45-4103-43d7-bca4-7d9096c4abfb
Build UUID: f064ee48-6e28-43d2-a575-883c9a45bca1
Build outcome: success
Build commit: 27da62ee2b064c685df35bf76dc395f349f68aba
Active version: 96710600-9968-4e1f-88d4-cd84cc546ca0
Active deployment: e6ab548a-b070-4a03-ab7a-b17c255face5
Traffic: 100%, one active version
Live runtime version: 96710600-9968-4e1f-88d4-cd84cc546ca0
```

Immutable receipt:

```text
docs/architecture/PHASE2_GATE24_DEPLOYMENT_RECEIPT.json
```

The receipt deliberately remains tied to the accepted Gate 2.4 SHA, not later governance commits.

## Deployment semantics

Canonical provenance is:

```text
Canonical CI SUCCESS
→ exact Git SHA
→ Workers Builds trigger called with commit_hash
→ build UUID
→ Worker version
→ deployment
→ runtime version acceptance
→ immutable receipt
```

Historical physical branch:

```text
__manual_ci_gated_deploy__
ce59e4cc43413338f35a34cb44622a7aa26f9875
```

It remains frozen rollback/reference evidence and is no longer the canonical provenance mechanism.

The Workers Builds trigger object is different from the historical branch-motion mechanism. Trigger UUID `33a47d45-4103-43d7-bca4-7d9096c4abfb` is still required by the exact-SHA Builds API path and must not be deleted now.

## Preview URL hardening

Read-only assessment found the version preview hostname publicly routable for the static UI shell, but found no protected API bypass and no D1 data bypass. This is a hardening issue, not evidence of a data leak.

Canonical runtime policy is now:

```text
preview_urls = false
```

This disables versioned/aliased preview URLs while retaining the canonical `workers.dev` route. The repository change is implementation-only until a controlled Dev exact-SHA deployment activates it live.

`GET /api/health` remains in place for deployment/version acceptance. Protected `/api/*` routes remain guarded by `ACCESS_MODE=enforce` and actor validation.

## Runtime and architecture convergence markers

Canonical Web runtime:

```text
cloudflare/runtime/wrangler.native.jsonc
→ cloudflare/runtime/web-entry.js
→ cloudflare/runtime/web-worker.js + modular APIs
```

Canonical browser data panel remains:

```text
assets/cloudflare-native-data-panel-v1.js
```

Retired browser loader implementations remain recoverable only as archive/reference material under:

```text
docs/archive/legacy-browser-loaders/
```

Cloud Raw import remains explicitly fail-closed with:

```text
cloudflare_native_raw_import_not_migrated
```

Runtime version evidence remains:

```text
GET /api/health
→ CF_VERSION_METADATA
```

Direct deploy aliases remain fail-closed through `scripts/block-direct-cloudflare-deploy.mjs`. Historical promotion/release helpers are implementation history/regression material, not canonical deployment control-plane code.

## Amazon state

Amazon Ads API remains DORMANT.

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

No credential provisioning, LWA live smoke, profile bootstrap, report creation/poll/download, real Amazon sync or Sync Worker deployment is authorized.

## Production state

The final Cloudflare Native Production deployment contract is **not established yet**.

Production remains NOT READY and untouched.

`cloudflare/runtime/wrangler.native.jsonc` still contains:

```text
REPLACE_PROD_CONTROL_D1_ID
REPLACE_PROD_STORE_01_D1_ID
REPLACE_PROD_STORE_02_D1_ID
REPLACE_PROD_STORE_03_D1_ID
REPLACE_PROD_STORE_04_D1_ID
https://REPLACE_ME.cloudflareaccess.com
ACCESS_AUD=REPLACE_ME
```

No Phase 2 work authorizes Production DNS, Access, Worker, D1, R2, deployment or break-glass changes.
