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

Phase 2 begins with repository/control-plane contracts only. This document does **not** authorize a Cloudflare deployment.

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
→ cloudflare/runtime/web-worker.js
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

The Phase 2 control plane will use the Cloudflare Workers Builds API rather than Git ref movement as the final exact-commit trigger mechanism.

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
- that build still records the expected Git SHA.

This closes the gap between "build succeeded" and "the expected build is actually serving traffic".

## Runtime version acceptance

The canonical Web Worker must expose Cloudflare Version Metadata in a controlled health/acceptance response so live acceptance can compare the runtime version ID with the API-observed active `version_id`.

The Wrangler binding name is standardized as:

```text
CF_VERSION_METADATA
```

Required runtime fields are limited to deployment provenance:

```text
id
tag
timestamp
```

No Cloudflare API token, build token, repository credential, Amazon credential, or secret may be exposed by the runtime endpoint.

## Deployment receipt

A future Phase 2 deployment receipt must contain, at minimum:

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

The receipt is evidence, not a deployment trigger. Receipt generation must fail closed if any lineage identifier disagrees.

## Phase 2 foundation gates

### Gate 2.0 — Repository deployment boundary

- `deployment-integrity-*` receives canonical push CI.
- required context name remains unchanged.
- direct repository deploy aliases remain blocked.
- canonical CI contains no `wrangler deploy`.
- canonical CI does not invoke the historical trigger-promotion helper.
- `__manual_ci_gated_deploy__` remains unchanged.
- Amazon remains dormant.

### Gate 2.1 — Runtime version observability

- Web Worker has `CF_VERSION_METADATA` binding.
- live acceptance can return runtime version ID without exposing secrets.
- local/integration regressions lock the response contract.

### Gate 2.2 — Builds API client, dry-run and fixtures

- exact-SHA input validation;
- Cloudflare response schema validation;
- build UUID capture;
- build commit SHA equality check;
- Worker/trigger identity check;
- deterministic mocked regressions;
- no live API mutation in canonical CI.

### Gate 2.3 — Read-only Cloudflare discovery

Only after explicit authorization and credential availability:

- resolve Worker tag / `external_script_id`;
- resolve production/preview trigger UUIDs;
- inspect historical builds;
- inspect current Dev deployment/version state;
- produce a read-only discovery record.

This gate does not trigger a build.

### Gate 2.4 — Controlled Dev exact-SHA build

Only after a separate explicit authorization:

- exact Git SHA already has canonical CI success;
- trigger Cloudflare build by API using that SHA;
- record build UUID;
- wait for terminal successful outcome;
- correlate Worker version/deployment;
- execute live acceptance;
- write deployment receipt.

### Gate 2.5 — Historical trigger retirement

Only after the Builds API path is proven and rollback material is preserved:

- stop depending on `__manual_ci_gated_deploy__`;
- archive its historical control logic;
- keep rollback evidence;
- do not rewrite Git history.

## Explicitly forbidden during foundation work

Do not:

- move `__manual_ci_gated_deploy__`;
- call a Cloudflare build trigger;
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
