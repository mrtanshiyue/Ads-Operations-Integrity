# Cloudflare Dev Remote Acceptance V1

This checklist is for the first real Cloudflare-native development deployment. It must not be used to provision production resources.

## Gate 0 - local/CI foundation

Required before remote provisioning:

```text
Cloudflare Foundation CI = success
SYNC_TRIGGER_ENABLED=false
AMAZON_ADS_ENABLED=false
production D1 IDs remain placeholders
```

## Gate 1 - provision development resources

Expected resources:

```text
D1  ads-ops-control-dev
D1  ads-ops-store-dev
R2  ads-ops-data-dev
```

Preferred command:

```bash
npm install --no-audit --no-fund
npm run provision:cf-native:dev:dry
npm run provision:cf-native:dev
```

Acceptance:

- exact-name existing dev resources are reused;
- no `-prod` resource is created;
- dev D1 UUIDs are written consistently to both Wrangler configs;
- all Control migrations are applied;
- all Store migrations are applied;
- remote `PRAGMA foreign_key_check` returns no rows.

## Gate 2 - bootstrap development identity/route

Use environment variables only:

```bash
DEV_OWNER_EMAIL='owner@example.com' \
DEV_OWNER_NAME='Owner' \
npm run bootstrap:cf-native:dev
```

Acceptance:

```text
user-dev-owner = active
owner global role exists
store-dev-01 = active
store-dev-01 internal route = STORE_01_DB
```

Do not commit rendered bootstrap SQL or a real user email.

## Gate 3 - Cloudflare Access

Populate dev web runtime values:

```text
TEAM_DOMAIN
ACCESS_AUD
```

Start with:

```text
ACCESS_MODE=observe
```

Acceptance:

- Access injects a valid identity JWT;
- the JWT identity maps to the pre-provisioned Control D1 user;
- `/api/v1/session` reports `authenticated=true` and `provisioned=true`;
- only then change development Access mode to `enforce`.

Production remains `enforce` at all times.

## Gate 4 - deploy disabled sync stack

Dependency order:

```text
1. ads-operations-sync-dev
2. ads-operations-web-dev
```

Command:

```bash
npm run deploy:cf-stack:dev
```

Acceptance:

- sync Worker deploys with Workflow class;
- web Worker resolves cross-script Workflow binding;
- `AMAZON_ADS_ENABLED=false`;
- `SYNC_TRIGGER_ENABLED=false`;
- no Workflow schedule exists.

## Gate 5 - public smoke

```bash
CF_NATIVE_BASE_URL='https://<dev-host>' npm run smoke:cf-native
```

The smoke test verifies:

- index loads as HTML;
- native API Client is present;
- native D1 Query Bridge is present;
- legacy browser Query Client script is absent from the built index;
- legacy external Worker origin is absent from the built index;
- CSP `connect-src` is same-origin only;
- `/api/health` sees Control D1, at least one Store D1, and R2;
- sync trigger remains disabled.

## Gate 6 - authenticated smoke

Use either an authenticated browser cookie or an Access service token.

Cookie mode:

```bash
CF_NATIVE_BASE_URL='https://<dev-host>' \
CF_NATIVE_COOKIE='<cookie>' \
npm run smoke:cf-native:auth
```

Service-token mode:

```bash
CF_NATIVE_BASE_URL='https://<dev-host>' \
CF_ACCESS_CLIENT_ID='<id>' \
CF_ACCESS_CLIENT_SECRET='<secret>' \
npm run smoke:cf-native:auth
```

Optional BI range:

```bash
CF_SMOKE_START_DATE='2026-08-01' \
CF_SMOKE_END_DATE='2026-08-14'
```

Acceptance includes:

- session/provisioning contract;
- accessible store list;
- Store D1 health route;
- capability contract;
- `/api/v1/analytics/data-health` contract;
- optional analytics overview contract;
- sync POST is rejected by the kill switch.

## Gate 7 - native UI regression

Browser validation must confirm:

```text
page layout unchanged
navigation unchanged
existing local/raw workflows still load where intentionally retained
ads query path identifies itself as query-cloudflare-d1
no browser request is made to the retired external Query Client backend
transactions/financial cloud query reports explicit not-migrated behavior rather than silently returning fabricated data
bid/target automation readiness remains false
```

## Gate 8 - seed synthetic dev facts

Before Amazon OAuth integration, insert a small synthetic development dataset only:

```text
amazon_profiles
campaigns
ad_groups
keywords
campaign_daily
keyword_daily
search_term_daily
advertised_product_daily
```

Then run rollup functions through a development-only harness/Workflow step and verify:

```text
store_daily_summary
product_daily_summary
keyword_performance_rollup
rollup_runs
rollup_watermarks
analytics/data-health
analytics/overview
```

Synthetic data must be clearly identifiable and must never be copied to production.

## Gate 9 - Amazon integration remains closed

Passing all previous gates does not authorize Amazon API use.

Amazon integration starts only after a separate review of:

```text
OAuth/token isolation
Secrets Store bindings
report type/config mapping
R2 raw object layout
report polling/retry rules
parser/upsert contracts
attribution windows
backfill policy
rate-limit policy
rollup Workflow partition plan
```

Only after that review may the two sync kill switches be changed in a dedicated development-only change.

## Production prohibition

Do not create or deploy:

```text
ads-ops-control-prod
ads-ops-store-01-prod ... ads-ops-store-04-prod
ads-ops-data-prod
ads-operations-web-prod
ads-operations-sync-prod
```

until every development gate above passes and production readiness validation passes with no placeholders.
