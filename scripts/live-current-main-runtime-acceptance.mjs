import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';
import { collectProductionClosureStatus } from './production-closure-observability.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const EXPECTED_MAIN_SHA = required('EXPECTED_MAIN_SHA');
const DEV_BASE_URL = (process.env.DEV_BASE_URL || 'https://ads-operations-web-dev.tanshiyuesir.workers.dev').replace(/\/$/, '');
const PROD_BASE_URL = (process.env.PROD_BASE_URL || 'https://ads-operations-web-prod.tanshiyuesir.workers.dev').replace(/\/$/, '');
const CONTROL_DB_ID = process.env.PROD_CONTROL_DB_ID || '2122248c-1fd4-4ccd-b611-9f9d2f3decbf';
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/live-current-main-runtime-acceptance';
const PRINCIPAL_USER_ID = `svc-live-runtime-${RUN_ID}`;
const PRINCIPAL_EMAIL = `svc-live-runtime-${RUN_ID}@machine.invalid`;
const ROLE_KEY = `live_runtime_${RUN_ID}`;
const SERVICE_TOKEN_NAME = `ads-ops-live-runtime-${RUN_ID}`;
const ACCESS_POLICY_NAME = `Live runtime acceptance ${RUN_ID}`;
const PRODUCT_UI_VERSION = '2.0.2';
const SCOPE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01' });
const AMAZON_HOST = /(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i;

await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'live-current-main-runtime-acceptance-v1',
  runId: RUN_ID,
  expectedCanonicalMain: EXPECTED_MAIN_SHA,
  targets: { development: DEV_BASE_URL, production: PROD_BASE_URL },
  startedAt: new Date().toISOString(),
  controlPlane: null,
  development: { checks: {}, amazonRequests: [], pageErrors: [], consoleErrors: [] },
  production: { checks: {}, amazonRequests: [], pageErrors: [], consoleErrors: [], race: {} },
  temporaryResources: {},
  cleanup: {},
  result: 'FAIL',
};

const controlDb = createD1RestDatabase({
  accountId: ACCOUNT_ID,
  databaseId: CONTROL_DB_ID,
  apiToken: API_TOKEN,
});

let targetApp = null;
let serviceToken = null;
let accessPolicy = null;
let store01 = null;
let store02 = null;
let failure = null;

try {
  const status = await waitForExactMainControlPlane();
  receipt.controlPlane = status;
  assert.deepEqual(status.blockers, [], `live control-plane blockers: ${status.blockers.join(',')}`);
  assert.equal(status.runtimeParity.status, 'exact_main_100_percent');
  assert.equal(status.amazonHardOff.status, 'HARD_OFF');
  assert.equal(status.productionSyncSchedules.length, 0);

  await provisionReadOnlyProductionIdentity();
  await runDevelopmentBrowser();
  await runProductionBrowser();

  assert.equal(receipt.development.amazonRequests.length, 0, 'Development browser attempted an Amazon network request');
  assert.equal(receipt.production.amazonRequests.length, 0, 'Production browser attempted an Amazon network request');
  assert.equal(receipt.development.pageErrors.length, 0, `Development page errors: ${receipt.development.pageErrors.join(' | ')}`);
  assert.equal(receipt.production.pageErrors.length, 0, `Production page errors: ${receipt.production.pageErrors.join(' | ')}`);

  receipt.result = 'PASS';
} catch (error) {
  failure = error;
  receipt.error = {
    message: scrub(error?.message || String(error)),
    stack: scrub(String(error?.stack || '')).slice(0, 12000),
  };
} finally {
  try {
    await cleanupTemporaryIdentity();
    await verifyCleanup();
  } catch (cleanupError) {
    receipt.cleanup.error = scrub(cleanupError?.message || String(cleanupError));
    if (!failure) failure = cleanupError;
    receipt.result = 'FAIL';
  }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(redactReceipt(receipt), null, 2));
}

if (failure) throw failure;

async function waitForExactMainControlPlane() {
  let lastStatus = null;
  let lastError = null;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      const status = await collectProductionClosureStatus({
        accountId: ACCOUNT_ID,
        token: API_TOKEN,
        mainSha: EXPECTED_MAIN_SHA,
      });
      lastStatus = status;
      receipt.controlPlane = status;
      if (status.blockers.length === 0
        && status.runtimeParity.status === 'exact_main_100_percent'
        && status.amazonHardOff.status === 'HARD_OFF') return status;
    } catch (error) {
      lastError = error;
    }
    await sleep(15_000);
  }
  if (lastStatus) {
    throw new Error(`LIVE_RUNTIME_CONTROL_PLANE_BLOCKED:${lastStatus.blockers.join(',') || lastStatus.runtimeParity.status}`);
  }
  throw new Error(`LIVE_RUNTIME_CONTROL_PLANE_UNREADABLE:${lastError?.message || 'unknown'}`);
}

