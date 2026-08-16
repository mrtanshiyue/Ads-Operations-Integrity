# Phase 3 Gate 3.3 — Operator Workspace Navigation Contract

Status: implementation candidate

## Decision

Gate 3.3 uses progressive shell convergence. Existing Cloudflare Native consoles remain authoritative for their domain behavior and API calls. A new `CloudflareOperatorWorkspace` shell becomes the primary operator entry layer and delegates to the existing public `open()` contracts.

This avoids a frontend big-bang rewrite while eliminating the growing header-button entry pattern.

## Information architecture

- Workspace
  - Overview
- Products
  - Product Registry
  - Store SKU / ASIN Mapping
- Keywords
  - Positive Keywords
  - Product Keyword Governance
  - Negative Keywords
- Ads Intelligence
  - Search Terms
  - Targeting
  - Bid Intelligence
- Operations
  - Operations Health
  - Data Health
  - Audit Trail
- Administration
  - Users
  - Store Membership
  - Roles / Access

## Permission contract

Navigation is fail closed. The shell reads the existing Native `capabilities()` and `stores()` contracts, combines global permissions with the selected store permissions, and only enables an entry when its declared permission set is satisfied.

The selected store is operator context only in Gate 3.3. The shell emits `cloudflare-operator-store-change` for future Gate 3.4 cross-console context convergence; it does not mutate backend state.

## Surface delegation

The shell delegates to existing public console contracts:

- `CloudflareProductGovernance.open()`
- `CloudflareKeywordGovernance.open()`
- `CloudflareNegativeGovernance.open()`
- `CloudflareOperationsHealth.open()`
- `CloudflareAuditConsole.open()`
- `CloudflareAccessConsole.open()`

Existing Phase 3 header buttons are retained in code for compatibility but hidden after the workspace mounts. They are not deleted in Gate 3.3.

## UX contract

- Chinese and English labels are defined for every workspace group and entry.
- Locale follows the existing document language / language toggle.
- Desktop keeps the current analytics page and inserts the operator shell into the existing sidebar.
- Tablet and mobile use responsive navigation layouts without rewriting the underlying analytics modules.
- The legacy single-page analytics anchors remain available as a secondary `Page Analytics` group.

## Build and deployment contract

`assets/cloudflare-native-operator-workspace-v1.js` is:

- injected exactly once by the canonical Cloudflare Native build entrypoint;
- present in the explicit deployment asset allowlist;
- guarded by deterministic Gate 3.3 contract assertions during `build:cf-native`, which is already part of `check:cf-native`.

Gate 3.3 performs no Cloudflare deployment. Deployment remains deferred to Gate 3.5 exact-SHA Dev Deployment + Live Acceptance.
