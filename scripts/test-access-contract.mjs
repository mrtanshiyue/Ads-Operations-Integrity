import assert from 'node:assert/strict';
import { normalizeVerifiedAccessIdentity } from '../src/access.js';

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

console.log(JSON.stringify({
  ok: true,
  contracts: ['identity-user', 'identity-service-token', 'missing-principal-rejected'],
}, null, 2));
