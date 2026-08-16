# Phase 2 — Deployment Integrity

## Status

Phase 2 starts from the exact canonical main baseline:

```text
d644ab22706d3b722ced1fc1bc92509a44600926
```

Working branch:

```text
deployment-integrity-phase2
```

Phase 0 — Architecture Convergence: COMPLETE + MERGED.

Phase 1 — Security Integrity: COMPLETE + MERGED.

Current Phase 2 status:

```text
Gate 2.0 repository deployment boundary = PASS
Gate 2.1 runtime version observability = PASS
Gate 2.2 exact-commit Workers Builds client = PASS
Gate 2.3 read-only discovery implementation/mock acceptance = PASS
Gate 2.3 live Cloudflare discovery = NOT EXECUTED
Gate 2.4 controlled Dev exact-SHA build = NOT STARTED / NOT AUTHORIZED
Gate 2.5 historical trigger retirement = NOT STARTED
```

Latest implementation acceptance before this status update:

```text
commit: 3cb7159ed0f9816d0679c5fe404b1aa7646a578a
Canonical CI Run: 31938073561
required context: Static site and security invariants
result: SUCCESS
```

This document does **not** authorize a Cloudflare deployment, build trigger, remote migration, Production change, Amazon activation, or historical trigger movement.

## Objective

Replace historical branch-motion deployment provenance with an exact, auditable chain:

```text
GitHub canonical CI success
→ exact Git commit SHA
→ Cloudflare Workers Builds API trigger pinned to commit_hash
→ Cloudflare build UUID
→ successful build whose recorded commit_hash equals the expected SHA
→ active Worker deployment/version ID
→ build-by-version reverse correlation
→ live runtime version acceptance
→ immutable deployment receipt
```

No stage may infer lineage from timestamps, "latest" ordering alone, branch names alone, or an unverified deployment URL.

## Current repository truth

Canonical CI:

```text
.github/workflows/cloudflare-native-canonical-ci.yml
```

Required check context:

```text
Static site and security invariants
```

Canonical Web runtime:

```text
cloudflare/runtime/wrangler.native.jsonc
→ cloudflare/runtime/web-entry.js
→ cloudflare/runtime/web-worker.js + modular APIs
```

Deployment/version acceptance runtime:

```text
cloudflare/runtime/deployment-health.js
→ GET /api/health
→ CF_VERSION_METADATA
```

Dormant Sync runtime:

```text
cloudflare/runtime/wrangler.sync.jsonc
→ cloudflare/runtime/sync-worker.js
```

Historical physical Cloudflare build trigger branch:

```text
__manual_ci_gated_deploy__
ce59e4cc43413338f35a34cb44622a7aa26f9875
```

It remains frozen during the Phase 2 foundation work. Retirement is a later controlled migration, not a prerequisite for defining the new control plane.

## Implemented Deployment Integrity control-plane libraries

### Exact-commit Builds client

```text
scripts/cloudflare-workers-builds-client.mjs
scripts/test-cloudflare-workers-builds-client.mjs
```

Properties:

- exact 40-character Git SHA required;
- explicit trigger UUID required;
- `commit_hash` pinned in the Workers Builds request;
- returned `build_uuid` required;
- terminal `status=stopped` required;
- `build_outcome=success` required;
- returned build commit must equal expected Git SHA;
- returned trigger identity must equal expected trigger UUID;
- optional immutable Worker tag must match;
- polling is deterministic and fail-closed;
- library accepts injected `fetch`/token only;
- no `process.argv`, `process.env`, token environment lookup, or automatic execution entry point.

Canonical CI tests this library only against mocked HTTP responses and performs no live Cloudflare request.

### Read-only deployment discovery client

```text
scripts/cloudflare-deployment-discovery-client.mjs
scripts/test-cloudflare-deployment-discovery-client.mjs
```

Correlation chain:

```text
Worker name
→ immutable Worker tag
→ Workers Builds triggers
→ active deployment
→ active version ID
→ version detail
→ build-by-version
→ build trigger + Worker tag
```

The library uses GET only. It contains no POST, PUT, PATCH or DELETE Cloudflare request path.

For live acceptance it requires a single active version at 100% traffic. A gradual/multi-version deployment fails closed rather than guessing which version represents the baseline.

The current session has no connected Cloudflare account tool/plugin, so this implementation has passed deterministic mocked acceptance only. **No live account discovery has been executed.**

### Runtime version evidence

Wrangler binds:

```text
CF_VERSION_METADATA
```

`GET /api/health` exposes only deployment provenance needed for acceptance:

```text
versionId
versionTag
versionTimestamp
```

The health response does not expose Cloudflare API tokens, repository credentials, Amazon credentials, or other secrets.

### Deployment receipt

```text
scripts/deployment-integrity-receipt.mjs
scripts/test-deployment-integrity-receipt.mjs
```

Receipt schema:

```text
cloudflare-deployment-receipt-v1
```

Required evidence fields:

```text
schemaVersion
repository
commitSha
githubWorkflowRunId
githubRequiredContext
cloudflareAccountId
workerName
workerTag
triggerUuid
buildUuid
buildOutcome
buildCommitSha
versionId
deploymentId
liveRuntimeVersionId
acceptedAt
```

Receipt creation fails closed unless:

```text
buildOutcome == success
buildCommitSha == commitSha
liveRuntimeVersionId == versionId
```

The receipt is immutable evidence, not a deployment trigger, and only allowlisted fields are serialized.

## Historical deployment code classification

The following files remain implementation history / regression material and are not the canonical Phase 2 deployment control plane:

