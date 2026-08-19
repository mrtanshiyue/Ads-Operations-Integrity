# Production Platform Status

## Authority

This document is the current repository contract for Cloudflare Production platform topology.
It supersedes the historical Phase 2 statement that Production was out of scope. Historical
Phase 2 receipts and acceptance evidence remain immutable and continue to describe the state
that existed when those receipts were created.

Production platform provisioning is authorized for non-Amazon capabilities. Amazon API
transport remains hard-disabled until an explicit future authorization changes that constraint.

## Current canonical topology

```text
Web Worker:      ads-operations-web-prod
Sync Worker:     ads-operations-sync-prod (dormant; AMAZON_ADS_ENABLED=false)
Control D1:      ads-ops-control-prod
Store 01 D1:     ads-ops-store-prod-01
Store 02 D1:     ads-ops-store-prod-02
Store 03 D1:     ads-ops-store-prod-03
Store 04 D1:     ads-ops-store-prod-04
R2:              ads-ops-data-prod
```

Canonical D1 IDs are bound in `cloudflare/runtime/wrangler.native.jsonc` and
`cloudflare/runtime/wrangler.sync.jsonc`. Those files, plus runtime discovery, are authoritative
for deployable resource identity; this document is descriptive and must not replace runtime verification.

## Access contract

Production web runtime remains fail-closed with:

```text
ACCESS_MODE=enforce
TEAM_DOMAIN=https://tanshiyuesir.cloudflareaccess.com
ACCESS_AUD=<bound production Access audience>
```

The Access audience is a public application identifier, not a secret. Access policy changes must
remain auditable and recoverable.

## Amazon hard-off contract

```text
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
```

No Amazon credential provisioning, live read, live write, report job, OAuth token exchange,
workflow execution, queue consumer, cron, or dispatcher may issue a network request to Amazon.
The dormant sync Worker may only be deployed when these controls remain false and no Amazon
credentials are provisioned.

## Deployment integrity

Production promotion follows the same provenance principles as Dev:

```text
canonical main
-> required CI success
-> exact commit deployment
-> immutable Worker version
-> active deployment correlation
-> runtime acceptance
-> deployment receipt
```

Production databases must be initialized from canonical migrations, not cloned from Dev. Data
writes must be explicit, auditable, and scoped to the intended Production database.

## Rollback and observability

Before carrying business data, Production must have a clear rollback path, migration state that
can be inspected, Worker deployment/version correlation, and baseline observability. Empty
resource creation by itself does not constitute Production acceptance.