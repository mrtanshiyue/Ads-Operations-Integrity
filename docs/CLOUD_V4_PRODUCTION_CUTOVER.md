# Cloud Warehouse V4 Production Cutover

Status: preparation only; the live GitHub Pages application is still on the V3 Worker.

## Locked production baseline

- Front-end `main`: `151115608b2677bcf0d6029532eccf5b1daf0930`
- Warehouse `main`: `683488d8dd22ec6923d3a454711a62dee3f6178a`
- Candidate branch: `cloud-migration-phase-1`

## Release sequence

1. Complete final browser module inspection on the candidate branch.
2. Confirm both coordinated PRs are mergeable and zero commits behind `main`.
3. Merge the private warehouse PR first and verify the V4 Worker remains healthy.
4. Merge this front-end PR second so GitHub Pages publishes the V4 origin.
5. Verify the live site reports 32 files, 215,800 rows, 18 redacted transaction reports, import stage `complete`, and zero browser errors.

## Rollback sequence

1. Revert the front-end cutover merge or restore `main` to `151115608b2677bcf0d6029532eccf5b1daf0930`.
2. Wait for GitHub Pages deployment to finish.
3. Confirm the live loader again reports the V3 Worker origin.
4. Keep TiDB and V4 warehouse objects intact; they are additive and do not block V3 operation.
5. Restore warehouse `main` to `683488d8dd22ec6923d3a454711a62dee3f6178a` only when repository rollback is also required.

## Abort conditions

Do not merge this PR when any of these conditions is true:

- coordinated warehouse validation is not passing
- candidate branch is behind `main`
- V4 health or Manifest checks fail
- browser import count differs from 32 files or 215,800 rows
- redacted transaction count differs from 18
- any page or console error is recorded
- rollback baseline is not reachable

## Authorization boundary

Production cutover preparation is approved. Final merge and live origin switch require a separate explicit owner approval.
