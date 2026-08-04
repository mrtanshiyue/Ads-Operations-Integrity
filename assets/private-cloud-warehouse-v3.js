(() => {
  'use strict';

  // Compatibility bootstrap retained for historical HTML references.
  // The production implementation has a single source of truth in
  // assets/private-cloud-warehouse-v4.js.
  const marker = 'warehouseV4LoaderRequested';
  if (document.documentElement.dataset[marker] === '1') return;
  document.documentElement.dataset[marker] = '1';

  const installProductionGuard = () => {
    if (window.__WAREHOUSE_V4_COMPAT_GUARD_BOUND__) return;
    window.__WAREHOUSE_V4_COMPAT_GUARD_BOUND__ = true;
    document.addEventListener('click', event => {
      const target = event.target?.closest?.('#btnPrivateCloudImport, #btnPrivateCloudLogout');
      if (!target || window.PrivateCloudAds?.channel?.() !== 'warehouse-v4-production') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (target.id === 'btnPrivateCloudImport') {
        window.PrivateCloudAds.load?.({ reason: 'manual' });
      } else {
        window.PrivateCloudAds.clearPassword?.();
        const status = document.getElementById('privateCloudImportStatus');
        if (status) {
          status.textContent = '会话密码已清除；下次加载时需要重新输入';
          status.dataset.kind = 'warn';
        }
      }
    }, true);
  };

  const script = document.createElement('script');
  script.src = new URL('assets/private-cloud-warehouse-v4.js', document.baseURI).href;
  script.defer = true;
  script.dataset.warehouseLoader = 'v4-production';
  script.onload = installProductionGuard;
  script.onerror = () => {
    document.documentElement.dataset[marker] = '0';
    console.error('Cloud Warehouse V4 production loader could not be loaded.');
  };
  document.head.appendChild(script);
})();
