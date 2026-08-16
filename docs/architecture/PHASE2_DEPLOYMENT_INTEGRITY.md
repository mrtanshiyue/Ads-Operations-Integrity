# Phase 2 — Deployment Integrity

## Canonical status

Canonical main baseline:

```text
d644ab22706d3b722ced1fc1bc92509a44600926
```

Working branch:

```text
deployment-integrity-phase2
```

Phase status:

```text
Phase 0 Architecture Convergence = COMPLETE + MERGED
Phase 1 Security Integrity = COMPLETE + MERGED
Phase 2 Deployment Integrity = FOUNDATION PASS
                               DEV LIVE DEPLOYMENT INTEGRITY PASS
                               PREVIEW URL HARDENING LIVE PASS
                               POST-ACCEPTANCE GOVERNANCE COMPLETE
                               NOT MERGED TO MAIN

Gate 2.0 = PASS
Gate 2.1 = PASS — IMPLEMENTED + LIVE
Gate 2.2 = PASS
Gate 2.3 = PASS — IMPLEMENTED + LIVE READ-ONLY DISCOVERY
Gate 2.4 = COMPLETE — EXACT-SHA DEV DEPLOYMENT ACCEPTED
Gate 2.5 = PREFLIGHT COMPLETE — RETIREMENT DEFINITION FROZEN / DESTRUCTIVE RETIREMENT NOT AUTHORIZED
```

Production remains out of scope and NOT READY. Amazon Ads API remains DORMANT.

## Canonical deployment truth

The canonical provenance chain is:

```text
Canonical GitHub CI SUCCESS
→ exact Git SHA
→ Workers Builds API request pinned by commit_hash
→ build_uuid
→ immutable Worker version_id
→ active deployment correlation
→ live runtime version acceptance
→ immutable deployment receipt
```

Branch names, timestamps, latest ordering, and a URL alone are not deployment provenance.

Canonical CI is validation-only. It does not call `wrangler deploy`, perform live Cloudflare API mutation, move the historical deployment branch, or activate Amazon.

## Gate 2.4 immutable acceptance

Accepted Git SHA:

```text
27da62ee2b064c685df35bf76dc395f349f68aba
```

Canonical CI:

```text
Workflow: Cloudflare Native Canonical CI
Run: 31938209069
Required context: Static site and security invariants
Result: SUCCESS
```

Cloudflare immutable lineage:

```text
Worker: ads-operations-web-dev
Worker tag / external_script_id: ab2b4da6c8be41a5a72223384c32b71c
Trigger UUID: 33a47d45-4103-43d7-bca4-7d9096c4abfb
Build UUID: f064ee48-6e28-43d2-a575-883c9a45bca1
Build outcome: success
Build commit SHA: 27da62ee2b064c685df35bf76dc395f349f68aba
Version ID: 96710600-9968-4e1f-88d4-cd84cc546ca0
Deployment ID: e6ab548a-b070-4a03-ab7a-b17c255face5
Traffic: 100%, exactly one active version
Live runtime version ID: 96710600-9968-4e1f-88d4-cd84cc546ca0
Accepted at: 2026-08-16T09:28:24.000Z
```

Immutable repository evidence:

```text
docs/architecture/PHASE2_GATE24_DEPLOYMENT_RECEIPT.json
```

That receipt remains tied to `27da62ee...`. Later governance and hardening work must never rewrite the Gate 2.4 accepted SHA.

## Gate 2.3 live discovery — PASS

Live read-only discovery established the intended Dev Worker identity, trigger UUID, active deployment, active version, and version→build correlation before Gate 2.4 acceptance. The discovery implementation remains GET-only and fails closed for ambiguous multi-version deployments.

## Gate 2.5 — Historical Branch-Motion Deployment Retirement

Gate 2.5 is not trigger-object deletion.

The exact-SHA deployment mechanism still invokes:

```text
POST /builds/triggers/{trigger_uuid}/builds
commit_hash = <exact accepted candidate SHA>
```

Therefore the Workers Builds trigger object is still required by the exact-SHA executor path.

Gate 2.5 is split into:

```text
Gate 2.5A — retire historical branch-motion semantics
Gate 2.5B — preserve/reclassify the Workers Builds trigger as exact-SHA build executor
Gate 2.5C — freeze the historical Git branch as rollback/reference evidence
Gate 2.5D — only later decide whether trigger replacement/deletion is desirable
```

Current historical evidence remains frozen:

```text
Git branch: __manual_ci_gated_deploy__
Frozen SHA: ce59e4cc43413338f35a34cb44622a7aa26f9875
Workers Builds trigger UUID: 33a47d45-4103-43d7-bca4-7d9096c4abfb
Trigger deleted_on: null
```

Do not delete the trigger object or Git branch during current Phase 2 governance work.

