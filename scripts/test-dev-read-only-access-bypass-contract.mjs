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
import {
  handleDevReadOnlyBootstrapRoute,
  isDevReadOnlyBootstrapEnabled,
} from '../cloudflare/runtime/dev-read-only-bootstrap-api.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(repoRoot, 'cloudflare/runtime/wrangler.native.jsonc'), 'utf8'));
const webEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/web-entry.js'), 'utf8');
const observedEntrySource = await readFile(path.join(repoRoot, 'cloudflare/runtime/runtime-observed-entry.js'), 'utf8');
const bootstrapSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/dev-read-only-bootstrap-api.js'), 'utf8');

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
assert.equal(isDevReadOnlyBootstrapEnabled(devBypassEnv), true);
assert.equal(isDevReadOnlyBootstrapEnabled({ APP_ENV: 'production', ACCESS_MODE: 'off' }), false);
assert.equal(isDevReadOnlyBootstrapEnabled({ APP_ENV: 'development', ACCESS_MODE: 'enforce' }), false);

assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/capabilities'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/analytics/overview'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/campaigns'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/imports'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/search-term-intelligence'), true);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/sync'), false);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/access/users'), false);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/stores/store-dev-01/optimization-actions'), false);
assert.equal(isDevReadOnlyAccessBypassRoute('/api/v1/unknown'), false);

assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/stores', 'GET', devBypassEnv), true);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/capabilities', 'GET', devBypassEnv), true);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/analytics/overview', 'GET', devBypassEnv), true);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/analytics/overview', 'HEAD', devBypassEnv), true);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/analytics/overview', 'POST', devBypassEnv), false);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/stores/store-dev-01/sync', 'GET', devBypassEnv), false);
assert.equal(isDevReadOnlyAccessBypassRequest('/api/v1/analytics/overview', 'GET', { APP_ENV: 'production', ACCESS_MODE: 'off' }), false);

for (const allowedUrl of [
  'https://example.test/api/v1/stores',
  'https://example.test/api/v1/capabilities',
  'https://example.test/api/v1/analytics/overview',
]) {
  const request = new Request(allowedUrl);
  assert.equal(guardDevReadOnlyAccessBypass(request, devBypassEnv, new URL(request.url)), null);
}

for (const writeUrl of [
  'https://example.test/api/v1/stores',
  'https://example.test/api/v1/capabilities',
  'https://example.test/api/v1/analytics/overview',
]) {
  const request = new Request(writeUrl, { method: 'POST' });
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

{
  const request = new Request('https://example.test/api/v1/stores');
  const response = await handleDevReadOnlyBootstrapRoute({
    request,
    env: { ...devBypassEnv, SYNC_TRIGGER_ENABLED: 'false', CONTROL_DB: fakeBootstrapDb() },
    url: new URL(request.url),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.stores.length, 1);
  assert.equal(payload.stores[0].store_id, 'store-dev-01');
}

{
  const request = new Request('https://example.test/api/v1/capabilities');
  const response = await handleDevReadOnlyBootstrapRoute({
    request,
    env: { ...devBypassEnv, SYNC_TRIGGER_ENABLED: 'false', CONTROL_DB: fakeBootstrapDb() },
    url: new URL(request.url),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.globalPermissions, ['ads.read', 'analytics.read', 'stores.manage']);
  assert.deepEqual(payload.storePermissions, {});
  assert.equal(payload.syncTriggerEnabled, false);
}

{
  const productionRequest = new Request('https://example.test/api/v1/stores');
  assert.equal(await handleDevReadOnlyBootstrapRoute({
    request: productionRequest,
    env: { APP_ENV: 'production', ACCESS_MODE: 'enforce' },
    url: new URL(productionRequest.url),
  }), null);
  const writeRequest = new Request('https://example.test/api/v1/stores', { method: 'POST' });
  assert.equal(await handleDevReadOnlyBootstrapRoute({
    request: writeRequest,
    env: { ...devBypassEnv, CONTROL_DB: fakeBootstrapDb() },
    url: new URL(writeRequest.url),
  }), null);
}

assert.match(webEntrySource, /if \(!devReadOnlyBypass\) \{\s*await touchLastSeen\(env\.CONTROL_DB, actor\.user_id\);\s*\}/);
assert.match(webEntrySource, /dev_read_only_bypass_write_blocked/);
assert.match(webEntrySource, /dev_read_only_bypass_route_blocked/);
assert.match(webEntrySource, /DEV_READ_ONLY_BYPASS_ACTOR_ID = 'user-dev-owner'/);
assert.match(webEntrySource, /'\/api\/v1\/stores'/);
assert.match(webEntrySource, /'\/api\/v1\/capabilities'/);
assert.match(observedEntrySource, /handleDevReadOnlyBootstrapRoute/);
assert.match(observedEntrySource, /uatResponse \|\| devBootstrapResponse \|\| await application\.fetch/);
assert.match(bootstrapSource, /APP_ENV/);
assert.match(bootstrapSource, /ACCESS_MODE/);
assert.match(bootstrapSource, /DEV_BOOTSTRAP_ACTOR_ID = 'user-dev-owner'/);
assert.doesNotMatch(bootstrapSource, /\.run\(\)/);
assert.doesNotMatch(bootstrapSource, /SYNC_TRIGGER_ENABLED\s*===\s*'true'.*create/s);

console.log(JSON.stringify({
  ok: true,
  contract: 'dev-read-only-access-bypass-v2',
  devAccessModeOff: true,
  productionAccessModeEnforce: true,
  devOnly: true,
  operatorBootstrapReadOnlyRoutesAllowed: [
    '/api/v1/stores',
    '/api/v1/capabilities',
  ],
  bootstrapRoutesInterceptedBeforeLegacyAuth: true,
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

function fakeBootstrapDb() {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return query(sql, params);
        },
        ...query(sql, []),
      };
    },
  };

  function query(sql, params) {
    if (/FROM users/.test(sql)) {
      return { async first() { assert.equal(params[0], 'user-dev-owner'); return { user_id: 'user-dev-owner', status: 'active' }; } };
    }
    if (/permission_key = 'stores\.manage'/.test(sql)) {
      return { async first() { return { ok: 1 }; } };
    }
    if (/FROM stores\s+WHERE status <> 'disabled'/.test(sql)) {
      return { async all() { return { results: [{ store_id: 'store-dev-01', store_code: 'DEV01', display_name: 'Development Store', marketplace_code: 'US', amazon_region: 'NA', status: 'active', sort_order: 10 }] }; } };
    }
    if (/SELECT DISTINCT rp\.permission_key/.test(sql)) {
      return { async all() { return { results: [{ permission_key: 'stores.manage' }, { permission_key: 'analytics.read' }, { permission_key: 'ads.read' }] }; } };
    }
    if (/SELECT sm\.store_id, rp\.permission_key/.test(sql)) {
      return { async all() { return { results: [] }; } };
    }
    if (/FROM store_members sm/.test(sql)) {
      return { async all() { return { results: [] }; } };
    }
    throw new Error(`Unexpected fake bootstrap query: ${sql}`);
  }
}
