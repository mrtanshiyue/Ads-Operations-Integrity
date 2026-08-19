# Production Operational Hardening V1

Status: active runbook

Date established: 2026-08-19

Scope: Cloudflare Web/Sync Workers, D1, R2, Access, exact-main deployment correlation, and rollback evidence for Ads-Operations-Integrity.

## 1. Non-negotiable safety boundary

Amazon transport remains hard-off during every operation covered by this runbook.

Required invariants:

- `SYNC_TRIGGER_ENABLED=false` on Web runtimes.
- `AMAZON_ADS_ENABLED=false` on Sync runtimes.
- No Amazon Ads API request, OAuth/token exchange, report job, advertiser/profile live discovery, workflow execution, cron/queue dispatch to Amazon, or optimization apply call is permitted as an observability probe.
- No secret provisioning is part of operational health acceptance.
- A healthy Cloudflare deployment is not evidence of Amazon execution authorization.

## 2. Exact-main deployment receipt

Every Web deployment receipt must correlate all of the following before it is accepted:

1. canonical GitHub `main` commit SHA;
2. protected-branch required context success;
3. manual Workers Build UUID;
4. build trigger UUID and expected Worker identity;
5. build metadata `commit_hash` exactly equal to canonical `main`;
6. expected environment-specific build/deploy command;
7. resulting Worker version ID;
8. resulting deployment ID at 100%;
9. runtime binding/flag acceptance;
10. Access acceptance for Production.

Do not deploy a feature SHA directly to Production. Do not reuse the Dev Worker trigger for Production.

### Current receipt — Analytics Foundation rollout

Canonical main:

`1536f81bb55da10683f41c5e8618e6f6ae43a02d`

Dev Web:

- trigger: `33a47d45-4103-43d7-bca4-7d9096c4abfb`
- build: `d6c5d3b8-700b-4ad2-b53d-94c51fbed406`
- deployment: `8a6c38a0-0a32-4f94-81bb-819089875fa0`
- version: `c7f0fe56-ed76-4f95-8a9e-52d90d217236`
- `APP_ENV=development`
- `ACCESS_MODE=off`
- `SYNC_TRIGGER_ENABLED=false`

Production Web:

- trigger: `fa90d482-de7b-466b-9ada-04404569ede9`
- build: `e6703808-dce1-43ad-8334-83563e0d9a4e`
- deployment: `4a385108-1316-4abd-bcab-366dabd81822`
- version: `de5643ab-32c1-4cc5-a1ca-d8fdc2a177e0`
- `APP_ENV=production`
- `ACCESS_MODE=enforce`
- `SYNC_TRIGGER_ENABLED=false`

Production Sync intentionally remained unchanged because the rollout did not modify sync code/config:

- deployment: `cf0b0adf-96dc-437d-8298-15af58f992ce`
- version: `295df84e-2103-4858-9895-49f67d4b10b4`
- `AMAZON_ADS_ENABLED=false`
- schedules: empty

## 3. D1 migration ledger observability

Before and after every Store migration, capture for each database:

- `COUNT(*)` from `d1_migrations`;
- maximum migration ID;
- latest migration name;
- `PRAGMA foreign_key_check`;
- relevant domain row counts.

The migration ledger and the actual schema are separate evidence surfaces. A ledger row alone does not prove the schema exists, and an existing schema without its expected ledger row is drift.

Current Production baseline:

- Control: 6/6, FK violations 0.
- Store 01: 22/22, latest `0022_store_csv_import_authority.sql`, FK violations 0.
- Store 02: 22/22, latest `0022_store_csv_import_authority.sql`, FK violations 0.
- Store 03: 22/22, latest `0022_store_csv_import_authority.sql`, FK violations 0.
- Store 04: 22/22, latest `0022_store_csv_import_authority.sql`, FK violations 0.

Current Production data-plane acceptance remains clean:

- Control users: 0.
- Control stores: 0.
- CSV facts: 0 across all four Store databases.
- CSV authority rows: 0.
- CSV source objects: 0.
- Advisory review records: 0.

## 4. Time Travel bookmark policy

A D1 mutation that changes schema or materially changes operational data requires a Time Travel bookmark captured immediately before the mutation.

Required receipt fields:

- database name / ID;
- bookmark;
- canonical GitHub SHA authorizing the operation;
- intended migration or mutation;
- pre-change migration ledger summary;
- pre-change FK result;
- post-change migration ledger summary;
- post-change FK result.

Do not create bookmarks merely for read-only queries or Web deployments that do not mutate D1.

Current baseline bookmarks at establishment of this runbook:

- Dev Control: `00000092-00000000-000050cc-b37f38a5a50dc91e0c867a3262a92880`
- Dev Store 01 latest after the 0020 drift repair: `00000093-00000002-000050cc-1a2bba69043618b38bcee7477cb96982`
- Production Control: `00000004-00000000-000050cc-32664e1e593eb94eb89c8d945acb6c6d`
- Production Store 01: `00000004-00000000-000050cc-9ac8bfc3265aeb3548caaa05429c82a7`
- Production Store 02: `00000004-00000000-000050cc-e20d37b1fac97c03632902f186c98ead`
- Production Store 03: `00000004-00000000-000050cc-7c3c37c5efac47974acf7518794896f5`
- Production Store 04: `00000004-00000000-000050cc-7e950db6b0eeca577ff518f8781e133d`

Bookmarks are operational receipts, not permanent identifiers. Capture a fresh bookmark before a future mutation.

## 5. D1 rollback procedure

Use rollback only for a confirmed migration/data incident. Prefer roll-forward for ordinary application-code defects.

For a D1 incident:

1. stop further D1 mutation paths associated with the incident;
2. identify the exact pre-change Time Travel bookmark from the operation receipt;
3. verify the affected database ID and intended recovery point;
4. execute recovery only against the affected database;
5. re-run the full migration ledger check;
6. run `PRAGMA foreign_key_check`;
7. re-run relevant domain counts/invariants;
8. correlate the recovered database state with the canonical application version;
9. record recovery evidence and the reason.

Do not improvise destructive `DOWN` SQL when a known Time Travel recovery point exists. Do not use rollback to bypass a failed migration gate.

For a Web-only application regression, deploy a previously accepted canonical commit through the correct environment-specific manual trigger; do not mutate D1 merely to compensate for Web code.

## 6. R2 read-only health baseline

Operational R2 health checks are read-only inventory/metadata checks:

- bucket exists;
- object inventory is readable;
- expected object key/size/content metadata is internally consistent when an object is expected;
- no unexpected Production object appears after a Web-only deployment.

Current baseline:

- Dev bucket `ads-ops-data-dev` exists and contains the synthetic acceptance source object only.
- Production bucket `ads-ops-data-prod` exists and is empty.
- The June `202606 (1).csv` exact source bytes are not present in Dev R2.

R2 metadata, filename similarity, historical hashes, or transformed warehouse bytes are not sufficient evidence to upgrade CSV provenance. Exact-source reconciliation requires the exact original bytes plus full deterministic reconciliation.

## 7. Worker observability baseline

Read-only Worker health checks should inspect:

- latest deployment ID;
- 100% active version ID;
- version metadata and Worker identity;
- environment bindings;
- runtime flags;
- schedules;
- exact-main Build metadata;
- error/log telemetry when available.

Never use an Amazon request as a liveness check.

Web-only analytics/UI changes should not cause Sync Worker deployment/version churn. Sync redeployment is justified only by changes to sync-worker code, workflow classes, sync bindings/config, or the Amazon transport safety contract.

## 8. Production Access drift check

Expected Production Access application:

- app ID: `499b5470-a257-4aec-9ede-7c3a460a42a4`
- domain: `ads-operations-web-prod.tanshiyuesir.workers.dev`
- AUD: `4cb87cb838507ac2e774cff9fdb6f53c6bbd2bc2db1ab0d9a2d1e04a9e5b1da8`
- policy: `Allow account owner for production access`
- decision: `allow`

For each Production Web rollout, verify the Worker `ACCESS_AUD` equals the Access app AUD and `ACCESS_MODE=enforce` remains active.

Do not create a service token or bypass policy solely for acceptance testing.

## 9. Analytics operational acceptance

CSV analytics is accepted only when all of these remain true:

- fact source is `csv_business_search_term_daily` or an equivalent explicit business-authority join;
- `acceptance` and `unclassified` imports are excluded;
- legacy business provenance may enter analytics but not recommendation/review;
- ratios are derived from aggregated integer metrics;
- zero denominators are represented explicitly as unavailable/null;
- absent comparison data is represented as unavailable, not 0%;
- observed CSV IDs remain non-canonical;
- response metadata explains imports, provenance, fact count, date range, marketplace/currency, analytics eligibility, and recommendation eligibility;
- no analytics acceptance sends an Amazon network request.

## 10. Incident rule

When drift is found, determine whether it is:

- code/deployment drift;
- binding/config drift;
- migration-ledger drift;
- actual schema drift;
- data-plane drift;
- Access drift;
- R2 inventory drift.

Repair only the proven drift surface. Do not re-run unrelated migrations, bootstrap data, provision credentials, or redeploy Sync merely to make version numbers look uniform.