```text
scripts/promote-cloudflare-sync-dev-trigger.mjs
scripts/deploy-cloudflare-sync-dev.mjs
```

The former promotion path is bound to the retired `cloudflare-foundation-v1` / `cloudflare-foundation-ci.yml` topology. The release helper also contains remote D1 migration and direct Wrangler deployment behavior. Neither may be reactivated by canonical CI.

Repository `deploy:*` aliases remain fail-closed through:

```text
scripts/block-direct-cloudflare-deploy.mjs
```

## Cloudflare Builds API contract

The Phase 2 control plane uses the Cloudflare Workers Builds API rather than Git ref movement as the final exact-commit trigger mechanism.

Required properties:

1. The caller supplies an expected 40-character Git SHA.
2. The expected SHA has already passed canonical GitHub CI.
3. The build request pins `commit_hash` to that exact SHA. A branch may also be supplied, but branch identity never substitutes for commit identity.
4. The trigger response must yield a `build_uuid`.
5. Polling that UUID must end in a successful build outcome.
6. The returned build metadata `commit_hash` must equal the expected SHA.
7. The build must belong to the expected Worker/trigger identity.
8. A successful build alone is not live-deployment proof.

## Version and deployment correlation

After a successful build, the control plane must read the Worker deployment/version APIs.

For a single-version Dev deployment, acceptance requires:

- the active deployment identifies exactly one version at 100%;
- that `version_id` exists in the Worker Versions API;
- querying Workers Builds by that `version_id` returns the recorded Phase 2 `build_uuid`;
- that build still records the expected Git SHA;
- live `/api/health` reports exactly that `version_id` through `CF_VERSION_METADATA`.

This closes the gap between "build succeeded" and "the expected build is actually serving traffic".

## Gate evidence

### Gate 2.0 — Repository deployment boundary — PASS

Acceptance candidate:

```text
6293d6fe86610d6239a1db18097010d7b11314f7
Run 31937495308 = SUCCESS
```

Established:

- `deployment-integrity-*` receives canonical push CI;
- required context name remains `Static site and security invariants`;
- direct repository deploy aliases remain blocked;
- canonical CI contains no `wrangler deploy`;
- canonical CI does not execute the historical trigger-promotion helper;
- historical deployment trigger remained unchanged;
- Amazon remained dormant.

### Gate 2.1 — Runtime version observability — PASS

Acceptance candidate:

```text
62c1f21a8ca1626c1a20b7125165c08cbd4b9322
Run 31937661089 = SUCCESS
```

Established:

- Web Worker has `CF_VERSION_METADATA` binding;
- canonical `/api/health` exposes runtime version ID/tag/timestamp;
- secret values are excluded;
- deterministic tests and existing runtime/security regressions pass.

### Gate 2.2 — Builds API client / mocked acceptance — PASS

Acceptance candidate:

```text
482469c71fd1182c75fa1e09ca92332d5c4a9d0e
Run 31937780368 = SUCCESS
```

Established:

- exact-SHA input validation;
- build UUID capture;
- build commit SHA equality check;
- build outcome check;
- Worker/trigger identity check;
- deterministic polling;
- deterministic mocked regressions;
- no live API mutation in canonical CI.

### Gate 2.3 — Read-only Cloudflare discovery

Implementation/mock acceptance candidate:

```text
3c7f762429ef688e9dfbf3d15689787e5107c05d
Run 31937956079 = SUCCESS
```

Receipt/control-plane consolidation candidate:

```text
3cb7159ed0f9816d0679c5fe404b1aa7646a578a
Run 31938073561 = SUCCESS
```

Implementation/mock acceptance = PASS.

Live Cloudflare account discovery = **NOT EXECUTED** because the current execution environment does not expose a connected Cloudflare account tool/plugin. No real Worker tag, trigger UUID, active deployment, active version, or active build is claimed by this document.

The live read-only discovery step, when separately authorized and credentialed, must:

- resolve Worker tag / `external_script_id`;
- resolve relevant trigger UUIDs;
- inspect historical/current builds;
- inspect current Dev deployment/version state;
- correlate version → build;
- produce a read-only discovery record.

This gate does not trigger a build.

### Gate 2.4 — Controlled Dev exact-SHA build — NOT STARTED / NOT AUTHORIZED

Only after a separate explicit authorization:

- exact Git SHA already has canonical CI success;
- live read-only discovery has identified the intended Dev Worker and trigger;
- trigger Cloudflare build by API using that exact SHA;
- record build UUID;
- wait for terminal successful outcome;
- correlate Worker version/deployment;
- execute live runtime version acceptance;
- write the immutable deployment receipt.

No build trigger has been called during Phase 2 foundation implementation.

### Gate 2.5 — Historical trigger retirement — NOT STARTED

Only after the Builds API path is proven and rollback material is preserved:

- stop depending on `__manual_ci_gated_deploy__`;
- archive its historical control logic;
- keep rollback evidence;
- do not rewrite Git history.

## Explicitly forbidden until later authorization

Do not:

- move `__manual_ci_gated_deploy__`;
- call a live Cloudflare build trigger;
- run `wrangler deploy`;
- apply remote D1 migrations;
- deploy `ads-operations-sync-dev`;
- change Cloudflare Production DNS / Access / Worker / D1 / R2;
- execute Production break-glass recovery;
- set `SYNC_TRIGGER_ENABLED=true`;
- set `AMAZON_ADS_ENABLED=true`;
- provision Amazon credentials;
- run live LWA or Amazon report operations.

Production remains out of scope while `wrangler.native.jsonc` contains Production placeholders.
