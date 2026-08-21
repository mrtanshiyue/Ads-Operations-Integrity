import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE_URL = process.env.DEV_BASE_URL || 'https://ads-operations-web-dev.tanshiyuesir.workers.dev';
const EXPECTED_MAIN_SHA = '0557f4eaeae2e0a749d49653844f7ce8e1579f17';
const OUT = 'artifacts/live-229-browser-acceptance';
await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'live-229-browser-acceptance-v1',
  target: BASE_URL,
  expectedMainSha: EXPECTED_MAIN_SHA,
  startedAt: new Date().toISOString(),
  browser: 'chromium',
  scope: null,
  checks: {},
  amazonRequests: [],
  consoleErrors: [],
  result: 'FAIL',
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();

page.on('console', (message) => {
  if (message.type() === 'error') receipt.consoleErrors.push(message.text().slice(0, 1000));
});
page.on('request', (request) => {
  try {
    const url = new URL(request.url());
    const host = url.hostname.toLowerCase();
    if (/(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i.test(host)) {
      receipt.amazonRequests.push({ method: request.method(), url: request.url() });
    }
  } catch {}
});

try {
  const response = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  assert(response, 'Dev root returned no navigation response');
  assert.equal(response.status(), 200, `Dev root expected 200, got ${response.status()}`);
  receipt.checks.devRoot200 = true;

  await page.waitForSelector('#cfDecisionPanel', { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(globalThis.CloudflareCsvRecommendationInboxUsability), null, { timeout: 60_000 });
  receipt.checks.decisionPanelRendered = true;

  const runtimeEvidence = await page.evaluate(async () => {
    const res = await fetch('/__deployment-health', { cache: 'no-store' }).catch(() => null);
    if (!res) return null;
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  receipt.runtimeEvidence = runtimeEvidence;

  const storeId = await page.waitForFunction(() => {
    const a = globalThis.CloudflareOperatorContext?.getContext?.().storeId;
    const b = globalThis.CloudflareOperatorWorkspace?.currentStoreId?.();
    return String(a || b || '').trim() || false;
  }, null, { timeout: 30_000 }).then((handle) => handle.jsonValue());
  assert(storeId, 'No live Dev store id resolved');
  receipt.storeId = storeId;

  const source = page.locator('#cfDecisionPanel [name="dataSource"]');
  if (await source.count()) {
    const options = await source.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value));
    if (options.includes('csv')) await source.selectOption('csv');
  }

  const candidateScope = await findCandidateScope(page, storeId);
  assert(candidateScope, 'No real Dev date window produced >=11 governed emitted candidates with complete scope');
  receipt.scope = candidateScope;

  await setScope(page, candidateScope);
  const section = page.locator('[data-csv-recommendation-inbox-workspace]');
  await section.waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-csv-recommendation-inbox-workspace] tr[data-cfri-item]').length >= 11, null, { timeout: 60_000 });
  receipt.checks.realCandidateScope = true;

  const currentKey = `cfri:presentation:v1:${storeId}:recommendation-inbox`;
  const foreignStoreKey = 'cfri:presentation:v1:foreign-store:recommendation-inbox';
  const foreignWorkspaceKey = `cfri:presentation:v1:${storeId}:other-workspace`;
  const foreignValue = JSON.stringify({ sort: 'sales', search: 'FOREIGN_SENTINEL', pageSize: 100 });
  await page.evaluate(({ currentKey, foreignStoreKey, foreignWorkspaceKey, foreignValue }) => {
    localStorage.removeItem(currentKey);
    localStorage.setItem(foreignStoreKey, foreignValue);
    localStorage.setItem(foreignWorkspaceKey, foreignValue);
  }, { currentKey, foreignStoreKey, foreignWorkspaceKey, foreignValue });

  const pageSize = section.locator('[data-cfri-page-size]');
  await pageSize.selectOption('10');
  await section.locator('[data-cfri-filter="sort"]').selectOption('spend');
  await page.waitForTimeout(150);

  const storageAfterInteraction = await page.evaluate(({ currentKey, foreignStoreKey, foreignWorkspaceKey }) => ({
    current: localStorage.getItem(currentKey),
    foreignStore: localStorage.getItem(foreignStoreKey),
    foreignWorkspace: localStorage.getItem(foreignWorkspaceKey),
  }), { currentKey, foreignStoreKey, foreignWorkspaceKey });
  assert(storageAfterInteraction.current, 'Current store presentation state was not persisted');
  const storedCurrent = JSON.parse(storageAfterInteraction.current);
  assert.equal(storedCurrent.pageSize, 10);
  assert.equal(storedCurrent.sort, 'spend');
  assert.equal(storageAfterInteraction.foreignStore, foreignValue);
  assert.equal(storageAfterInteraction.foreignWorkspace, foreignValue);
  receipt.checks.namespacedLocalStorage = true;
  receipt.checks.storeWorkspaceNamespaceIsolation = true;

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#cfDecisionPanel', { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(globalThis.CloudflareCsvRecommendationInboxUsability), null, { timeout: 60_000 });
  await setScope(page, candidateScope);
  const sectionReloaded = page.locator('[data-csv-recommendation-inbox-workspace]');
  await sectionReloaded.waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-csv-recommendation-inbox-workspace] tr[data-cfri-item]').length >= 11, null, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const section = document.querySelector('[data-csv-recommendation-inbox-workspace]');
    return section?.querySelector('[data-cfri-page-size]')?.value === '10'
      && section?.querySelector('[data-cfri-filter="sort"]')?.value === 'spend';
  }, null, { timeout: 10_000 });
  receipt.checks.reloadPresentationRestore = true;

  const totalRows = await sectionReloaded.locator('tr[data-cfri-item]').count();
  assert(totalRows >= 11, `Need >=11 real candidates for pagination, got ${totalRows}`);
  await page.waitForFunction(() => !document.querySelector('[data-cfri-page-next]')?.disabled, null, { timeout: 10_000 });
  await sectionReloaded.locator('[data-cfri-page-next]').click();
  await page.waitForFunction(() => /Page 2 of /.test(document.querySelector('[data-cfri-page-number]')?.textContent || ''), null, { timeout: 10_000 });
  await sectionReloaded.locator('[data-cfri-page-previous]').click();
  await page.waitForFunction(() => /Page 1 of /.test(document.querySelector('[data-cfri-page-number]')?.textContent || ''), null, { timeout: 10_000 });
  receipt.checks.paginationPreviousNext = true;
  receipt.checks.pageSizeInteraction = true;

  await sectionReloaded.locator('[data-cfri-page-next]').click();
  await page.waitForFunction(() => /Page 2 of /.test(document.querySelector('[data-cfri-page-number]')?.textContent || ''), null, { timeout: 10_000 });
  const search = sectionReloaded.locator('[data-cfri-filter="search"]');
  await search.fill('__LIVE_229_ZERO_RESULT_SENTINEL__');
  await page.waitForFunction(() => /Page 1 of 1/.test(document.querySelector('[data-cfri-page-number]')?.textContent || ''), null, { timeout: 10_000 });
  receipt.checks.filterChangeResetsPage = true;
  await page.waitForFunction(() => document.querySelector('[data-cfri-empty-state="filters_zero"]'), null, { timeout: 10_000 });
  receipt.checks.clientFilterZeroResult = true;

  await search.fill('');
  await page.waitForFunction(() => document.querySelectorAll('[data-csv-recommendation-inbox-workspace] tr[data-cfri-item]').length >= 11, null, { timeout: 10_000 });
  const firstRow = sectionReloaded.locator('tr[data-cfri-item]').first();
  const inboxItemId = await firstRow.getAttribute('data-cfri-item');
  const buttons = firstRow.locator('button');
  const buttonTexts = (await buttons.allTextContents()).map((text) => text.trim()).filter(Boolean);
  receipt.firstRowButtons = buttonTexts;
  let clickedPresentationState = false;
  for (let i = 0; i < buttonTexts.length; i += 1) {
    if (/detail|evidence|view|acknowledge|needs review|reviewed/i.test(buttonTexts[i])) {
      await buttons.nth(i).click();
      clickedPresentationState = true;
      await page.waitForTimeout(100);
      break;
    }
  }
  assert(clickedPresentationState, `Could not find a safe review/view/details control in first row: ${buttonTexts.join(', ')}`);

  const storageAfterReviewView = await page.evaluate((key) => localStorage.getItem(key), currentKey);
  assert(storageAfterReviewView, 'Presentation state disappeared after review/view interaction');
  const parsedAfterReviewView = JSON.parse(storageAfterReviewView);
  const allowedKeys = new Set(['priority', 'candidateType', 'lifecycle', 'root', 'reviewState', 'search', 'sort', 'pageSize']);
  assert.deepEqual(Object.keys(parsedAfterReviewView).filter((key) => !allowedKeys.has(key)), []);
  const rawLower = storageAfterReviewView.toLowerCase();
  if (inboxItemId) assert(!rawLower.includes(inboxItemId.toLowerCase()), 'Inbox item id leaked into localStorage');
  assert(!rawLower.includes('viewed'), 'viewed state leaked into localStorage');
  assert(!rawLower.includes('acknowledged'), 'acknowledged state leaked into localStorage');
  assert(!rawLower.includes('needs_review'), 'needs_review state leaked into localStorage');
  receipt.checks.reviewViewedNotPersisted = true;

  assert.equal(receipt.amazonRequests.length, 0, `Amazon network request observed: ${JSON.stringify(receipt.amazonRequests)}`);
  receipt.checks.amazonRequestsZero = true;

  await page.screenshot({ path: `${OUT}/dev-inbox-final.png`, fullPage: true });
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

