# Cloudflare Native Data Pipeline V1

This document defines the Cloudflare-native data path for Ads Operations Integrity. It is independent of the repository's previous database/deployment path.

## 1. Source-of-truth layers

```text
Amazon Ads API / report files
        |
        v
R2 raw objects                     immutable/replayable source
        |
        v
Per-store D1                       store-scoped operational source of truth
  campaigns / ad_groups / keywords / targets
  campaign_daily / keyword_daily / search_term_daily / ...
        |
        +------------------------------+
        |                              |
        v                              v
Store read APIs                 deterministic rollups
/api/v1/stores/:id/*                   |
                                       v
                                  Control D1
                                  store_daily_summary
                                  product_daily_summary
                                  keyword_performance_rollup
                                  store_sync_status
                                  rollup_runs
                                  rollup_watermarks
                                       |
                                       v
                              Cross-store analytics APIs
                              /api/v1/analytics/*
                                       |
                                       v
                         CloudflareNativeAPI / Query Bridge
                                       |
                                       v
                                 Existing browser UI
```

The browser never queries D1 directly and never receives a D1 binding name.

## 2. Current native browser migration boundary

The Cloudflare-native build injects:

```text
assets/cloudflare-native-api-v1.js
assets/cloudflare-native-query-bridge-v1.js
```

and removes the previous browser Query Client script reference from the built artifact only. Source `index.html` remains unchanged for rollback.

The native bridge exposes the compatibility name `window.PrivateCloudQuery` so existing ads/overview modules can migrate without rewriting the large legacy UI bundle.

Current bridge coverage:

| Capability | Native D1 status | Notes |
|---|---|---|
| Ads/search-term analytical rows | Enabled | Reads store search-term APIs |
| Overview trend | Enabled | Reads Control D1 analytics overview |
| Store/campaign/ad-group/keyword/target lists | Enabled via `CloudflareNativeAPI` | Same-origin APIs |
| Cross-store product analytics | Enabled via `CloudflareNativeAPI` | Reads Control rollup |
| Cross-store keyword analytics | Enabled via `CloudflareNativeAPI` | Reads Control rollup |
| Data freshness/quality | Enabled via `analytics/data-health` | Reads sync status + rollup watermarks |
| Transactions / financial settlement | Not migrated | Native Query Bridge deliberately returns 501 |
| Amazon mutation / bid changes | Disabled | Requires completed Ads API adapter and explicit kill-switch enablement |

## 3. Query Bridge governance

The compatibility bridge must not manufacture data that the Store D1 API does not currently provide.

Therefore bridge-generated ad rows intentionally use:

```text
currentBid = null
targetBid = null
bidValueTrusted = false
governanceReady = false
```

and governance readiness remains false for:

```text
targetingIdentityReady
bidSourceColumnReady
bidValueNullabilityTrusted
adProductReady
advertisedProductIdentityReady
attributionMaturityReady
bidGovernanceReady
campaignStudioReady
```

This keeps analytical browsing available while preventing incomplete identity/bid data from being treated as safe automation input.

## 4. Store daily rollup

`refreshStoreDailySummary()` reads `campaign_daily` from one Store D1 and aggregates by:

```text
report_date + ad_product
```

For the requested date window, Control D1 performs a transaction batch containing:

```text
DELETE old rows for store/date window
INSERT replacement rows
```

The operation is idempotent: re-running the same date window replaces, rather than adds to, the previous rollup.

## 5. Product daily rollup

`refreshProductDailySummaryDate()` processes one report date at a time.

Source:

```text
Store D1 advertised_product_daily
```

Mapping priority:

```text
1. seller SKU
2. ASIN fallback
```

Destination:

```text
Control D1 product_daily_summary
```

Mapping policy is fail-closed:

- one SKU/ASIN -> one product: include;
- no mapped product: skip and increment `unmappedRows`;
- one identifier maps to multiple product IDs: skip and increment `ambiguousRows`;
- never choose a product arbitrarily.

Each date is replaced transactionally and is safe to retry.

## 6. Keyword performance rollup

`refreshKeywordPerformanceRollupPartition()` aggregates Store D1 `keyword_daily` over a supported window:

```text
7 / 14 / 30 / 60 / 90 / 180 / 365 days
```

Store keyword identity is normalized with `keywords.normalized_keyword` and mapped to Control D1 `keyword_library.normalized_term + language_code`.

The function accepts a normalized-term prefix partition. Production Workflows should split a large keyword corpus into bounded partitions instead of one unbounded D1 invocation.

Unmapped or ambiguous normalized terms are counted and excluded from trusted rollups.

## 7. D1 batch/query guard

Foundation rollup code caps a single transactional write batch at 900 statements. This leaves headroom below the platform invocation query limit and prevents a large product/keyword corpus from being forced into one Worker step.

Large rollups must be partitioned by date or keyword prefix and executed as multiple durable Workflow steps.

## 8. Rollup observability

Every production rollup step should be wrapped with `observedRollup()`.

Lifecycle:

```text
insert rollup_runs(status=running)
        |
        v
execute deterministic rollup
        |
        +-- success --> update rollup_runs(succeeded)
        |               + upsert rollup_watermarks in one Control D1 batch
        |
        +-- failure --> update rollup_runs(failed, error_code)
```

Watermarks carry:

```text
last successful date/as-of date
summary row count
unmapped row count
ambiguous row count
last successful run ID
updated timestamp
```

The browser reads these through:

```text
GET /api/v1/analytics/data-health
```

so BI freshness and data quality are queryable application state rather than log-only diagnostics.

## 9. Sync integration order

The Amazon Ads adapter is still disabled. When it is implemented, each successful ingestion Workflow should use this order:

```text
1. Acquire/validate Amazon credentials server-side
2. Request/download report
3. Preserve raw object in R2
4. Parse and UPSERT Store D1 facts
5. Validate ingestion quality
6. Run observed Store rollup
7. Run observed product daily partitions
8. Run observed keyword window partitions
9. Advance Store D1 sync watermark
10. Update Control D1 store_sync_status
```

Do not advance cross-store BI watermarks before Store D1 ingestion is known to be complete.

## 10. Current safety state

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

No Workflow schedule is configured. Native deployment may be tested with these switches disabled, but no Amazon synchronization or mutation should occur until the adapter, credentials, R2 ingestion, remote D1 tests, and explicit production review are complete.
