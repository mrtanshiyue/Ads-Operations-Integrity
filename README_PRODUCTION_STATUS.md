# Ads Operations Integrity — Current Production Status

> **Authority:** current-state companion to `README.md`, last verified `2026-08-08`.
> If an older production behavior SHA, run, phase number or component version in `README.md` conflicts with this file, use this file for current-state decisions and still re-check live GitHub/Pages/Worker state before changing production.
> **Never treat a static document as the current `main` SHA.** Read `main` live. This file records the last verified **runtime-changing Pages behavior SHA**, which can legitimately remain unchanged while cleanup/docs-only commits advance `main`.

## Repository and Pages baseline

- Repository: `mrtanshiyue/Ads-Operations-Integrity`
- Current `main`: **must be read live; do not copy a docs-only SHA into this file**
- Last repository-cleanup baseline before this status document: `701df9c2b7156f303c47703c0036f58f61c33dc6`
- Cleanup commit: `Maintenance: clean historical repair artifacts and archive V4 cutover docs (#38)`
- Cleanup CI: Run `31247951613` ✅

The deployed GitHub Pages **runtime behavior** remains the last application-changing Phase 12 commit:

```text
43b32f14ec7726950ff55d938b6ec794405de0a5
Phase 12: fix Query-native trend Chart lifecycle collision (#37)
```

Validated Phase 12 runs:

```text
Frontend main CI: 31193065886 ✅
GitHub Pages:     31193065972 ✅
```

Do not confuse newer cleanup/docs-only `main` SHAs with the static application behavior SHA.

## Current frontend component versions

```text
Loader                         4.3.0
Query Client                   1.3.0
Query-native Module Adapter    1.2.0
Ads Trend Controller           1.1.0
Ads Trend Host Guard           1.0.0
Bid Governance Parity Audit    1.0.4
Worker API                     4.2.2
```

The older long-form README still lists Bid Governance Parity Audit `1.0.3`; the production asset itself reports `1.0.4`.

## Runtime architecture

```text
GitHub Pages / Browser
        -> Cloudflare Worker V4
        -> TiDB Cloud / Private Amazon-Data-Warehouse
```

The browser must not directly access TiDB or the private Warehouse repository.

The Bearer credential remains current-tab / memory-only. Do not persist it to localStorage, IndexedDB, HTML or tracked JavaScript.

## Query-native / Bid Governance state

Production Phase 8 parity remains metric/identity aligned for the validated month, while advanced Bid Governance continues to fail closed because source readiness is incomplete.

Current blockers remain conceptually:

```text
adProductReady
advertisedProductIdentityReady
attributionMaturityReady
legacyBidComparable
```

Phase 16A adds provenance-aware Sponsored Products Advertised Product source preflight on the Warehouse side. Detecting a supplemental candidate **does not authorize execution** and does not justify client defaults.

Never invent:

- `SP` for missing Ad Product;
- advertised ASIN/SKU;
- attribution window;
- Legacy Bid values.

## Cloudflare Workers Free accepted risk

The backend repository has confirmed through Cloudflare Tail that intermittent full-history Raw failures are platform CPU-limit terminations, not a frontend retry/CORS implementation bug.

Observed failing backend invocations:

```text
HTTP 503
Cloudflare outcome = exceededCpu
exception = Worker exceeded CPU time limit.
```

Cloudflare also explicitly rejected an attempted bounded CPU configuration with error code `100328`, stating that CPU limits are not supported on the **Free plan**.

Operational consequence for the frontend:

- normal Query-first operation remains the preferred path;
- full-history Raw compatibility can succeed but is not deterministic on Workers Free;
- do not increase frontend retry counts or weaken Chromium/transport gates to mask the backend plan limit;
- a deterministic full-history Raw guarantee requires the backend infrastructure prerequisite to be resolved first.

## Repository cleanup status

Completed on `main`:

- removed completed one-off `repair_*` / cutover scripts;
- archived obsolete V3→V4 cutover documents;
- added root `.gitignore` hygiene rules;
- retained production assets, vendor files, generated runtime assets and active regression tests;
- cleanup did not intentionally republish a new application runtime.

Remaining hygiene debt:

- many historical branches still exist and require separate branch deletion tooling;
- the long-form `README.md` contains older Phase 8 production snapshots; this file supersedes those current-state values until consolidation.

## Release discipline

For any future data/API/schema change:

1. Warehouse branch + PR first.
2. Warehouse CI.
3. TiDB reconciliation / Worker smoke / historical integrity.
4. Chromium full acceptance.
5. Only then change/publish Frontend if required.

Do not restore V2, bypass Warehouse-first release order, weaken source-readiness gates or allow a frontend default to manufacture missing backend evidence.
