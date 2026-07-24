# Cloud Warehouse V4 Canary Plan

## Safety boundary

The production application continues to use the existing V3 Worker. Do not change the production API origin until the R2 + TiDB Worker has passed every comparison below.

## Prerequisites

- V4 health endpoint returns a version beginning with `4.`
- One advertising report has imported successfully
- One combined transaction report has imported successfully and is redacted
- The V4 manifest exposes the same store, month, report-type, and data-type contract as V3

## Contract comparison

Run from a trusted local environment:

```bash
V4_ORIGIN=https://<new-v4-worker>.workers.dev \
WAREHOUSE_PASSWORD=<password> \
SCOPE=YTDBNS \
node scripts/compare-warehouse-v3-v4.mjs
```

For a full byte comparison of non-transaction reports:

```bash
FULL_COMPARE=true \
V4_ORIGIN=https://<new-v4-worker>.workers.dev \
WAREHOUSE_PASSWORD=<password> \
SCOPE=YTDBNS \
node scripts/compare-warehouse-v3-v4.mjs
```

Transaction files are not expected to be byte-identical because V4 sanitizes them once during ingestion. Their row counts and business totals must still match.

## Acceptance sequence

1. Compare one file.
2. Compare one store and one month.
3. Compare all files for one store.
4. Compare `ALL` scope.
5. Test all dashboard modules on the feature branch.
6. Keep V3 available as immediate fallback.
7. Change the production API origin only after acceptance.

## Required business reconciliation

For the selected month, verify exact equality for:

- advertising spend
- advertising sales
- advertising orders
- transaction sales
- refunds
- Amazon fees
- calculated operating profit

A missing report, unexplained row-count difference, or unexplained financial difference blocks the cutover.

## Rollback

If a canary test fails, leave the production front end on V3. No data needs to be restored because the V4 service is parallel and the original GitHub-backed warehouse remains unchanged.
