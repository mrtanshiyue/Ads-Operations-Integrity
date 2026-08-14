# API Boundaries V1

## Public web Worker

All browser access is authenticated by Cloudflare Access and authorized again by application RBAC.

Suggested route families:

```text
GET    /api/v1/session
GET    /api/v1/stores
GET    /api/v1/stores/:storeId/status

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
POST   /api/v1/stores/:storeId/sync
GET    /api/v1/stores/:storeId/sync/:runId
```

## Routing invariant

The browser never chooses a D1 binding name. It supplies a logical `storeId`; the Worker loads the authorized store from Control D1 and maps that store to a fixed server-side binding allowlist.

Example server-side mapping concept:

```text
STORE_DB_01 -> ads-ops-store-01-prod
STORE_DB_02 -> ads-ops-store-02-prod
STORE_DB_03 -> ads-ops-store-03-prod
STORE_DB_04 -> ads-ops-store-04-prod
```

Unrecognized bindings fail closed.

## Sync Worker boundary

The sync Worker is not a general public API. It owns Amazon Ads OAuth exchange, report creation/polling/download, R2 writes, parsing, D1 UPSERTs, rollup generation, and optimization mutations.

The web Worker invokes sync operations through a Cloudflare service binding or Workflow binding. Browser code never receives Amazon refresh tokens or client secrets.

## Mutation pattern

Amazon-changing operations follow this sequence:

1. Authenticate Cloudflare Access identity.
2. Check store membership and permission.
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

API errors should return a stable machine code plus request ID. Never expose raw Amazon authorization responses, SQL text, token content, D1 binding identifiers, or stack traces to the browser.
