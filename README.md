# Ads Operations Integrity

A browser-based Amazon advertising operations, business analytics, and decision-support workspace.

The application is delivered as a static single-page site through GitHub Pages. Protected business data remains in a separate private repository and is accessed through an authenticated Cloudflare Worker.

> Application version: `V61.5.4.7`  
> Live application: <https://mrtanshiyue.github.io/Ads-Operations-Integrity/>

## Overview

Ads Operations Integrity consolidates advertising reports, transaction reports, and business reports into one analytical workspace.

The project is designed to:

- Standardize advertising, transaction, and business metrics
- Support multi-month and high-volume report imports
- Isolate analytical data by store scope
- Connect data ingestion, governance, analysis, and execution planning
- Keep public application code separate from private operational data

## Core Capabilities

### Data ingestion and governance

- Local CSV, XLSX, and XLS imports
- Authenticated private-cloud loading
- Advertising, transaction, and business report detection
- Header normalization and date standardization
- Duplicate detection and row quarantine
- File-level import diagnostics
- Batched downloads and deferred finalization for large datasets

### Advertising operations

- Portfolio, campaign, ad group, targeting, and search-term filtering
- Mature-attribution and pending-attribution separation
- ACOS, ROAS, CPC, CTR, CVR, order, and sales analysis
- Keyword, search-term, root-term, and long-tail analysis
- Bid governance and negative-targeting recommendations
- Advertising structure indexing and execution controls

### Business and financial analysis

- Executive business overview
- Advertising-sales and transaction-sales reconciliation
- Refund, fee, settlement, and operating-profit analysis
- Transaction finance reporting
- Product cost integration
- Actual operating-cost and profit adjustments

### Multi-store analysis

The interface supports an aggregate scope and individual store scopes.

Store display labels and internal store identifiers are intentionally not documented in this public repository. Internal identifiers must remain consistent across:

- The private warehouse directory structure
- Cloudflare Worker configuration
- Manifest responses
- Front-end scope mapping

Do not rename internal store identifiers without updating the complete data pipeline.

## Architecture

```text
Browser / GitHub Pages
        │
        │ HTTPS + authenticated request header
        ▼
Cloudflare Worker
        │
        │ GitHub API + private repository token
        ▼
Private Data Warehouse
        │
        ├─ raw/<STORE_CODE>/
        ├─ raw/<STORE_CODE>/
        └─ raw/<STORE_CODE>/
```

### Repository boundary

| Repository type | Visibility | Purpose |
|---|---|---|
| Application repository | Public | Front-end application, deployment configuration, and maintenance utilities |
| Data warehouse repository | Private | Raw advertising, transaction, and business reports |

Never commit business reports, order records, passwords, GitHub tokens, or Cloudflare credentials to this public repository.

## Private-Cloud Loading Pipeline

The current loading process is designed for large multi-file datasets:

1. The browser performs a Worker health check
2. The Worker returns a dynamic manifest for the active store scope
3. Files are downloaded in batches of four
4. Standard advertising reports are streamed through the Worker
5. Transaction reports are sanitized before being returned to the browser
6. Intermediate batches are parsed and appended without full recalculation
7. The final batch performs deduplication, indexing, aggregation, filtering, and rendering
8. Business and transaction-finance modules are updated after finalization

The access password is stored only in the current browser tab through `sessionStorage`.

## Data File Convention

Files in the private warehouse must follow this path format:

```text
raw/<STORE_CODE>/<YYYY-MM>-<REPORT_TYPE>.csv
```

Supported examples:

```text
2026-06-advertising-report.csv
2026-06-combined-report.csv
2026-06-business-report.csv
2026-06-ads-search-term.csv
2026-06-ads-targeting.csv
2026-06-ads-campaign.csv
2026-06-ads-advertised-product.csv
2026-06-ads-placement.csv
```

Requirements:

- Use `YYYY-MM` for the reporting month
- Use `.csv` or `.tsv` as the file extension
- Do not use duplicate extensions
- Do not add temporary suffixes to production files
- Use only registered report-type names
- Use the configured internal store identifier for the directory name

Invalid example:

```text
2026-06-combined-reportcsv.csv
```

## Online Usage

Open the application:

<https://mrtanshiyue.github.io/Ads-Operations-Integrity/>

Typical workflow:

