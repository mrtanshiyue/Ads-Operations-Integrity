# Cloud Warehouse V4 front-end cutover archive

Status: completed on 2026-08-04; post-cutover engineering consolidation completed on 2026-08-05.

## Final production state

- GitHub Pages serves `main`.
- Warehouse API origin: `https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev`
- Production loader channel: `warehouse-v4-production`
- Formal loader: `assets/private-cloud-warehouse-v4.js`
- Legacy path `assets/private-cloud-warehouse-v3.js` is only a compatibility bootstrap.
- Cutover baseline: 32 files, 215,800 rows, 18 sanitized transaction reports.

## Permanent controls

- `.github/workflows/ci-main.yml` validates pull requests and `main`.
- `.github/workflows/pages.yml` builds one immutable Pages artifact and deploys it once.
- The Warehouse deployment workflow performs authenticated production Chromium validation after Worker deployment.

## Historical evidence

The one-time Canary trigger files, result JSON, diagnostics, patch workflow and release-candidate documents were removed from the active tree. They remain available in Git history and merged PR #2.

## Rollback

The pre-V4 rollback branch remains available. A front-end rollback must not delete TiDB records or immutable Warehouse objects.
