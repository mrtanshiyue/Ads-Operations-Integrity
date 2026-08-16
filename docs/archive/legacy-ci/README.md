# Retired granular CI workflows

These workflows were retired during Architecture Convergence Phase 0 after their deterministic test coverage was absorbed by `.github/workflows/cloudflare-native-canonical-ci.yml`.

Retired from active GitHub Actions paths:

- `cloudflare-access-governance-ci.yml`
- `cloudflare-amazon-report-transport-ci.yml`
- `cloudflare-foundation-ci.yml`
- `cloudflare-gate24-ci.yml`
- `cloudflare-gate25-ci.yml`
- `cloudflare-gate26-ci.yml`
- `cloudflare-gate27-ci.yml`

The archived files are exact historical workflow blobs. They are not active CI definitions.

Important: the former Amazon report transport workflow contained push-triggered `promote-dev-trigger` and exact disabled Dev smoke jobs. Those execution jobs were intentionally not copied into Canonical CI. Canonical CI retains only deterministic, non-deploying regression tests while Amazon API integration remains dormant.
