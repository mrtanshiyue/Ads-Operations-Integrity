# Frontend cutover gates

The Cloudflare-native Web runtime does not replace the current production frontend until:

- Cloudflare Access application/policies are live for approved users.
- `ads-operations-web` Worker is deployed with Static Assets and private `WAREHOUSE` Service Binding.
- Warehouse `/api/bootstrap`, `/api/data-coverage`, `/api/overview` and required feature APIs are production-accepted.
- No shared password or cross-origin Warehouse URL remains in the new application.
- Each migrated UI module has functional and data-output acceptance coverage.
- Error, loading, empty-data and permission-denied states are explicit.
- Large historical operations use asynchronous export/job APIs rather than browser-side full-history calculation.
- Security headers and Access JWT verification smoke checks pass.
- Rollback to the current frontend remains available until final acceptance.
