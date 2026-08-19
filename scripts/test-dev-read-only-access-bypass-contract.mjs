import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  guardDevReadOnlyAccessBypass,
  isDevReadOnlyAccessBypassEnabled,
  isDevReadOnlyAccessBypassRequest,
  isDevReadOnlyAccessBypassRoute,
  resolveDevReadOnlyBypassActor,
} from '../cloudflare/runtime/web-entry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(repoRoot, 'cloudflare/runtime/wrangler.native.jsonc'), 'utf8'));
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');

assert.equal(config.env.dev.vars.APP_ENV, 'development');
assert.equal(config.env.dev.vars.ACCESS_MODE, 'off');
assert.equal(config.env.production.vars.APP_ENV, 'production');
assert.equal(config.env.production.vars.ACCESS_MODE, 'enforce');
assert.equal(config.env.dev.vars.SYNC_TRIGGER_ENABLED, 'false');
assert.equal(config.env.production.vars.SYNC_TRIGGER_ENABLED, 'false');

const devBypassEnv = { APP_ENV: 'development', ACCESS_MODE: 'off' };
assert.equal(isDevReadOnlyAccessBypassEnabled(devBypassEnv), true);
assert.equal(isDevReadOnlyAccessBypassEnabled({ APP_ENV: 'development', ACCESS_MODE: 'enforce' }), false);
assert.equal(isDevReadOnlyAccessBypassEnabled({ APP_ENV: 'production', ACCESS_MODE: 'off' }), false);

assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/analytics/overview'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/campaigns'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/imports'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/search-term-intelligence'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/sync'), false);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/access/users'), false);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/optimization-actions'), false);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/unknown'), false);

assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/analytics/overview', 'GET', devBypassEnv), true);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/analytics/overview', 'HEAD', devBypassEnv), true);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/analytics/overview', 'POST', devBypassEnv), false);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/stores/store-dev-01/sync', 'GET', devBypassEnv), false);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/analytics/overview', 'GET', { APP_ENV: 'production', ACCESS_MODE: 'off' }), false);

{
  const request = new Request('https://example.test/api/v1/analytics/overview');
  assert.equal(guardDevReadOnlyAccessBypass(request, devBypassEnv, new URL(request.url)), null);
}

{
  const request = new Request('https://example.test/api/v1/analytics/overview', { method: 'POST' });
  const response = guardDevReadOnlyAccessBypass(request, devBypassEnv, new URL(request.url));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'dev_read_only_bypass_write_blocked' });
}

for (const blockedUrl of [
  'https://example.test/api/v1/stores/store-dev-01/sync',
  'https://example.test/api/v1/access/users',
  'https://example.test/api/v1/stores/store-dev-01/optimization-actions',
  'https://example.test/api/v1/unknown',
]) {
  const request = new Request(blockedUrl);
  const response = guardDevReadOnlyAccessBypass(request, devBypassEnv, new URL(request.url));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'dev_read_only_bypass_route_blocked' });
}

{
  const request = new Request('https://example.test/api/health');
  assert.equal(guardDevReadOnlyAccessBypass(request, devBypassEnv, new URL(request.url)), null);
}

{
  const request = new Request('https://example.test/api/v1/analytics/overview', { method: 'OPTIONS' });
  assert.equal(guardDevReadOnlyAccessBypass(request, devBypassEnv, new URL(request.url)), null);
}

{
  const db = fakeDevBypassActorDb();
  const actor = await resolveDevReadOnlyBypassActor(db);
  assert.equal(actor.user_id, 'user-dev-owner');
  assert.equal(actor.status, 'active');
  assert.equal(db.writeCount, 0);
}

assert.match(webEntrySource, /if \(!devReadOnlyBypass\) \{\s*await touchLastSeen\(env\.CONTROL_DB, actor\.user_id\);\s*\}/);
assert.match(webEntrySource, /dev_read_only_bypass_write_blocked/);
assert.match(webEntrySource, /dev_read_only_bypass_route_blocked/);
assert.match(webEntrySource, /DEV_READ_ONLY_BYPASS_ACTOR_ID = 'user-dev-owner'/);

console.log(JSON.stringify({
  ok: true,
  contract: 'dev-read-only-access-bypass-v1',
  devAccessModeOff: true,
  productionAccessModeEnforce: true,
  devOnly: true,
  anonymousReadOnlyRoutesAllowlisted: true,
  writeMethodsBlocked: true,
  syncRouteBlocked: true,
  accessGovernanceBlocked: true,
  optimizationActionsBlocked: true,
  unknownApiRoutesBlocked: true,
  fixedBootstrapActorRequired: 'user-dev-owner',
  bypassLastSeenMutation: false,
  amazonSyncStillDisabled: true,
  productionBypassAllowed: false,
}, null, 2));

function fakeDevBypassActorDb() {
  const db = {
    writeCount: 0,
    prepare(sql) {
      assert.match(sql, /FROM users/);
      assert.match(sql, /user_id = \?1/);
      return {
        bind(userId) {
          assert.equal(userId, 'user-dev-owner');
          return {
            async first() {
              return {
                user_id: 'user-dev-owner',
                cf_access_sub: null,
                email: 'owner@example.test',
                email_norm: 'owner@example.test',
                display_name: 'Development Owner',
                status: 'active',
              };
            },
            async run() {
              db.writeCount += 1;
              throw new Error('Dev read-only bypass actor lookup must not write');
            },
          };
        },
      };
    },
  };
  return db;
}
