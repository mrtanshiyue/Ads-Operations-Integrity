# Phase 5 — Store 01 Real Amazon Read-Only Activation Contract

Status: **FROZEN ACTIVATION CONTRACT — NOT YET ACTIVATED**  
Scope: Store 01 only, Development execution plane, Amazon Ads read operations only.

## 1. Goal

Produce the first trustworthy real Amazon Ads dataset for Store 01 and prove the complete read pipeline:

```text
Amazon Ads
→ canonical profile
→ entity mirror
→ Search Term report
→ R2 raw source object
→ Store 01 D1 search-term facts
→ provenance / reconciliation
→ Search Term Intelligence-ready data
```

This phase activates existing implementation. It does not authorize Amazon mutation, Store 02 credentials, Production rollout, or claims that every Store D1 daily-fact table already has a live Amazon producer.

## 2. Current implementation truth

The Store D1 schema contains multiple daily fact families, and the generic sync-intent contract recognizes multiple dataset names. **The currently implemented live producer capability is narrower: only `search_term_daily` is executable.**

Current producer contract:

```text
implemented dataset: search_term_daily
entity mirror required: true
report contract: search_term_daily.sp.v1
```

`campaign_daily`, `ad_group_daily`, `keyword_daily`, `target_daily`, `advertised_product_daily`, `purchased_product_daily`, and `placement_daily` are not valid Phase 5 live producer inputs yet. If supplied, producer capability must fail closed rather than pretend those datasets were acquired.

The entity mirror still supplies the campaign / ad group / keyword / target / product-ad identity context required by the Search Term pipeline. Daily metric producers for the other fact families are subsequent implementation work after the first trusted Search Term loop.

## 3. Current pre-activation state

Required starting state:

```text
Web Dev:  SYNC_TRIGGER_ENABLED=false
Sync Dev: AMAZON_ADS_ENABLED=false
Sync Dev: STORE_01_DB bound
Sync Dev: CONTROL_DB bound
Sync Dev: DATA_BUCKET bound
Sync Dev: AMAZON_SYNC_WORKFLOW bound
```

The current Dev Sync plane may service only the Store 01 activation in this phase. Multi-store credentials are prohibited.

At the 2026-08-17 preflight, Store 01 D1 still contains synthetic Dev fixtures and no real `report_jobs` or `sync_runs`. Synthetic fixtures are regression assets, not live Amazon authority.

## 4. Hard safety boundaries

### Amazon operations allowed

Only read/acquisition operations required to populate the implemented Search Term pipeline:

- LWA access-token refresh;
- Amazon Ads profile discovery/bootstrap;
- supported entity-list reads;
- Create Report for the implemented Search Term report contract;
- Get/Poll Report status;
- Download completed report content.

### Amazon operations prohibited

No campaign, ad group, keyword, target, product-ad, budget, bid, state, negative, portfolio, or other Amazon mutation may be called.

### Cloudflare mutations allowed only when explicitly required by activation

Phase 5 may eventually require exact-SHA Dev deployment/configuration and Store 01 secret provisioning. Before those mutations, all read-only preflight checks in this contract must pass. Production Cloudflare resources remain out of scope.

### Store boundary

- no Store 02/03/04 Amazon credential provisioning;
- no shared multi-store credential namespace;
- no adding Store 02/03/04 D1 bindings to the Store 01 Dev Sync Worker for Phase 5;
- no treating the existing `production` stanza in `wrangler.sync.jsonc` as approved topology.

### Data-authority boundary

Real Amazon decision intelligence must never aggregate synthetic and live profile facts as one authority.

For Phase 5 acceptance and all Phase 6 recommendation inputs:

- use the canonical real Amazon `profileId` resolved from the live `listProfiles` response;
- query Store 01 facts with that exact profile scope;
- require valid `source_report_job_id` lineage and the corresponding validated Amazon report / R2 object / source-content identity where the read contract exposes those checks;
- do not treat a row with missing/invalid report lineage as live recommendation authority;
- do not delete historical synthetic fixtures merely to manufacture clean-looking acceptance evidence.

Existing generic entity/search-term browse APIs may allow an omitted `profileId` for Dev browsing. That unscoped mode is not an approved recommendation source after live activation.

## 5. Activation conditions

These are operational conditions, not a return to historical Gate numbering.

### A. Repository and runtime preflight

Must verify:

- canonical `main` and required CI are green;
- intended Sync runtime comes from an exact reviewed Git SHA;
- Web Dev and Sync Dev current bindings match Store 01 scope;
- `SYNC_TRIGGER_ENABLED=false`;
- `AMAZON_ADS_ENABLED=false`;
- no Production mutation is included;
- `search_term_daily` producer/report contracts remain covered by canonical CI.

Failure is a blocker.

### B. Store 01 canonical identity preflight

Control D1 store route must resolve exactly one active Store 01 entry with:

- store ID/code;
- marketplace `US` / expected marketplace code;
- Amazon region `NA` / expected region;
- Store D1 binding key `STORE_01_DB`;
- operator `sync.run` / `sync.read` authorization.

The live producer must resolve canonical profile identity from Amazon, not from an arbitrary pre-existing active row in Store D1. For the current US contract, canonical selection must fail closed if the Amazon account returns zero or more than one eligible US seller/vendor profile.

Synthetic profile/entity/fact fixtures may remain only as non-authoritative Dev regression data and must be excluded by canonical live profile + provenance scope.

### C. Credential provisioning while execution is disabled

