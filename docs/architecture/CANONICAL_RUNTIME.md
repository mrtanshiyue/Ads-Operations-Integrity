# Canonical Architecture and Runtime

Status: Architecture Convergence Phase 0 — implementation converged, PR review pending

Foundation baseline: `b1828b8b6f62c167f8e0654175413e55f449c4bd`

## Canonical product architecture

The active product target is Cloudflare Native:

```text
Cloudflare Access
  -> Web Worker
  -> application RBAC
  -> Control D1
  -> store-scoped D1
  -> R2 raw objects
  -> Workflows
  -> Sync Worker
  -> Amazon Ads API (dormant until the later Amazon integration phase)
```

The historical GitHub Pages / TiDB / `amazon-warehouse-cloud-v4` architecture is migration history only. It is not an active deployment target.

## Canonical runtime entrypoints

Web runtime:

```text
cloudflare/runtime/wrangler.native.jsonc
  -> cloudflare/runtime/web-entry.js
  -> cloudflare/runtime/web-worker.js + modular APIs
```

Dormant sync runtime:

```text
cloudflare/runtime/wrangler.sync.jsonc
  -> cloudflare/runtime/sync-worker.js
```

There is no active root `wrangler.jsonc` and no active `src/worker.js` Warehouse proxy.

## Canonical browser data path

```text
assets/cloudflare-native-api-v1.js
  -> assets/cloudflare-native-query-bridge-v1.js
  -> assets/cloudflare-native-data-panel-v1.js
```

Browser transport rules:

- same-origin Cloudflare Native APIs only;
- Cloudflare Access browser session, not Warehouse dashboard passwords;
- no `X-Dashboard-Password`;
- no session-stored Warehouse credential;
- no browser request to `amazon-warehouse-cloud-v4`;
- Cloud Raw import remains explicitly fail-closed with `501 cloudflare_native_raw_import_not_migrated` until migrated;
- local file import remains a separate browser workflow.

Legacy browser cloud loaders/query client are archived under `docs/archive/legacy-browser-loaders/` and are neither active source assets nor deployment assets.

## Canonical build

```text
npm run build
  -> scripts/build-cloudflare.mjs
  -> scripts/build-cloudflare-native.mjs
  -> scripts/build-cloudflare-native-copy-all.mjs
  -> scripts/enforce-cloudflare-native-asset-allowlist.mjs
  -> dist-cloudflare-native/
```

The final Native artifact is controlled by an explicit file allowlist. The build strips legacy migration script-tag markers from the input HTML, injects Native browser clients, and enforces `connect-src 'self'`.

## Canonical CI

The only active repository CI topology for convergence is:

```text
.github/workflows/cloudflare-native-canonical-ci.yml
```

It covers:

- Architecture Convergence contracts;
- Native runtime/build/UI/Gate regressions;
- Native cloud-loader strangler boundary;
- foundation schema/migration regressions;
- Phase E producer/ingestion/migration regressions;
- R2 provenance Gates 24–27;
- Access/user/global-role governance;
- dormant Amazon transport tests without deployment or promotion.

The former Foundation, Access, Amazon transport and Gate 24–27 granular workflows were retired only after coverage parity was proven and are archived under `docs/archive/legacy-ci/`.

GitHub Pages `pages.yml` and TiDB-era `ci-main.yml` are archived under `docs/archive/legacy-github-pages/`.

## Deployment and live-execution boundaries

Repository `deploy:*` npm aliases are fail-closed through `scripts/block-direct-cloudflare-deploy.mjs`.

The Amazon secret-provisioning npm entrypoint is fail-closed through `scripts/block-dormant-amazon-execution.mjs`.

Dormant Amazon helper implementations remain in the repository for deterministic regression coverage and later resumption, but Amazon credential provisioning, live LWA smoke, sync trigger promotion and sync Worker deployment are not part of the Phase 0 execution surface.

Current kill switches remain:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

## Repository ownership

Active architecture/runtime source:

- `cloudflare/foundation/`
- `cloudflare/runtime/`
- active `assets/cloudflare-native-*`
- active Native/query/governance assets required by the allowlist
- `scripts/` validation/build/test helpers

Historical implementation/configuration:

- `docs/archive/legacy-github-pages/`
- `docs/archive/legacy-warehouse-v4/`
- `docs/archive/legacy-browser-loaders/`
- `docs/archive/legacy-ci/`
- `docs/archive/legacy-deploy/`
- `docs/archive/dormant-amazon/`

History is preserved, but archived paths do not define current runtime behavior.

## Phase 0 guardrails

Until the consolidation PR is explicitly reviewed and merged:

1. Do not advance `main` outside the controlled PR.
2. Do not move `__manual_ci_gated_deploy__` as part of repository convergence.
3. Do not deploy Workers from repository scripts.
4. Do not create or modify Production resources.
5. Do not resume Amazon API credentials, live smoke, report transport execution or real sync.
6. Do not weaken source provenance/readiness fail-closed semantics.

## Deferred phases

Phase 0 intentionally does not complete:

- final Production resource provisioning or Production acceptance;
- exact-SHA Cloudflare deployment API migration / deployment-integrity work;
- Security Integrity expansion;
- frontend visual modernization;
- Cloud Raw import migration;
- Amazon Store 01 real API activation.

Those are later phases and should not be mixed into the convergence PR.
