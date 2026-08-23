# Phase 3 Gate 3.4 — Operator UX / Workflow Convergence

Status: implementation candidate

## Objective

Turn the Gate 3.3 navigation shell into a shared operator workflow without rewriting the existing Product, Keyword, Negative, Operations Health, Audit, or Access consoles.

## Shared context contract

Gate 3.4 introduces `CloudflareOperatorContext` with three advisory selection dimensions:

- `storeId`
- `productId`
- `keywordId`

Authorization remains server-authoritative. Shared context never grants access and never bypasses an individual console's permission checks.

## Convergence behavior

The context bridge:

1. consumes the Gate 3.3 `cloudflare-operator-store-change` event;
2. exposes a product selector backed by the existing global product registry;
3. exposes a keyword selector backed by the existing product-keyword mapping read path;
4. propagates store context to Product Mapping, Negative Governance, Operations Health, Audit, and Access consoles;
5. propagates product context to Product Mapping, Positive Keyword Governance, and Negative Governance;
6. propagates selected keyword text to the positive keyword search surface without overriding operator-entered search text;
7. mirrors console status output into one shared operator-feedback strip;
8. provides one read-only audit-link action scoped to the current store and, when available, the current entity type;
9. displays a permission-derived `manage`, `read-only`, or `locked` workspace mode;
10. preserves tablet and mobile responsive behavior.

## Architectural decision

Context orchestration is isolated in:

`assets/cloudflare-native-operator-context-v1.js`

The existing consoles remain independent business surfaces. No console is made authoritative for cross-console context.

## Fail-closed rules

If capability, product, or keyword catalog reads fail:

- the context selector fails closed;
- no permission is synthesized;
- the existing console remains usable only according to its own server-authoritative permissions;
- no write is performed by the context bridge.

## Deployment boundary

Gate 3.4 does not deploy Cloudflare.

Repository merge is not runtime deployment.

Phase 3 exact-SHA Dev deployment remains Gate 3.5.

## Permanently unchanged

- canonical CI remains validation-only;
- explicit deployment asset allowlist remains explicit;
- dormant Amazon state remains unchanged;
- Production remains not ready;
- Cloud Raw import remains fail closed.
