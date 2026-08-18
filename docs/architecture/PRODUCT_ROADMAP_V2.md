# Product Roadmap V2 — Productization Authority

Status: **AUTHORITATIVE FOR FUTURE DELIVERY**  
Effective: 2026-08-17  
Supersedes: historical Phase/Gate sequencing as a future roadmap. Phase 0–3 remain immutable implementation history and regression evidence.

> **Active temporary delivery override — 2026-08-18:** Amazon Ads live API work is frozen while CSV-first / analytics-first / local-data-first productization continues. During this freeze, `docs/architecture/CSV_FIRST_OPERATING_DIRECTIVE_2026-08-18.md` takes precedence over conflicting Phase 5+ sequencing below. Existing Amazon code remains dormant; the historical roadmap is retained so it can be resumed only after explicit authorization.

## 1. Product thesis

Ads Operations Integrity is no longer primarily an infrastructure-convergence project. Architecture, security, deployment integrity, D1/R2 provenance, and operator governance are mature enough to support productization.

The long-term business system optimizes this loop:

```text
real Amazon data
→ trusted store facts
→ decision intelligence
→ explainable recommendation
→ human approval
→ controlled action
→ verification
→ learning
```

While the active CSV-first directive is in force, the delivery loop is intentionally narrower:

```text
CSV/manual report evidence
→ trusted local facts
→ decision intelligence
→ explainable advisory output
→ human review
```

The temporary loop does not grant canonical Amazon identity, governance persistence, or execution authority.

Work that only increases receipt count, provenance depth, or Gate count is not prioritized unless it closes a concrete architecture, security, audit, or data-integrity risk.

## 2. Current capability / missing capability matrix

| Domain | Current capability | Missing capability / next product requirement | Owning phase |
|---|---|---|---|
| Architecture | Cloudflare Native Web, Control D1, Store D1, R2, Workflows, Sync runtime | Multi-store physical execution isolation | Phase 9 |
| Security | Cloudflare Access, application RBAC, store-scoped authorization, fail-closed controls | Production launch policy and execution-specific approval hardening | Phase 8–10 |
| Deployment | Canonical CI, exact-SHA Workers Builds provenance, immutable runtime receipts | Product release cadence without reopening old Gate taxonomy | Phase 4+ |
| Control data | Users/RBAC/stores/products/product mappings/keyword & negative governance/rules/rollups/audit | Recommendation policy configuration and product-facing explainability | Phase 6–8 |
| Store entities | Amazon profile/campaign/ad-group/keyword/target/product-ad schemas plus entity mirror implementation | Live Store 01 population remains frozen; local observed CSV identity is available for advisory analysis | Phase 5 / active CSV-first override |
| Store fact schemas | campaign/ad-group/keyword/target/search-term/product/placement daily tables and ingestion/provenance structures exist | Expand CSV/manual-report producers and local historical analytics while Amazon live producers are frozen | Phase 5+ / active CSV-first override |
| Implemented live fact producer | Dormant `search_term_daily` Amazon path plus active CSV Search Term import/analysis | Keep Amazon producer dormant; continue CSV-first productization | Phase 5 / active CSV-first override |
| Provenance | Report jobs, sync receipts, R2 source identity/content evidence, CSV content hashes/import receipts/input-set fingerprints | Operational data-quality diagnostics for CSV overlap/gaps/mixed scopes and future live Store 01 SLOs | Phase 5–6 |
| Amazon transport | Credential provider, profile bootstrap, entity mirror, Search Term Create/Poll/Download Report path, report-cycle runtime | **Frozen:** no credential provisioning, live reads/writes, report jobs, or activation until explicit authorization | Phase 5 / frozen |
| Search Term intelligence | Search Term fact pipeline, CSV advisory profitability/waste/harvest/root analysis, local observed targeting identity | Same-origin UI exposure, historical comparison, keyword/negative library review integration | Phase 6 / active CSV-first override |
| Recommendation | deterministic advisory scoring/fingerprinting and existing governance primitives | Keep CSV outputs advisory-only; build review workflows without Amazon mutation authority | Phase 6 |
| Action ledger | `optimization_actions` + events and lifecycle states already exist | Governed Action API and transition enforcement | Phase 8 |
| Approval UX | Operator product surfaces exist | Recommendation inbox, evidence drilldown, approve/reject UX | Phase 8 |
| Amazon writes | No authorized mutation path | **Frozen** and remains unauthorized | Phase 11 |
| Frontend | Native same-origin UI on Cloudflare APIs | React + Vite + TypeScript strangler for intelligence workflows | Phase 7 |
| Multi-store | Central store routing and multiple Store D1 model | Per-store Worker/Workflow/credential/R2 physical execution boundary | Phase 9 |
| Production | Historical/placeholder config exists; Production not current priority | Read-only production contract and launch evidence | Phase 10 |
| Learning loop | Audit/action events can record outcomes | Post-action outcome attribution and rule/model feedback | Phase 12 |

