# Ads Operations Integrity — Current Platform Status

> Authority: repository/platform status during Architecture Convergence Phase 0. This file is not a substitute for live GitHub or Cloudflare state. Always verify the exact SHA and deployment receipt before promotion.

## Current strategy

The canonical target is Cloudflare Native. The historical GitHub Pages + TiDB + `amazon-warehouse-cloud-v4` architecture is retired from the active deployment model.

Convergence started from:

```text
cloudflare-foundation-v1
b1828b8b6f62c167f8e0654175413e55f449c4bd
```

Active consolidation work is performed on:

```text
consolidation/architecture-convergence-phase0
```

`main` is intentionally not advanced during Phase 0 until the consolidated branch has passed the required CI and review.

## Runtime truth

Canonical web runtime:

```text
cloudflare/runtime/wrangler.native.jsonc
→ cloudflare/runtime/web-entry.js
→ cloudflare/runtime/web-worker.js + modular APIs
```

Canonical sync runtime remains dormant:

```text
cloudflare/runtime/wrangler.sync.jsonc
→ cloudflare/runtime/sync-worker.js
```

Canonical browser data path:

```text
assets/cloudflare-native-api-v1.js
→ assets/cloudflare-native-query-bridge-v1.js
→ assets/cloudflare-native-data-panel-v1.js
```

The Native browser uses same-origin API calls and the Cloudflare Access browser session. Warehouse dashboard passwords, `X-Dashboard-Password`, session-stored Warehouse credentials, and the Warehouse external browser transport are not part of the Native deployment artifact.

Cloud Raw import is not yet migrated. It is explicitly fail-closed with `501 cloudflare_native_raw_import_not_migrated`; local file import remains available as a separate browser workflow.

The old root Warehouse Service Binding Worker and Wrangler configuration have been archived and removed from active runtime paths.

## Build truth

Canonical build:

```text
npm run build
→ scripts/build-cloudflare.mjs
→ scripts/build-cloudflare-native.mjs
→ dist-cloudflare-native/
```

The Native build:

- enforces `connect-src 'self'`;
- injects the Native API, query bridge, governance, Access/audit clients and Native data panel;
- strips legacy browser cloud-loader script tags from the deployment HTML;
- enforces an explicit deployment-asset allowlist.

Legacy Warehouse browser implementations are archived under:

```text
docs/archive/legacy-browser-loaders/
```

They are not active source assets and are forbidden from `dist-cloudflare-native/`.

## CI truth

The canonical workflow is:

```text
.github/workflows/cloudflare-native-canonical-ci.yml
```

It now covers:

- Architecture Convergence boundary contracts;
- Cloudflare Native build/runtime/UI/Gate regressions;
- Native cloud-loader strangler regression;
- foundation migrations and regressions;
- Phase E producer/ingestion/migration regressions;
- R2 provenance Gates 24–27;
- Access/user/global-role governance;
- dormant Amazon transport tests without deployment or promotion.

The former granular Foundation, Access, Amazon transport and Gate 24–27 workflows were retired only after coverage parity was demonstrated. Their exact historical files are archived under `docs/archive/legacy-ci/`.

The historical GitHub Pages `pages.yml` and TiDB-era `ci-main.yml` are archived under `docs/archive/legacy-github-pages/` and are inactive.

## Deployment safety

Repository `deploy:*` npm aliases are quarantined. They call `scripts/block-direct-cloudflare-deploy.mjs` and fail closed instead of running `wrangler deploy`.

The previous deploy command map is archived under:

```text
docs/archive/legacy-deploy/package-deploy-scripts.json
```

No direct repository deployment path is authorized during Phase 0.

## Amazon state

Amazon integration is not being expanded during Phase 0.

Existing credential, LWA smoke, report transport, acquisition, staging, fact publishing, provenance and Workflow code is retained only as a dormant subsystem under regression coverage.

Current controls remain:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

No Amazon mutation or sync-worker deployment is authorized in this phase.

## Production state

The final Cloudflare Native Production deployment contract is **not established yet**. Production placeholders and multi-store production configuration are planning material, not evidence that the Native production stack has been provisioned and accepted.

Do not create or alter Production resources during Architecture Convergence Phase 0.

The long-term production entrypoint should use a Cloudflare Custom Domain protected by Cloudflare Access.

## Phase 0 convergence state

The following repository-level split-brain paths have now been removed or quarantined on the consolidation branch:

- root legacy Wrangler deployment entry;
- GitHub Pages deployment workflow;
- TiDB-era main CI;
- granular Cloudflare CI topology after coverage parity;
- unqualified/direct npm deploy aliases;
- legacy `src/worker.js` Warehouse proxy;
- Warehouse browser loaders/query client from the Native deployment artifact;
- Warehouse browser loader implementations from active source ownership.

Remaining work before Phase 0 can be considered ready for controlled PR review is primarily verification and consolidation hygiene, not expansion of Amazon or Production scope.
