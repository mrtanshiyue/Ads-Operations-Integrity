# Cloudflare-native Ads Operations Web

This directory is the clean-slate frontend runtime for Ads Operations Integrity.

The existing GitHub Pages application remains untouched while this implementation is built and validated in parallel.

## Runtime boundary

```text
Operator browser
      |
      v
Cloudflare Access
      |
      v
ads-operations-web
Worker + Static Assets
      |
      | private Service Binding
      v
amazon-ops-api
(Amazon-Data-Warehouse repo)
```

## Principles

1. No browser connection to D1, R2, R2 SQL, Pipelines, Queues or Amazon APIs.
2. No shared dashboard password.
3. No public warehouse hostname is required for normal application operation.
4. No CORS dependency between frontend and warehouse because browser API calls are same-origin.
5. Access establishes identity; the application maps that identity to store/role permissions.
6. The browser receives only the data needed for the current screen.
7. Large exports are generated server-side and delivered as authorized R2-backed downloads.
8. Existing business logic is migrated module-by-module, not copied as another monolithic HTML file.

## Web Worker responsibilities

- serve SPA static assets
- validate Cloudflare Access identity context
- same-origin `/api/*` BFF routes
- pass authenticated user context to `amazon-ops-api` through Service Binding
- apply response security headers
- normalize client-facing errors
- never store Amazon credentials or warehouse secrets

## Warehouse responsibilities

The frontend does not reproduce warehouse logic. Source lineage, data readiness, query governance, Amazon synchronization, ingestion and authorization decisions belong to `amazon-ops-api`.

## Frontend structure

Target application structure:

```text
cloudflare-web/
  src/
    worker.ts                 same-origin BFF
    app/
      shell/
      routes/
      components/
      features/
        overview/
        products/
        keywords/
        listings/
        marketing/
        operations/
        analytics/
        settings/
      data/
        api-client.ts
        query-keys.ts
        contracts.ts
      state/
      styles/
  public/
  wrangler.template.jsonc
```

The old `index.html`/generated inline script system is not the target architecture.

## Data access model

Primary dashboard requests are bounded and aggregate-first:

```text
GET /api/bootstrap
GET /api/overview?store=...&from=...&to=...
GET /api/ads/campaigns?...pagination...
GET /api/ads/targets?...pagination...
GET /api/ads/search-terms?...pagination...
GET /api/products?...pagination...
GET /api/finance?...
GET /api/inventory?...
GET /api/data-coverage
```

Deep analysis/export is job-oriented:

```text
POST /api/exports
GET  /api/jobs/{id}
GET  /api/exports/{id}/download
```

The browser does not download every historical raw file to calculate the default dashboard.

## Authentication and authorization

Cloudflare Access protects the application hostname. The Web Worker extracts verified Access identity and sends only normalized identity context to the warehouse Service Binding.

The warehouse D1 control database owns application authorization:

```text
Access subject/email -> user -> store role -> API permission
```

Role checks are server-side. Hidden UI controls are a usability feature, never the authorization boundary.

## Deployment

The target is Workers Static Assets, not GitHub Pages.

A frontend deployment ships Worker logic and static assets as one Cloudflare deployment unit. GitHub remains source control/CI only.

## Migration rule

Do not port the current million-line generated script wholesale.

For each feature:

1. identify its business contract and user interaction
2. define the new API contract
3. implement the feature as an isolated module
4. verify output parity where parity is meaningful
5. remove the old module dependency only after acceptance

Historical UI bugs and obsolete data-loading workarounds are not requirements.
