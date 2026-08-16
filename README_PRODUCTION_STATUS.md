# Ads Operations Integrity — Current Platform Status

> Repository/platform status after Architecture Convergence and during Security Integrity acceptance. This file is not a substitute for live GitHub or Cloudflare state. Always verify the exact Git SHA, required CI and deployment receipt before any promotion.

## Current strategic state

Architecture Convergence Phase 0 is complete and merged to canonical `main`:

```text
main
d83bd4dcabe8ed92d873902a463163191bf60382
```

Phase 1 — Security Integrity is implemented on:

```text
security-integrity-phase1
```

The accepted implementation candidate before final documentation commits is:

```text
5ef2d455c33b73144b07d0333ed3a9ce8b22b203
```

Its Canonical CI evidence is:

```text
Run 31931495846
Static site and security invariants = SUCCESS
```

Final Phase 1 PR-ready status still requires the documentation tip to pass the same required check.

## Canonical runtime truth

Web runtime:

```text
cloudflare/runtime/wrangler.native.jsonc
→ cloudflare/runtime/web-entry.js
→ cloudflare/runtime/web-worker.js + modular APIs
```

Sync runtime remains dormant:

```text
cloudflare/runtime/wrangler.sync.jsonc
→ cloudflare/runtime/sync-worker.js
```

Browser data path:

```text
assets/cloudflare-native-api-v1.js
→ assets/cloudflare-native-query-bridge-v1.js
→ assets/cloudflare-native-data-panel-v1.js
```

Warehouse browser credentials, Warehouse external transport, the old root Worker and legacy root Wrangler deployment target are retired from active runtime/source ownership. Exact retired browser-loader implementations remain recoverable only under:

```text
docs/archive/legacy-browser-loaders/
```

Cloud Raw import remains explicitly fail-closed with:

```text
501 cloudflare_native_raw_import_not_migrated
```

## Security Integrity state

Control D1 now has append-only defense-in-depth migrations:

```text
0005_control_security_integrity.sql
0006_control_access_recovery.sql
```

They enforce single global role, global/store role-scope boundaries, active global-role lifecycle, global/store membership exclusivity, last-active-owner protection, immutable assigned role scope, and audited owner Access-subject recovery.

Global Role governance and user lifecycle mutations now require D1 transaction batches so the governance mutation and audit event commit or roll back together. There is no sequential fallback.

Security-critical CI includes a real local Cloudflare Workers/D1 harness. It applies actual Control D1 migrations and proves rollback behavior for:

- Global Role grant/revoke audit failure;
- user lifecycle audit failure;
- break-glass owner Access recovery audit failure.

The full Access request pipeline is also tested through the production `web-entry.js` with `ACCESS_MODE=enforce`, real generated RSA/RS256 JWTs, JWKS interception at the Node test boundary, strict actor binding, real local D1, RBAC and a governed Global Role mutation with audit evidence.

No production authentication bypass or test identity header is introduced.

## Break-glass recovery

An out-of-band owner Access-subject recovery CLI exists:

```text
npm run security:break-glass:access-recovery -- ...
```

Important properties:

- default behavior is dry-run;
- it only rebinds an existing active owner's Cloudflare Access subject;
- it cannot create, grant, revoke or replace a global role;
- the Cloudflare API token is read only from `CLOUDFLARE_API_TOKEN`;
- execution requires an exact confirmation string;
- Production additionally requires `BREAK_GLASS_PRODUCTION_ENABLED=1` and a second exact Production confirmation;
- the recovery ledger is immutable and audit-backed;
- this repository work does **not** authorize executing Production recovery.

## CI truth

Canonical workflow:

```text
.github/workflows/cloudflare-native-canonical-ci.yml
```

Required main branch check context must remain exactly:

```text
Static site and security invariants
```

The Canonical CI covers `main`, long-lived compatibility source where still needed, and short-lived `feature/**`, `fix/**`, `security-integrity-*` / convergence branches.

It validates:

- architecture boundaries;
- Cloudflare Native runtime/build/UI;
- foundation and Security Integrity migrations;
- Phase E ingestion/producer regressions;
- R2 provenance regressions;
- Access/user/global-role governance;
- real local D1 security transactions;
- full Access JWT/JWKS request pipeline;
- dormant Amazon transport regressions without deployment or promotion.

Historical granular Cloudflare workflows and GitHub Pages/TiDB workflows remain archived, not active.

## Deployment safety

Repository `deploy:*` npm aliases remain fail-closed through `scripts/block-direct-cloudflare-deploy.mjs`.

The physical historical deployment trigger remains intentionally unchanged at the Phase 1 acceptance audit:

```text
__manual_ci_gated_deploy__
ce59e4cc43413338f35a34cb44622a7aa26f9875
```

Phase 1 does not move that branch and does not deploy any Worker.

## Amazon state

Amazon integration remains dormant. Existing credential, LWA smoke, report transport, acquisition, staging, fact publishing, provenance and Workflow code is retained under deterministic regression coverage only.

Controls remain:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

Security Integrity and intermediate platform phases do not authorize Amazon credential provisioning, live LWA smoke, report transport activation, sync-trigger promotion or sync Worker deployment.

Controlled Amazon activation begins later with Store 01 read-only only after deployment integrity and Dev exact-SHA baseline work are complete.

## Production state

The final Cloudflare Native Production deployment contract is **not established yet**. No Phase 1 work creates or alters Production DNS, Access, Worker, D1, R2 or Amazon resources.

Production deployment, Production break-glass execution and Production readiness remain separate future decisions.

## Acceptance record

Phase 0:

```text
docs/architecture/PHASE0_ACCEPTANCE.md
```

Phase 1:

```text
docs/architecture/PHASE1_SECURITY_ACCEPTANCE.md
```

After the final Phase 1 documentation tip passes Canonical CI, the branch can be treated as PR-ready. Opening or merging that PR does not authorize deployment.
