# Ads Operations Integrity — Current Platform Status

> Canonical repository/platform status after Architecture Convergence and Security Integrity merge, during Deployment Integrity Phase 2. This file is not a substitute for live GitHub or Cloudflare state. Always verify exact Git SHA, required CI, Cloudflare lineage and deployment receipt before promotion.

## Canonical repository truth

Architecture Convergence Phase 0 and Security Integrity Phase 1 are complete and merged.

Canonical `main`:

```text
d644ab22706d3b722ced1fc1bc92509a44600926
```

Phase 2 working branch:

```text
deployment-integrity-phase2
```

Current phase state:

```text
Phase 0 — Architecture Convergence = COMPLETE + MERGED
Phase 1 — Security Integrity = COMPLETE + MERGED
Phase 2 — Deployment Integrity = IN PROGRESS
```

Phase 2 implementation state before the latest documentation commits:

```text
Gate 2.0 repository deployment boundary = PASS
Gate 2.1 runtime version observability = PASS
Gate 2.2 exact-commit Workers Builds client/mock acceptance = PASS
Gate 2.3 read-only discovery implementation/mock acceptance = PASS
Gate 2.3 live Cloudflare discovery = NOT EXECUTED
Gate 2.4 controlled Dev exact-SHA build = NOT STARTED / NOT AUTHORIZED
Gate 2.5 historical trigger retirement = NOT STARTED
```

Latest implementation/control-plane candidate before status documentation:

```text
3cb7159ed0f9816d0679c5fe404b1aa7646a578a
Run 31938073561
Static site and security invariants = SUCCESS
```

## Canonical runtime truth

Web runtime:

```text
cloudflare/runtime/wrangler.native.jsonc
→ cloudflare/runtime/web-entry.js
→ cloudflare/runtime/web-worker.js + modular APIs
```

Deployment/version acceptance path:

```text
cloudflare/runtime/deployment-health.js
→ GET /api/health
→ CF_VERSION_METADATA
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

Warehouse browser credentials, Warehouse external transport, old root Worker deployment ownership and legacy root Wrangler deployment ownership remain retired from canonical runtime/source ownership. Exact retired browser-loader implementations remain recoverable only under:

```text
docs/archive/legacy-browser-loaders/
```

Cloud Raw import remains explicitly fail-closed with:

```text
501 cloudflare_native_raw_import_not_migrated
```

## Security Integrity state

Control D1 has append-only defense-in-depth migrations:

```text
0005_control_security_integrity.sql
0006_control_access_recovery.sql
```

They enforce single global role, global/store role-scope boundaries, active global-role lifecycle, global/store membership exclusivity, last-active-owner protection, immutable assigned role scope and audited owner Access-subject recovery.

Global Role governance and user lifecycle mutations require D1 transaction batches so governance mutation and audit evidence commit or roll back together. There is no sequential fallback.

Security-critical Canonical CI includes a real local Cloudflare Workers/D1 harness and the full production `web-entry.js` Access request pipeline with `ACCESS_MODE=enforce`, generated RSA/RS256 JWTs, JWKS interception at the Node test boundary, strict actor binding, real local D1, RBAC and governed mutation/audit evidence.

No production authentication bypass or test identity header exists.

## Break-glass recovery

Out-of-band owner Access-subject recovery remains available only through:

```text
npm run security:break-glass:access-recovery -- ...
```

It is dry-run by default, can only rebind an existing active owner, cannot change global roles, reads Cloudflare API token only from `CLOUDFLARE_API_TOKEN`, requires exact execution confirmation, and requires additional Production gates for any Production attempt.

Current work does **not** authorize Production break-glass execution.

## Deployment Integrity control plane

Phase 2 now has deterministic, CI-verified building blocks without live Cloudflare mutation.

Exact-commit Workers Builds client:

```text
scripts/cloudflare-workers-builds-client.mjs
scripts/test-cloudflare-workers-builds-client.mjs
```

It pins `commit_hash`, captures `build_uuid`, verifies terminal success, verifies returned build commit SHA, verifies trigger identity and optionally verifies immutable Worker tag. The library has no automatic CLI/environment execution path.

Read-only Cloudflare topology discovery:

```text
scripts/cloudflare-deployment-discovery-client.mjs
scripts/test-cloudflare-deployment-discovery-client.mjs
```

Its intended live correlation chain is:

```text
Worker name
→ immutable Worker tag
→ build trigger(s)
→ active deployment
→ active version
→ build-by-version
→ live runtime version
```

The discovery library uses GET only and fails closed for multi-version/gradual active deployments instead of guessing lineage.

Deployment receipt:

```text
scripts/deployment-integrity-receipt.mjs
scripts/test-deployment-integrity-receipt.mjs
```

Receipt schema:

```text
cloudflare-deployment-receipt-v1
```

Receipt generation requires:

```text
buildOutcome == success
buildCommitSha == commitSha
liveRuntimeVersionId == versionId
```

It serializes only allowlisted evidence fields and is not a deployment trigger.

## CI truth

Canonical workflow:

```text
.github/workflows/cloudflare-native-canonical-ci.yml
```

Required main branch check context remains exactly:

```text
Static site and security invariants
```

Canonical push coverage includes `deployment-integrity-*` in addition to canonical main/convergence/security development branches.

Canonical CI validates:

- architecture convergence boundaries;
- Deployment Integrity foundation contracts;
- runtime Version Metadata health evidence;
- exact-commit Workers Builds client against deterministic mocked responses;
- read-only deployment discovery client against deterministic mocked responses;
- fail-closed deployment receipt;
- Cloudflare Native runtime/build/UI;
- foundation and Security Integrity migrations;
- Phase E ingestion/producer regressions;
- R2 provenance regressions;
- Access/user/global-role governance;
- real local D1 security transactions;
- full Access JWT/JWKS request pipeline;
- dormant Amazon transport regressions without deployment or promotion.

Canonical CI does not perform live Cloudflare API requests and does not run `wrangler deploy`.

Historical granular Cloudflare workflows and GitHub Pages/TiDB workflows remain archived, not active.

## Deployment safety

Repository `deploy:*` npm aliases remain fail-closed through:

```text
scripts/block-direct-cloudflare-deploy.mjs
```

Historical physical deployment trigger remains frozen:

```text
__manual_ci_gated_deploy__
ce59e4cc43413338f35a34cb44622a7aa26f9875
```

Phase 2 foundation implementation has not moved this branch.

The historical promotion/release helpers remain implementation history/regression material and are not the canonical Phase 2 deployment control plane:

```text
scripts/promote-cloudflare-sync-dev-trigger.mjs
scripts/deploy-cloudflare-sync-dev.mjs
```

## Live Cloudflare state

The current execution environment does not expose a connected Cloudflare account tool/plugin. Therefore Phase 2 has **not** claimed or fabricated live values for:

- Worker immutable tag / `external_script_id`;
- Workers Builds trigger UUID;
- active deployment ID;
- active Worker version ID;
- active build UUID;
- live runtime Version Metadata.

Gate 2.3 live discovery remains a separate read-only step requiring an authorized, credentialed Cloudflare account path.

Gate 2.4 controlled Dev exact-SHA build remains **NOT STARTED / NOT AUTHORIZED**.

No Cloudflare build trigger has been called by Phase 2 foundation work.

## Amazon state

Amazon integration remains dormant. Existing credential, LWA smoke, report transport, acquisition, staging, fact publishing, provenance and Workflow code stays under deterministic regression coverage only.

Controls remain:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

Phase 2 does not authorize Amazon credential provisioning, live LWA smoke, report transport activation, sync-trigger promotion, real Amazon sync or Sync Worker deployment.

Controlled Amazon activation begins later with Store 01 read-only only after Deployment Integrity establishes an accepted Dev exact-SHA baseline and a separate activation decision is made.

## Production state

Cloudflare Native Production deployment remains **NOT READY**. `wrangler.native.jsonc` still contains explicit Production placeholders.

No current work authorizes or creates Production DNS, Access, Worker, D1, R2, Amazon resources, Production deployment, or Production break-glass execution.

## Acceptance records

Phase 0:

```text
docs/architecture/PHASE0_ACCEPTANCE.md
```

Phase 1:

```text
docs/architecture/PHASE1_SECURITY_ACCEPTANCE.md
```

Phase 2 definition/current evidence:

```text
docs/architecture/PHASE2_DEPLOYMENT_INTEGRITY.md
```

The next allowed live step is **read-only Cloudflare discovery only after an authorized credential path exists**. A controlled Dev build remains a later, separately authorized action.
