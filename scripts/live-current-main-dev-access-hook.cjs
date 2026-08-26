'use strict';

const { appendFileSync, mkdirSync } = require('node:fs');
const { chromium } = require('playwright');

const originalLaunch = chromium.launch.bind(chromium);
const diagnosticDir = 'artifacts/live-current-main-runtime-acceptance';
const diagnosticPath = `${diagnosticDir}/browser-http-errors.jsonl`;
mkdirSync(diagnosticDir, { recursive: true });

chromium.launch = async (...args) => {
  const browser = await originalLaunch(...args);
  const originalNewContext = browser.newContext.bind(browser);

  browser.newContext = async (options = {}) => {
    let developmentContext = false;
    if (!options.extraHTTPHeaders) {
      const clientId = String(process.env.DEV_CF_ACCESS_CLIENT_ID || '').trim();
      const clientSecret = String(process.env.DEV_CF_ACCESS_CLIENT_SECRET || '').trim();
      if (clientId && clientSecret) {
        developmentContext = true;
        options = {
          ...options,
          extraHTTPHeaders: {
            'CF-Access-Client-Id': clientId,
            'CF-Access-Client-Secret': clientSecret,
          },
        };
      }
    }

    const context = await originalNewContext(options);
    const originalNewPage = context.newPage.bind(context);

    context.newPage = async (...pageArgs) => {
      const page = await originalNewPage(...pageArgs);
      const originalGoto = page.goto.bind(page);
      const originalLocator = page.locator.bind(page);

      page.on('response', async (response) => {
        if (response.status() < 400) return;
        const request = response.request();
        let environment = 'other';
        let parsedUrl = null;
        try {
          parsedUrl = new URL(response.url());
          const host = parsedUrl.hostname.toLowerCase();
          if (host === new URL(process.env.DEV_BASE_URL || 'https://invalid.example').hostname.toLowerCase()) environment = 'development';
          if (host === new URL(process.env.PROD_BASE_URL || 'https://invalid.example').hostname.toLowerCase()) environment = 'production';
        } catch {}
        const record = {
          environment,
          status: response.status(),
          method: request.method(),
          url: response.url(),
          resourceType: request.resourceType(),
          contentType: response.headers()['content-type'] || '',
          cfRay: response.headers()['cf-ray'] || '',
        };
        if (environment === 'development' && response.status() === 403 && parsedUrl?.pathname === '/api/v1/session' && record.contentType.includes('application/json')) {
          try {
            const payload = await response.json();
            record.session = {
              error: typeof payload?.error === 'string' ? payload.error : '',
              authenticated: payload?.authenticated === true,
              provisioned: payload?.provisioned === true,
              principalType: typeof payload?.identity?.principalType === 'string' ? payload.identity.principalType : '',
            };
          } catch {}
        }
        appendFileSync(diagnosticPath, `${JSON.stringify(record)}\n`, 'utf8');
        console.log(`LIVE_HTTP_ERROR ${JSON.stringify(record)}`);
      });

      page.locator = (selector, locatorOptions) => {
        if (selector === '#cfAdvisoryReviewPanel [data-review-action="close"]') {
          return originalLocator('#cfAdvisoryReviewPanel button[data-review-action="close"]', locatorOptions);
        }
        return originalLocator(selector, locatorOptions);
      };

      page.goto = async (url, gotoOptions) => {
        const response = await originalGoto(url, gotoOptions);
        const target = String(url || '').replace(/\/$/, '');
        const devBaseUrl = String(process.env.DEV_BASE_URL || '').replace(/\/$/, '');
        const prodBaseUrl = String(process.env.PROD_BASE_URL || '').replace(/\/$/, '');

        if (developmentContext && devBaseUrl && target === devBaseUrl) {
          await page.waitForFunction(() => {
            const api = globalThis.CloudflareOperatorWorkspace;
            return Boolean(api && typeof api.currentStoreId === 'function' && api.currentStoreId());
          }, null, { timeout: 30_000 });
        }

        if (!developmentContext && prodBaseUrl && target === prodBaseUrl) {
          await page.waitForFunction(() => {
            const select = document.querySelector('#cfOperatorStore');
            const values = Array.from(select?.options || [])
              .map((option) => String(option.value || '').trim())
              .filter(Boolean);
            return values.length >= 2;
          }, null, { timeout: 30_000 });
        }

        return response;
      };

      return page;
    };

    return context;
  };

  return browser;
};
