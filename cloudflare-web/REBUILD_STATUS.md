# Cloudflare-native frontend rebuild status

Status: implementation branch only; production GitHub Pages remains unchanged.

## Completed baseline

- Cloudflare Workers Static Assets target defined.
- Same-origin `/api/*` BFF boundary defined.
- Private Service Binding to `amazon-ops-api` defined.
- Cloudflare Access JWT signature/issuer/audience/time validation implemented.
- Access JWKS key rotation retry implemented.
- Browser-supplied internal identity headers are stripped before trusted identity is injected.
- Shared dashboard password and cross-origin Warehouse dependency are not part of the new runtime.
- Security response headers added.
- CI validates syntax and prevents legacy backend/database secrets from entering the frontend boundary.

## Not yet production-ready

- Existing UI modules have not yet been migrated into the new modular application shell.
- Access application/domain values are still placeholders.
- The backend Service Binding is not deployed yet.
- No production hostname has been switched.

## Production gate

Do not replace GitHub Pages until the Cloudflare-native backend has verified historical data, D1 Serving snapshots, Access user/store roles, and feature-level UI parity for the agreed operational modules.
