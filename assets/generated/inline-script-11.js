(() => {
  'use strict';
  const SHOP_UI_VERSION = '1.1.0';
  const SHOPS = Object.freeze(['ALL','YTDBNS','YY','JJ']);
  const SHOP_SHORT_LABELS = Object.freeze({ALL:'ALL',YTDBNS:'YT',YY:'YY',JJ:'JJ'});
  const SHOP_LABELS = Object.freeze({ALL:'全部店铺',YTDBNS:'YT 店铺',YY:'YY 店铺',JJ:'JJ 店铺'});
  const STORAGE_KEY = 'lr_active_shop_scope';
  const normalizeShop = value => {
    const shop = String(value || '').trim().toUpperCase();
    return SHOPS.includes(shop) ? shop : 'ALL';
  };
  const storage = {
    get: () => { try { return localStorage.getItem(STORAGE_KEY) || 'ALL'; } catch (_) { return 'ALL'; } },
    set: value => { try { localStorage.setItem(STORAGE_KEY, value); } catch (_) {} }
  };
  let activeShop = normalizeShop(storage.get());

  const progressiveNodeIds = Object.freeze([
    'queryFirstRawActions',
    'queryFirstOverviewCard',
  ]);

  const collectProgressiveNodes = () => progressiveNodeIds
    .map(id => document.getElementById(id))
    .filter(Boolean);

  const directChild = (panel, selector) => [...panel.children]
    .find(child => child.matches(selector)) || null;

  const restoreProgressiveNodes = (panel, suppliedNodes = null) => {
    const nodes = suppliedNodes || collectProgressiveNodes();
    const statusRow = directChild(panel, '.cloudStatusRow');
    for (const node of nodes) panel.insertBefore(node, statusRow || null);
    panel.dataset.shopUiVersion = SHOP_UI_VERSION;
    return nodes.length;
  };

  const syncShopUi = shop => {
    document.querySelectorAll('#privateCloudImportPanel [data-shop]').forEach(button => {
      const selected = button.dataset.shop === shop;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
    const hint = document.getElementById('activeShopHint');
    if (hint) hint.textContent = `当前：${SHOP_SHORT_LABELS[shop]} · ${SHOP_LABELS[shop]}`;
    document.documentElement.dataset.activeShop = shop;
  };

  const setActiveShop = (value, options = {}) => {
    const next = normalizeShop(value);
    const changed = next !== activeShop;
    activeShop = next;
    storage.set(next);
    syncShopUi(next);
    window.ACTIVE_SHOP = next;
    if (changed || options.force) {
      window.dispatchEvent(new CustomEvent('lr:shop-change', {
        detail: { shop: next, label: SHOP_LABELS[next], source: options.source || 'shop-selector' }
      }));
    }
    if (!options.silent && changed) {
      try {
        if (typeof notify === 'function') notify(`分析店铺已切换为 ${SHOP_SHORT_LABELS[next]} · ${SHOP_LABELS[next]}`, 'good');
      } catch (_) {}
    }
    return next;
  };

  const mount = () => {
    const panel = document.getElementById('privateCloudImportPanel');
    const loadButton = document.getElementById('btnPrivateCloudImport');
    const logoutButton = document.getElementById('btnPrivateCloudLogout');
    const status = document.getElementById('privateCloudImportStatus');
    if (!panel || !loadButton || !logoutButton || !status) return false;
    if (panel.dataset.shopUiReady === '1') {
      restoreProgressiveNodes(panel);
      syncShopUi(activeShop);
      return true;
    }

    const progressiveNodes = collectProgressiveNodes();
    loadButton.textContent = '☁ 加载私有云数据';
    logoutButton.textContent = '清除密码';
    const shell = document.createElement('div');
    shell.innerHTML = `
      <div class="cloudPanelHeader">
        <div class="cloudPanelIcon" aria-hidden="true">☁</div>
        <div class="cloudPanelCopy">
          <div class="cloudPanelTitle">私有云数据</div>
          <div class="cloudPanelSub">选择分析店铺，再安全读取广告、交易与成本数据</div>
        </div>
        <span class="cloudProviderBadge">CLOUDFLARE</span>
      </div>
      <div class="shopScopeCard">
        <div class="shopScopeHead">
          <span class="shopScopeLabel">店铺范围</span>
          <span id="activeShopHint"></span>
        </div>
        <div class="shopScopeSwitch" role="radiogroup" aria-label="分析店铺范围">
          ${SHOPS.map(shop => `<button class="shopScopeButton" type="button" role="radio" data-shop="${shop}" aria-label="${SHOP_LABELS[shop]}">${SHOP_SHORT_LABELS[shop]}</button>`).join('')}
        </div>
      </div>
      <div class="privateCloudActions">
        <span data-slot="load"></span>
        <span data-slot="logout"></span>
      </div>
      <div class="cloudStatusRow">
        <span class="cloudStatusDot" aria-hidden="true"></span>
        <span data-slot="status"></span>
      </div>`;

    shell.querySelector('[data-slot="load"]').replaceWith(loadButton);
    shell.querySelector('[data-slot="logout"]').replaceWith(logoutButton);
    shell.querySelector('[data-slot="status"]').replaceWith(status);
    panel.replaceChildren(...shell.childNodes);
    restoreProgressiveNodes(panel, progressiveNodes);
    panel.dataset.shopUiReady = '1';
    panel.addEventListener('click', event => {
      const button = event.target.closest('[data-shop]');
      if (!button || !panel.contains(button)) return;
      setActiveShop(button.dataset.shop, { source: 'data-import-panel' });
    });
    setActiveShop(activeShop, { silent: true, force: true, source: 'initialization' });
    return true;
  };

  const init = () => {
    let attempts = 0;
    const tryMount = () => {
      if (mount()) return;
      attempts += 1;
      if (attempts < 120) requestAnimationFrame(tryMount);
    };
    tryMount();
    window.ShopScope = Object.freeze({
      version: SHOP_UI_VERSION,
      options: SHOPS,
      labels: SHOP_LABELS,
      shortLabels: SHOP_SHORT_LABELS,
      display: value => SHOP_SHORT_LABELS[normalizeShop(value)],
      get: () => activeShop,
      set: value => setActiveShop(value, { source: 'api' })
    });
    window.__SHOP_SCOPE_UI_VERSION__ = SHOP_UI_VERSION;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