Provision exactly the credential set required by the existing credential provider to `ads-operations-sync-dev` for Store 01 only:

```text
AMAZON_ADS_CLIENT_ID
AMAZON_ADS_CLIENT_SECRET
AMAZON_ADS_REFRESH_TOKEN
```

During provisioning:

```text
AMAZON_ADS_ENABLED=false
SYNC_TRIGGER_ENABLED=false
```

Secrets must never be committed to Git, written to D1, returned to the browser, or copied into audit payloads.

### D. Credential smoke — zero report/data side effects

Run the existing Dev-only endpoint:

```text
POST /health/amazon-credentials
```

Contract requirements:

- `AMAZON_ADS_ENABLED` must still be `false`;
- request proof must be tied to the immutable runtime Git tag and short-lived timestamp;
- LWA token refresh must pass;
- no Create Report;
- no Poll Report;
- no Download Report;
- no D1 write;
- no R2 write.

A successful LWA smoke proves credentials/token exchange only. It does **not** prove profile identity or report access.

### E. Read execution enablement

Only after A–D pass:

1. use the reviewed exact-SHA Sync runtime/configuration;
2. enable `AMAZON_ADS_ENABLED=true` on the Store 01 Dev Sync Worker under controlled deployment/config provenance;
3. keep Web `SYNC_TRIGGER_ENABLED=false` until Sync health/version/bindings are accepted;
4. verify Sync `/health` reports the expected immutable version, Store DB count, Workflow, R2, and `amazonAdsEnabled=true`;
5. then enable Web `SYNC_TRIGGER_ENABLED=true` only for the controlled manual run window.

No scheduled recurring sync is authorized by the first activation run.

## 6. First controlled manual run

The Web API contract is:

```text
POST /api/v1/stores/{storeId}/sync
Idempotency-Key: <unique durable key>
```

The body must contain only allowed sync intent fields. Caller-supplied `profileId` and caller-supplied report configuration authority remain forbidden; the producer resolves the canonical Amazon profile.

### Executable dataset

The first live run MUST request exactly the currently implemented business dataset:

```text
search_term_daily
```

Do not include `keyword_daily`, `target_daily`, `campaign_daily`, or any other daily dataset in this run. The generic intent parser recognizes those names, but the live producer intentionally rejects them until their producer implementations exist.

Entity bootstrap/mirror remains part of the Search Term producer path and provides the targeting identity context needed for Search Term Intelligence.

### Date range

Use the smallest practical recent closed reporting window that can produce stable Amazon report data. Do not start with a large historical backfill. Backfill is a later operation after the single-window pipeline is accepted.

## 7. Required run receipts and acceptance

A successful first live run must prove all of the following.

### Identity

- one canonical real Amazon profile selected for Store 01;
- profile marketplace/region matches Control D1 store routing;
- no caller-injected profile authority;
- entity rows reference the same canonical profile context;
- synthetic profile data is not selected as live authority.

### Acquisition

- Create Report succeeds for `search_term_daily.sp.v1`;
- polling terminates correctly;
- completed report identity is persisted;
- download content corresponds to the expected report/profile/date context.

### R2

- raw object exists;
- object key is linked from the report receipt;
- content SHA-256 / native object metadata / byte size evidence is coherent where the current provenance contract requires it;
- object identity is not substituted across reports or stores.

### Store D1

- report job and sync run reach a valid terminal state;
- staged/published Search Term facts contain real Store 01 identifiers;
- date grain and metric units are preserved;
- Search Term rows retain source report lineage;
- duplicate/replay guards remain valid;
- no synthetic row is accepted as live authority.

### Reconciliation

For the accepted Search Term report window, compare source report totals to Store D1 totals for the metrics represented by the report contract. Reconciliation must use the canonical real `profileId`, not an unscoped Store DB aggregate. Any unexplained material mismatch blocks Phase 5 acceptance.

### No-write proof

Audit/runtime evidence must show no Amazon mutation transport was invoked.

## 8. Kill switch and rollback

### Stop new runs

Set first:

```text
SYNC_TRIGGER_ENABLED=false
```

This prevents the Web API from registering/triggering new producer runs.

### Stop Amazon producer execution

If credentials, profile identity, report authority, R2 identity, Store D1 integrity, or unexpected Amazon behavior is in doubt, set:

```text
AMAZON_ADS_ENABLED=false
```

Do not continue with retries or backfill until the defect is understood.

### Data handling after a failed run

- preserve immutable raw/report evidence required to diagnose the failed run;
- mark terminal failure through existing run/report state contracts;
- do not silently rewrite provenance to make the run appear successful;
- use idempotent/recovery semantics already defined by the runtime rather than hand-editing Store D1 facts.

## 9. Phase 5 completion criteria

Phase 5 is complete when:

1. Store 01 live credentials are valid and isolated to the Store 01 Dev Sync plane;
2. at least one controlled real `search_term_daily` sync reaches terminal success, or an explicitly accepted partial state with no identity/integrity defect;
3. canonical real profile/entities exist;
4. Search Term report acquisition → R2 → Store D1 lineage is verified;
5. facts reconcile sufficiently for decision intelligence under the canonical real profile scope;
6. no Amazon write occurred;
7. kill switches are proven operational;
8. a repeat run demonstrates idempotent/replay-safe behavior;
9. Search Term Intelligence can consume only real, provenance-valid facts without synthetic substitution.

After this, Phase 6 may build recommendations from real Store 01 Search Term data while broader backfill, recurring scheduling, and additional daily-fact producer implementations continue as explicit incremental work.
