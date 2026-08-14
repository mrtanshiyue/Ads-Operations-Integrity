import assert from 'node:assert/strict';
import { normalizeVerifiedAccessIdentity } from '../src/access.js';
import { enforceStrictAccessActorBinding } from '../src/access-actor.js';

const user = normalizeVerifiedAccessIdentity({
  sub: 'user-sub-123',
  email: 'Owner@Example.COM ',
  exp: 1_800_000_000,
});
assert.deepEqual(user, {
  sub: 'user-sub-123',
  email: 'owner@example.com',
  exp: 1_800_000_000,
  principalType: 'user',
});

const service = normalizeVerifiedAccessIdentity({
  sub: '',
  common_name: '0123456789abcdef.access',
  exp: 1_800_000_000,
});
assert.deepEqual(service, {
  sub: '0123456789abcdef.access',
  email: '',
  exp: 1_800_000_000,
  principalType: 'service_token',
});

assert.throws(
  () => normalizeVerifiedAccessIdentity({ sub: '', common_name: '', exp: 1_800_000_000 }),
  /subject missing/,
);
assert.throws(
  () => normalizeVerifiedAccessIdentity({ sub: '', common_name: 'not-a-service-token', exp: 1_800_000_000 }),
  /subject missing/,
);

{
  const db = fakeUsersDb({
    user_id: 'user-dev-owner',
    cf_access_sub: 'user-sub-123',
    email: 'owner@example.com',
    email_norm: 'owner@example.com',
    display_name: 'Owner',
    status: 'active',
  });
  const result = await enforceStrictAccessActorBinding(db, {
    authenticated: true,
    identity: { sub: 'user-sub-123', email: 'owner@example.com' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.newlyBound, false);
}

{
  const db = fakeUsersDb({
    user_id: 'user-dev-owner',
    cf_access_sub: 'original-sub',
    email: 'owner@example.com',
    email_norm: 'owner@example.com',
    display_name: 'Owner',
    status: 'active',
  });
  const result = await enforceStrictAccessActorBinding(db, {
    authenticated: true,
    identity: { sub: 'different-sub', email: 'owner@example.com' },
  });
  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: 'access_subject_mismatch',
  });
}

{
  const db = fakeUsersDb({
    user_id: 'user-dev-owner',
    cf_access_sub: null,
    email: 'owner@example.com',
    email_norm: 'owner@example.com',
    display_name: 'Owner',
    status: 'active',
  });
  const result = await enforceStrictAccessActorBinding(db, {
    authenticated: true,
    identity: { sub: 'first-real-sub', email: 'owner@example.com' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.newlyBound, true);
  assert.equal(db.row.cf_access_sub, 'first-real-sub');
}

{
  const db = fakeUsersDb({
    user_id: 'user-dev-owner',
    cf_access_sub: 'user-sub-123',
    email: 'owner@example.com',
    email_norm: 'owner@example.com',
    display_name: 'Owner',
    status: 'active',
  });
  const result = await enforceStrictAccessActorBinding(db, {
    authenticated: true,
    identity: { sub: 'unknown-sub', email: 'nobody@example.com' },
  });
  assert.deepEqual(result, {
    ok: false,
    status: 403,
    error: 'app_user_not_provisioned',
  });
}

console.log(JSON.stringify({
  ok: true,
  contracts: [
    'identity-user',
    'identity-service-token',
    'missing-principal-rejected',
    'bound-sub-accepted',
    'bound-sub-email-fallback-rejected',
    'unbound-email-first-bind-verified',
    'unknown-identity-rejected',
  ],
}, null, 2));

function fakeUsersDb(initialRow) {
  const db = {
    row: { ...initialRow },
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              const row = db.row;
              if (!row || row.status !== 'active') return null;

              if (sql.includes('user_id = ?1') && sql.includes('cf_access_sub = ?2')) {
                return row.user_id === params[0] && row.cf_access_sub === params[1] ? { ...row } : null;
              }
              if (sql.includes('cf_access_sub = ?1')) {
                return row.cf_access_sub === params[0] ? { ...row } : null;
              }
              if (sql.includes('email_norm = ?1')) {
                return row.email_norm === params[0] ? { ...row } : null;
              }
              throw new Error(`Unexpected SELECT contract: ${sql}`);
            },
            async run() {
              const row = db.row;
              if (!sql.includes('UPDATE users') || !sql.includes('cf_access_sub IS NULL')) {
                throw new Error(`Unexpected UPDATE contract: ${sql}`);
              }
              if (row && row.user_id === params[1] && !row.cf_access_sub) {
                row.cf_access_sub = params[0];
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db;
}
