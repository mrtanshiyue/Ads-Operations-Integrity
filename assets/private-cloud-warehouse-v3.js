(() => {
  'use strict';

  // Compatibility bootstrap retained for historical HTML references.
  // The production implementation has a single source of truth in
  // assets/private-cloud-warehouse-v4.js.
  const marker = 'warehouseV4LoaderRequested';
  if (document.documentElement.dataset[marker] === '1') return;
  document.documentElement.dataset[marker] = '1';

  const script = document.createElement('script');
  script.src = new URL('assets/private-cloud-warehouse-v4.js', document.baseURI).href;
  script.defer = true;
  script.dataset.warehouseLoader = 'v4-production';
  script.onerror = () => {
    document.documentElement.dataset[marker] = '0';
    console.error('Cloud Warehouse V4 production loader could not be loaded.');
  };
  document.head.appendChild(script);
})();