1. Select an analysis scope
2. Click **Load Private Cloud Data**
3. Enter the private warehouse access password
4. Wait for all download and import batches to finish
5. Apply date and business filters
6. Review advertising, business, and transaction-finance modules

Do not refresh the page, switch scopes, or allow the computer to sleep during a large import.

## Local Development

The project is a static single-page application and does not require a front-end build framework.

```bash
git clone https://github.com/mrtanshiyue/Ads-Operations-Integrity.git
cd Ads-Operations-Integrity
python3 -m http.server 8000
```

Open:

```text
http://localhost:8000
```

The local origin must be included in the Worker allowlist before private-cloud access can be tested locally.

## GitHub Pages Deployment

Primary deployment workflow:

```text
.github/workflows/pages.yml
```

Deployment rules:

- `main` is the source branch
- Changes to `index.html` trigger the deployment workflow
- Inline JavaScript is extracted and syntax-checked before publication
- `gh-pages` is an automatically generated deployment branch
- Do not edit `gh-pages` manually

Updating `README.md` does not change the deployed application.

## Key Files

```text
index.html
├─ Application layout and interface
├─ Data parsing and normalization
├─ Advertising and business analysis engines
├─ Transaction finance reporting
└─ Front-end state and rendering logic

assets/private-cloud-warehouse-v3.js
└─ Private-cloud connection, batching, retry, and scope-loading logic

.github/workflows/pages.yml
└─ GitHub Pages validation and deployment

scripts/
└─ Targeted diagnostics, repairs, and maintenance utilities
```

## Large-Dataset Design Rules

The current implementation includes safeguards for large files and high row counts:

- Standard advertising CSV files are streamed through the Worker
- A failed file request is retried up to four times
- The per-file request timeout is four minutes
- Raw batch files are released after import
- Intermediate batches do not repeat full analysis
- Maximum, minimum, and append operations use iterative processing
- Attribution windows are calculated in a single pass

Avoid large-array argument expansion:

```javascript
Math.max(...largeArray);
target.push(...largeArray);
```

Use iteration, chunking, or safe helper functions instead.

## Troubleshooting

### The browser still shows an older version

Close the existing tab and reopen the application, or temporarily add a cache-busting query parameter:

```text
https://mrtanshiyue.github.io/Ads-Operations-Integrity/?v=YYYYMMDD-01
```

Force refresh:

- Windows: `Ctrl + Shift + R`
- macOS: `Command + Shift + R`

### `Failed to fetch`

Check the following:

1. The Cloudflare Worker deployment completed successfully
2. The Worker health endpoint is reachable
3. The private repository token is valid
4. The browser origin is allowed by Worker CORS rules
5. Warehouse filenames follow the required convention
6. Repository validation and deployment Actions have not failed
7. Large non-sensitive reports are using the streaming response path

### `Maximum call stack size exceeded`

This normally indicates that a large array was expanded into function arguments or that full analysis was repeatedly executed during batch loading.

The import error panel reports the active stage, such as:

```text
batch-appended
deduplicate
enrich-and-index
apply-filters
render-transactions
```

Use the reported stage and stack trace to locate the exact function.

### A module is blank or reports `... is not defined`

Check the runtime error indicator in the lower-right corner.

These failures are often caused by helper-function scope errors or missing runtime dependencies. `node --check` validates syntax only; it does not verify browser execution scope.

## Security Requirements

- Never store GitHub or Cloudflare tokens in front-end code
- Never commit raw order records to the public repository
- Never paste passwords into README files, Issues, commits, or logs
- Transaction reports must be sanitized before browser delivery
- Sensitive address fields must be removed
- Order and settlement identifiers must be pseudonymized
- Secrets must be managed through GitHub Actions Secrets and Cloudflare Secrets
- CORS, authentication, and scope changes require regression testing
- Store display names and internal identifiers must not be documented publicly

## Maintenance Checklist

Before releasing a code change, verify:

```text
1. Inline JavaScript syntax validation
2. Private-cloud loading regression test
3. Large-array expansion scan
4. Scope isolation and manifest consistency
5. Transaction finance report runtime test
6. Worker streaming and sanitization tests
7. main and gh-pages deployment consistency
```

Commit messages should identify the affected subsystem, for example:

```text
Fix transaction finance runtime helper scope
Stream large advertising reports through Worker
Defer full analysis until final cloud import batch
```

---

This project supports an internal Amazon advertising and business-analytics workflow. The public repository contains application code only; operational data is maintained separately in a protected private warehouse.
