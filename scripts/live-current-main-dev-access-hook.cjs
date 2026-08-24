'use strict';

const { chromium } = require('playwright');

const originalLaunch = chromium.launch.bind(chromium);

chromium.launch = async (...args) => {
  const browser = await originalLaunch(...args);
  const originalNewContext = browser.newContext.bind(browser);

  browser.newContext = async (options = {}) => {
    if (!options.extraHTTPHeaders) {
      const clientId = String(process.env.DEV_CF_ACCESS_CLIENT_ID || '').trim();
      const clientSecret = String(process.env.DEV_CF_ACCESS_CLIENT_SECRET || '').trim();
      if (clientId && clientSecret) {
        options = {
          ...options,
          extraHTTPHeaders: {
            'CF-Access-Client-Id': clientId,
            'CF-Access-Client-Secret': clientSecret,
          },
        };
      }
    }
    return originalNewContext(options);
  };

  return browser;
};