Historical promotion/release helpers remain implementation history / regression material, not canonical deployment truth:

```text
scripts/promote-cloudflare-sync-dev-trigger.mjs
scripts/deploy-cloudflare-sync-dev.mjs
```

## Preview URL hardening — LIVE PASS

The read-only assessment initially established:

```text
canonical workers.dev hostname = Cloudflare Access protected
version preview hostname = publicly routable UI shell
protected API bypass = NOT FOUND
D1 data bypass = NOT FOUND
```

Repository policy was changed to:

```text
cloudflare/runtime/wrangler.native.jsonc
preview_urls = false
```

The hardening candidate was accepted only after full Canonical CI success:

```text
Candidate SHA: 0d1115da98282e6874ce2b8128a14fb05a1ac968
Canonical CI Run: 31940028696
Required context: Static site and security invariants
Result: SUCCESS
```

Exact-SHA Dev hardening deployment lineage:

```text
Git SHA: 0d1115da98282e6874ce2b8128a14fb05a1ac968
Trigger UUID: 33a47d45-4103-43d7-bca4-7d9096c4abfb
Build UUID: 006a7123-4204-499d-bae7-4138284bf30d
Build status/outcome: stopped / success
Build commit SHA: 0d1115da98282e6874ce2b8128a14fb05a1ac968
Worker version ID: 1264fc03-c111-4037-9029-e21ba57a84b2
Deployment ID: 46993acd-cc8f-46fb-bd6c-c1a3b7f41bcb
Traffic: 100%, exactly one active version
workers.dev enabled: true
preview URLs enabled: false
```

Version→build reverse correlation resolves `1264fc03...` back to build `006a7123...` and exact commit `0d1115da...`.

The live Worker version retains:

```text
ACCESS_MODE=enforce
SYNC_TRIGGER_ENABLED=false
CF_VERSION_METADATA binding present
```

Cloudflare Access remains attached to the canonical Dev hostname with application `ads-operations-web-dev access` and the `Dev owner only` allow policy. Therefore preview hardening did not remove the canonical Access control plane.

An independent Browser Rendering HTTP probe was attempted after deployment but Cloudflare returned API error `2001 Rate limit exceeded`. This is recorded as an observation limitation, not treated as an application failure and not substituted with fabricated HTTP evidence. Live runtime identity in the receipt is accepted from Cloudflare's active deployment at 100% traffic plus version→build correlation and enabled canonical `workers.dev` routing.

Immutable hardening receipt:

```text
docs/architecture/PHASE2_PREVIEW_HARDENING_DEPLOYMENT_RECEIPT.json
```

`GET /api/health` remains part of the runtime contract. A future acceptance refinement may use an authenticated canonical-host request when an Access-authenticated execution path is available.

## Deployment Integrity control-plane libraries

Exact-SHA build client:

```text
scripts/cloudflare-workers-builds-client.mjs
scripts/test-cloudflare-workers-builds-client.mjs
```

Required behavior includes exact 40-character SHA validation, explicit trigger identity, `commit_hash`, `build_uuid`, successful terminal outcome, build commit equality, trigger/Worker identity checks and fail-closed deterministic polling.

Read-only discovery client:

```text
scripts/cloudflare-deployment-discovery-client.mjs
scripts/test-cloudflare-deployment-discovery-client.mjs
```

Deployment receipt code:

```text
scripts/deployment-integrity-receipt.mjs
scripts/test-deployment-integrity-receipt.mjs
```

Receipt creation fails closed unless build outcome is successful, build commit equals candidate commit, and accepted live runtime version equals the correlated Worker version.

## Governance invariants

Canonical CI must continue to prove:

- `deployment-integrity-*` push coverage;
- required context remains `Static site and security invariants`;
- canonical CI performs no live Cloudflare mutation;
- direct repository deployment aliases remain fail-closed;
- historical branch promotion remains non-canonical;
- Workers Builds trigger object remains preserved while exact-SHA execution depends on it;
- preview URLs are disabled in canonical runtime config;
- Gate 2.4 immutable receipt remains unchanged;
- Preview hardening immutable receipt remains tied to `0d1115da...`;
- `SYNC_TRIGGER_ENABLED=false`;
- `AMAZON_ADS_ENABLED=false`;
- Production placeholders remain present.

## Production and Amazon constraints

Production remains out of scope. `wrangler.native.jsonc` still contains explicit Production placeholders, including D1 IDs, Access team domain and Access audience values. Phase 2 does not authorize Production DNS, Access, Worker, D1, R2, deployment or break-glass mutation.

Amazon remains dormant. Do not provision credentials, run LWA smoke, bootstrap profiles, create/poll/download reports, deploy `ads-operations-sync-dev`, enable `SYNC_TRIGGER_ENABLED`, enable `AMAZON_ADS_ENABLED`, or execute a real Amazon sync.
