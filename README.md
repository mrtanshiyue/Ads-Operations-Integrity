# Ads Operations Integrity

Amazon Ads Operations OS — Cloudflare Native control plane, governed store data planes, CSV decision intelligence, recommendation approval, and controlled future Amazon execution.

> **Current product phase: CSV Decision Intelligence Productization.** The CSV / Cloudflare Non-Amazon Production Foundation is complete and accepted. Operational UAT is `31/31 LIVE PASS`, Failure Recovery including real rollback/restore is PASS, and `blockers=[]`. Amazon remains **HARD-OFF / FROZEN** pending explicit authorization.

## Product objective

The active product loop is:

```text
trusted CSV / historical reports
→ decision intelligence
→ explainable recommendation
→ human review
→ keyword / negative library
→ historical learning
→ operator decision
```

The longer-term controlled-action loop remains valid:

```text
trusted data
→ decision intelligence
→ explainable recommendation
→ human approval
→ controlled action
→ verification
→ learning
```

Amazon live execution is not the current delivery mainline. While `docs/architecture/CSV_FIRST_OPERATING_DIRECTIVE_2026-08-18.md` remains active, delivery is CSV-first, analytics-first, local-data-first, and operator-decision-first.

## Final Non-Amazon Production baseline

Canonical accepted baseline:

```text
GitHub main: a90c9158d8afd224e717218827923d4beab593b1
Production Worker: ads-operations-web-prod
Exact-main build: f4ed6b12-5beb-44f8-944c-061b300c7ec1
Exact-main deployment: 0ccd32ac-0328-4a02-b6f1-7445495a128b
Final runtime version: 44716995-a894-47ee-a9ed-5d371a771e83
Restored active deployment: 67feb2ce-cff5-4a79-bbd0-6b9460edd438
Operational UAT: 31/31 LIVE PASS
Failure Recovery: PASS
blockers=[]
```

The immutable closure record is `docs/architecture/FINAL_NON_AMAZON_PRODUCTION_CLOSURE_2026-08-20.md`.

Do not reopen completed Runtime / Privacy / RBAC / D1 migration / CSV provenance / CSV dedup / R2 create-only / deployment-governance / Operational-UAT / rollback work unless a real regression, security issue, availability issue, or data-integrity drift is observed.

## Current business priority

Product work should preferentially improve the operator's ability to find profitable terms, waste, negative candidates, scale opportunities, and trend changes:

```text
CSV
→ Historical Data
→ Search Term Intelligence
→ Profit / Waste / Root Analysis
→ Recommendation
→ Human Review
→ Keyword / Negative Library
```

Priority product surfaces:

1. Search Term Intelligence
2. Historical / Monthly Intelligence
3. Recommendation Inbox
4. Keyword Library
5. Negative Keyword Library
6. Data Quality / Import Health

Product intelligence takes priority over cosmetic UI rewrites.

## Canonical architecture

Central governance remains shared and store-scoped data isolation remains enforced:

```text
Cloudflare Access
        ↓
Central Web / App Worker
        ↓
Application RBAC
        ↓
Control D1
        ↓
store-scoped routing
        ↓
Per-store Store D1
        ↓
CSV / local evidence
        ↓
Decision intelligence
        ↓
Human review
```

Dormant Amazon transport/execution code remains preserved but unauthorized. A future Amazon restart must be explicitly authorized and must re-establish the required per-store execution isolation before multi-store live activation.

## Current platform truth

### Control D1

Central governance covers users/RBAC, stores, products and store mappings, keyword library and product-keyword mappings, store keyword policy, negative governance, optimization rules, rollups, audit, and operator governance.

### Store D1

Store-local data covers Amazon-shaped entities where already present, report/sync state, campaign/keyword/target/search-term/product/placement daily facts, CSV ingestion state, R2/source provenance, and the optimization action ledger.

`optimization_actions` and `optimization_action_events` are the canonical action lifecycle. Do not create a second action database. Recommendation, approval, future execution, verification, and revert semantics build around that ledger.

### Decision intelligence

The repository already contains CSV Search Term intelligence, profitability/waste analysis, deterministic recommendation fingerprints, period-over-period analysis, historical CSV primitives, observed CSV identity handling, recommendation governance, and local keyword/negative governance surfaces.

The current productization gap is to consolidate those primitives into operator-facing business semantics: Profit Winners, Scale Opportunities, Waste Terms, Watchlist, root intelligence, evidence-backed candidates, lifecycle/trend states, and review workflow.

## Amazon state — HARD-OFF

Runtime kill switches remain closed:

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

Until the user explicitly lifts the Amazon freeze, do not perform:

- Amazon Ads API live reads or writes
- SP-API
- Amazon report acquisition
- campaign / bid / keyword / negative / budget mutation
- Amazon workflow execution
- Amazon credential provisioning or secret mutation

Dormant Amazon code may remain in the repository. Its presence does not authorize execution.

## Canonical runtime entrypoints

- Web runtime: `cloudflare/runtime/web-entry.js`
- Web Worker config: `cloudflare/runtime/wrangler.native.jsonc`
- Sync runtime: `cloudflare/runtime/sync-worker.js`
- Sync config: `cloudflare/runtime/wrangler.sync.jsonc`
- Native build entrypoint: `scripts/build-cloudflare-native.mjs`
- Native artifact: `dist-cloudflare-native/`
- Canonical CI: `.github/workflows/cloudflare-native-canonical-ci.yml`
- Required context: `Static site and security invariants`

Production Web deployment governance remains manual exact-main only. Repository merge, Cloudflare deployment, and Amazon activation remain separate authority events.

## Frontend direction

Modernization uses a TypeScript + React + Vite strangler, not a big-bang rewrite. Start with Search Term Intelligence and Historical Analytics; do not prioritize Settings, landing-page cosmetics, or unrelated page rewrites ahead of decision quality.

## Delivery authority

- `docs/architecture/CSV_FIRST_OPERATING_DIRECTIVE_2026-08-18.md` controls current operating sequence while active.
- `docs/architecture/PRODUCT_ROADMAP_V2.md` remains the long-term product direction.
- `docs/architecture/FINAL_NON_AMAZON_PRODUCTION_CLOSURE_2026-08-20.md` is the immutable closure baseline for the completed Non-Amazon Production foundation.
- Historical Gate/UAT/rollback documents remain evidence, not active delivery work.

## Safety boundaries

- Canonical CI validates; it does not imply deployment or Amazon activation.
- Repository merge ≠ Dev deployment ≠ Production deployment ≠ Amazon activation.
- Production changes remain governed by the exact-main/manual deployment contract.
- Amazon mutation remains unauthorized while the CSV-first freeze is active.
- Existing accepted infrastructure closure should not be churned without a real regression.
- Historical GitHub Pages / TiDB / Warehouse material under `docs/archive/` remains traceability/rollback history only.
- The repository root intentionally has no implicit `wrangler.jsonc` deployment target; direct deployment aliases remain fail-closed.

See `README_PRODUCTION_STATUS.md` for current operational truth.