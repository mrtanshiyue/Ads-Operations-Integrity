(function initCloudflareNativeNegativeGovernance(global) {
  'use strict';

  const VERSION = '1.0.0';
  const PAGE_LIMIT = 200;

  function api() {
    if (!global.CloudflareNativeAPI) {
      const error = new Error('cloudflare_native_api_not_ready');
      error.code = 'cloudflare_native_api_not_ready';
      throw error;
    }
    return global.CloudflareNativeAPI;
  }

  function listLibrary(params = {}) {
    return api().listNegativeKeywords({ limit: PAGE_LIMIT, ...params });
  }

  function listStoreScopes(storeId, params = {}) {
    return api().storeNegativeKeywords(storeId, { limit: PAGE_LIMIT, ...params });
  }

  function listProductScopes(storeId, productId, params = {}) {
    return api().productNegativeKeywords(storeId, productId, { limit: PAGE_LIMIT, ...params });
  }

  function putStoreScope(storeId, negativeKeywordId, status = 'active') {
    return api().putStoreNegativeKeyword(storeId, negativeKeywordId, { status });
  }

  function deleteStoreScope(storeId, negativeKeywordId) {
    return api().deleteStoreNegativeKeyword(storeId, negativeKeywordId);
  }

  function putProductScope(storeId, productId, negativeKeywordId, status = 'active') {
    return api().putProductNegativeKeyword(storeId, productId, negativeKeywordId, { status });
  }

  function deleteProductScope(storeId, productId, negativeKeywordId) {
    return api().deleteProductNegativeKeyword(storeId, productId, negativeKeywordId);
  }

  const publicApi = Object.freeze({
    version: VERSION,
    listLibrary,
    listStoreScopes,
    listProductScopes,
    putStoreScope,
    deleteStoreScope,
    putProductScope,
    deleteProductScope,
    mount,
    open,
  });

  Object.defineProperty(global, 'CloudflareNegativeGovernance', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (!global.document) return;
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  const state = {
    mounted: false,
    open: false,
    mode: 'library',
    stores: [],
    storeId: '',
    products: [],
    productId: '',
    capabilities: null,
    rows: [],
    loading: false,
    requestSerial: 0,
    productLoadSerial: 0,
  };

  function mount() {
    if (state.mounted || !global.document?.body) return;
    const host = global.document.querySelector('.bidGovHeaderActions')
      || global.document.querySelector('#btnShowPhraseNegatives')?.parentElement
      || global.document.querySelector('.header .actions');
    if (!host) return;

    state.mounted = true;
    installStyles();

    const button = global.document.createElement('button');
    button.id = 'btnNativeNegativeGovernance';
    button.type = 'button';
    button.className = 'btn primary';
    button.textContent = '否定词治理';
    button.title = '管理全局否定词库的店铺级与产品级作用域';
    button.addEventListener('click', open);
    host.insertBefore(button, host.firstChild);

    const modal = global.document.createElement('div');
    modal.id = 'nativeNegativeGovernanceModal';
    modal.className = 'modalOverlay cfNegGovOverlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'nativeNegativeGovernanceTitle');
    modal.innerHTML = `
      <div class="largeModal cfNegGovModal">
        <div class="largeModalHeader cfNegGovHeader">
          <div>
            <div class="cfNegGovEyebrow">CLOUDFLARE NATIVE GOVERNANCE</div>
            <h2 id="nativeNegativeGovernanceTitle">否定关键词作用域治理</h2>
            <div class="small">全局词库 → 店铺作用域 → 产品作用域。这里只管理治理状态，不触发广告同步。</div>
          </div>
          <div class="cfNegGovHeaderActions">
            <span class="cfNegGovAccess" id="cfNegGovAccess">权限检查中</span>
            <button class="btn" id="btnCfNegGovRefresh" type="button">刷新</button>
            <button class="btn" id="btnCfNegGovClose" type="button">关闭</button>
          </div>
        </div>
        <div class="largeModalBody cfNegGovBody">
          <div class="cfNegGovControls">
            <label>店铺<select id="cfNegGovStore"></select></label>
            <label>产品<select id="cfNegGovProduct"></select></label>
            <label>匹配<select id="cfNegGovMatch"><option value="">全部</option><option value="PHRASE">PHRASE</option><option value="EXACT">EXACT</option></select></label>
            <label>关键词状态<select id="cfNegGovKeywordStatus"><option value="active">active</option><option value="retired">retired</option><option value="">全部</option></select></label>
            <label>Scope 状态<select id="cfNegGovScopeStatus"><option value="">全部</option><option value="active">active</option><option value="disabled">disabled</option></select></label>
            <label class="cfNegGovSearch">搜索<input id="cfNegGovSearch" type="search" placeholder="keyword / normalized term" maxlength="200"/></label>
          </div>
          <div class="cfNegGovTabs" role="tablist" aria-label="否定关键词治理视图">
            <button class="segBtn active" data-cf-neg-mode="library" type="button" role="tab">全局词库</button>
            <button class="segBtn" data-cf-neg-mode="store" type="button" role="tab">店铺作用域</button>
            <button class="segBtn" data-cf-neg-mode="product" type="button" role="tab">产品作用域</button>
          </div>
          <div class="cfNegGovStatus" id="cfNegGovStatus" aria-live="polite"></div>
          <div class="table-container cfNegGovTableWrap">
            <table class="cfNegGovTable">
              <thead><tr><th>关键词</th><th>匹配</th><th>原因</th><th>词库状态</th><th>Scope</th><th>操作</th></tr></thead>
              <tbody id="cfNegGovRows"></tbody>
            </table>
          </div>
          <div class="small cfNegGovFoot">单页最多 200 条。写操作需要 <code>negatives.manage</code>；只读权限仍可查看。</div>
        </div>
      </div>`;
    global.document.body.appendChild(modal);

    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    global.document.querySelector('#btnCfNegGovClose')?.addEventListener('click', close);
    global.document.querySelector('#btnCfNegGovRefresh')?.addEventListener('click', refresh);
    global.document.querySelector('#cfNegGovStore')?.addEventListener('change', onStoreChange);
    global.document.querySelector('#cfNegGovProduct')?.addEventListener('change', onProductChange);
    global.document.querySelector('#cfNegGovMatch')?.addEventListener('change', refresh);
    global.document.querySelector('#cfNegGovKeywordStatus')?.addEventListener('change', refresh);
    global.document.querySelector('#cfNegGovScopeStatus')?.addEventListener('change', refresh);
    global.document.querySelector('#cfNegGovSearch')?.addEventListener('input', debounce(refresh, 250));
    for (const tab of global.document.querySelectorAll('[data-cf-neg-mode]')) {
      tab.addEventListener('click', () => setMode(tab.dataset.cfNegMode));
    }
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) close();
    });
  }

  async function open() {
    if (!state.mounted) mount();
    const modal = global.document?.querySelector('#nativeNegativeGovernanceModal');
    if (!modal) return;
    state.open = true;
    modal.style.display = 'flex';
    await hydrateContext();
    await refresh();
  }

  function close() {
    const modal = global.document?.querySelector('#nativeNegativeGovernanceModal');
    if (modal) modal.style.display = 'none';
    state.open = false;
  }

  async function hydrateContext() {
    setBusy(true, '正在加载治理上下文…');
    try {
      const [storesPayload, capabilities] = await Promise.all([
        api().stores(),
        api().capabilities(),
      ]);
      state.capabilities = capabilities || {};
      state.stores = normalizeStores(storesPayload?.stores);
      if (!state.stores.some((item) => item.storeId === state.storeId)) {
        state.storeId = state.stores[0]?.storeId || '';
      }
      renderStores();
      await loadProducts();
      renderAccess();
    } catch (error) {
      setStatus(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function loadProducts() {
    const storeId = state.storeId;
    const serial = ++state.productLoadSerial;
    state.products = [];
    state.productId = '';
    renderProducts();
    if (!storeId) return;
    try {
      const payload = await api().storeProducts(storeId, { limit: PAGE_LIMIT });
      if (serial !== state.productLoadSerial || storeId !== state.storeId) return;
      state.products = normalizeProducts(payload?.items);
      state.productId = state.products[0]?.productId || '';
    } catch (error) {
      if (serial !== state.productLoadSerial || storeId !== state.storeId) return;
      setStatus(`产品列表不可用：${errorText(error)}`, 'warn');
    }
    if (serial !== state.productLoadSerial || storeId !== state.storeId) return;
    renderProducts();
  }

  async function onStoreChange(event) {
    const storeId = String(event.target.value || '');
    state.storeId = storeId;
    state.requestSerial += 1;
    await loadProducts();
    if (storeId !== state.storeId) return;
    renderAccess();
    await refresh();
  }

  async function onProductChange(event) {
    state.productId = String(event.target.value || '');
    await refresh();
  }

  async function setMode(mode) {
    if (!['library', 'store', 'product'].includes(mode)) return;
    state.mode = mode;
    for (const tab of global.document.querySelectorAll('[data-cf-neg-mode]')) {
      const active = tab.dataset.cfNegMode === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    const scopeStatus = global.document.querySelector('#cfNegGovScopeStatus');
    if (scopeStatus) scopeStatus.disabled = mode === 'library';
    await refresh();
  }

  async function refresh() {
    if (!state.open) return;
    const serial = ++state.requestSerial;
    const filters = readFilters();
    setBusy(true, '正在读取治理数据…');
    try {
      let payload;
      if (state.mode === 'library') {
        payload = await listLibrary({
          q: filters.q,
          matchType: filters.matchType,
          status: filters.keywordStatus,
        });
      } else if (state.mode === 'store') {
        if (!state.storeId) return renderEmpty('没有可用店铺');
        payload = await listStoreScopes(state.storeId, {
          q: filters.q,
          matchType: filters.matchType,
          keywordStatus: filters.keywordStatus,
          scopeStatus: filters.scopeStatus,
        });
      } else {
        if (!state.storeId) return renderEmpty('没有可用店铺');
        if (!state.productId) return renderEmpty('当前店铺没有可用产品');
        payload = await listProductScopes(state.storeId, state.productId, {
          q: filters.q,
          matchType: filters.matchType,
          keywordStatus: filters.keywordStatus,
          scopeStatus: filters.scopeStatus,
        });
      }
      if (serial !== state.requestSerial) return;
      state.rows = Array.isArray(payload?.items) ? payload.items : [];
      renderRows();
      setStatus(`已加载 ${state.rows.length} 条 · ${modeLabel(state.mode)}`, 'ok');
    } catch (error) {
      if (serial !== state.requestSerial) return;
      state.rows = [];
      renderRows();
      setStatus(errorText(error), 'bad');
    } finally {
      if (serial === state.requestSerial) setBusy(false);
    }
  }

  function renderRows() {
    const tbody = global.document.querySelector('#cfNegGovRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.rows.length) {
      renderEmpty('当前条件下没有记录');
      return;
    }
    for (const row of state.rows) {
      const tr = global.document.createElement('tr');
      tr.appendChild(cell(primaryText(row)));
      tr.appendChild(cell(row.matchType || '—'));
      tr.appendChild(cell(row.reasonCode || '—'));
      tr.appendChild(cell(row.status || row.keywordStatus || '—'));
      tr.appendChild(cell(state.mode === 'library' ? '—' : (row.scopeStatus || '—')));
      const actionCell = global.document.createElement('td');
      actionCell.className = 'cfNegGovActions';
      appendActions(actionCell, row);
      tr.appendChild(actionCell);
      tbody.appendChild(tr);
    }
  }

  function appendActions(host, row) {
    const id = String(row.negativeKeywordId || '');
    if (!id) return;
    const activeKeyword = (row.status || row.keywordStatus || 'active') === 'active';
    const canManage = canManageStore(state.storeId);
    if (!canManage) {
      const span = global.document.createElement('span');
      span.className = 'small';
      span.textContent = '只读';
      host.appendChild(span);
      return;
    }

    if (state.mode === 'library') {
      host.appendChild(actionButton('启用到店铺', async () => {
        requireStore();
        await putStoreScope(state.storeId, id, 'active');
      }, !state.storeId || !activeKeyword));
      host.appendChild(actionButton('启用到产品', async () => {
        requireProduct();
        await putProductScope(state.storeId, state.productId, id, 'active');
      }, !state.storeId || !state.productId || !activeKeyword));
      return;
    }

    const scopeStatus = row.scopeStatus || 'active';
    const nextStatus = scopeStatus === 'active' ? 'disabled' : 'active';
    host.appendChild(actionButton(nextStatus === 'active' ? '启用' : '停用', async () => {
      if (state.mode === 'store') {
        requireStore();
        await putStoreScope(state.storeId, id, nextStatus);
      } else {
        requireProduct();
        await putProductScope(state.storeId, state.productId, id, nextStatus);
      }
    }, nextStatus === 'active' && !activeKeyword));
    host.appendChild(actionButton('移除', async () => {
      if (state.mode === 'store') {
        requireStore();
        await deleteStoreScope(state.storeId, id);
      } else {
        requireProduct();
        await deleteProductScope(state.storeId, state.productId, id);
      }
    }, false, 'danger'));
  }

  function actionButton(label, operation, disabled, tone = '') {
    const button = global.document.createElement('button');
    button.type = 'button';
    button.className = `btn cfNegGovAction${tone ? ` ${tone}` : ''}`;
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.addEventListener('click', async () => {
      if (button.disabled || state.loading) return;
      setBusy(true, `${label}…`);
      try {
        await operation();
        setStatus(`${label}成功`, 'ok');
        await refresh();
      } catch (error) {
        setStatus(errorText(error), 'bad');
      } finally {
        setBusy(false);
      }
    });
    return button;
  }

  function renderStores() {
    const select = global.document.querySelector('#cfNegGovStore');
    if (!select) return;
    select.replaceChildren();
    for (const store of state.stores) {
      const option = global.document.createElement('option');
      option.value = store.storeId;
      option.textContent = `${store.displayName || store.storeCode || store.storeId} · ${store.marketplaceCode || ''}`.replace(/ · $/, '');
      select.appendChild(option);
    }
    select.value = state.storeId;
  }

  function renderProducts() {
    const select = global.document.querySelector('#cfNegGovProduct');
    if (!select) return;
    select.replaceChildren();
    if (!state.products.length) {
      const option = global.document.createElement('option');
      option.value = '';
      option.textContent = '无可用产品';
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const product of state.products) {
      const option = global.document.createElement('option');
      option.value = product.productId;
      option.textContent = [product.modelCode, product.asin, product.sellerSku].filter(Boolean).join(' · ') || product.productId;
      select.appendChild(option);
    }
    select.value = state.productId;
  }

  function renderAccess() {
    const badge = global.document.querySelector('#cfNegGovAccess');
    if (!badge) return;
    const allowed = canManageStore(state.storeId);
    badge.textContent = allowed ? '可管理' : '只读';
    badge.classList.toggle('can-manage', allowed);
  }

  function canManageStore(storeId) {
    const globalPermissions = Array.isArray(state.capabilities?.globalPermissions)
      ? state.capabilities.globalPermissions
      : [];
    if (globalPermissions.includes('negatives.manage')) return true;
    const storePermissions = state.capabilities?.storePermissions;
    return Boolean(storeId && Array.isArray(storePermissions?.[storeId]) && storePermissions[storeId].includes('negatives.manage'));
  }

  function normalizeStores(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      storeId: String(row.storeId || row.store_id || ''),
      storeCode: String(row.storeCode || row.store_code || ''),
      displayName: String(row.displayName || row.display_name || ''),
      marketplaceCode: String(row.marketplaceCode || row.marketplace_code || ''),
    })).filter((row) => row.storeId);
  }

  function normalizeProducts(rows) {
    const seen = new Set();
    const output = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const productId = String(row.productId || '');
      if (!productId || seen.has(productId)) continue;
      seen.add(productId);
      output.push({
        productId,
        modelCode: String(row.modelCode || ''),
        asin: String(row.asin || ''),
        sellerSku: String(row.sellerSku || ''),
      });
    }
    return output;
  }

  function readFilters() {
    return {
      q: String(global.document.querySelector('#cfNegGovSearch')?.value || '').trim(),
      matchType: String(global.document.querySelector('#cfNegGovMatch')?.value || ''),
      keywordStatus: String(global.document.querySelector('#cfNegGovKeywordStatus')?.value || ''),
      scopeStatus: String(global.document.querySelector('#cfNegGovScopeStatus')?.value || ''),
    };
  }

  function requireStore() {
    if (!state.storeId) throw localError('store_required');
  }

  function requireProduct() {
    requireStore();
    if (!state.productId) throw localError('product_required');
  }

  function primaryText(row) {
    return String(row.keywordText || row.normalizedTerm || row.negativeKeywordId || '—');
  }

  function cell(value) {
    const td = global.document.createElement('td');
    td.textContent = String(value ?? '—');
    return td;
  }

  function renderEmpty(message) {
    const tbody = global.document.querySelector('#cfNegGovRows');
    if (!tbody) return;
    tbody.replaceChildren();
    const tr = global.document.createElement('tr');
    const td = global.document.createElement('td');
    td.colSpan = 6;
    td.className = 'cfNegGovEmpty';
    td.textContent = message;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function setBusy(value, message = '') {
    state.loading = Boolean(value);
    const modal = global.document?.querySelector('#nativeNegativeGovernanceModal');
    if (modal) modal.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    if (message) setStatus(message, 'info');
    for (const control of global.document?.querySelectorAll('#nativeNegativeGovernanceModal button, #nativeNegativeGovernanceModal select, #nativeNegativeGovernanceModal input') || []) {
      if (control.id === 'btnCfNegGovClose') continue;
      control.disabled = state.loading || (control.id === 'cfNegGovProduct' && !state.products.length);
    }
  }

  function setStatus(message, tone = 'info') {
    const node = global.document?.querySelector('#cfNegGovStatus');
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.tone = tone;
  }

  function errorText(error) {
    const code = error?.code || error?.payload?.error || error?.message || 'unknown_error';
    const requestId = error?.requestId ? ` · request ${error.requestId}` : '';
    return `${String(code)}${requestId}`;
  }

  function localError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function modeLabel(mode) {
    return mode === 'library' ? '全局词库' : mode === 'store' ? '店铺作用域' : '产品作用域';
  }

  function debounce(fn, delay) {
    let timer = null;
    return function debounced(...args) {
      global.clearTimeout(timer);
      timer = global.setTimeout(() => fn(...args), delay);
    };
  }

  function installStyles() {
    if (global.document.querySelector('#cfNegGovStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfNegGovStyles';
    style.textContent = `
      .cfNegGovModal{width:min(1240px,calc(100vw - 32px));max-width:1240px;max-height:calc(100vh - 32px);overflow:hidden;display:flex;flex-direction:column}
      .cfNegGovHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .cfNegGovHeader h2{margin:3px 0 5px}.cfNegGovEyebrow{font-size:10px;font-weight:800;letter-spacing:.09em;color:var(--accent)}
      .cfNegGovHeaderActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .cfNegGovAccess{padding:6px 9px;border-radius:999px;background:var(--softWarn);color:var(--warn);font-size:11px;font-weight:750}.cfNegGovAccess.can-manage{background:var(--softGood);color:var(--good)}
      .cfNegGovBody{overflow:auto}.cfNegGovControls{display:grid;grid-template-columns:1.1fr 1.4fr .7fr .7fr .7fr 1.5fr;gap:8px;margin-bottom:10px}.cfNegGovControls label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:10.8px;font-weight:700}.cfNegGovControls select,.cfNegGovControls input{min-width:0;border:1px solid var(--line);background:var(--input-bg);color:var(--text);border-radius:8px;padding:8px 9px}
      .cfNegGovTabs{display:flex;gap:3px;padding:3px;border:1px solid var(--line);background:var(--hover-bg);border-radius:10px;width:max-content;margin-bottom:8px}.cfNegGovStatus{min-height:28px;display:flex;align-items:center;padding:5px 8px;border-radius:8px;margin-bottom:8px;background:var(--hover-bg);color:var(--muted);font-size:11px}.cfNegGovStatus[data-tone="ok"]{background:var(--softGood);color:var(--good)}.cfNegGovStatus[data-tone="bad"]{background:var(--softBad);color:var(--bad)}.cfNegGovStatus[data-tone="warn"]{background:var(--softWarn);color:var(--warn)}
      .cfNegGovTableWrap{max-height:58vh}.cfNegGovTable{width:100%;min-width:900px;border-collapse:collapse}.cfNegGovTable th:nth-child(1){width:30%}.cfNegGovActions{display:flex;gap:5px;flex-wrap:wrap}.cfNegGovAction{padding:5px 8px;font-size:10.8px}.cfNegGovAction:disabled{opacity:.42;cursor:not-allowed}.cfNegGovEmpty{text-align:center;color:var(--muted);padding:26px!important}.cfNegGovFoot{margin-top:8px;color:var(--muted)}
      @media(max-width:1050px){.cfNegGovControls{grid-template-columns:repeat(2,minmax(0,1fr))}.cfNegGovHeader{flex-direction:column}.cfNegGovHeaderActions{justify-content:flex-start}}
      @media(max-width:620px){.cfNegGovControls{grid-template-columns:1fr}.cfNegGovModal{width:calc(100vw - 18px);max-height:calc(100vh - 18px)}}`;
    global.document.head.appendChild(style);
  }
})(window);
