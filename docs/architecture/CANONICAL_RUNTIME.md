# Canonical Architecture and Runtime

Status: Architecture Convergence Phase 0

Baseline: `b1828b8b6f62c167f8e0654175413e55f449c4bd`

## Canonical product architecture

The active product target is Cloudflare Native:

Cloudflare Access -> Web Worker -> application RBAC -> Control D1 -> store-scoped D1 -> R2 raw objects -> Workflows -> Sync Worker -> Amazon Ads API.

The historical GitHub Pages / TiDB / `amazon-warehouse-cloud-v4` architecture is retained only as rollback and migration history. It is not a canonical deployment target.

## Canonical runtime entrypoints

- Web runtime: `cloudflare/runtime/web-entry.js`
- Web Wrangler config: `cloudflare/runtime/wrangler.native.jsonc`
- Sync runtime: `cloudflare/runtime/sync-worker.js`
- Sync Wrangler config: `cloudflare/runtime/wrangler.sync.jsonc`
- Native asset builder: `scripts/build-cloudflare-native.mjs`
- Native artifact: `dist-cloudflare-native/`

There must be no implicit root Wrangler deployment target. All Worker commands must name the intended Cloudflare Native config explicitly until the deployment-integrity phase replaces direct Wrangler deployment with exact-SHA Workers Builds API deployment.

## Repository convergence guardrails

During Phase 0:

1. Do not merge this consolidation work to `main` until canonical CI is green.
2. Do not alter Production resources or Production bindings.
3. Do not move `__manual_ci_gated_deploy__` as part of repository canonicalization.
4. Do not delete legacy implementation merely because it is old; first prove that active runtime/build references are absent.
5. Legacy workflows/configuration removed from active paths must be preserved under `docs/archive/` or by Git history/tag.
6. Cloudflare Native build output must eventually use an explicit asset allowlist rather than copying the entire `assets/` tree.

## Transitional compatibility debt

`index.html` still loads `assets/private-cloud-warehouse-v4.js`. That browser runtime still owns legacy private-cloud UI behavior and directly references the retired Warehouse API origin. The Cloudflare Native query bridge provides `window.PrivateCloudQuery`, but it does not yet prove that the Warehouse V4 browser loader can be removed without UI regression.

Therefore Phase 0 keeps the Warehouse V4 browser compatibility layer in source and current Native UI until its remaining behaviors are mapped and replaced. This is an explicit migration boundary, not the target architecture.

## Legacy archive

The following historical deployment material is archived and is not active CI/CD/runtime configuration:

- `docs/archive/legacy-github-pages/pages.yml`
- `docs/archive/legacy-github-pages/ci-main.yml`
- `docs/archive/legacy-warehouse-v4/wrangler.jsonc`

## Canonical CI

`.github/workflows/cloudflare-native-canonical-ci.yml` is the convergence umbrella CI. It validates the Cloudflare Native runtime, foundation regressions, Access governance regressions, and dormant Amazon transport regressions without activating Amazon or deploying any Worker.

Existing granular Cloudflare workflows remain temporarily as regression history during convergence. They can be consolidated only after equivalent coverage is proven in canonical CI.

## Next Phase 0 slices

1. Rewire package-level default build/check commands to Cloudflare Native semantics and quarantine obsolete deploy aliases.
2. Build an asset dependency manifest and replace whole-tree `assets/` copying with an allowlist.
3. Retire or replace remaining Warehouse V4 browser behaviors from the Native artifact.
4. Rewrite root README/status documentation to reflect the canonical architecture.
5. Prepare the repository for a controlled PR to canonical `main` only after full CI passes.
