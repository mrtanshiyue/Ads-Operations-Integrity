import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.DEV_BASE_URL || 'https://ads-operations-web-dev.tanshiyuesir.workers.dev';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const evidence = { responses: [], errors: [] };

page.on('response', async (res) => {
  if (!res.url().includes('/search-term-intelligence')) return;
  let body = {};
  try { body = await res.json(); } catch {}
  evidence.responses.push({
    url: res.url(),
    status: res.status(),
    scope: body?.productization?.analysisScope || body?.productization?.recommendationInbox?.analysisScope || null,
    inboxCount: body?.productization?.recommendationInbox?.items?.length ?? null,
    error: body?.error || null,
  });
});
page.on('console', (msg) => { if (msg.type() === 'error') evidence.errors.push(msg.text()); });

async function open() {
  await page.waitForSelector('#cfDecisionPanel', { state: 'attached', timeout: 60000 });
  await page.waitForFunction(() => Boolean(globalThis.CloudflareCsvIntelligence) && Boolean(globalThis.CloudflareCsvRecommendationInboxUsability), null, { timeout: 60000 });
  const panel = page.locator('#cfDecisionPanel');
  if (!await panel.isVisible()) await page.getByRole('button', { name: 'Decision Intelligence', exact: true }).click();
  await panel.waitFor({ state: 'visible', timeout: 15000 });
  const source = panel.locator('[name="dataSource"]');
  if (await source.count()) await source.selectOption('csv');
}

async function run(label) {
  const panel = page.locator('#cfDecisionPanel');
  await panel.locator('[name="startDate"]').fill('2026-06-01');
  await panel.locator('[name="endDate"]').fill('2026-06-01');
  const limit = panel.locator('[name="limit"]');
  if (await limit.count()) {
    if (await limit.evaluate((el) => el.tagName) === 'SELECT') await limit.selectOption('50');
    else await limit.fill('50');
  }
  const before = evidence.responses.length;
  await panel.getByRole('button', { name: 'Run preview', exact: true }).click();
  await page.waitForFunction((n) => globalThis.__dummy || n < 0, before, { timeout: 50 }).catch(() => {});
  await page.waitForTimeout(5000);
  const workspace = await panel.locator('[data-csv-operator-workspace]').count();
  const status = await panel.locator('[data-status]').textContent().catch(() => '');
  console.log(JSON.stringify({ label, workspace, status, newResponses: evidence.responses.slice(before) }, null, 2));
  return workspace;
}

try {
  const nav = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  assert.equal(nav?.status(), 200);
  await open();
  const first = await run('before_reload');
  assert(first > 0, 'before_reload workspace missing');
  const storeId = await page.evaluate(() => String(globalThis.CloudflareOperatorContext?.getContext?.().storeId || globalThis.CloudflareOperatorWorkspace?.currentStoreId?.() || ''));
  const key = `cfri:presentation:v1:${storeId}:recommendation-inbox`;
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ priority:'',candidateType:'',lifecycle:'',root:'',reviewState:'',search:'',sort:'spend',pageSize:10 })), key);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await open();
  const second = await run('after_reload');
  console.log(JSON.stringify({ final: { first, second }, evidence }, null, 2));
  if (!second) process.exitCode = 2;
} finally {
  await browser.close();
}
