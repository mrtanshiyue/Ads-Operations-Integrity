# Phase 1 — Security Integrity Acceptance

Status: implementation complete; final documentation SHA must pass Canonical CI before PR-ready declaration.

## Canonical base

Phase 1 started from the merged Architecture Convergence baseline:

```text
main
d83bd4dcabe8ed92d873902a463163191bf60382
```

Security work is isolated on:

```text
security-integrity-phase1
```

Implementation acceptance candidate before this documentation commit:

```text
5ef2d455c33b73144b07d0333ed3a9ce8b22b203
```

Canonical CI evidence for that implementation candidate:

```text
Cloudflare Native Canonical CI
Run 31931495846
Static site and security invariants = SUCCESS
```

At acceptance audit, the security branch was ahead of `main` by 32 commits and behind by 0; the merge base was exactly the canonical Phase 0 main commit above.

## Security properties established

### Control D1 defense in depth

Append-only migrations:

```text
0005_control_security_integrity.sql
0006_control_access_recovery.sql
```

Database-level invariants now enforce:

- at most one global role per user;
- global-role assignments may only use `role_scope='global'` roles;
- store memberships may only use `role_scope='store'` roles;
- global-role users must remain active;
- a user cannot simultaneously hold a global role and a store membership;
- assigned role scope cannot be changed underneath active assignments;
- the last active owner cannot be deleted or demoted;
- a bound owner's Cloudflare Access subject cannot be directly rewritten outside the audited recovery ledger.

Migration tests execute against real SQLite semantics and the Canonical CI real-D1 harness applies the same migrations to a local Cloudflare D1 binding.

### Global Role governance atomicity

`cloudflare/runtime/global-role-governance-api.js` now requires `CONTROL_DB.batch()`.

Grant/revoke mutations and their audit events are committed in one D1 transaction. There is no sequential fallback. Tests prove that an injected audit failure rolls back the role mutation and that concurrent owner revocation cannot reduce the system to zero active owners.

### User lifecycle atomicity

`cloudflare/runtime/user-lifecycle-api.js` now commits status mutation, audit event and readback through one D1 batch.

The mutation SQL rechecks actor activity and `users.manage` at write time. Tests prove audit failure rollback and actor-permission-loss race fail-closed behavior.

### Break-glass Access recovery

Recovery is CLI-only:

```text
npm run security:break-glass:access-recovery -- ...
```

It is not a Web Worker route and does not create or modify global roles.

The CLI defaults to dry-run. The Cloudflare API token is accepted only from `CLOUDFLARE_API_TOKEN`, never from a CLI flag. Execution requires an exact confirmation string; Production additionally requires `BREAK_GLASS_PRODUCTION_ENABLED=1` and a second exact Production confirmation.

Recovery itself is one insert into the append-only `access_recovery_events` ledger. D1 triggers revalidate exact current owner/email/subject state, apply the new Access subject and write the audit event in the same SQLite statement transaction. The recovery ledger is immutable.

Real local D1 tests prove that an injected audit failure rolls back the recovery ledger insert and owner subject update together.

### Full Access request pipeline

Canonical CI executes the production Web entrypoint with:

- `ACCESS_MODE=enforce`;
- real generated RSA-2048 key pairs;
- real RS256 JWT signing and WebCrypto verification;
- Cloudflare Access JWKS request interception only at the Node test boundary supported by the Workers test harness;
- real local Control D1 migrations and bindings;
- production strict actor binding and RBAC;
- production Global Role governance mutation and audit.

The pipeline verifies:

- missing token rejected;
- invalid signature rejected;
- invalid audience rejected;
- same-email / mismatched-subject identity rejected;
- provisioned unbound user first-bind behavior;
- disabled user rejection;
- valid owner JWT performing a governed Global Role mutation with persisted audit evidence.

No authentication bypass or test-only identity header exists in the production Access or Web entrypoint code.

## Test architecture

Canonical required check context remains exactly:

```text
Static site and security invariants
```

The Canonical CI also covers short-lived `feature/**`, `fix/**` and `security-integrity-*` branches.

Security-critical tests now include both deterministic contract tests and Cloudflare local runtime integration through `createTestHarness()` / local D1 migrations.

No remote Dev or Production D1 is touched by these integration tests.

## Explicitly unchanged / forbidden

Phase 1 does not authorize or perform:

- Cloudflare Production resource changes;
- movement of `__manual_ci_gated_deploy__`;
- direct `wrangler deploy`;
- sync Worker deployment;
- Amazon Ads credential provisioning;
- live LWA credential smoke;
- Amazon Create/Poll/Download report activity;
- real Amazon sync;
- `AMAZON_ADS_ENABLED=true`;
- `SYNC_TRIGGER_ENABLED=true`;
- Global Role UI work;
- frontend modernization;
- Production readiness claims.

Amazon live execution remains dormant until a later explicitly authorized controlled Store 01 read-only activation phase.

## Repository safety state at acceptance audit

Observed before this acceptance document was written:

```text
main = d83bd4dcabe8ed92d873902a463163191bf60382
security-integrity-phase1 = 5ef2d455c33b73144b07d0333ed3a9ce8b22b203
__manual_ci_gated_deploy__ = ce59e4cc43413338f35a34cb44622a7aa26f9875
```

The deployment trigger remained unchanged throughout Phase 1.

## Merge gate

Phase 1 becomes PR-ready only after the final documentation tip passes the same Canonical required check. Opening a PR, marking it ready for review, merging it, and any later deployment are separate explicit decisions.
