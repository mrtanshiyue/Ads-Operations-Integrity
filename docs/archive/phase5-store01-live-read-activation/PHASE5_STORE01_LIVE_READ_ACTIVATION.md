# Phase 5 — Store 01 Real Amazon Read-Only Activation Contract

Status: **FROZEN ACTIVATION CONTRACT — NOT YET ACTIVATED**  
Scope: Store 01 only, Development execution plane, Amazon Ads read operations only.

## 1. Goal

Produce the first trustworthy real Amazon Ads dataset for Store 01:

```text
Amazon credentials
→ canonical profile discovery
→ exact single-run permit
→ entity mirror
→ Search Term report
→ R2 raw source object
→ Store 01 D1 search-term facts
→ provenance / reconciliation
→ Search Term Intelligence-ready data
```

This phase does not authorize Amazon mutation, Store 02 credentials, Production rollout, recurring sync, or claims that every Store D1 fact table has a live producer.

## 2. Current implementation truth

The only implemented live fact producer is:

```text
search_term_daily
report contract: search_term_daily.sp.v1
Amazon report type: spSearchTerm
entity mirror required: true
```

The Store D1 schema contains other daily fact tables and the generic sync-intent parser recognizes additional dataset names. That is not producer readiness. Unsupported datasets must fail closed before durable run registration.

Current Sponsored Products Search Term contract truth:

- time unit: DAILY;
- lookback metadata: 65 days;
- seller attribution: 7 days;
- vendor attribution: 14 days.

## 3. Starting state

Required pre-activation state:

```text
activation state = safe_disabled
Web Dev:  SYNC_TRIGGER_ENABLED=false
Web Dev:  PHASE5_SINGLE_RUN_PERMIT_ID=""
Web Dev:  PHASE5_SINGLE_RUN_REPORT_DATE=""
Sync Dev: AMAZON_ADS_ENABLED=false
Sync Dev: CONTROL_DB bound
Sync Dev: STORE_01_DB bound
Sync Dev: DATA_BUCKET bound
Sync Dev: AMAZON_SYNC_WORKFLOW bound
```

Store 02/03/04 execution bindings or credentials are not permitted in this phase.

Synthetic Dev fixtures may remain for regression coverage. They are never live recommendation authority.

## 4. Git-controlled activation authority

Authoritative state file:

```text
docs/operations/PHASE5_STORE01_ACTIVATION_STATE.json
```

Allowed state machine:

```text
safe_disabled
  AMAZON_ADS_ENABLED=false
  SYNC_TRIGGER_ENABLED=false
  singleRunPermit=null
  Web permit vars empty

        ↓ only after credential + profile preflights pass

amazon_read_ready
  AMAZON_ADS_ENABLED=true
  SYNC_TRIGGER_ENABLED=false
  singleRunPermit=null
  Web permit vars empty

        ↓ only with one exact planner-generated permit

single_run_open
  AMAZON_ADS_ENABLED=true
  SYNC_TRIGGER_ENABLED=true
  singleRunPermit={permitId, reportDate}
  Web permit vars exactly match permit

        ↓ immediately after exact run registration

amazon_read_ready
```

Emergency rollback may move either active state directly to `safe_disabled`. Normal `safe_disabled → single_run_open` is forbidden.

`single_run_open` is an exact permit, not a generic time window. Git state, Web runtime vars, `Idempotency-Key`, report date, dataset, and manual trigger semantics must agree before Store D1 `sync_runs` registration or Workflow creation.

Canonical CI and `validate-cloudflare-native.mjs` validate activation state, flags, permit, Store 01 topology, dataset scope, and Production-disabled invariants.

## 5. Hard boundaries

### Allowed Amazon operations

Only the read/acquisition operations needed for Phase 5:

- LWA token refresh;
- `GET /v2/profiles` canonical profile discovery;
- supported entity-list reads during the controlled Workflow;
- Create Report for `search_term_daily.sp.v1`;
- Poll/Get Report;
- Download completed report content.

### Prohibited Amazon operations

No bid, budget, campaign, ad group, keyword, target, product-ad, negative, portfolio, state, or other Amazon mutation is authorized.

### Store and Production boundaries

