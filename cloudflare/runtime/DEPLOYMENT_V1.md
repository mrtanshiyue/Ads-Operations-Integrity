# Cloudflare Native Runtime V1

This runtime is intentionally separate from the repository's previous deployment path.
It deploys the current frontend as Workers Static Assets and reserves `/api/*` for the Worker API.
It does not migrate or depend on TiDB.

## Runtime contract

- Web Worker: `ads-operations-web-{env}`
- Sync Worker: `ads-operations-sync-{env}`
- Workflow: `ads-amazon-sync-{env}`
- Static assets: `dist-cloudflare-native/`
- API prefix: `/api/*`
- Control D1 binding: `CONTROL_DB`
- Store D1 bindings: `STORE_01_DB` ... `STORE_04_DB`
- Object storage binding: `DATA_BUCKET`
- Authentication: Cloudflare Access + in-Worker JWT validation

`run_worker_first` is scoped to `/api/*`. Normal HTML/JS/CSS asset requests are served by Workers Static Assets without invoking the application API router.

D1 binding names are server-only implementation details. They are never returned by store-list or health APIs.

The web Worker binds to the Workflow class exported by the sync Worker. Deploy the sync Worker before the web Worker.

## Development provisioning

The preferred path is the idempotent dev-only provisioner:

```bash
npm ci
npm run provision:cf-native:dev:dry
npm run provision:cf-native:dev
```

`provision:cf-native:dev` has a fixed allowlist and refuses production provisioning. It:

1. lists the account's D1 databases;
2. reuses exact-name development databases if they already exist;
3. creates only `ads-ops-control-dev` and `ads-ops-store-dev` when absent, with the `apac` location hint;
4. reuses or creates only `ads-ops-data-dev` in R2;
5. resolves the D1 UUIDs and updates the dev D1 IDs in both `wrangler.native.jsonc` and `wrangler.sync.jsonc`;
6. applies Control and Store migrations remotely;
7. runs `PRAGMA foreign_key_check` against both remote D1 databases.

The provisioner deliberately cannot create any resource whose name ends in `-prod`.

### Manual fallback

If provisioning must be performed manually:

```bash
npx wrangler d1 create ads-ops-control-dev --location=apac
npx wrangler d1 create ads-ops-store-dev --location=apac
npx wrangler r2 bucket create ads-ops-data-dev --location=apac
```

Copy the returned D1 UUIDs into both runtime configs under `env.dev`, then apply migrations by database name:

```bash
npx wrangler d1 migrations apply ads-ops-control-dev \
  --remote --env dev --config cloudflare/runtime/wrangler.native.jsonc

npx wrangler d1 migrations apply ads-ops-store-dev \
  --remote --env dev --config cloudflare/runtime/wrangler.native.jsonc
```

Verify both databases:

```bash
npx wrangler d1 execute ads-ops-control-dev --remote --yes \
  --command="PRAGMA foreign_key_check; SELECT COUNT(*) AS roles FROM app_roles;"

npx wrangler d1 execute ads-ops-store-dev --remote --yes \
  --command="PRAGMA foreign_key_check; SELECT COUNT(*) AS tables FROM sqlite_master WHERE type='table';"
```

Do not create production databases until the development schema and API behavior pass validation.

## Bootstrap the development owner and store route

Use `cloudflare/foundation/bootstrap/seed_dev_control.sql.template` only after replacing:

- `REPLACE_OWNER_EMAIL`
- `REPLACE_OWNER_NAME`

The template creates one pre-provisioned owner and one logical development store whose internal route is `STORE_01_DB`.

Execute the rendered file against `ads-ops-control-dev`; do not commit the rendered file if it contains a real email address.

## Build and local validation

```bash
npm ci
npm run test:cf-foundation
npm run build:cf-native
npm run check:cf-native
npm run validate:cf-native:dev
```

For local processes:

```bash
npm run dev:cf-sync
npm run dev:cf-native
```

The validator cross-checks both runtime configs. A web/sync D1 UUID mismatch, R2 mismatch, Workflow name mismatch, class mismatch, or cross-script binding mismatch fails validation.

## Safety state before Amazon integration

Both sync controls must remain disabled during foundation deployment:

```text
wrangler.native.jsonc: SYNC_TRIGGER_ENABLED=false
wrangler.sync.jsonc:   AMAZON_ADS_ENABLED=false
```

The validator fails if either flag is enabled. No Workflow schedule is configured.

This allows the sync Worker and Workflow definition to be deployed and inspected without permitting Amazon API calls or user-triggered synchronization.

## Dev deployment

After provisioning, the D1 UUIDs are already populated. Configure the remaining web Access values under `env.dev`:

- `TEAM_DOMAIN`
- `ACCESS_AUD`

Then deploy the stack in dependency order:

```bash
npm run deploy:cf-stack:dev
```

That command validates/tests once, deploys `ads-operations-sync-dev` first, then deploys `ads-operations-web-dev` with its cross-script Workflow binding.

Validate in this order:

1. Sync Worker `/health`
2. Web Worker `GET /api/health`
3. `GET /api/v1/session`
4. `GET /api/v1/stores`
5. `GET /api/v1/capabilities`
6. `GET /api/v1/stores/store-dev-01/health`
7. `GET /api/v1/system/health` as owner
8. current frontend asset loading
9. confirm `POST /api/v1/stores/store-dev-01/sync` returns `sync_trigger_disabled`

The store health route validates the complete routing chain: Access identity -> Control D1 app user -> store permission -> internal binding lookup -> Store D1 query.

Keep `ACCESS_MODE=observe` until the Access application is confirmed to inject valid JWTs. Change development to `enforce` only after validation. Production is always `enforce`.

## Production gate

Production provisioning is blocked until all of the following are true:

1. Dev Control D1 migrations pass.
2. Dev Store D1 migrations pass.
3. `PRAGMA foreign_key_check` returns no rows.
4. Duplicate-ingestion/UPSERT tests pass.
5. Cloudflare Access identity maps to a pre-provisioned app user.
6. Store authorization prevents a user from querying a store they do not belong to.
7. Store APIs never return internal D1 binding identifiers.
8. R2 raw-object path and retention rules are validated.
9. Sync Worker and cross-script Workflow binding deploy with both kill switches disabled.
10. Workers preview deployment passes browser regression testing.
11. Amazon OAuth/secrets design passes review before either sync kill switch can be changed.
12. `node scripts/validate-cloudflare-native.mjs --env production --require-ready` passes.

Only then create `ads-ops-control-prod`, the four production store databases, and `ads-ops-data-prod`.
