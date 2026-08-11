# Cloudflare Workers Builds deployment

This clean-slate frontend is deployed by Cloudflare Workers Builds. GitHub is source storage only; GitHub Actions is not part of the deployment path.

## Worker

- Name: `ads-operations-web`
- Repository: `mrtanshiyue/Ads-Operations-Integrity`
- Production branch during rebuild: `rebuild/cloudflare-native-v1`
- Root directory: `cloudflare-web`
- Build command: `npm run validate`
- Deploy command: `npm run deploy`
- Non-production branch builds: disabled until cutover

The build script copies the existing repository-root `index.html` and `assets/` into `cloudflare-web/dist` inside Cloudflare's build environment. No local build is required.

## Required dependencies before first deploy

1. Backend Worker `amazon-ops-api` exists.
2. Frontend service binding `WAREHOUSE` targets `amazon-ops-api`.
3. Cloudflare Access application exists.
4. `TEAM_DOMAIN` and `ACCESS_AUD` are configured from the Access application.
5. `wrangler.jsonc` is rendered from `wrangler.template.jsonc` only after those values are known.

The browser must not receive D1, R2, Pipeline, Amazon OAuth, or infrastructure credentials.
