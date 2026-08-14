# API Boundaries V1

## Public web Worker

All browser access is authenticated by Cloudflare Access and authorized again by application RBAC.

Implemented foundation routes:

```text
GET    /api/health
GET    /api/v1/session
GET    /api/v1/stores
GET    /api/v1/capabilities
GET    /api/v1/stores/:storeId/health
POST   /api/v1/stores/:storeId/sync
GET    /api/v1/stores/:storeId/sync/:instanceId
GET    /api/v1/system/health
```

Planned business route families:

```text
GET    /api/v1/products
POST   /api/v1/products
PATCH  /api/v1/products/:productId

GET    /api/v1/keywords
POST   /api/v1/keywords
PATCH  /api/v1/keywords/:keywordId
GET    /api/v1/negative-keywords
POST   /api/v1/negative-keywords

GET    /api/v1/analytics/overview
GET    /api/v1/analytics/products
GET    /api/v1/analytics/keywords

GET    /api/v1/stores/:storeId/campaigns
GET    /api/v1/stores/:storeId/ad-groups
GET    /api/v1/stores/:storeId/keywords
GET    /api/v1/stores/:storeId/targets
GET    /api/v1/stores/:storeId/search-terms
GET    /api/v1/stores/:storeId/products

POST   /api/v1/stores/:storeId/actions
GET    /api/v1/stores/:storeId/actions
```

## Authorization invariant

Global and store-scoped roles are never flattened into one authorization set.

- Global roles (`owner`, `admin`) may grant permissions across stores.
- Store roles (`operator`, `analyst`, `viewer`) grant permissions only for the store membership that assigned the role.
- Every store-scoped route must authorize `user_id + store_id + permission_key` before resolving the Store D1 binding.
- A user who has `ads.write` on Store 01 must not inherit `ads.write` on Store 02.
- Starting a sync requires `sync.run`; inspecting that store's sync status requires `sync.read`.

## Routing invariant

The browser never chooses or receives a D1 binding name. It supplies a logical `storeId`; the Worker:

1. verifies the user's permission for that `storeId` in Control D1;
2. loads the store record internally;
3. reads the server-only `d1_binding_key`;
4. resolves it through a fixed binding allowlist;
5. queries the matching Store D1.

Current internal binding names are:

```text
STORE_01_DB -> ads-ops-store-01-prod
STORE_02_DB -> ads-ops-store-02-prod
STORE_03_DB -> ads-ops-store-03-prod
STORE_04_DB -> ads-ops-store-04-prod
```

Unrecognized or missing bindings fail closed as `store_db_unavailable`. Binding identifiers are not returned to the browser.

## Sync Worker boundary

The sync Worker owns the durable Amazon Ads synchronization workflow. The target production responsibilities are OAuth exchange, report creation/polling/download, R2 writes, parsing, D1 UPSERTs, rollup generation, and optimization mutations.

The web Worker binds directly to the Workflow defined in the isolated sync Worker by using a cross-script Workflow binding. Browser code never receives Amazon refresh tokens, client secrets, Workflow credentials, or internal D1 binding names.

The current foundation is deliberately inert:

```text
web:  SYNC_TRIGGER_ENABLED=false
sync: AMAZON_ADS_ENABLED=false
```

Both flags are enforced by the deployment validator. No Workflow schedule is configured. The Amazon adapter must not be enabled until OAuth, report adapters, R2 ingestion, remote idempotency tests, and production review are complete.

## Sync trigger idempotency

`POST /api/v1/stores/:storeId/sync` requires an `Idempotency-Key` header.

The Worker derives a deterministic Workflow instance ID from:

```text
storeId
+ profileId
+ startDate
+ endDate
+ sorted datasets
+ Idempotency-Key
```

The digest becomes a `sync-<sha256>` Workflow instance ID. A repeated request with the same logical inputs and key reuses the existing `sync_runs`/Workflow instance rather than creating a second synchronization job.

Before triggering the Workflow, the web Worker also:

1. checks `sync.run` for the specific store;
2. resolves the Store D1 internally;
3. verifies the Amazon profile is active in that Store D1;
4. inserts the matching `sync_runs` ledger row;
5. creates the Workflow instance with the deterministic ID;
6. records a Control D1 audit event.

Status lookup first verifies that the `instanceId` exists in the requested Store D1's `sync_runs` table before querying the Workflow binding. This prevents a user authorized for one store from using the status API to inspect another store's Workflow instance.

## Canonical sync datasets

The foundation currently accepts only these normalized destinations:

```text
campaign_daily
ad_group_daily
keyword_daily
target_daily
search_term_daily
advertised_product_daily
purchased_product_daily
placement_daily
```

Amazon report-type names are adapter details. The API and downstream BI layer operate on these canonical dataset keys.

## Amazon mutation pattern

Amazon-changing operations follow this sequence:

1. Authenticate Cloudflare Access identity.
2. Check `user_id + store_id + permission_key`.
3. Validate requested mutation against policy/rule constraints.
4. Create `optimization_actions` row with a unique idempotency key.
5. Apply Amazon API mutation server-side.
6. Persist external request/result metadata.
7. Append `optimization_action_events` entry.
8. Refresh the affected entity from Amazon.

A browser retry must return/reuse the same logical action rather than duplicate the external mutation.

## Pagination

List endpoints use cursor pagination. Avoid large offset scans on fact tables. Date-range analytics requires explicit start/end dates and hard server-side maximum ranges per endpoint.

## Error contract

API errors return a stable machine code plus request ID. Never expose raw Amazon authorization responses, SQL text, token content, D1 binding identifiers, Workflow internals, or stack traces to the browser.