- Store 01 Dev only;
- no Store 02/03/04 credentials;
- no Store 02/03/04 D1 bindings on the Store 01 Dev Sync plane;
- Production `AMAZON_ADS_ENABLED=false` always during Phase 5;
- Production `SYNC_TRIGGER_ENABLED=false` always during Phase 5;
- Production permit vars remain empty;
- no Production mutation.

### Recommendation authority

Phase 5/6 live authority must be scoped by:

```text
canonical real Amazon profileId
+ valid source_report_job_id
+ validated Amazon report identity
+ validated R2 object/content provenance
```

Unscoped Dev browse queries and synthetic rows are not recommendation inputs.

## 6. Pre-activation sequence while fully disabled

All steps in this section run while:

```text
activation state = safe_disabled
AMAZON_ADS_ENABLED=false
SYNC_TRIGGER_ENABLED=false
singleRunPermit=null
Web permit vars empty
```

### A. Repository/runtime preflight

Verify:

- canonical `main` required CI is green;
- intended Web/Sync runtime identities are exact reviewed Git SHAs when those planes change;
- Web/Sync Dev bindings are Store 01 only;
- Production remains disabled;
- `search_term_daily` is the only Phase 5 executable dataset.

### B. Store 01 route preflight

Control D1 must resolve one active Store 01 route with expected US / NA contract and `STORE_01_DB` binding. Required operator authorization remains `sync.run` / `sync.read` for the later controlled run.

### C. Credential provisioning

Provision exactly:

```text
AMAZON_ADS_CLIENT_ID
AMAZON_ADS_CLIENT_SECRET
AMAZON_ADS_REFRESH_TOKEN
```

Secrets must never enter Git, D1, browser responses, audit payloads, or command-line argv.

### D. Credential-only smoke

Run:

```text
POST /health/amazon-credentials
```

Requirements:

- immutable runtime Git tag is valid and expected;
- short-lived request proof is valid;
- LWA token refresh passes;
- Amazon execution remains disabled;
- no Create/Poll/Download Report;
- no D1/R2 side effects.

This proves token exchange only.

### E. Canonical profile discovery smoke

Still while `AMAZON_ADS_ENABLED=false`, run:

```text
POST /health/amazon-profile
```

Operator client:

```text
node scripts/smoke-cloudflare-amazon-profile-discovery-dev.mjs
```

The request uses a distinct short-lived HMAC proof bound to the profile-smoke path and exact runtime Git tag.

The endpoint is allowed to perform only:

1. read the active Store 01 route from Control D1;
2. obtain an LWA access token;
3. call Amazon Ads `GET /v2/profiles`;
4. apply the existing `resolveCanonicalProfile()` contract.

It must not:

- write Control D1;
- read/write Store D1;
- fetch entity snapshots;
- Create/Poll/Download reports;
- read/write R2;
- persist the canonical profile.

Success returns only the non-secret planning identity:

```text
profileId
accountType = seller | vendor
marketplaceId
countryCode
currencyCode
region
timezone
```

Canonical selection is fail-closed: zero valid US seller/vendor profiles, multiple valid profiles, unsupported account type, or marketplace/region mismatch block activation.

The smoke result is preflight evidence, not durable producer authority. The first real Workflow must resolve Amazon profile authority again and persist its own durable receipt.

### F. First-run plan

After profile discovery supplies `seller|vendor`, determine the latest fully closed reporting date in that marketplace context and run:

```text
node scripts/plan-phase5-store01-first-run.mjs \
  --account-type <seller|vendor> \
  --as-of-date <YYYY-MM-DD>
```

The planner generates exactly one attribution-mature Search Term day and deterministic permit ID:

- seller: `asOfDate - 7 days`;
- vendor: `asOfDate - 14 days`.

The planner does not guess marketplace closure/timezone.

## 7. Enable Amazon read execution

Only after all pre-activation steps pass:

1. create reviewed Git transition `safe_disabled → amazon_read_ready`;
2. set Dev Sync `AMAZON_ADS_ENABLED=true`;
3. keep Web `SYNC_TRIGGER_ENABLED=false` and permit vars empty;
4. canonical CI must pass;
5. merge to `main`;
6. exact-SHA deploy Sync Dev;
7. verify Sync `/health` reports the exact runtime and `amazonAdsEnabled=true`.