async function findCandidateScope(page, storeId) {
  const dates = Array.from({ length: 30 }, (_, index) => `2026-06-${String(index + 1).padStart(2, '0')}`);
  const windows = [];
  for (const length of [1, 2, 3, 4, 5, 7]) {
    for (let start = 0; start + length <= dates.length; start += 1) {
      windows.push({ startDate: dates[start], endDate: dates[start + length - 1] });
    }
  }
  let best = null;
  for (const candidate of windows) {
    const probe = await page.evaluate(async ({ storeId, candidate }) => {
      const params = new URLSearchParams({ source: 'csv', startDate: candidate.startDate, endDate: candidate.endDate, limit: '50', sort: 'cost' });
      const res = await fetch(`/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence?${params}`, { cache: 'no-store', credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      const p = body?.productization || {};
      const scope = p.analysisScope || p.recommendationInbox?.analysisScope || {};
      const items = Array.isArray(p.recommendationInbox?.items) ? p.recommendationInbox.items : [];
      return {
        status: res.status,
        complete: scope.complete === true,
        financiallyComparable: scope.financiallyComparable === true,
        candidateEmissionAuthorized: scope.candidateEmissionAuthorized === true,
        reviewCandidateCount: Number(p.recommendationInbox?.summary?.reviewCandidateCount ?? items.length ?? 0),
        itemCount: items.length,
        reasons: scope.reasons || [],
      };
    }, { storeId, candidate });
    const scored = { ...candidate, ...probe };
    if (!best || scored.itemCount > best.itemCount) best = scored;
    if (probe.status === 200 && probe.complete && probe.candidateEmissionAuthorized && probe.itemCount >= 11) return scored;
  }
  console.error('Best real candidate scope found but insufficient for pagination:', best);
  return null;
}

async function setScope(page, scope) {
  const panel = page.locator('#cfDecisionPanel');
  const start = panel.locator('[name="startDate"]');
  const end = panel.locator('[name="endDate"]');
  assert(await start.count(), 'startDate control missing');
  assert(await end.count(), 'endDate control missing');
  await start.fill(scope.startDate);
  await end.fill(scope.endDate);
  const limit = panel.locator('[name="limit"]');
  if (await limit.count()) {
    const tag = await limit.evaluate((el) => el.tagName);
    if (tag === 'SELECT') {
      const options = await limit.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value));
      if (options.includes('50')) await limit.selectOption('50');
    } else await limit.fill('50');
  }
  const sort = panel.locator('[name="sort"]');
  if (await sort.count()) {
    const options = await sort.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value));
    if (options.includes('cost')) await sort.selectOption('cost');
  }
  await page.evaluate(() => globalThis.CloudflareCsvRecommendationInboxUi?.refresh?.());
}
