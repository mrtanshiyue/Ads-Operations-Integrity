(() => {
  'use strict';

  const HOST_VERSION = '1.0.0';
  const hostGuard = {
    __queryNativeTrendHostGuard: true,
    data: { labels: [], datasets: [] },
    options: {},
    update() {},
    resize() {},
    destroy() {},
  };

  const installRawCompatibilityBridge = () => {
    try {
      const debug = window.AdsDashboardApp?.debug;
      if (!debug || typeof debug.getAdsRowsForQueryCompatibility === 'function') return;
      if (typeof AdsStore === 'undefined') return;
      debug.getAdsRowsForQueryCompatibility = () => Array.isArray(AdsStore?.all) ? AdsStore.all : [];
    } catch (error) {
      console.warn('Query-native Raw compatibility bridge was not installed:', error);
    }
  };

  const installHostGuard = () => {
    try {
      if (typeof trendChart === 'undefined') return false;
      if (trendChart && trendChart !== hostGuard && !trendChart.__queryNativeTrendHostGuard) {
        try { trendChart.destroy?.(); } catch (_) {}
      }
      trendChart = hostGuard;
      return true;
    } catch (error) {
      console.warn('Query-native trend host guard was not installed:', error);
      return false;
    }
  };

  const install = () => {
    installRawCompatibilityBridge();
    installHostGuard();
  };

  const scheduleInstall = () => {
    queueMicrotask(install);
    setTimeout(install, 0);
  };

  document.addEventListener('change', installHostGuard, true);
  document.addEventListener('input', event => {
    if (event.target?.id === 'filterSearchTerm') installHostGuard();
  }, true);
  document.addEventListener('click', event => {
    if (event.target?.closest?.('[data-exec-trend-mode], #btnTheme, [data-theme-choice]')) installHostGuard();
  }, true);
  window.addEventListener('lr:query-native-trend-ready', scheduleInstall);
  window.addEventListener('lr:query-native-trend-error', scheduleInstall);
  window.addEventListener('lr:query-native-assets-ready', scheduleInstall);
  window.addEventListener('lr:shop-change', scheduleInstall);

  window.QueryNativeAdsTrendHost = Object.freeze({
    version: HOST_VERSION,
    install,
    hasRawBridge: () => typeof window.AdsDashboardApp?.debug?.getAdsRowsForQueryCompatibility === 'function',
    guarded: () => {
      try { return typeof trendChart !== 'undefined' && trendChart === hostGuard; }
      catch (_) { return false; }
    },
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