No run may be registered yet.

## 8. Open exactly one run

Using the already generated planner output:

1. create reviewed Git transition `amazon_read_ready → single_run_open`;
2. set Web `SYNC_TRIGGER_ENABLED=true`;
3. set `singleRunPermit={permitId, reportDate}`;
4. copy exactly the same values into:
   - `PHASE5_SINGLE_RUN_PERMIT_ID`;
   - `PHASE5_SINGLE_RUN_REPORT_DATE`;
5. canonical CI must pass;
6. merge and exact-SHA deploy Web Dev;
7. verify exact runtime identity and permit vars;
8. submit exactly one request:

```text
POST /api/v1/stores/store-dev-01/sync
Idempotency-Key: <exact permitId>

{
  "startDate": "<permit reportDate>",
  "endDate": "<permit reportDate>",
  "datasets": ["search_term_daily"]
}
```

Different idempotency key, date, dataset, or normalized intent must fail before Store D1 registration and Workflow creation.

Immediately after the exact run is registered, return to `amazon_read_ready`, set Web trigger false, set `singleRunPermit=null`, clear both permit vars, pass CI, merge, and exact-SHA deploy Web Dev again.

No scheduled recurring sync is authorized.

## 9. First-run acceptance

### Identity

- Workflow resolves exactly one canonical real Store 01 profile from Amazon;
- durable profile identity matches the preflight profile identity;
- seller/vendor and marketplace/region are coherent;
- no caller-injected profile authority;
- synthetic profile rows are not live authority.

A mismatch between preflight profile discovery and durable Workflow profile resolution is a blocker.

### Acquisition

- entity mirror uses the same canonical profile;
- Create Report succeeds for `search_term_daily.sp.v1`;
- polling terminates correctly;
- completed report identity is persisted;
- downloaded content matches profile/date/report context.

### R2 and Store D1

- raw object exists and identity/content provenance is coherent;
- report job and sync run reach a valid terminal state;
- Search Term rows contain real Store 01 identifiers;
- date grain/metric units are preserved;
- source report lineage is retained;
- duplicate/replay guards remain valid;
- synthetic rows are excluded from live authority.

### Reconciliation

Reconcile the accepted report date using the canonical real `profileId`, not an unscoped Store D1 aggregate. Unexplained material mismatch blocks Phase 5 acceptance.

### No-write proof

Runtime/audit evidence must show no Amazon mutation transport was invoked.

## 10. Kill switch / rollback

### Stop new runs

Return to `amazon_read_ready`:

```text
SYNC_TRIGGER_ENABLED=false
singleRunPermit=null
PHASE5_SINGLE_RUN_PERMIT_ID=""
PHASE5_SINGLE_RUN_REPORT_DATE=""
```

### Stop Amazon read execution

For credential, profile, report, R2, Store D1, or unexpected Amazon behavior defects, move directly to `safe_disabled`:

```text
AMAZON_ADS_ENABLED=false
SYNC_TRIGGER_ENABLED=false
singleRunPermit=null
PHASE5_SINGLE_RUN_PERMIT_ID=""
PHASE5_SINGLE_RUN_REPORT_DATE=""
```

Preserve diagnostic evidence; do not rewrite provenance or hand-edit facts to manufacture success.

## 11. Completion criteria

Phase 5 is complete when:

1. Store 01 credentials validate under the isolated Dev Sync plane;
2. safe-disabled profile discovery identifies one canonical real seller/vendor profile;
3. durable Workflow profile resolution matches that preflight identity;
4. one exact-permit real `search_term_daily` run reaches accepted terminal state;
5. report → R2 → Store D1 lineage is verified;
6. facts reconcile under the real profile scope;
7. no Amazon mutation occurred;
8. kill-switch / exact-permit transitions are proven;
9. replay with the same permit identity is replay-safe;
10. Search Term Intelligence can consume only real provenance-valid facts.

After this, Phase 6 may build recommendations from real Store 01 Search Term data. Broader backfill, scheduling, and additional daily-fact producers remain explicit later work.