## 3. Non-negotiable architecture invariants

1. **Control D1 remains central governance.** It must not become a container for Amazon store-local fact data.
2. **Store D1 remains store-local.** Amazon entities, facts, reports, sync state, and optimization actions stay in the store data plane.
3. **No parallel action database.** Recommendation and approval must use `optimization_actions` and `optimization_action_events`.
4. **No browser Amazon transport.** Browser calls same-origin product APIs; Workers own Amazon communication.
5. **Amazon mutation remains unauthorized until Phase 11.** Read-only activation does not imply write authority.
6. **Store 02 is an isolation gate.** Before Store 02 credentials exist, execution must be physically split by Worker, Workflow, credentials, and R2 boundary.
7. **Deployment and activation identities remain separate.** Merge, deploy, and Amazon activation are distinct controlled events.
8. **Exact-SHA deployment provenance remains valid infrastructure, not a roadmap.** Do not create new Gate numbering merely to preserve the old process shape.
9. **Fact-table existence is not producer readiness.** A Store D1 schema or generic intent name must not be described as live-acquirable until the producer capability explicitly implements it.
10. **Recommendation authority is profile + provenance scoped.** Unscoped Dev fixture queries must not feed live optimization decisions.
11. **Observed CSV identity is not canonical Amazon identity.** Local CSV IDs may support advisory grouping, but they cannot establish live Amazon authority while the active directive is in force.
12. **Dormant-code divergence is allowed during the freeze.** Do not deploy merely to align GitHub with a safe runtime when the delta is inactive and deployment is not otherwise required.

## 4. Phase 4 — Project Truth & Productization Reset

### Objective

Make repository, runtime, product capability, and future roadmap tell the same truth.

### Required outputs

- README/status/runtime docs point to Product Roadmap V2;
- capability/missing-capability matrix is explicit;
- Store 01 read-only activation contract is frozen;
- recommendation → action API contract is frozen;
- historical Phase 0–3 is clearly separated from future delivery;
- no Production or Amazon live mutation is required for Phase 4 completion.

### Exit

Canonical CI green, merged to `main`, post-merge correlation confirms no architecture/security regression. Under the active 2026-08-18 directive, continue CSV-first productization instead of proceeding to Phase 5 activation.

## 5. Phase 5 — Store 01 Real Amazon Read-Only Pipeline

> **Temporarily frozen by `CSV_FIRST_OPERATING_DIRECTIVE_2026-08-18.md`.** The content in this phase remains the long-term restart plan; it is not current execution authorization.

### Objective

Acquire trustworthy, repeatable, auditable real Amazon Ads data for Store 01 without any Amazon mutation.

### Current executable scope

The first live producer scope is intentionally narrow:

```text
search_term_daily
```

The producer also performs the canonical profile bootstrap and entity mirror needed to interpret Search Term targeting identity. Other Store D1 daily-fact schemas are not evidence that their live producers are implemented.

### Sequence

```text
runtime/binding preflight
→ provision Store 01 credentials while Amazon execution disabled
→ LWA credential smoke with zero report/D1/R2 side effects
→ exact-SHA Sync runtime acceptance
→ enable Store 01 Amazon read execution under explicit kill switch
→ enable one controlled manual Web sync trigger
→ canonical profile bootstrap
→ entity mirror
→ Search Term report Create/Poll/Download
→ R2 materialization
→ Store D1 Search Term ingestion
→ profile-scoped data reconciliation + source provenance acceptance
→ disable/retain trigger according to operating mode
```

This sequence is dormant while the active CSV-first directive is in force. Do not execute any step that provisions credentials, enables Amazon flags, creates report jobs, applies live-binding migrations, or performs live Amazon reads/writes without explicit restart authorization.

### Data priority

**Executable after the freeze is explicitly lifted**

1. `search_term_daily`
2. supporting entity mirror required for identity/explanation

**Next producer implementations after the first trusted Search Term loop**

1. `keyword_daily`
2. `target_daily`
3. `campaign_daily`
4. remaining daily-fact families according to decision-intelligence value

Producer expansion is explicit implementation work; the generic sync-intent allowlist must not be mistaken for implemented capability.

### Exit evidence

- real Store 01 canonical Amazon profile resolved;
- real entities mirrored with store/profile identity intact;
- at least one controlled Search Term report cycle reaches terminal success;
- raw object exists in R2 with validated identity/content provenance;
- Store D1 Search Term facts reconcile to report receipt and date/profile context;
- acceptance reads use the canonical real profile and valid lineage, excluding synthetic fixtures from authority;
- no Amazon write endpoint invoked;
- kill switches and rollback path verified.

Detailed contract: `docs/architecture/PHASE5_STORE01_LIVE_READ_ACTIVATION.md`.

## 6. Phase 6 — Decision Intelligence MVP

### Objective