async function provisionReadOnlyProductionIdentity() {
  const apps = await cf('/access/apps');
  const prodHost = new URL(PROD_BASE_URL).hostname.toLowerCase();
  targetApp = (Array.isArray(apps.result) ? apps.result : []).find(
    (app) => String(app?.domain || '').toLowerCase() === prodHost,
  );
  assert(targetApp?.id, `Production Access app not found for ${prodHost}`);
  receipt.temporaryResources.accessAppId = targetApp.id;

  serviceToken = (await cf('/access/service_tokens', {
    method: 'POST',
    body: { name: SERVICE_TOKEN_NAME, duration: '1h', enabled: true },
  })).result;
  assert(serviceToken?.id && serviceToken?.client_id && serviceToken?.client_secret,
    'Cloudflare Access service token response incomplete');
  receipt.temporaryResources.serviceTokenId = serviceToken.id;

  accessPolicy = (await cf(`/access/apps/${encodeURIComponent(targetApp.id)}/policies`, {
    method: 'POST',
    body: {
      name: ACCESS_POLICY_NAME,
      decision: 'non_identity',
      include: [{ service_token: { token_id: serviceToken.id } }],
    },
  })).result;
  assert(accessPolicy?.id, 'Cloudflare Access acceptance policy response incomplete');
  receipt.temporaryResources.accessPolicyId = accessPolicy.id;

  store01 = await controlDb.prepare(`SELECT store_id, store_code FROM stores WHERE d1_binding_key='STORE_01_DB' AND status <> 'disabled' LIMIT 1`).first();
  store02 = await controlDb.prepare(`SELECT store_id, store_code FROM stores WHERE d1_binding_key='STORE_02_DB' AND status <> 'disabled' LIMIT 1`).first();
  assert(store01?.store_id, 'Store01 registry row not found');
  assert(store02?.store_id, 'Store02 registry row not found');
  receipt.production.stores = {
    store01: { id: store01.store_id, code: store01.store_code || null },
    store02: { id: store02.store_id, code: store02.store_code || null },
  };

  await controlDb.prepare(`INSERT INTO app_roles(role_key,role_name,role_scope,priority,is_system) VALUES(?1,?2,'store',900,0)`)
    .bind(ROLE_KEY, `Live Runtime Acceptance ${RUN_ID}`).run();
  await controlDb.prepare(`INSERT INTO role_permissions(role_key,permission_key) VALUES(?1,'analytics.read')`)
    .bind(ROLE_KEY).run();
  await controlDb.prepare(`INSERT INTO users(user_id,cf_access_sub,email,email_norm,display_name,status,created_at,updated_at) VALUES(?1,?2,?3,lower(?3),'Live Runtime Acceptance Service','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .bind(PRINCIPAL_USER_ID, serviceToken.client_id, PRINCIPAL_EMAIL).run();
  await controlDb.prepare(`INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)`)
    .bind(store01.store_id, PRINCIPAL_USER_ID, ROLE_KEY).run();
  await controlDb.prepare(`INSERT INTO store_members(store_id,user_id,role_key) VALUES(?1,?2,?3)`)
    .bind(store02.store_id, PRINCIPAL_USER_ID, ROLE_KEY).run();

  const permissions = await controlDb.prepare(`SELECT permission_key FROM role_permissions WHERE role_key=?1 ORDER BY permission_key`)
    .bind(ROLE_KEY).all();
  assert.deepEqual(permissions.results.map((row) => row.permission_key), ['analytics.read']);
  const memberships = await controlDb.prepare(`SELECT store_id FROM store_members WHERE user_id=?1 ORDER BY store_id`)
    .bind(PRINCIPAL_USER_ID).all();
  assert.equal(memberships.results.length, 2);
  receipt.temporaryResources.principalUserId = PRINCIPAL_USER_ID;
  receipt.temporaryResources.roleKey = ROLE_KEY;
  receipt.temporaryResources.storeMembershipCount = memberships.results.length;
}

async function runDevelopmentBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await installAmazonBlocker(context, receipt.development.amazonRequests);
  const page = await context.newPage();
  monitorPage(page, receipt.development);
  try {
    const nav = await page.goto(DEV_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    assert(nav, 'Development root returned no navigation response');
    assert.equal(nav.status(), 200, `Development root expected 200, got ${nav.status()}`);
    receipt.development.checks.root200 = true;

    await waitForRuntimeUi(page);
    const productVersion = await page.evaluate(() => globalThis.CloudflareCsvProductUI?.version || '');
    assert.equal(productVersion, PRODUCT_UI_VERSION, `Development Product UI version ${productVersion}`);
    receipt.development.checks.productUiVersion = productVersion;

    const health = await page.evaluate(async () => {
      const response = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    });
    assert.equal(health.status, 200);
    assert.equal(health.body?.environment, 'development');
    receipt.development.health = health.body;
    receipt.development.checks.health200 = true;

    const storeId = await currentStoreId(page);
    assert(storeId, 'Development current store is empty');
    receipt.development.storeId = storeId;

    const navButton = page.locator('[data-csv-product-nav="intelligence"]');
    await navButton.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-csv-product-nav="intelligence"]')?.getAttribute('aria-disabled') !== 'true');
    await navButton.click();
    const panel = page.locator('#cfDecisionPanel');
    await panel.waitFor({ state: 'visible', timeout: 20_000 });
    const source = panel.locator('[name="dataSource"]');
    if (await source.count()) await source.selectOption('csv');
    await panel.locator('[name="startDate"]').fill(SCOPE.startDate);
    await panel.locator('[name="endDate"]').fill(SCOPE.endDate);
    const limit = panel.locator('[name="limit"]');
    if (await limit.count()) {
      const tag = await limit.evaluate((node) => node.tagName);
      if (tag === 'SELECT') await limit.selectOption('50');
      else await limit.fill('50');
    }

    const responsePromise = page.waitForResponse((response) => {
      try {
        const url = new URL(response.url());
        return url.pathname.includes(`/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence`)
          && response.request().method() === 'GET';
      } catch { return false; }
    }, { timeout: 45_000 });
    await panel.locator('[data-run]').click();
    const response = await responsePromise;
    const body = await response.json().catch(() => ({}));
    assert.equal(response.status(), 200, `Development CSV preview returned ${response.status()}`);
    const scopeEvidence = body?.productization?.analysisScope || body?.productization?.recommendationInbox?.analysisScope || {};
    const inboxItems = Array.isArray(body?.productization?.recommendationInbox?.items)
      ? body.productization.recommendationInbox.items
      : [];
    assert.equal(scopeEvidence.complete, true, 'Development live CSV universe is incomplete');
    assert.equal(scopeEvidence.candidateEmissionAuthorized, true, 'Development candidate emission not authorized for review');
    assert(inboxItems.length > 0, 'Development live scope emitted no Recommendation Inbox candidates');
    receipt.development.csvPreview = {
      status: response.status(),
      complete: scopeEvidence.complete === true,
      candidateEmissionAuthorized: scopeEvidence.candidateEmissionAuthorized === true,
      inboxCount: inboxItems.length,
    };
    await panel.locator('[data-csv-operator-workspace]').waitFor({ state: 'visible', timeout: 30_000 });
    receipt.development.checks.realCsvPreview = true;
    receipt.development.checks.realRecommendationInbox = true;
    await page.screenshot({ path: `${OUT}/development-live.png`, fullPage: true });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runProductionBrowser() {
  assert(serviceToken?.client_id && serviceToken?.client_secret, 'Production service auth is unavailable');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    extraHTTPHeaders: {
      'CF-Access-Client-Id': serviceToken.client_id,
      'CF-Access-Client-Secret': serviceToken.client_secret,
    },
  });
  await installAmazonBlocker(context, receipt.production.amazonRequests);
  const page = await context.newPage();
  monitorPage(page, receipt.production);
  try {
    const nav = await page.goto(PROD_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    assert(nav, 'Production root returned no navigation response');
    assert.equal(nav.status(), 200, `Production root expected 200, got ${nav.status()}`);
    receipt.production.checks.root200 = true;

    await waitForRuntimeUi(page);
    const productVersion = await page.evaluate(() => globalThis.CloudflareCsvProductUI?.version || '');
    assert.equal(productVersion, PRODUCT_UI_VERSION, `Production Product UI version ${productVersion}`);
    receipt.production.checks.productUiVersion = productVersion;

    const health = await page.evaluate(async () => {
      const response = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    });
    assert.equal(health.status, 200, `Production health returned ${health.status}`);
    assert.equal(health.body?.environment, 'production');
    assert.equal(health.body?.syncTriggerEnabled, false, 'Production SYNC_TRIGGER_ENABLED is not false');
    receipt.production.health = health.body;
    receipt.production.checks.health200 = true;
    receipt.production.checks.syncTriggerHardOff = true;

    const storeSelect = page.locator('#cfOperatorStore');
    await storeSelect.waitFor({ state: 'visible', timeout: 30_000 });
    const options = await storeSelect.locator('option').evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, text: node.textContent || '' })));
    assert(options.some((option) => option.value === store01.store_id), 'Store01 missing from Production Operator Workspace');
    assert(options.some((option) => option.value === store02.store_id), 'Store02 missing from Production Operator Workspace');
    receipt.production.storeOptions = options;

    await storeSelect.selectOption(store01.store_id);
    await waitForStore(page, store01.store_id);
    await page.waitForFunction(() => document.querySelector('[data-csv-product-nav="advisory"]')?.getAttribute('aria-disabled') !== 'true');

    await assertCrossStoreReviewRace(page, store01.store_id, store02.store_id);
    await assertCloseReopenLifecycle(page, store02.store_id);

    const authorityText = await page.locator('#cfAdvisoryReviewPanel .cfAdvisoryAuthority').textContent();
    assert.match(authorityText || '', /CSV ADVISORY ONLY/i);
    assert.match(authorityText || '', /Amazon execution and mutation disabled/i);
    receipt.production.checks.advisoryAuthorityBoundary = true;
    await page.screenshot({ path: `${OUT}/production-live.png`, fullPage: true });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function assertCrossStoreReviewRace(page, storeA, storeB) {
  const pathA = `/api/v1/stores/${encodeURIComponent(storeA)}/advisory-reviews`;
  const pathB = `/api/v1/stores/${encodeURIComponent(storeB)}/advisory-reviews`;
  const matcherA = new RegExp(`${escapeRegExp(pathA)}\\?`);
  let releaseA;
  let resolveAHeld;
  const releaseAPromise = new Promise((resolve) => { releaseA = resolve; });
  const aHeld = new Promise((resolve) => { resolveAHeld = resolve; });
  let aRequestCount = 0;

  await page.route(matcherA, async (route) => {
    aRequestCount += 1;
    const response = await route.fetch();
    resolveAHeld({ status: response.status(), url: response.url() });
    await releaseAPromise;
    await route.fulfill({ response });
  });

  const advisoryNav = page.locator('[data-csv-product-nav="advisory"]');
  await advisoryNav.waitFor({ state: 'visible', timeout: 20_000 });
  await advisoryNav.click();
  const held = await withTimeout(aHeld, 30_000, 'Store A Advisory Review request was not intercepted');
  assert.equal(held.status, 200, `Store A Advisory Review backend returned ${held.status}`);

  const bResponsePromise = page.waitForResponse((response) => {
    try {
      const url = new URL(response.url());
      return url.pathname === pathB && response.request().method() === 'GET';
    } catch { return false; }
  }, { timeout: 40_000 });

  await page.locator('#cfOperatorStore').selectOption(storeB);
  await waitForStore(page, storeB);
  const bResponse = await bResponsePromise;
  assert.equal(bResponse.status(), 200, `Store B Advisory Review returned ${bResponse.status()}`);
  await waitForReviewSettled(page, storeB);
  const beforeReleaseRows = await reviewRowIds(page);
  const beforeReleaseText = await page.locator('#cfAdvisoryReviewPanel .cfAdvisoryBody').textContent();

  receipt.production.race.storeARequestHeld = true;
  receipt.production.race.storeBRequestCompletedBeforeStoreARelease = true;
  receipt.production.race.storeARequestCount = aRequestCount;
  receipt.production.race.storeBStatus = bResponse.status();
  receipt.production.race.storeBRowsBeforeStoreARelease = beforeReleaseRows;

  releaseA();
  await page.waitForTimeout(700);
  await waitForReviewSettled(page, storeB);
  const afterReleaseRows = await reviewRowIds(page);
  const afterReleaseText = await page.locator('#cfAdvisoryReviewPanel .cfAdvisoryBody').textContent();
  const headerStore = String(await page.locator('#cfAdvisoryReviewPanel .cfAdvisoryTopline span').textContent() || '').trim();
  assert.equal(headerStore, storeB, 'Late Store A response changed the Advisory Review store header');
  assert.deepEqual(afterReleaseRows, beforeReleaseRows, 'Late Store A response replaced Store B review rows');
  assert.equal(afterReleaseText, beforeReleaseText, 'Late Store A response repainted Store B Advisory Review content');
  receipt.production.race.lateStoreAResponseSuppressed = true;
  receipt.production.checks.crossStoreReviewGenerationOwnership = true;
  await page.unroute(matcherA);
}

async function assertCloseReopenLifecycle(page, storeId) {
  const path = `/api/v1/stores/${encodeURIComponent(storeId)}/advisory-reviews`;
  const matcher = new RegExp(`${escapeRegExp(path)}\\?`);
  let holdNext = true;
  let releaseOld;
  let resolveHeld;
  const oldRelease = new Promise((resolve) => { releaseOld = resolve; });
  const held = new Promise((resolve) => { resolveHeld = resolve; });

  await page.route(matcher, async (route) => {
    if (!holdNext) return route.continue();
    holdNext = false;
    const response = await route.fetch();
    resolveHeld({ status: response.status() });
    await oldRelease;
    await route.fulfill({ response });
  });

  await page.locator('#cfAdvisoryReviewPanel [data-review-action="refresh"]').click();
  const old = await withTimeout(held, 30_000, 'Reopen lifecycle refresh was not intercepted');
  assert.equal(old.status, 200);
  await page.locator('#cfAdvisoryReviewPanel [data-review-action="close"]').click();
  await page.waitForFunction(() => document.querySelector('#cfAdvisoryReviewPanel')?.hidden === true);

  const newResponsePromise = page.waitForResponse((response) => {
    try {
      const url = new URL(response.url());
      return url.pathname === path && response.request().method() === 'GET';
    } catch { return false; }
  }, { timeout: 40_000 });
  const nav = page.locator('[data-csv-product-nav="advisory"]');
  await nav.waitFor({ state: 'visible', timeout: 20_000 });
  await nav.click();
  const fresh = await newResponsePromise;
  assert.equal(fresh.status(), 200, `Reopened Advisory Review returned ${fresh.status()}`);
  await waitForReviewSettled(page, storeId);
  const beforeReleaseRows = await reviewRowIds(page);
  releaseOld();
  await page.waitForTimeout(700);
  await waitForReviewSettled(page, storeId);
  const afterReleaseRows = await reviewRowIds(page);
  assert.deepEqual(afterReleaseRows, beforeReleaseRows, 'Old closed-panel refresh repainted the reopened Advisory Review');
  receipt.production.checks.advisoryCloseReopenGenerationOwnership = true;
  await page.unroute(matcher);
}

async function waitForRuntimeUi(page) {
  await page.waitForSelector('#cfOperatorWorkspace', { state: 'attached', timeout: 60_000 });
  await page.waitForFunction(() => Boolean(globalThis.CloudflareOperatorWorkspace)
    && Boolean(globalThis.CloudflareCsvProductUI)
    && Boolean(globalThis.CloudflareNativeAPI), null, { timeout: 60_000 });
  await page.waitForSelector('#cfOperatorStore', { state: 'attached', timeout: 30_000 });
}

async function currentStoreId(page) {
  return String(await page.evaluate(() => globalThis.CloudflareOperatorWorkspace?.currentStoreId?.() || '') || '').trim();
}

async function waitForStore(page, storeId) {
  await page.waitForFunction((expected) => {
    const workspace = globalThis.CloudflareOperatorWorkspace?.currentStoreId?.();
    const product = globalThis.CloudflareCsvProductUI?.currentStoreId?.();
    return String(workspace || '') === expected && String(product || '') === expected;
  }, storeId, { timeout: 30_000 });
}

async function waitForReviewSettled(page, storeId) {
  await page.waitForFunction((expected) => {
    const root = document.querySelector('#cfAdvisoryReviewPanel');
    const header = root?.querySelector('.cfAdvisoryTopline span')?.textContent?.trim() || '';
    const refresh = root?.querySelector('[data-review-action="refresh"]');
    return root && !root.hidden && header === expected && refresh && refresh.disabled === false;
  }, storeId, { timeout: 30_000 });
}

async function reviewRowIds(page) {
  return page.locator('#cfAdvisoryReviewPanel [data-review-id]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-review-id') || ''),
  );
}

async function installAmazonBlocker(context, sink) {
  await context.route('**/*', async (route) => {
    let host = '';
    try { host = new URL(route.request().url()).hostname.toLowerCase(); } catch {}
    if (AMAZON_HOST.test(host)) {
      sink.push({ method: route.request().method(), url: route.request().url() });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}

function monitorPage(page, target) {
  page.on('pageerror', (error) => target.pageErrors.push(scrub(error?.message || String(error))));
  page.on('console', (message) => {
    if (message.type() === 'error') target.consoleErrors.push(scrub(message.text()));
  });
}

async function cleanupTemporaryIdentity() {
  const errors = [];
  await bestEffort(errors, 'store_members', async () => {
    await controlDb.prepare(`DELETE FROM store_members WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
  });
  await bestEffort(errors, 'user', async () => {
    await controlDb.prepare(`DELETE FROM users WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
  });
  await bestEffort(errors, 'role_permissions', async () => {
    await controlDb.prepare(`DELETE FROM role_permissions WHERE role_key=?1`).bind(ROLE_KEY).run();
  });
  await bestEffort(errors, 'role', async () => {
    await controlDb.prepare(`DELETE FROM app_roles WHERE role_key=?1 AND is_system=0`).bind(ROLE_KEY).run();
  });
  await bestEffort(errors, 'access_policy', async () => {
    if (targetApp?.id && accessPolicy?.id) {
      await cf(`/access/apps/${encodeURIComponent(targetApp.id)}/policies/${encodeURIComponent(accessPolicy.id)}`, { method: 'DELETE' });
    }
  });
  await bestEffort(errors, 'service_token', async () => {
    if (serviceToken?.id) await cf(`/access/service_tokens/${encodeURIComponent(serviceToken.id)}`, { method: 'DELETE' });
  });
  receipt.cleanup.operations = errors.length ? errors : ['all_cleanup_operations_completed'];
  if (errors.length) throw new Error(`LIVE_RUNTIME_CLEANUP_ERRORS:${errors.join('|')}`);
}

async function verifyCleanup() {
  const verification = {
    storeMemberships: await count(controlDb, `SELECT COUNT(*) AS count FROM store_members WHERE user_id=?1`, PRINCIPAL_USER_ID),
    rolePermissions: await count(controlDb, `SELECT COUNT(*) AS count FROM role_permissions WHERE role_key=?1`, ROLE_KEY),
    roles: await count(controlDb, `SELECT COUNT(*) AS count FROM app_roles WHERE role_key=?1`, ROLE_KEY),
    users: await count(controlDb, `SELECT COUNT(*) AS count FROM users WHERE user_id=?1`, PRINCIPAL_USER_ID),
    accessPolicies: await countNamedAccessPolicies(),
    serviceTokens: await countNamedServiceTokens(),
  };
  receipt.cleanup.verification = verification;
  for (const [key, value] of Object.entries(verification)) assert.equal(value, 0, `temporary resource leaked: ${key}=${value}`);
  receipt.cleanup.verifiedZero = true;
}

async function count(db, sql, ...params) {
  const statement = db.prepare(sql);
  const row = params.length ? await statement.bind(...params).first() : await statement.first();
  return Number(row?.count ?? -1);
}

async function countNamedAccessPolicies() {
  if (!targetApp?.id) return 0;
  const policies = await cf(`/access/apps/${encodeURIComponent(targetApp.id)}/policies?per_page=100`);
  return (Array.isArray(policies.result) ? policies.result : []).filter((item) => item?.name === ACCESS_POLICY_NAME).length;
}

async function countNamedServiceTokens() {
  const tokens = await cf('/access/service_tokens?per_page=100');
  return (Array.isArray(tokens.result) ? tokens.result : []).filter((item) => item?.name === SERVICE_TOKEN_NAME).length;
}

async function cf(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const code = payload?.errors?.[0]?.code || response.status;
    const message = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`cloudflare_api_failed:${path}:${code}:${scrub(message)}`);
  }
  return payload;
}

async function bestEffort(errors, name, operation) {
  try { await operation(); }
  catch (error) { errors.push(`${name}:${scrub(error?.message || String(error))}`); }
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrub(value) {
  let text = String(value || '');
  if (API_TOKEN) text = text.split(API_TOKEN).join('[REDACTED_API_TOKEN]');
  if (serviceToken?.client_secret) text = text.split(serviceToken.client_secret).join('[REDACTED_SERVICE_SECRET]');
  return text.replace(/[\r\n\t]+/g, ' ').trim();
}

function redactReceipt(value) {
  return JSON.parse(JSON.stringify(value, (key, current) => /secret|apiToken/i.test(key) ? '[REDACTED]' : current));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
