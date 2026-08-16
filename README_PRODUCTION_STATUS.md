# Ads Operations Integrity — Current Platform Status

> Authority: repository/platform status during Architecture Convergence Phase 0. This file is not a substitute for live GitHub or Cloudflare state. Always verify the exact SHA and deployment receipt before promotion.

## Current strategy

The canonical target is Cloudflare Native. The historical GitHub Pages + TiDB + `amazon-warehouse-cloud-v4` architecture is no longer the future production target.

Current convergence source started from:

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
cloudflare/runtime/web-entry.js
cloudflare/runtime/wrangler.native.jsonc
```

Canonical sync runtime:

```text
cloudflare/runtime/sync-worker.js
cloudflare/runtime/wrangler.sync.jsonc
```

Canonical build:

```text
npm run build
→ scripts/build-cloudflare.mjs compatibility shim
→ scripts/build-cloudflare-native.mjs
→ dist-cloudflare-native/
```

The root Warehouse Service Binding Wrangler configuration has been archived and removed from the active repository root, so an unqualified root `wrangler deploy` is not a canonical deployment path.

## CI truth

Architecture Convergence introduces:

```text
.github/workflows/cloudflare-native-canonical-ci.yml
```

It validates:

- Cloudflare Native runtime/build contracts;
- foundation migrations and regressions;
- Access/user/global-role governance regressions;
- dormant Amazon credential/report transport regressions.

Historical GitHub Pages `pages.yml` and TiDB-era `ci-main.yml` are archived under `docs/archive/legacy-github-pages/` and are no longer active workflows on the consolidation branch.

Existing granular Cloudflare Gate/Foundation workflows remain temporarily for regression traceability during convergence. They are not the long-term workflow topology.

## Native asset boundary

The Native builder no longer treats the whole `assets/` directory as implicitly deployable. Final output is constrained by an explicit file allowlist.

Explicitly forbidden from the final Native artifact:

```text
assets/private-cloud-query-v1.js
assets/private-cloud-warehouse-v3.js
```

`assets/private-cloud-warehouse-v4.js` remains temporarily allowlisted because the current monolithic UI still depends on some of its browser behavior. It is migration compatibility debt, not the future data plane.

## Amazon state

Amazon integration is not being expanded during Phase 0.

Existing credential, LWA smoke, report transport, acquisition, staging, fact publishing, provenance, and Workflow code is retained as a dormant subsystem. Controlled activation resumes only after convergence and starts with Store 01 read-only.

No Amazon mutation is authorized in this phase.

## Production state

The final Cloudflare Native Production deployment contract is **not established yet**. Production placeholders and multi-store production configuration are planning material, not evidence that the Native production stack has been provisioned and accepted.

Do not create or alter Production resources during Architecture Convergence Phase 0.

The long-term production entrypoint should use a Cloudflare Custom Domain protected by Cloudflare Access.

## Next convergence work

Remaining Phase 0 priorities:

1. prove and retire remaining Warehouse V4 browser behavior from the Native artifact;
2. continue workflow consolidation after coverage equivalence is proven;
3. normalize package/deploy command semantics so direct deployment aliases cannot be mistaken for the future deployment model;
4. define canonical directory ownership for legacy vs active source;
5. produce a green consolidation branch suitable for controlled PR into `main`.

Security Integrity, exact-SHA deployment API migration, frontend modernization, and Amazon Store 01 activation are later phases and must not be pulled forward into Phase 0 merely to reduce the number of open tasks.
