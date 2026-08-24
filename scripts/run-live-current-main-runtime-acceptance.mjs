import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const DEV_BASE_URL = (process.env.DEV_BASE_URL || 'https://ads-operations-web-dev.tanshiyuesir.workers.dev').replace(/\/$/, '');
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/live-current-main-runtime-acceptance';
const DEV_SERVICE_TOKEN_NAME = `ads-ops-live-runtime-dev-${RUN_ID}`;
const DEV_ACCESS_POLICY_NAME = `Dev live runtime acceptance ${RUN_ID}`;
const AMAZON_HOST = /(^|\.)amazon\.com$|(^|\.)amazonaws\.com$|advertising-api|sellingpartnerapi|amazon-ads-api/i;

await mkdir(OUT, { recursive: true });

const wrapperReceipt = {
  schemaVersion: 'live-current-main-dev-access-wrapper-v1',
  runId: RUN_ID,
  target: DEV_BASE_URL,
  startedAt: new Date().toISOString(),
  diagnostics: {
    amazonRequests: [],
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    badResponses: [],
  },
  temporaryResources: {},
  cleanup: {},
  result: 'FAIL',
};

let devAccessApp = null;
let devServiceToken = null;
let devAccessPolicy = null;
let failure = null;
let childExitCode = null;

try {
  await provisionDevelopmentAccess();
  await diagnoseDevelopmentSurface();
  childExitCode = await runCanonicalAcceptanceHarness();
  wrapperReceipt.childExitCode = childExitCode;
  assert.equal(childExitCode, 0, `canonical acceptance harness exited ${childExitCode}`);
  wrapperReceipt.result = 'PASS';
} catch (error) {
  failure = error;
  wrapperReceipt.error = {
    message: scrub(error?.message || String(error)),
    stack: scrub(String(error?.stack || '')).slice(0, 12000),
  };
} finally {
  try {
    await cleanupDevelopmentAccess();
    await verifyDevelopmentAccessCleanup();
  } catch (cleanupError) {
    wrapperReceipt.cleanup.error = scrub(cleanupError?.message || String(cleanupError));
    wrapperReceipt.result = 'FAIL';
    if (!failure) failure = cleanupError;
  }

  wrapperReceipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/development-access-wrapper.json`, `${JSON.stringify(wrapperReceipt, null, 2)}\n`);
  await augmentCanonicalReceipt();
  console.log(JSON.stringify(redact(wrapperReceipt), null, 2));
}

if (failure) throw failure;

async function provisionDevelopmentAccess() {
  const apps = await cf('/access/apps');
  const devHost = new URL(DEV_BASE_URL).hostname.toLowerCase();
  devAccessApp = (Array.isArray(apps.result) ? apps.result : []).find(
    (app) => String(app?.domain || '').toLowerCase() === devHost,
  );
  assert(devAccessApp?.id, `Development Access app not found for ${devHost}`);
  wrapperReceipt.temporaryResources.accessAppId = devAccessApp.id;

  devServiceToken = (await cf('/access/service_tokens', {
    method: 'POST',
    body: { name: DEV_SERVICE_TOKEN_NAME, duration: '1h', enabled: true },
  })).result;
  assert(devServiceToken?.id && devServiceToken?.client_id && devServiceToken?.client_secret,
    'Development Cloudflare Access service token response incomplete');
  wrapperReceipt.temporaryResources.serviceTokenId = devServiceToken.id;

  devAccessPolicy = (await cf(`/access/apps/${encodeURIComponent(devAccessApp.id)}/policies`, {
    method: 'POST',
    body: {
      name: DEV_ACCESS_POLICY_NAME,
      decision: 'non_identity',
      include: [{ service_token: { token_id: devServiceToken.id } }],
    },
  })).result;
  assert(devAccessPolicy?.id, 'Development Cloudflare Access acceptance policy response incomplete');
  wrapperReceipt.temporaryResources.accessPolicyId = devAccessPolicy.id;
}

async function diagnoseDevelopmentSurface() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    extraHTTPHeaders: {
      'CF-Access-Client-Id': devServiceToken.client_id,
      'CF-Access-Client-Secret': devServiceToken.client_secret,
    },
  });
  await context.route('**/*', async (route) => {
    let host = '';
    try { host = new URL(route.request().url()).hostname.toLowerCase(); } catch {}
    if (AMAZON_HOST.test(host)) {
      wrapperReceipt.diagnostics.amazonRequests.push({ method: route.request().method(), url: route.request().url() });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  const page = await context.newPage();
  monitorDiagnosticPage(page);
  try {
    const nav = await page.goto(DEV_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    wrapperReceipt.diagnostics.navigation = {
      status: nav?.status() ?? null,
      url: page.url(),
      contentType: nav?.headers()?.['content-type'] || '',
    };
    assert(nav, 'Development diagnostic root returned no navigation response');
    assert.equal(nav.status(), 200, `Development diagnostic root expected 200, got ${nav.status()}`);

    try {
      await page.waitForSelector('#cfOperatorWorkspace', { state: 'attached', timeout: 30_000 });
      await page.waitForFunction(() => Boolean(globalThis.CloudflareOperatorWorkspace)
        && Boolean(globalThis.CloudflareCsvProductUI)
        && Boolean(globalThis.CloudflareNativeAPI), null, { timeout: 30_000 });
    } catch (error) {
      await captureDevelopmentFingerprint(page);
      throw error;
    }

    await captureDevelopmentFingerprint(page);
    assert.equal(wrapperReceipt.diagnostics.fingerprint?.selectors?.sidebar, true,
      'Development canonical .sidebar missing after Access service auth');
    assert.equal(wrapperReceipt.diagnostics.fingerprint?.selectors?.operatorWorkspace, true,
      'Development #cfOperatorWorkspace missing after Access service auth');
    assert.equal(wrapperReceipt.diagnostics.fingerprint?.globals?.CloudflareOperatorWorkspace, true,
      'Development CloudflareOperatorWorkspace global missing');
    assert.equal(wrapperReceipt.diagnostics.fingerprint?.globals?.CloudflareNativeAPI, true,
      'Development CloudflareNativeAPI global missing');
    assert.equal(wrapperReceipt.diagnostics.fingerprint?.globals?.CloudflareCsvProductUI, true,
      'Development CloudflareCsvProductUI global missing');
    assert.equal(wrapperReceipt.diagnostics.amazonRequests.length, 0,
      'Development diagnostic browser attempted an Amazon network request');
    wrapperReceipt.diagnostics.canonicalShellConfirmed = true;
  } finally {
    try {
      await page.screenshot({ path: `${OUT}/development-surface-diagnostic.png`, fullPage: true });
    } catch {}
    await context.close();
    await browser.close();
  }
}

async function captureDevelopmentFingerprint(page) {
  wrapperReceipt.diagnostics.fingerprint = await page.evaluate(() => {
    const bodyText = String(document.body?.innerText || '');
    const html = String(document.documentElement?.outerHTML || '');
    const title = String(document.title || '');
    const accessLike = /cloudflare access|sign in|one-time pin|cloudflare zero trust/i.test(`${title}\n${bodyText}`)
      || /cloudflareaccess\.com/i.test(location.href);
    return {
      url: location.href,
      title,
      readyState: document.readyState,
      bodyClassName: document.body?.className || '',
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '',
      bodyTextPrefix: bodyText.slice(0, 5000),
      htmlPrefix: html.slice(0, 5000),
      selectors: {
        app: Boolean(document.querySelector('.app')),
        sidebar: Boolean(document.querySelector('.sidebar')),
        operatorWorkspace: Boolean(document.querySelector('#cfOperatorWorkspace')),
        operatorStore: Boolean(document.querySelector('#cfOperatorStore')),
      },
      globals: {
        CloudflareOperatorWorkspace: Boolean(globalThis.CloudflareOperatorWorkspace),
        CloudflareNativeAPI: Boolean(globalThis.CloudflareNativeAPI),
        CloudflareCsvProductUI: Boolean(globalThis.CloudflareCsvProductUI),
        csvProductUiVersion: globalThis.CloudflareCsvProductUI?.version || '',
      },
      scripts: Array.from(document.scripts).map((node) => node.src || '[inline]').slice(0, 200),
      accessLike,
    };
  });
}

function monitorDiagnosticPage(page) {
  page.on('pageerror', (error) => wrapperReceipt.diagnostics.pageErrors.push(scrub(error?.message || String(error))));
  page.on('console', (message) => {
    if (message.type() === 'error') wrapperReceipt.diagnostics.consoleErrors.push(scrub(message.text()));
  });
  page.on('requestfailed', (request) => {
    wrapperReceipt.diagnostics.failedRequests.push({
      method: request.method(),
      url: request.url(),
      errorText: scrub(request.failure()?.errorText || ''),
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      wrapperReceipt.diagnostics.badResponses.push({
        status: response.status(),
        url: response.url(),
        resourceType: response.request().resourceType(),
      });
    }
  });
}

async function runCanonicalAcceptanceHarness() {
  const hookPath = path.resolve('scripts/live-current-main-dev-access-hook.cjs');
  const existingNodeOptions = String(process.env.NODE_OPTIONS || '').trim();
  const nodeOptions = [existingNodeOptions, `--require=${hookPath}`].filter(Boolean).join(' ');
  const env = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    DEV_CF_ACCESS_CLIENT_ID: devServiceToken.client_id,
    DEV_CF_ACCESS_CLIENT_SECRET: devServiceToken.client_secret,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/live-current-main-runtime-acceptance.mjs'], {
      stdio: 'inherit',
      env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`canonical acceptance harness terminated by ${signal}`));
      else resolve(Number(code ?? 1));
    });
  });
}

async function cleanupDevelopmentAccess() {
  const errors = [];
  await bestEffort(errors, 'development_access_policy', async () => {
    if (devAccessApp?.id && devAccessPolicy?.id) {
      await cf(`/access/apps/${encodeURIComponent(devAccessApp.id)}/policies/${encodeURIComponent(devAccessPolicy.id)}`, { method: 'DELETE' });
    }
  });
  await bestEffort(errors, 'development_service_token', async () => {
    if (devServiceToken?.id) await cf(`/access/service_tokens/${encodeURIComponent(devServiceToken.id)}`, { method: 'DELETE' });
  });
  wrapperReceipt.cleanup.operations = errors.length ? errors : ['all_cleanup_operations_completed'];
  if (errors.length) throw new Error(`DEV_ACCESS_CLEANUP_ERRORS:${errors.join('|')}`);
}

async function verifyDevelopmentAccessCleanup() {
  const policies = devAccessApp?.id
    ? await cf(`/access/apps/${encodeURIComponent(devAccessApp.id)}/policies?per_page=100`)
    : { result: [] };
  const tokens = await cf('/access/service_tokens?per_page=100');
  const accessPolicies = (Array.isArray(policies.result) ? policies.result : [])
    .filter((item) => item?.name === DEV_ACCESS_POLICY_NAME).length;
  const serviceTokens = (Array.isArray(tokens.result) ? tokens.result : [])
    .filter((item) => item?.name === DEV_SERVICE_TOKEN_NAME).length;
  wrapperReceipt.cleanup.verification = { accessPolicies, serviceTokens };
  assert.equal(accessPolicies, 0, `temporary Development Access policy leaked: ${accessPolicies}`);
  assert.equal(serviceTokens, 0, `temporary Development service token leaked: ${serviceTokens}`);
  wrapperReceipt.cleanup.verifiedZero = true;
}

async function augmentCanonicalReceipt() {
  const receiptPath = `${OUT}/receipt.json`;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch {
    return;
  }

  parsed.temporaryResources = parsed.temporaryResources || {};
  parsed.temporaryResources.developmentAccessAppId = devAccessApp?.id || null;
  parsed.temporaryResources.developmentAccessPolicyId = devAccessPolicy?.id || null;
  parsed.temporaryResources.developmentServiceTokenId = devServiceToken?.id || null;
  parsed.development = parsed.development || {};
  parsed.development.surfaceDiagnostic = {
    navigation: wrapperReceipt.diagnostics.navigation || null,
    canonicalShellConfirmed: wrapperReceipt.diagnostics.canonicalShellConfirmed === true,
    fingerprint: wrapperReceipt.diagnostics.fingerprint || null,
    failedRequests: wrapperReceipt.diagnostics.failedRequests,
    badResponses: wrapperReceipt.diagnostics.badResponses,
  };
  parsed.cleanup = parsed.cleanup || {};
  parsed.cleanup.verification = parsed.cleanup.verification || {};
  parsed.cleanup.verification.developmentAccessPolicies = Number(wrapperReceipt.cleanup.verification?.accessPolicies ?? -1);
  parsed.cleanup.verification.developmentServiceTokens = Number(wrapperReceipt.cleanup.verification?.serviceTokens ?? -1);
  parsed.cleanup.developmentAccessVerifiedZero = wrapperReceipt.cleanup.verifiedZero === true;
  if (failure || wrapperReceipt.cleanup.verifiedZero !== true) {
    parsed.result = 'FAIL';
    parsed.error = parsed.error || { message: scrub(failure?.message || 'Development Access wrapper failed') };
  }
  await writeFile(receiptPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function cf(pathname, { method = 'GET', body = null } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${pathname}`, {
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
    throw new Error(`cloudflare_api_failed:${pathname}:${code}:${scrub(message)}`);
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

function scrub(value) {
  let text = String(value || '');
  if (API_TOKEN) text = text.split(API_TOKEN).join('[REDACTED_API_TOKEN]');
  if (devServiceToken?.client_secret) text = text.split(devServiceToken.client_secret).join('[REDACTED_DEV_SERVICE_SECRET]');
  return text.replace(/[\r\n\t]+/g, ' ').trim();
}

function redact(value) {
  return JSON.parse(JSON.stringify(value, (key, current) => /secret|apiToken/i.test(key) ? '[REDACTED]' : current));
}
