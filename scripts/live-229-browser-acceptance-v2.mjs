import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE_URL = process.env.DEV_BASE_URL || 'https://ads-operations-web-dev.tanshiyuesir.workers.dev';
const EXPECTED_WORKER_VERSION = '93a2ac62-70f3-44c5-89dc-a502b4ff62f1';
const OUT = 'artifacts/live-229-browser-acceptance';
const SCOPE = Object.freeze({ startDate: '2026-06-01', endDate: '2026-06-01' });
await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'live-229-browser-acceptance-v2',
  target: BASE_URL,
  expectedCanonicalMain: '0557f4eaeae2e0a749d49653844f7ce8e1579f17',
  expectedWorkerVersion: EXPECTED_WORKER_VERSION,
  browser: 'chromium',
  startedAt: new Date().toISOString(),
  scope: SCOPE,
  checks: {},
  previewResponses: [],
  amazonRequests: [],
  unexpected4xx: [],
  result: 'FAIL',
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();

page.on('request', (request) => {
  try {
    const host = new URL(request.url()).hostname.toLowerCase();
    if (/(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(host)) {
      receipt.amazonRequests.push({ method: request.method(), url: request.url() });
    }
  } catch {}
});
page.on('response', (response) => {
  if (response.status() >= 400 && response.status() < 500) {
    receipt.unexpected4xx.push({ status: response.status(), url: response.url() });
  }
});

try {
  const nav = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert(nav, 'Dev root returned no navigation response');
  assert.equal(nav.status(), 200, `Dev root expected 200, got ${nav.status()}`);
  receipt.rootHeaders = await nav.allHeaders();
  const rootWorkerVersion = receipt.rootHeaders['x-runtime-worker-version'] || '';
  if (rootWorkerVersion) assert.equal(rootWorkerVersion, EXPECTED_WORKER_VERSION, `Unexpected Dev worker version ${rootWorkerVersion}`);
  receipt.checks.devRoot200 = true;
  receipt.checks.devWorkerVersion = rootWorkerVersion || 'header_not_exposed';

  const storeId = await ready(page);
  receipt.storeId = storeId;
  await assertRealScope(page, storeId);
  await runPreview(page, storeId, 'initial');
  await waitInboxRows(page, 11);
  receipt.checks.realCandidateScope = true;

  const section = page.locator('[data-csv-recommendation-inbox-workspace]');
  const currentKey = `cfri:presentation:v1:${storeId}:recommendation-inbox`;
  const foreignStoreKey = 'cfri:presentation:v1:foreign-store:recommendation-inbox';
  const foreignWorkspaceKey = `cfri:presentation:v1:${storeId}:other-workspace`;
  const sentinel = JSON.stringify({ search: 'FOREIGN_SENTINEL', sort: 'sales', pageSize: 100 });
  await page.evaluate(({ currentKey, foreignStoreKey, foreignWorkspaceKey, sentinel }) => {
    localStorage.removeItem(currentKey);
    localStorage.setItem(foreignStoreKey, sentinel);
    localStorage.setItem(foreignWorkspaceKey, sentinel);
  }, { currentKey, foreignStoreKey, foreignWorkspaceKey, sentinel });

  await section.locator('[data-cfri-page-size]').selectOption('10');
  await section.locator('[data-cfri-filter="sort"]').selectOption('spend');
  await page.waitForTimeout(250);
  const storage1 = await readStorage(page, currentKey, foreignStoreKey, foreignWorkspaceKey);
  assert(storage1.current, 'Current namespace presentation state missing');
  const currentState = JSON.parse(storage1.current);
  assert.equal(currentState.pageSize, 10);
  assert.equal(currentState.sort, 'spend');
  assert.equal(storage1.foreignStore, sentinel, 'Foreign store namespace was modified');
  assert.equal(storage1.foreignWorkspace, sentinel, 'Foreign workspace namespace was modified');
  receipt.checks.namespacedLocalStorageRestoreSeeded = true;
  receipt.checks.storeWorkspaceNamespaceIsolation = true;

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  const reloadStoreId = await ready(page);
  assert.equal(reloadStoreId, storeId, 'Store context changed across reload');
  await runPreview(page, reloadStoreId, 'after_reload');
  await waitInboxRows(page, 11);
  await page.waitForFunction(() => {
    const section = document.querySelector('[data-csv-recommendation-inbox-workspace]');
    return section?.querySelector('[data-cfri-page-size]')?.value === '10'
      && section?.querySelector('[data-cfri-filter="sort"]')?.value === 'spend';
  }, null, { timeout: 15_000 });
  receipt.checks.reloadPresentationFiltersRestore = true;

  const reloaded = page.locator('[data-csv-recommendation-inbox-workspace]');
  const rowCount = await reloaded.locator('tr[data-cfri-item]').count();
  assert(rowCount >= 11, `Expected >=11 real candidates, got ${rowCount}`);
  assert.equal(await reloaded.locator('[data-cfri-page-size]').inputValue(), '10');
  receipt.checks.pageSizeInteraction = true;

  const next = reloaded.locator('[data-cfri-page-next]');
  const previous = reloaded.locator('[data-cfri-page-previous]');
  assert.equal(await next.isDisabled(), false, 'Next should be enabled with 12 candidates at page size 10');
  await next.click();
  await expectPage(page, 2);
  await previous.click();
  await expectPage(page, 1);
  receipt.checks.paginationPreviousNext = true;

  await next.click();
  await expectPage(page, 2);
  const search = reloaded.locator('[data-cfri-filter="search"]');
  await search.fill('__LIVE_229_ZERO_RESULT_SENTINEL__');
  await expectPage(page, 1, 1);
  receipt.checks.filterChangeResetsPage = true;
  await page.waitForSelector('[data-cfri-empty-state="filters_zero"]', { state: 'visible', timeout: 15_000 });
  receipt.checks.clientFilterZeroResultEmptyState = true;

  await search.fill('');
  await waitInboxRows(page, 11);
  const firstRow = reloaded.locator('tr[data-cfri-item]').first();
  const inboxItemId = String(await firstRow.getAttribute('data-cfri-item') || '');
  const evidenceButton = firstRow.locator('[data-cfri-evidence]');
  assert.equal(await evidenceButton.count(), 1, 'Evidence button missing from first real Inbox row');
  await evidenceButton.click();
  await page.waitForSelector('[data-cfri-drawer]:not([hidden])', { state: 'visible', timeout: 10_000 });
  receipt.checks.viewedSessionStateInteraction = true;

  const storage2 = await readStorage(page, currentKey, foreignStoreKey, foreignWorkspaceKey);
  assert(storage2.current, 'Presentation namespace missing after Evidence/view interaction');
  const parsed2 = JSON.parse(storage2.current);
  const allowedKeys = new Set(['priority','candidateType','lifecycle','root','reviewState','search','sort','pageSize']);
  assert.deepEqual(Object.keys(parsed2).filter((key) => !allowedKeys.has(key)), [], 'Non-presentation keys leaked into localStorage');
  const raw = storage2.current.toLowerCase();
  if (inboxItemId) assert(!raw.includes(inboxItemId.toLowerCase()), 'Viewed item identity leaked into localStorage');
  assert(!raw.includes('"viewed"'), 'Viewed state value leaked into localStorage');
  assert(!raw.includes('"acknowledged"'), 'Review acknowledgement leaked into localStorage');
  assert(!raw.includes('"needs_review"'), 'Review state leaked into localStorage');
  assert.equal(storage2.foreignStore, sentinel);
  assert.equal(storage2.foreignWorkspace, sentinel);
  receipt.checks.reviewViewedStateNotPersisted = true;

  assert.equal(receipt.amazonRequests.length, 0, `Amazon network request observed: ${JSON.stringify(receipt.amazonRequests)}`);
  receipt.checks.amazonRequestsZero = true;
  await page.screenshot({ path: `${OUT}/dev-live-pass.png`, fullPage: true });
  receipt.result = 'PASS';
} catch (error) {
  receipt.error = { message: error?.message || String(error), stack: String(error?.stack || '').slice(0, 8000) };
  try { await page.screenshot({ path: `${OUT}/failure.png`, fullPage: true }); } catch {}
  throw error;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  await browser.close();
}

async function ready(page) {
  await page.waitForSelector('#cfDecisionPanel', { state: 'attached', timeout: 60_000 });
  await page.waitForFunction(() => Boolean(globalThis.CloudflareCsvIntelligence)
    && Boolean(globalThis.CloudflareCsvRecommendationInboxUi)
    && Boolean(globalThis.CloudflareCsvRecommendationInboxUsability), null, { timeout: 60_000 });
  const storeId = await page.waitForFunction(() => {
    const value = globalThis.CloudflareOperatorContext?.getContext?.().storeId
      || globalThis.CloudflareOperatorWorkspace?.currentStoreId?.();
    return String(value || '').trim() || false;
  }, null, { timeout: 30_000 }).then((handle) => handle.jsonValue());
  const panel = page.locator('#cfDecisionPanel');
  if (!await panel.isVisible()) {
    const launcher = page.getByRole('button', { name: 'Decision Intelligence', exact: true });
    assert.equal(await launcher.count(), 1, 'Decision Intelligence launcher missing');
    await launcher.click();
  }
  await panel.waitFor({ state: 'visible', timeout: 15_000 });
  const source = panel.locator('[name="dataSource"]');
  if (await source.count()) await source.selectOption('csv');
  return String(storeId);
}

async function assertRealScope(page, storeId) {
  const probe = await page.evaluate(async ({ storeId, scope }) => {
    const params = new URLSearchParams({ source:'csv', startDate:scope.startDate, endDate:scope.endDate, limit:'50', sort:'cost' });
    const res = await fetch(`/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence?${params}`, { credentials:'same-origin', cache:'no-store' });
    const body = await res.json().catch(() => ({}));
    const p = body?.productization || {};
    const s = p.analysisScope || p.recommendationInbox?.analysisScope || {};
    const items = Array.isArray(p.recommendationInbox?.items) ? p.recommendationInbox.items : [];
    return { status:res.status, complete:s.complete === true, financiallyComparable:s.financiallyComparable === true, candidateEmissionAuthorized:s.candidateEmissionAuthorized === true, itemCount:items.length, reviewCandidateCount:Number(p.recommendationInbox?.summary?.reviewCandidateCount ?? items.length), reasons:s.reasons || [] };
  }, { storeId, scope:SCOPE });
  receipt.scopeEvidence = probe;
  assert.equal(probe.status, 200);
  assert.equal(probe.complete, true);
  assert.equal(probe.candidateEmissionAuthorized, true);
  assert(probe.itemCount >= 11, `Real scope has only ${probe.itemCount} candidates`);
}

async function runPreview(page, storeId, phase) {
  const panel = page.locator('#cfDecisionPanel');
  await panel.locator('[name="startDate"]').fill(SCOPE.startDate);
  await panel.locator('[name="endDate"]').fill(SCOPE.endDate);
  const limit = panel.locator('[name="limit"]');
  if (await limit.count()) {
    if (await limit.evaluate((node) => node.tagName) === 'SELECT') await limit.selectOption('50');
    else await limit.fill('50');
  }
  const responsePromise = page.waitForResponse((response) => response.url().includes(`/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence?`) && response.request().method() === 'GET', { timeout: 40_000 });
  await panel.getByRole('button', { name: 'Run preview', exact: true }).click();
  const response = await responsePromise;
  let body = {};
  try { body = await response.json(); } catch {}
  const p = body?.productization || {};
  const scope = p.analysisScope || p.recommendationInbox?.analysisScope || {};
  receipt.previewResponses.push({ phase, status:response.status(), url:response.url(), complete:scope.complete === true, candidateEmissionAuthorized:scope.candidateEmissionAuthorized === true, inboxCount:p.recommendationInbox?.items?.length ?? null, error:body?.error || null });
  assert.equal(response.status(), 200, `${phase} preview returned ${response.status()}`);
  await panel.locator('[data-csv-operator-workspace]').waitFor({ state:'visible', timeout:30_000 });
}

async function waitInboxRows(page, min) {
  await page.locator('[data-csv-recommendation-inbox-workspace]').waitFor({ state:'visible', timeout:30_000 });
  await page.waitForFunction((minimum) => document.querySelectorAll('[data-csv-recommendation-inbox-workspace] tr[data-cfri-item]').length >= minimum, min, { timeout:30_000 });
}

async function readStorage(page, currentKey, foreignStoreKey, foreignWorkspaceKey) {
  return page.evaluate(({ currentKey, foreignStoreKey, foreignWorkspaceKey }) => ({ current:localStorage.getItem(currentKey), foreignStore:localStorage.getItem(foreignStoreKey), foreignWorkspace:localStorage.getItem(foreignWorkspaceKey) }), { currentKey, foreignStoreKey, foreignWorkspaceKey });
}

async function expectPage(page, current, pages = null) {
  await page.waitForFunction(({ current, pages }) => {
    const text = document.querySelector('[data-cfri-page-number]')?.textContent || '';
    return pages === null ? text.startsWith(`Page ${current} of `) : text === `Page ${current} of ${pages}`;
  }, { current, pages }, { timeout:10_000 });
}
