# Cloudflare Native Runtime V1

This runtime is intentionally separate from the repository's previous deployment path.
It deploys the current frontend as Workers Static Assets and reserves `/api/*` for the Worker API.
It does not migrate or depend on TiDB.

## Runtime contract

- Worker: `ads-operations-web-{env}`
- Static assets: `dist-cloudflare-native/`
- API prefix: `/api/*`
- Control D1 binding: `CONTROL_DB`
- Store D1 bindings: `STORE_01_DB` ... `STORE_04_DB`
- Object storage binding: `DATA_BUCKET`
- Authentication: Cloudflare Access + in-Worker JWT validation

`run_worker_first` is scoped to `/api/*`. Normal HTML/JS/CSS asset requests are served by Workers Static Assets without invoking the application API router.

## Development resources

Create only the isolated development resources first:

```bash
npx wrangler d1 create ads-ops-control-dev --location=apac
npx wrangler d1 create ads-ops-store-dev --location=apac
npx wrangler r2 bucket create ads-ops-data-dev --location=apac
```

Copy the two D1 UUIDs into `wrangler.native.jsonc` under `env.dev`.

Do not create production databases until the development schema and API behavior pass validation.

## Apply migrations

Always address D1 migrations by database name, not by binding alias.

```bash
npx wrangler d1 migrations list ads-ops-control-dev \
  --remote --env dev --config cloudflare/runtime/wrangler.native.jsonc

npx wrangler d1 migrations apply ads-ops-control-dev \
  --remote --env dev --config cloudflare/runtime/wrangler.native.jsonc

npx wrangler d1 migrations list ads-ops-store-dev \
  --remote --env dev --config cloudflare/runtime/wrangler.native.jsonc

npx wrangler d1 migrations apply ads-ops-store-dev \
  --remote --env dev --config cloudflare/runtime/wrangler.native.jsonc
```

After migration, run remote checks:

```bash
npx wrangler d1 execute ads-ops-control-dev --remote \
  --command="PRAGMA foreign_key_check; SELECT COUNT(*) AS roles FROM app_roles;"

npx wrangler d1 execute ads-ops-store-dev --remote \
  --command="PRAGMA foreign_key_check; SELECT COUNT(*) AS tables FROM sqlite_master WHERE type='table';"
```

## Build and local validation

```bash
npm ci
npm run build:cf-native
npm run check:cf-native
npm run dev:cf-native
```

Wrangler local development simulates D1/R2 locally by default. Use remote bindings only when a test explicitly requires the remote development database.

## Dev deployment

Before deploying, replace the Access placeholders in `env.dev.vars`:

- `TEAM_DOMAIN`
- `ACCESS_AUD`

Then:

```bash
npm run deploy:cf-native:dev
```

Validate:

- `/api/health`
- `/api/v1/session`
- `/api/v1/stores`
- `/api/v1/capabilities`
- current frontend asset loading

Keep `ACCESS_MODE=observe` until the Access application is confirmed to inject valid JWTs. Change development to `enforce` only after validation. Production is always `enforce`.

## Production gate

Production provisioning is blocked until all of the following are true:

1. Dev Control D1 migrations pass.
2. Dev Store D1 migrations pass.
3. `PRAGMA foreign_key_check` returns no rows.
4. Duplicate-ingestion/UPSERT tests pass remotely.
5. Cloudflare Access identity maps to a pre-provisioned app user.
6. Store authorization prevents a user from querying a store they do not belong to.
7. R2 raw-object path and retention rules are validated.
8. Workers preview deployment passes browser regression testing.

Only then create `ads-ops-control-prod`, the four production store databases, and `ads-ops-data-prod`.
