# Cloudflare Native Runtime V1

This runtime is intentionally separate from the repository's previous deployment path.
It deploys the current frontend as Workers Static Assets and reserves `/api/*` for the Worker API.
It does not migrate or depend on TiDB.

## Runtime contract

- Web Worker: `ads-operations-web-{env}`
- Web entry: `cloudflare/runtime/web-entry.js`
- Sync Worker: `ads-operations-sync-{env}`
- Workflow: `ads-amazon-sync-{env}`
- Static assets: `dist-cloudflare-native/`
- API prefix: `/api/*`
- Control D1 binding: `CONTROL_DB`
- Store D1 bindings: `STORE_01_DB` ... `STORE_04_DB`
- Object storage binding: `DATA_BUCKET`
- Authentication: Cloudflare Access + in-Worker JWT validation + Control D1 RBAC

`run_worker_first` is scoped to `/api/*`. Normal HTML/JS/CSS requests are served by Workers Static Assets without entering the application API router.

The native build does not modify source `index.html`. In the deployment artifact it:

1. replaces browser `connect-src` with `connect-src 'self'`;
2. injects `assets/cloudflare-native-api-v1.js`;
3. therefore makes `/api/*` the only browser data boundary for the Cloudflare-native deployment.

D1 binding names are server-only implementation details. They are never returned by store-list, analytics, or health APIs.

The web Worker binds to the Workflow class exported by the sync Worker. Deploy the sync Worker before the web Worker.

## Package install

There is currently no `package-lock.json`, so do not use `npm ci`.
Wrangler is pinned exactly in `package.json` to keep local, CI, and Workers Builds behavior aligned.

```bash
npm install --no-audit --no-fund
```

## Development provisioning

The preferred path is the idempotent dev-only provisioner:

```bash
npm install --no-audit --no-fund
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
npm install --no-audit --no-fund
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

The validator cross-checks both runtime configs. A web/sync D1 UUID mismatch, R2 mismatch, Workflow name mismatch, class mismatch, script mismatch, wrong web entry, unresolved Access value, or prematurely enabled Amazon sync gate fails validation.

GitHub Actions also runs the database foundation tests and native checks on this development branch and relevant pull requests. The CI workflow never deploys resources or reads Amazon credentials.

## Implemented API layers

### Control D1

- `/api/v1/products`
- `/api/v1/keywords`
- `/api/v1/negative-keywords`

Read access is permission-based. Central master-data writes require global governance permissions and are audited.

### Store D1

- `/api/v1/stores/:storeId/campaigns`
- `/api/v1/stores/:storeId/ad-groups`
- `/api/v1/stores/:storeId/keywords`
- `/api/v1/stores/:storeId/targets`
- `/api/v1/stores/:storeId/search-terms`

Every route checks `user_id + store_id + ads.read` before resolving the internal Store D1 binding. Search-term analytics requires an explicit date range and currently caps one request at 93 days.

### Cross-store Control D1 analytics

- `/api/v1/analytics/overview`
- `/api/v1/analytics/products`
- `/api/v1/analytics/keywords`

These endpoints read asynchronous Control D1 rollups. They do not fan out to all Store D1 databases during a dashboard request.

## Safety state before Amazon integration

Both sync controls must remain disabled during foundation deployment:

```text
wrangler.native.jsonc: SYNC_TRIGGER_ENABLED=false
wrangler.sync.jsonc:   AMAZON_ADS_ENABLED=false
```

The validator fails if either flag is enabled. No Workflow schedule is configured.

This allows the sync Worker and Workflow definition to be deployed and inspected without permitting Amazon API calls or user-triggered synchronization.

## Dev deployment

After provisioning, the D1 UUIDs are populated by the provisioner. Configure the remaining Cloudflare Access values under `env.dev`:

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
7. `GET /api/v1/products`
8. `GET /api/v1/keywords`
9. `GET /api/v1/negative-keywords`
10. Store entity read endpoints with an authorized dev user
11. Cross-store analytics endpoints after rollup seed data exists
12. `GET /api/v1/system/health` as owner
13. current frontend asset loading and `window.CloudflareNativeAPI`
14. confirm the built CSP has `connect-src 'self'`
15. confirm `POST /api/v1/stores/store-dev-01/sync` returns `sync_trigger_disabled`

The store health route validates the complete routing chain: Access identity -> Control D1 app user -> store permission -> internal binding lookup -> Store D1 query.

Keep `ACCESS_MODE=observe` only while validating that the Access application injects valid JWTs. Move development to `enforce` before the environment is shared with users. Production is always `enforce`.

## Production gate

Production provisioning is blocked until all of the following are true:

1. Dev Control D1 migrations pass remotely.
2. Dev Store D1 migrations pass remotely.
3. `PRAGMA foreign_key_check` returns no rows remotely.
4. Duplicate-ingestion/UPSERT tests pass remotely.
5. Cloudflare Access identity maps to a pre-provisioned app user.
6. Store authorization prevents a user from querying a store they do not belong to.
7. Store APIs never return internal D1 binding identifiers.
8. Native browser requests are same-origin only.
9. R2 raw-object path and retention rules are validated.
10. Sync Worker and cross-script Workflow binding deploy with both kill switches disabled.
11. Workers preview deployment passes browser regression testing.
12. Control CRUD, Store reads, and Control rollup analytics pass dev integration tests.
13. Amazon OAuth/secrets design passes review before either sync kill switch can be changed.
14. `node scripts/validate-cloudflare-native.mjs --env production --require-ready` passes.

Only then create `ads-ops-control-prod`, the four production store databases, and `ads-ops-data-prod`.
