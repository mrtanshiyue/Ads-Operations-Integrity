(function initCloudflareNativeDataPanel(global) {
  'use strict';

  const VERSION = '1.0.0';
  const SHOPS = Object.freeze(['ALL', 'YTDBNS', 'YY', 'JJ']);
  const SHOP_LABELS = Object.freeze({
    ALL: '全部店铺',
    YTDBNS: 'YT 店铺',
    YY: 'YY 店铺',
    JJ: 'JJ 店铺',
  });
  const SHOP_SHORT_LABELS = Object.freeze({ ALL: 'ALL', YTDBNS: 'YT', YY: 'YY', JJ: 'JJ' });
  const SHOP_STORAGE_KEY = 'lr_active_shop_scope';
  const RAW_NOT_MIGRATED = 'cloudflare_native_raw_import_not_migrated';

  const state = {
    loading: false,
    connected: false,
    scope: 'ALL',
    from: '',
    to: '',
    lastOverview: null,
    lastError: null,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function normalizeShop(value) {
    const shop = String(value || '').trim().toUpperCase();
    return SHOPS.includes(shop) ? shop : 'ALL';
  }

  function readStoredShop() {
    try {
      return normalizeShop(global.localStorage?.getItem(SHOP_STORAGE_KEY));
    } catch (_) {
      return 'ALL';
    }
  }

  function writeStoredShop(value) {
    try {
      global.localStorage?.setItem(SHOP_STORAGE_KEY, value);
    } catch (_) {}
  }

  let activeShop = readStoredShop();

  function installShopScope() {
    global.ACTIVE_SHOP = activeShop;
    Object.defineProperty(global, 'ShopScope', {
      value: Object.freeze({
        version: 'cloudflare-native-1.0.0',
        options: SHOPS,
        labels: SHOP_LABELS,
        shortLabels: SHOP_SHORT_LABELS,
        display: value => SHOP_SHORT_LABELS[normalizeShop(value)],
        get: () => activeShop,
        set: value => setActiveShop(value, { source: 'api' }),
      }),
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  function setActiveShop(value, options = {}) {
    const next = normalizeShop(value);
    const changed = next !== activeShop;
    activeShop = next;
    state.scope = next;
    global.ACTIVE_SHOP = next;
    writeStoredShop(next);
    syncShopUi();
    if (changed || options.force) {
      global.dispatchEvent?.(new CustomEvent('lr:shop-change', {
        detail: {
          shop: next,
          label: SHOP_LABELS[next],
          source: options.source || 'cloudflare-native-data-panel',
        },
      }));
    }
    if (changed && state.connected && !options.silent) {
      void loadOverview({ reason: 'shop-change' });
    }
    return next;
  }

  function bridge() {
    const value = global.CloudflareNativeQueryBridge;
    if (!value || typeof value.overview !== 'function') {
      const error = new Error('cloudflare_native_query_bridge_not_ready');
      error.status = 503;
      error.code = 'cloudflare_native_query_bridge_not_ready';
      throw error;
    }
    return value;
  }

  function ensureStyles() {
    if (byId('cloudflareNativeDataPanelStyles')) return;
    const style = document.createElement('style');
    style.id = 'cloudflareNativeDataPanelStyles';
    style.textContent = `
      #privateCloudImportPanel{display:grid;gap:9px;width:100%;min-width:0;margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
      #privateCloudImportPanel .nativeDataPanelHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      #privateCloudImportPanel .nativeDataPanelTitle{font-size:12.5px;font-weight:800;color:var(--text)}
      #privateCloudImportPanel .nativeDataPanelSub{margin-top:2px;font-size:10.5px;line-height:1.4;color:var(--muted)}
      #privateCloudImportPanel .nativeDataPanelBadge{padding:3px 7px;border-radius:999px;background:var(--chip);font-size:9.5px;font-weight:700;color:var(--accent);white-space:nowrap}
      #privateCloudImportPanel .nativeShopSwitch{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}
      #privateCloudImportPanel .nativeShopButton{border:1px solid var(--line);border-radius:9px;background:var(--input-bg);padding:7px 5px;color:var(--muted);font-size:10.5px;font-weight:700;cursor:pointer}
      #privateCloudImportPanel .nativeShopButton.active{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,var(--card))}
      #privateCloudImportPanel .nativeDataActions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}
      #privateCloudImportPanel .nativeDataActions .btn{justify-content:center;padding:8px 10px;border-radius:10px;font-size:11px}
      #privateCloudImportStatus{min-height:16px;font-size:10.5px;line-height:1.4;color:var(--muted);overflow-wrap:anywhere}
      #privateCloudImportStatus[data-kind="good"]{color:var(--good)}
      #privateCloudImportStatus[data-kind="warn"]{color:var(--warn)}
      #privateCloudImportStatus[data-kind="bad"]{color:var(--bad)}
      #queryFirstOverviewCard{display:none;gap:7px;padding:9px;border:1px solid var(--line);border-radius:10px;background:var(--input-bg)}
      #queryFirstOverviewCard[data-ready="1"]{display:grid}
      #queryFirstOverviewMeta{font-size:10px;color:var(--muted)}
      #queryFirstKpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
      #queryFirstKpis .nativeKpi{padding:7px;border-radius:9px;background:var(--chip);min-width:0}
      #queryFirstKpis .nativeKpiLabel{font-size:9.5px;color:var(--muted)}
      #queryFirstKpis .nativeKpiValue{margin-top:2px;font-size:12px;font-weight:800;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #nativeRawBoundary{padding:8px;border:1px dashed var(--line);border-radius:9px;font-size:10px;line-height:1.45;color:var(--muted)}
      @media(max-width:420px){#privateCloudImportPanel .nativeShopSwitch{grid-template-columns:repeat(2,minmax(0,1fr))}#privateCloudImportPanel .nativeDataActions{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensureUi() {
    ensureStyles();
    let panel = byId('privateCloudImportPanel');
    if (!panel) {
      const input = byId('fileInput');
      if (!input) return null;
      panel = document.createElement('div');
      panel.id = 'privateCloudImportPanel';
      input.insertAdjacentElement('afterend', panel);
    }
    if (panel.dataset.nativeDataPanelReady === '1') return panel;

    panel.dataset.nativeDataPanelReady = '1';
    panel.innerHTML = `
      <div class="nativeDataPanelHeader">
        <div>
          <div class="nativeDataPanelTitle">Cloudflare Native 数据</div>
          <div class="nativeDataPanelSub">同源 API · D1/R2 · Cloudflare Access 会话</div>
        </div>
        <span class="nativeDataPanelBadge">NATIVE</span>
      </div>
      <div class="nativeShopSwitch" id="nativeShopSwitch" role="radiogroup" aria-label="分析店铺范围">
        ${SHOPS.map(shop => `<button class="nativeShopButton" type="button" role="radio" data-shop="${shop}">${SHOP_SHORT_LABELS[shop]}</button>`).join('')}
      </div>
      <div class="nativeDataActions">
        <button class="btn primary" id="btnPrivateCloudImport" type="button">↻ 刷新 Native 概览</button>
        <button class="btn" id="btnPrivateCloudLogout" type="button">清除视图</button>
      </div>
      <div id="privateCloudImportStatus">Cloudflare Native · 尚未读取概览</div>
      <div id="queryFirstOverviewCard" data-ready="0">
        <div id="queryFirstOverviewMeta"></div>
        <div id="queryFirstKpis"></div>
      </div>
      <div id="nativeRawBoundary">云端 Raw 导入在 Native 架构中尚未迁移，因此保持关闭；本地文件导入入口不受影响。</div>
    `;

    panel.addEventListener('click', event => {
      const shopButton = event.target?.closest?.('[data-shop]');
      if (shopButton && panel.contains(shopButton)) {
        setActiveShop(shopButton.dataset.shop, { source: 'data-panel' });
        return;
      }
      const action = event.target?.closest?.('#btnPrivateCloudImport, #btnPrivateCloudLogout');
      if (!action) return;
      if (action.id === 'btnPrivateCloudImport') void loadOverview({ reason: 'manual' });
      else clearView();
    });

    syncShopUi();
    return panel;
  }

  function syncShopUi() {
    document.querySelectorAll('#privateCloudImportPanel [data-shop]').forEach(button => {
      const selected = normalizeShop(button.dataset.shop) === activeShop;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
    document.documentElement.dataset.activeShop = activeShop;
  }

  function canonicalDate(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? '' : text;
  }

  function dateRange() {
    let from = canonicalDate(byId('dateStart')?.value);
    let to = canonicalDate(byId('dateEnd')?.value);
    if (from && to && from <= to) return { from, to };

    const end = new Date();
    const start = new Date(end.getTime() - (29 * 86400000));
    to = end.toISOString().slice(0, 10);
    from = start.toISOString().slice(0, 10);
    return { from, to };
  }

  function setStatus(message, kind = '') {
    const element = byId('privateCloudImportStatus');
    if (!element) return;
    element.textContent = message;
    element.dataset.kind = kind;
  }

  function setBusy(value) {
    state.loading = value;
    const button = byId('btnPrivateCloudImport');
    if (button) {
      button.disabled = value;
      button.textContent = value ? '正在读取 Native 概览…' : '↻ 刷新 Native 概览';
    }
    document.querySelectorAll('#privateCloudImportPanel [data-shop]').forEach(button => {
      button.disabled = value;
    });
  }

  function money(value) {
    return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function integer(value) {
    return Number(value || 0).toLocaleString('en-US');
  }

  function renderOverview(payload) {
    const card = byId('queryFirstOverviewCard');
    const meta = byId('queryFirstOverviewMeta');
    const kpis = byId('queryFirstKpis');
    if (!card || !meta || !kpis) return;

    const totals = payload?.totals || {};
    const spend = Number(totals.spend || 0);
    const sales = Number(totals.sales || 0);
    const acos = sales > 0 ? spend / sales : null;
    meta.textContent = `${SHOP_SHORT_LABELS[activeShop]} · ${state.from} → ${state.to} · query-cloudflare-d1`;
    const rows = [
      ['广告销售', money(sales)],
      ['广告花费', money(spend)],
      ['ACOS', acos === null ? '—' : `${(acos * 100).toFixed(2)}%`],
      ['点击', integer(totals.clicks)],
      ['订单', integer(totals.orders)],
      ['销量', integer(totals.units)],
    ];
    kpis.innerHTML = rows.map(([label, value]) => `
      <div class="nativeKpi"><div class="nativeKpiLabel">${label}</div><div class="nativeKpiValue">${value}</div></div>
    `).join('');
    card.dataset.ready = '1';
  }

  function renderEmpty() {
    const card = byId('queryFirstOverviewCard');
    const meta = byId('queryFirstOverviewMeta');
    const kpis = byId('queryFirstKpis');
    if (card) card.dataset.ready = '0';
    if (meta) meta.textContent = '';
    if (kpis) kpis.replaceChildren();
  }

  async function loadOverview(options = {}) {
    if (state.loading) return null;
    ensureUi();
    const range = dateRange();
    state.scope = activeShop;
    state.from = range.from;
    state.to = range.to;
    state.lastError = null;
    setBusy(true);
    setStatus(`正在读取 ${SHOP_SHORT_LABELS[activeShop]} · ${range.from} → ${range.to} Native 概览…`);

    try {
      const payload = await bridge().overview({
        scope: activeShop,
        from: range.from,
        to: range.to,
        grain: 'day',
      });
      state.connected = true;
      state.lastOverview = payload;
      renderOverview(payload);
      setStatus(`Native 概览已就绪 · ${SHOP_SHORT_LABELS[activeShop]} · ${range.from} → ${range.to}`, 'good');
      const detail = {
        source: 'query-cloudflare-d1',
        scope: activeShop,
        from: range.from,
        to: range.to,
        overview: payload,
        rawLoaded: false,
        rawCloudImportReady: false,
        reason: options.reason || 'manual',
      };
      global.dispatchEvent?.(new CustomEvent('lr:cloud-overview-ready', { detail }));
      return detail;
    } catch (error) {
      state.lastError = String(error?.code || error?.message || error || 'native_overview_failed');
      setStatus(`Native 概览读取失败：${state.lastError}`, 'bad');
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function clearView() {
    state.connected = false;
    state.lastOverview = null;
    state.lastError = null;
    try { bridge().clearCache?.(); } catch (_) {}
    renderEmpty();
    setStatus('Native 查询视图与内存缓存已清除', 'good');
    return true;
  }

  function rawNotMigrated() {
    const error = new Error(RAW_NOT_MIGRATED);
    error.name = 'CloudflareNativeRawImportError';
    error.status = 501;
    error.code = RAW_NOT_MIGRATED;
    setStatus('云端 Raw 导入尚未迁移到 Native；请使用本地文件导入。', 'warn');
    return Promise.reject(error);
  }

  function retiredCredentialMethod() {
    const error = new Error('cloudflare_native_password_credentials_retired');
    error.status = 410;
    error.code = 'cloudflare_native_password_credentials_retired';
    throw error;
  }

  function retiredQueryRequest() {
    const error = new Error('warehouse_path_query_request_retired');
    error.status = 410;
    error.code = 'warehouse_path_query_request_retired';
    return Promise.reject(error);
  }

  function installCompatibilitySurface() {
    const api = Object.freeze({
      version: VERSION,
      source: 'cloudflare-native',
      load: options => loadOverview(options || {}),
      loadOverview: options => loadOverview(options || {}),
      reload: () => loadOverview({ reason: 'reload' }),
      loadRaw: rawNotMigrated,
      loadCurrentMonth: rawNotMigrated,
      loadRecentMonths: rawNotMigrated,
      loadFullHistory: rawNotMigrated,
      setPassword: retiredCredentialMethod,
      clearPassword() { return false; },
      clearCache: clearView,
      queryRequest: retiredQueryRequest,
      query: () => global.PrivateCloudQuery || null,
      apiBase: global.location?.origin || '',
      channel: () => 'cloudflare-native',
      state: () => ({
        loading: state.loading,
        connectedOnce: state.connected,
        connectedScope: state.scope,
        loadedOnce: false,
        rawStale: false,
        rawCloudImportReady: false,
        credentialMode: 'cloudflare-access-session',
        source: 'query-cloudflare-d1',
        from: state.from,
        to: state.to,
        lastError: state.lastError,
      }),
    });
    Object.defineProperty(global, 'PrivateCloudAds', {
      value: api,
      configurable: true,
      enumerable: true,
      writable: false,
    });
    Object.defineProperty(global, 'CloudflareNativeDataPanel', {
      value: api,
      configurable: false,
      enumerable: true,
      writable: false,
    });
  }

  function init() {
    installShopScope();
    installCompatibilitySurface();
    ensureUi();
    setActiveShop(activeShop, { silent: true, force: true, source: 'initialization' });
    global.__CLOUDFLARE_NATIVE_DATA_PANEL_VERSION__ = VERSION;
    global.dispatchEvent?.(new CustomEvent('lr:native-data-panel-ready', {
      detail: { version: VERSION, source: 'cloudflare-native' },
    }));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(window);