Turn trustworthy facts into explainable, deterministic recommendations. During the active CSV-first directive, this phase may operate over provenance-valid imported CSV evidence only as non-authoritative advisory analysis.

### MVP intelligence

- Search Term waste detection;
- negative keyword candidate recommendation;
- keyword harvesting candidate recommendation;
- bid opportunity/risk recommendation where the required targeting/bid source state is trustworthy;
- ACoS/ROAS/CVR/CPC diagnostics;
- evidence/confidence envelope for every recommendation;
- profitable/toxic root analysis with profit-root protection;
- deterministic Search Term → observed targeting identity links for local review.

### Recommendation authority

For live authority after the freeze, a recommendation MUST consume the canonical real profile scope and provenance-valid facts. Dev fixture rows, missing source report lineage, or unscoped multi-profile aggregates are not authorized recommendation input.

During the active CSV-first directive, imported CSV recommendations remain explicitly non-authoritative even when the file contains observed Amazon identifiers. They may support human review but cannot establish canonical Amazon identity or execution authority.

Every recommendation must identify:

```text
store/profile or explicit observed CSV scope
entity/action target
analysis window
source facts/provenance
rule/model version
before state
proposed state
rationale
confidence
idempotency fingerprint
```

A recommendation can create a `proposed` action only when the separately authorized governance path permits it; CSV advisory output alone cannot approve, persist, or apply itself.

## 7. Phase 7 — Ads Intelligence Native UI / React-Vite Strangler

### Objective

Modernize only the product surfaces needed for intelligence workflows while preserving Native APIs, Access, RBAC, and store boundaries.

Priority screens:

- Search Term Intelligence;
- joint CSV profitability/toxicity analysis;
- observed targeting identity/evidence drilldown;
- Recommendation Inbox;
- trend/efficiency context;
- data freshness/health.

Do not big-bang rewrite the entire migration-era UI.

## 8. Phase 8 — Recommendation Approval / Action Control Plane

### Objective

Make recommendations governable operational actions.

Deliver:

- Action API over existing Store D1 ledger;
- proposed action list/detail;
- approve/reject with RBAC and audit;
- immutable/append-only action events;
- concurrency/idempotency rules;
- apply remains fail-closed unless Phase 11 execution adapter is explicitly enabled.

Detailed API contract: `docs/architecture/OPTIMIZATION_ACTION_API_CONTRACT_V1.md`.

## 9. Phase 9 — Multi-Store Execution Isolation

### Objective

Make Amazon execution physically store-scoped before any Store 02 credential provisioning.

Target topology:

```text
Central Web + Control D1
  ├─ Store 01 D1 → Sync Worker 01 → Workflow 01 → Credentials 01 → R2 boundary 01
  ├─ Store 02 D1 → Sync Worker 02 → Workflow 02 → Credentials 02 → R2 boundary 02
  ├─ Store 03 D1 → Sync Worker 03 → Workflow 03 → Credentials 03 → R2 boundary 03
  └─ Store 04 D1 → Sync Worker 04 → Workflow 04 → Credentials 04 → R2 boundary 04
```

No shared Sync Worker may hold multiple stores' Amazon credentials.

## 10. Phase 10 — Production Read-Only Launch

### Objective

Promote the proven Store 01 read path to a production-grade, read-only operating contract.

Includes Production Access/DNS/runtime/resource identities, exact-SHA release, data SLOs, rollback, observability, and operator runbook. Still no Amazon mutation authority.

## 11. Phase 11 — Controlled Amazon Execution

### Objective

Apply approved actions through a store-isolated, idempotent Amazon execution adapter.

Required properties:

- approved action is the only executable input;
- before-state revalidation before write;
- idempotency key and external request ID;
- action status `approved → applying → applied|failed`;
- verification read after mutation;
- event/audit evidence;
- kill switch;
- explicit supported action-type allowlist;
- revert only where Amazon semantics permit a safe compensating action.

## 12. Phase 12 — Closed-loop Optimization

### Objective

Measure outcomes after applied actions and feed verified results back into recommendation quality.

Outputs include outcome windows, counterfactual-safe attribution where feasible, recommendation precision, rejected/failed-action learning, rule thresholds, and operator trust metrics.

## 13. Priority rule

While the active 2026-08-18 CSV-first directive remains in force, use this order:

```text
trusted CSV/manual report data
> joint/historical analysis and data quality
> Search Term profitability/waste/root intelligence
> local observed identity and keyword/negative library review
> explainable advisory UX
> provenance/audit/CI/security integrity
> other non-Amazon local automation
```

After the directive is explicitly lifted, the long-term order resumes:

```text
trusted real Store 01 data
> Search Term decision intelligence
> explainable recommendation
> governed approval/action control
> UI modernization required to operate those capabilities
> multi-store expansion
> Production read-only
> Amazon writes
> autonomous/closed-loop optimization
```

Infrastructure work may preempt either order only for a concrete architecture, security, availability, or data-integrity blocker.
