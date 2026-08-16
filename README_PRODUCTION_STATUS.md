# Ads Operations Integrity — Current Platform Status

> Operational status summary only. Canonical architecture truth is `docs/architecture/PHASE2_DEPLOYMENT_INTEGRITY.md`; immutable deployment evidence is stored under `docs/architecture/`.

## Repository status

Architecture Convergence Phase 0 remains COMPLETE + MERGED. Security Integrity Phase 1 remains COMPLETE + MERGED.

```text
Canonical main: d644ab22706d3b722ced1fc1bc92509a44600926
Phase 2 branch: deployment-integrity-phase2
Gate 2.4 accepted SHA: 27da62ee2b064c685df35bf76dc395f349f68aba
Preview-hardening deployed SHA: 0d1115da98282e6874ce2b8128a14fb05a1ac968

Phase 0 = COMPLETE + MERGED
Phase 1 = COMPLETE + MERGED
Phase 2 = FOUNDATION PASS / DEV LIVE DEPLOYMENT INTEGRITY PASS
          PREVIEW URL HARDENING LIVE PASS
          POST-ACCEPTANCE GOVERNANCE COMPLETE
          NOT MERGED TO MAIN

Gate 2.0 = PASS
Gate 2.1 = PASS — IMPLEMENTED + LIVE
Gate 2.2 = PASS
Gate 2.3 = PASS — LIVE READ-ONLY DISCOVERY COMPLETE
Gate 2.4 = COMPLETE
Gate 2.5 = PREFLIGHT COMPLETE / RETIREMENT DEFINITION FROZEN / DESTRUCTIVE RETIREMENT NOT AUTHORIZED
```

`deployment-integrity-phase2` remains a forward-only branch from current main. Do not merge main without separate authorization.

## Canonical CI

```text
Workflow: Cloudflare Native Canonical CI
Required context: Static site and security invariants
Gate 2.4 Run: 31938209069 = SUCCESS
Preview-hardening Run: 31940028696 = SUCCESS
Preview-hardening head SHA: 0d1115da98282e6874ce2b8128a14fb05a1ac968
```

Canonical CI is validation-only. It performs no `wrangler deploy`, no live Cloudflare mutation, no historical branch promotion and no Amazon activation.

## Current live Cloudflare Dev state

```text
Account: 19cd528b5c32e8da423da3cf66a9f05d
Worker: ads-operations-web-dev
Worker immutable tag: ab2b4da6c8be41a5a72223384c32b71c
Workers Builds trigger: 33a47d45-4103-43d7-bca4-7d9096c4abfb
Hardening build UUID: 006a7123-4204-499d-bae7-4138284bf30d
Build outcome: success
Build commit: 0d1115da98282e6874ce2b8128a14fb05a1ac968
Active version: 1264fc03-c111-4037-9029-e21ba57a84b2
Active deployment: 46993acd-cc8f-46fb-bd6c-c1a3b7f41bcb
Traffic: 100%, one active version
workers.dev enabled: true
preview URLs enabled: false
```

Immutable receipts:

```text
docs/architecture/PHASE2_GATE24_DEPLOYMENT_RECEIPT.json
docs/architecture/PHASE2_PREVIEW_HARDENING_DEPLOYMENT_RECEIPT.json
```

The Gate 2.4 receipt remains tied to `27da62ee...`; the preview-hardening receipt remains tied to `0d1115da...`. Documentation commits do not rewrite either deployed SHA.

## Deployment semantics

Canonical provenance remains:

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

Historical physical branch remains frozen:

```text
__manual_ci_gated_deploy__
ce59e4cc43413338f35a34cb44622a7aa26f9875
```

It is rollback/reference evidence and is no longer the canonical provenance mechanism.

The Workers Builds trigger object is different from the historical branch-motion mechanism. Trigger UUID `33a47d45-4103-43d7-bca4-7d9096c4abfb` is still required by the exact-SHA Builds API path and must not be deleted now.

## Preview URL hardening

Canonical runtime policy is:

```text
preview_urls = false
```

The controlled Dev exact-SHA deployment has now activated that policy live. Cloudflare reports the canonical `workers.dev` route still enabled while `previews_enabled=false`.

The live Worker version retains `ACCESS_MODE=enforce`, and the canonical Dev hostname remains covered by the Cloudflare Access application `ads-operations-web-dev access` with policy `Dev owner only`.

A post-deployment Browser Rendering HTTP probe was attempted but was rate-limited by Cloudflare API error `2001`; no HTTP success was fabricated. Control-plane acceptance is based on the active 100% deployment, exact version→build→commit correlation, canonical `workers.dev` enabled state, preview URLs disabled state and retained Access/Worker fail-closed controls.

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

Runtime version evidence contract remains:

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
