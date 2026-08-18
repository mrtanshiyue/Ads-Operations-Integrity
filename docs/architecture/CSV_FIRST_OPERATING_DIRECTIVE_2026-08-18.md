# CSV-First Operating Directive — 2026-08-18

Status: **ACTIVE TEMPORARY DELIVERY DIRECTIVE**  
Scope: GitHub development, CI, Cloudflare Dev/Production operations, D1 migrations, Amazon Ads integration, product analytics  
Precedence: while active, this directive overrides conflicting future-delivery sequencing in `PRODUCT_ROADMAP_V2.md`. Historical implementation evidence remains unchanged.

## 1. Operating decision

The Amazon Ads API mainline is temporarily frozen. The project itself is not frozen.

Until this directive is explicitly lifted, delivery proceeds as:

```text
CSV-first
→ analytics-first
→ local-data-first
→ provenance/audit-first
→ operator UX
```

Existing Amazon transport, identity, binding, receipt, and execution-control code remains dormant. Do not delete, roll back, or activate it merely to reduce repository/runtime divergence.

## 2. Frozen Amazon scope

Do not perform any of the following while this directive is active:

- develop or activate the live `POST /adsApi/v1/query/advertiserAccounts` adapter;
- continue live Amazon advertiser-account → profile binding;
- connect Amazon credentials;
- create, rotate, or modify Amazon secrets;
- perform Amazon Ads live API reads or writes;
- enable `AMAZON_ADS_ENABLED`;
- create Amazon report jobs;
- execute Amazon optimization actions;
- issue an execution permit;
- deploy solely because dormant Amazon-related code moved on GitHub.

Dormant Amazon code is retained for a future explicitly authorized restart.

## 3. Cloudflare and data-plane safety invariants

While this directive is active:

1. Do not modify Production.
2. Do not weaken branch protection, required CI, Access enforcement, kill switches, or security gates.
3. Do not create Cloudflare Access service tokens or other credentials to bypass missing operator authentication.
4. Do not perform real Dev D1 writes or migrations without explicit authorization.
5. In particular, do not apply `0020_store_advertiser_profile_binding_receipts.sql` to remote Dev Store D1 unless explicitly authorized.
6. Do not deploy merely to align GitHub `main` with a currently safe runtime. Intentional dormant-code divergence is allowed.
7. A feature that can be validated in GitHub CI without runtime activation should remain undeployed unless deployment is separately justified and authorized.

## 4. Active delivery priorities

Use this order when choosing new work:

```text
CSV/manual report ingestion and data quality
> multi-file/joint report analysis
> Search Term profitability and waste analysis
> toxic/profitable root analysis and negative-keyword review suggestions
> local observed Search Term → targeting identity
> keyword / negative-keyword library capabilities
> monthly and historical analytics accumulation
> provenance, audit receipts, deterministic fingerprints
> dashboard / UI / UX
> Access, RBAC, CI, deployment-integrity hardening
> other local automation that does not depend on Amazon live APIs
```

Prefer work that improves operator decision quality without creating mutation authority.

## 5. Current CSV-first capability baseline

The following non-Amazon work is now part of the canonical GitHub line:

- required CI executes the key CSV Imports, CSV Intelligence, and CSV Product UI contracts rather than syntax-checking them only;
- a local advisory Search Term profitability/toxicity engine classifies profit terms, waste terms, profitable roots, and toxic roots;
- exact-negative candidates and phrase-root review candidates are separated;
- roots that contain an already-profitable Search Term are protected from phrase-negative review suggestions;
- multi-CSV joint Search Term analysis rejects duplicate content by SHA-256, preserves per-import provenance receipts, and produces an order-independent input-set fingerprint;
- a read-only local CLI can analyze multiple Search Term CSV files and emits JSON to stdout only;
- observed CSV campaign/ad-group/targeting evidence can be grouped into deterministic local identity fingerprints;
- conflicting observed targeting identities are marked ambiguous and confidence-blocked;
- observed identity remains explicitly distinct from canonical Amazon identity.

All advisory outputs remain:

```text
authoritative = false
canonicalAmazonIdentityResolved = false
governancePersistenceAllowed = false
executionAuthorized = false
amazonMutationAuthorized = false
```

## 6. Required development workflow

Every independent work unit must use:

```text
feature branch
→ implementation
→ tests/contracts
→ pull request
→ exact-head required CI
→ merge
```

Rules:

- treat only the PR's current exact head as valid CI evidence;
- if CI fails, fix on the same feature branch and rerun exact-head CI;
- do not merge on stale successful checks from an older head;
- do not bypass the required context `Static site and security invariants`;
- do not couple a GitHub merge to a Cloudflare deployment unless runtime activation is actually required and separately allowed.

## 7. Identity terminology

To prevent accidental authority escalation, use these terms precisely:

- **Observed CSV identity**: IDs/names/match type/targeting text contained in imported CSV evidence. It may support local grouping and analytics.
- **Canonical Amazon identity**: identity established through an explicitly authorized Amazon live binding/authority path. This is frozen under the current directive.

Observed CSV identity must never be described as canonical merely because a CSV contains real-looking Amazon IDs.

Any ambiguity such as conflicting targeting text or inconsistent targeting-ID parentage must fail closed for identity confidence.

## 8. Recommended next work

Highest-value safe follow-ons are:

1. surface joint CSV profitability/toxicity and observed-identity results in the same-origin operator UI without adding mutation authority;
2. connect advisory candidates to local keyword and negative-keyword library review workflows;
3. add historical/monthly aggregation and period comparison over imported local data;
4. strengthen provenance/data-quality diagnostics for overlapping periods, gaps, mixed scopes, and import-set reproducibility;
5. continue UI/UX and security/CI integrity work that does not require Amazon activation.

## 9. Conditions to resume Amazon API work

Do not infer resumption from code readiness, repository SHA, deployment drift, or the presence of dormant contracts.

Amazon API work resumes only after an explicit operating decision lifts this directive and separately authorizes the required credentials/live access. At that point, re-establish the exact authorized scope before provisioning credentials, enabling flags, running migrations needed for live binding, creating report jobs, or deploying activation-related changes.
