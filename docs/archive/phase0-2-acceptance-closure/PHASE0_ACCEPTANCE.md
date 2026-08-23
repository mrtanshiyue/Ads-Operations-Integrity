# Architecture Convergence Phase 0 — Acceptance Record

Date: 2026-08-16

Repository: `mrtanshiyue/Ads-Operations-Integrity`

Consolidation branch: `consolidation/architecture-convergence-phase0`

## Verified implementation candidate

Foundation baseline:

```text
b1828b8b6f62c167f8e0654175413e55f449c4bd
```

Verified implementation candidate before this documentation-only acceptance commit:

```text
04d1e10a006a59c99ad398767b72ecb192805661
```

Canonical CI acceptance for that candidate:

```text
Run 31928430624
Conclusion: SUCCESS
```

The run completed all of the following successfully:

- Architecture Convergence boundary contract;
- canonical Cloudflare Native runtime/build checks;
- Native cloud-loader strangler contract;
- foundation regressions;
- Phase E producer/ingestion regressions;
- R2 provenance Gates 24–27;
- Access governance regressions;
- dormant Amazon transport regressions without deployment.

## Ref integrity observed before PR preparation

```text
main
1a55d808d233aecbbe4cea51fa9ca66bcfbf7e03

cloudflare-foundation-v1
b1828b8b6f62c167f8e0654175413e55f449c4bd

__manual_ci_gated_deploy__
ce59e4cc43413338f35a34cb44622a7aa26f9875

consolidation/architecture-convergence-phase0
04d1e10a006a59c99ad398767b72ecb192805661
```

No source-branch drift occurred during Phase 0: `cloudflare-foundation-v1` remained on the exact starting baseline.

Neither `main` nor the physical Cloudflare deployment-trigger branch was moved by Phase 0.

## Ancestry and merge shape

At the verified implementation candidate:

```text
main -> cloudflare-foundation-v1
status: ahead
foundation ahead_by: 245
foundation behind_by: 0

main -> consolidation/architecture-convergence-phase0
status: ahead
consolidation ahead_by: 260
consolidation behind_by: 0

cloudflare-foundation-v1 -> consolidation/architecture-convergence-phase0
status: ahead
Phase 0 ahead_by: 15
Phase 0 behind_by: 0
```

Therefore the consolidation branch is a direct descendant of `main`; it is not an unrelated or diverged history. A normal controlled pull request can review the resulting forward-only history.

## Phase 0 acceptance scope

The following split-brain paths were resolved or quarantined:

1. Root legacy Wrangler deployment target removed from active source and archived.
2. Legacy `src/worker.js` Warehouse proxy removed from active runtime and archived.
3. GitHub Pages deployment workflow and TiDB-era main CI retired and archived.
4. Granular Cloudflare Foundation/Access/Amazon/Gate workflows retired after canonical coverage parity.
5. Canonical CI established as the active regression topology.
6. Repository default build converged on the Cloudflare Native artifact.
7. Native deployment assets constrained by an explicit allowlist.
8. Warehouse V3/V4 browser loaders, old query client and legacy generated cloud-loader scripts removed from active source ownership and Native artifact.
9. Native browser data panel established on the same-origin Cloudflare Native query bridge.
10. Warehouse password/session credential transport removed from the Native browser artifact.
11. Cloud Raw import left explicitly fail-closed instead of being falsely declared migrated.
12. Direct repository `deploy:*` npm aliases blocked.
13. Amazon secret-provisioning npm entrypoint blocked while dormant helper code remains regression-testable.
14. Root architecture/status documentation rewritten to Cloudflare Native truth.
15. Executable Architecture Convergence contracts added to prevent accidental restoration of retired paths.

## Explicitly not accepted in Phase 0

Phase 0 does **not** authorize or claim completion of:

- Production provisioning;
- Production DNS / Access / Worker / D1 / R2 changes;
- Cloudflare deployment-trigger promotion;
- manual Wrangler deployment;
- sync Worker deployment;
- Amazon Ads credentials provisioning;
- live LWA credential smoke;
- Create/Poll/Download Amazon reports;
- real Amazon Dev sync;
- `AMAZON_ADS_ENABLED=true`;
- `SYNC_TRIGGER_ENABLED=true`;
- Cloud Raw import migration;
- Security Integrity expansion;
- frontend modernization;
- Store 01 real Amazon activation.

## PR readiness conditions

Phase 0 may enter a controlled pull request to `main` only when:

1. the final documentation commit also receives a green Canonical CI run;
2. `main` still matches the observed base or the ancestry comparison is re-run if it moved;
3. `cloudflare-foundation-v1` still has no unintegrated commits;
4. `__manual_ci_gated_deploy__` has not been moved by this work;
5. the PR does not trigger a Cloudflare deployment as a side effect;
6. merge remains a separate explicit decision after review.

Opening the PR is not authorization to deploy or to merge automatically.
