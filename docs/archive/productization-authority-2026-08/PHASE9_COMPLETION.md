# Phase 9 — Recommendation + Governance Completion

Status: **COMPLETE when this change is merged to canonical `main` and canonical CI/deployment acceptance passes.**

Phase 9 is closed as a product capability. It must not be extended with additional proof-only gates or telemetry unless a real production defect or safety requirement appears.

## Exit criteria

- Search-term intelligence produces deterministic metrics, trend, confidence, freshness, evidence, recommendation, suppression and lineage context.
- Recommendation quality policy enforces deterministic precedence for duplicate, collision, semantic conflict, approved-not-executed, rejection cooldown, repeated-suggestion cooldown and store/profile integrity suppression.
- Cooldown basis remains `current_recommendation_analysis_window`; no arbitrary fixed-day cooldown is introduced.
- Operator governance supports explicit proposal, dry-run validation, approve, reject with rejection reason, lifecycle history and audit context.
- Governance approval remains distinct from Amazon execution: `Governance Approved != Amazon Executed`.
- Governance Health exposes awaiting-review, approved, rejected, stale, confidence distribution, aging, errors, recent lifecycle and durable suppression observability.
- Batch 2C `recommendation_quality_suppression` is surfaced from durable Control D1 audit telemetry; no request-time proof counter is added.
- Search Term Intelligence and Recommendation Queue expose operator filtering/search and readable suppression rationale without adding Amazon mutation transport.
- Canonical tests continue to enforce fail-closed authority and `amazonMutationAuthorized=false` for Phase 9 productization paths.

## Deferred live acceptance

The existing Store D1 synthetic search-term facts have `source_report_job_id = null` and `report_jobs` is empty. Therefore they cannot form an authoritative lineage-valid recommendation candidate. A zero live count for recommendation-quality suppression is valid under that dataset.

This acceptance is recorded as:

`Deferred live acceptance pending natural authoritative candidate`

Do not fabricate `report_jobs`, lineage, audit events, recommendation candidates or operational D1 evidence to change that count.

## Compatibility debt decision

No currently exercised compatibility path is removed merely to satisfy cleanup. In particular, legacy unprefixed action-event vocabulary remains read-compatible while canonical writes use `action.<transition>`. Removing active read compatibility without migration evidence would create regression risk and is not considered obvious obsolete debt.

## Boundary after Phase 9

The next work is product completion and Amazon execution safety, not additional Phase 9 micro-gates. Amazon mutation remains disabled until the controlled execution release path explicitly authorizes a single permitted action.