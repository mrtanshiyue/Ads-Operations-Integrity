'use strict';

const { chromium } = require('playwright');

const originalLaunch = chromium.launch.bind(chromium);

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
    if (!developmentContext) return context;

    const originalNewPage = context.newPage.bind(context);
    context.newPage = async (...pageArgs) => {
      const page = await originalNewPage(...pageArgs);
      const originalGoto = page.goto.bind(page);
      page.goto = async (url, gotoOptions) => {
        const response = await originalGoto(url, gotoOptions);
        const devBaseUrl = String(process.env.DEV_BASE_URL || '').replace(/\/$/, '');
        const target = String(url || '').replace(/\/$/, '');
        if (devBaseUrl && target === devBaseUrl) {
          await page.waitForFunction(() => {
            const api = globalThis.CloudflareOperatorWorkspace;
            return Boolean(api && typeof api.currentStoreId === 'function' && api.currentStoreId());
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
