(function initCloudflareNativeProductGovernance(global) {
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

  function listRegistry(params = {}) {
    return api().listProducts({ limit: PAGE_LIMIT, ...params });
  }

  function createProduct(input = {}) {
    const modelCode = String(input.modelCode || '').trim();
    if (!modelCode) return reject('product_model_code_required');
    return api().createProduct({
      modelCode,
      modelName: nullableText(input.modelName),
      brand: nullableText(input.brand),
      status: normalizeProductStatus(input.status || 'active'),
      attributes: plainObject(input.attributes) ? input.attributes : null,
    });
  }

  function updateProduct(productId, body = {}) {
    const id = String(productId || '').trim();
    if (!id) return reject('product_id_required');
    return api().updateProduct(id, body);
  }

  function listStores() {
    return api().stores();
  }

  function listStoreMappings(storeId, params = {}) {
    const id = String(storeId || '').trim();
    if (!id) return reject('store_id_required');
    return api().storeProducts(id, { limit: PAGE_LIMIT, ...params });
  }

  function putStoreMapping(storeId, productId, sellerSku, body = {}) {
    const store = String(storeId || '').trim();
    const product = String(productId || '').trim();
    const sku = String(sellerSku || '').trim();
    if (!store) return reject('store_id_required');
    if (!product) return reject('product_id_required');
    if (!sku) return reject('seller_sku_required');
    return api().putStoreProduct(store, product, sku, {
      asin: nullableText(body.asin),
      parentAsin: nullableText(body.parentAsin),
      listingStatus: nullableText(body.listingStatus),
    });
  }

  function deleteStoreMapping(storeId, productId, sellerSku) {
    const store = String(storeId || '').trim();
    const product = String(productId || '').trim();
    const sku = String(sellerSku || '').trim();
    if (!store) return reject('store_id_required');
    if (!product) return reject('product_id_required');
    if (!sku) return reject('seller_sku_required');
    return api().deleteStoreProduct(store, product, sku);
  }

  const publicApi = Object.freeze({
    version: VERSION,
    listRegistry,
    createProduct,
    updateProduct,
    listStores,
    listStoreMappings,
    putStoreMapping,
    deleteStoreMapping,
    mount,
    open,
  });

  Object.defineProperty(global, 'CloudflareProductGovernance', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  const state = {
    mounted: false,
    open: false,
    mode: 'registry',
    loading: false,
    requestSerial: 0,
    capabilities: null,
    stores: [],
    products: [],
    rows: [],
    storeId: '',
  };

  if (!global.document) return;
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  function mount() {
    if (state.mounted || !global.document?.body) return;
    const host = global.document.querySelector('.bidGovHeaderActions')
      || global.document.querySelector('.header .actions');
    if (!host) return;

    state.mounted = true;
    installStyles();

    const button = global.document.createElement('button');
    button.id = 'btnNativeProductGovernance';
    button.type = 'button';
    button.className = 'btn';
    button.textContent = '产品治理';
    button.title = '管理 Cloudflare Native 产品注册表与店铺 SKU/ASIN 映射';
    button.addEventListener('click', open);
    host.insertBefore(button, host.firstChild);

    const modal = global.document.createElement('div');
    modal.id = 'nativeProductGovernanceModal';
    modal.className = 'modalOverlay cfProductGovOverlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'nativeProductGovernanceTitle');
    modal.innerHTML = `
      <div class="largeModal cfProductGovModal">
        <div class="largeModalHeader cfProductGovHeader">
          <div>
            <div class="cfProductGovEyebrow">PHASE 3 · GATE 3.1</div>
            <h2 id="nativeProductGovernanceTitle">产品注册表与店铺映射</h2>
            <div class="small">Control D1 产品真相 → store SKU / ASIN identity mapping。不会触发 Sync、Amazon API 或 Production。</div>
          </div>
          <div class="cfProductGovHeaderActions">
            <span class="cfProductGovAccess" id="cfProductGovAccess">权限检查中</span>
            <button class="btn" id="btnCfProductGovRefresh" type="button">刷新</button>
            <button class="btn" id="btnCfProductGovClose" type="button">关闭</button>
          </div>
        </div>
        <div class="largeModalBody cfProductGovBody">
          <div class="cfProductGovTabs" role="tablist" aria-label="产品治理视图">
            <button class="segBtn active" data-cf-product-mode="registry" type="button" role="tab" aria-selected="true">全局产品注册表</button>
            <button class="segBtn" data-cf-product-mode="store" type="button" role="tab" aria-selected="false">店铺 SKU / ASIN 映射</button>
          </div>

          <div class="cfProductGovControls">
            <label id="cfProductGovStoreLabel">店铺<select id="cfProductGovStore"></select></label>
            <label>产品状态<select id="cfProductGovStatus"><option value="active">active</option><option value="inactive">inactive</option><option value="archived">archived</option><option value="">全部</option></select></label>
            <label class="cfProductGovSearch">搜索<input id="cfProductGovSearch" type="search" placeholder="model / brand / SKU / ASIN" maxlength="200"/></label>
          </div>

          <form class="cfProductGovCreate" id="cfProductGovCreateForm">
            <div class="cfProductGovCreateTitle">新增产品</div>
            <input id="cfProductGovModelCode" type="text" maxlength="120" placeholder="Model code" required/>
            <input id="cfProductGovModelName" type="text" maxlength="240" placeholder="Model name（可选）"/>
            <input id="cfProductGovBrand" type="text" maxlength="120" placeholder="Brand（可选）"/>
            <select id="cfProductGovCreateStatus"><option value="active">active</option><option value="inactive">inactive</option><option value="archived">archived</option></select>
            <button class="btn primary" id="btnCfProductGovCreate" type="submit">新增</button>
          </form>

          <form class="cfProductGovMapping" id="cfProductGovMappingForm">
            <div class="cfProductGovCreateTitle">映射到店铺</div>
            <select id="cfProductGovMappingProduct" required></select>
            <input id="cfProductGovSellerSku" type="text" maxlength="128" placeholder="Seller SKU" required/>
            <input id="cfProductGovAsin" type="text" maxlength="128" placeholder="ASIN（可选）"/>
            <input id="cfProductGovParentAsin" type="text" maxlength="128" placeholder="Parent ASIN（可选）"/>
            <input id="cfProductGovListingStatus" type="text" maxlength="80" placeholder="Listing status（可选）"/>
            <button class="btn primary" id="btnCfProductGovMap" type="submit">保存映射</button>
          </form>

          <div class="cfProductGovStatus" id="cfProductGovMessage" aria-live="polite"></div>
          <div class="table-container cfProductGovTableWrap">
            <table class="cfProductGovTable">
              <thead><tr><th>产品</th><th>品牌 / 状态</th><th>店铺 Identity</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody id="cfProductGovRows"></tbody>
            </table>
          </div>
          <div class="small cfProductGovFoot">产品注册表写入只允许 global <code>products.manage</code>；店铺映射写入允许 global 或该 store 的 <code>products.manage</code>。所有服务端写入继续进入 audit log。</div>
        </div>
      </div>`;
    global.document.body.appendChild(modal);

    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    global.document.querySelector('#btnCfProductGovClose')?.addEventListener('click', close);
    global.document.querySelector('#btnCfProductGovRefresh')?.addEventListener('click', refresh);
    global.document.querySelector('#cfProductGovStore')?.addEventListener('change', onStoreChange);
    global.document.querySelector('#cfProductGovStatus')?.addEventListener('change', refresh);
    global.document.querySelector('#cfProductGovSearch')?.addEventListener('input', debounce(refresh, 250));
    global.document.querySelector('#cfProductGovCreateForm')?.addEventListener('submit', onCreateProduct);
    global.document.querySelector('#cfProductGovMappingForm')?.addEventListener('submit', onPutMapping);
    for (const tab of global.document.querySelectorAll('[data-cf-product-mode]')) {
      tab.addEventListener('click', () => setMode(tab.dataset.cfProductMode));
    }
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) close();
    });
    syncModeUi();
  }

  async function open() {
    if (!state.mounted) mount();
    const modal = global.document?.querySelector('#nativeProductGovernanceModal');
    if (!modal) return;
    state.open = true;
    modal.style.display = 'flex';
    await hydrateContext();
    await refresh();
  }

  function close() {
    const modal = global.document?.querySelector('#nativeProductGovernanceModal');
    if (modal) modal.style.display = 'none';
    state.open = false;
  }

  async function hydrateContext() {
    setBusy(true, '正在加载产品治理上下文…');
    try {
      const [capabilities, storesPayload, productsPayload] = await Promise.all([
        api().capabilities(),
        listStores(),
        listRegistry({ status: '' }),
      ]);
      state.capabilities = capabilities || {};
      state.stores = normalizeStores(storesPayload?.stores);
      state.products = normalizeProducts(productsPayload?.items);
      if (!state.stores.some((store) => store.storeId === state.storeId)) {
        state.storeId = state.stores[0]?.storeId || '';
      }
      renderStores();
      renderMappingProducts();
      renderAccess();
      syncModeUi();
    } catch (error) {
      setMessage(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function setMode(mode) {
    if (!['registry', 'store'].includes(mode)) return;
    state.mode = mode;
    syncModeUi();
    await refresh();
  }

  async function onStoreChange(event) {
    state.storeId = String(event.target.value || '');
    renderAccess();
    if (state.mode === 'store') await refresh();
  }

  function syncModeUi() {
    for (const tab of global.document.querySelectorAll('[data-cf-product-mode]')) {
      const active = tab.dataset.cfProductMode === state.mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    const createForm = global.document.querySelector('#cfProductGovCreateForm');
    const mappingForm = global.document.querySelector('#cfProductGovMappingForm');
    const storeLabel = global.document.querySelector('#cfProductGovStoreLabel');
    if (createForm) createForm.style.display = state.mode === 'registry' ? 'grid' : 'none';
    if (mappingForm) mappingForm.style.display = state.mode === 'store' ? 'grid' : 'none';
    if (storeLabel) storeLabel.dataset.required = state.mode === 'store' ? '1' : '0';
  }

  async function refresh() {
    if (!state.open) return;
    const serial = ++state.requestSerial;
    const filters = readFilters();
    setBusy(true, '正在读取产品治理数据…');
    try {
      let payload;
      if (state.mode === 'registry') {
        payload = await listRegistry({ q: filters.q, status: filters.status });
      } else {
        if (!state.storeId) return renderEmpty('没有可用店铺');
        payload = await listStoreMappings(state.storeId, { q: filters.q, productStatus: filters.status });
      }
      if (serial !== state.requestSerial) return;
      state.rows = Array.isArray(payload?.items) ? payload.items : [];
      renderRows();
      setMessage(`已加载 ${state.rows.length} 条 · ${state.mode === 'registry' ? '全局产品注册表' : '店铺映射'}`, 'ok');
    } catch (error) {
      if (serial !== state.requestSerial) return;
      state.rows = [];
      renderRows();
      setMessage(errorText(error), 'bad');
    } finally {
      if (serial === state.requestSerial) setBusy(false);
    }
  }

  async function onCreateProduct(event) {
    event.preventDefault();
    if (!canManageRegistry()) return setMessage('缺少 global products.manage', 'bad');
    const modelCode = String(global.document.querySelector('#cfProductGovModelCode')?.value || '').trim();
    if (!modelCode) return setMessage('请输入 Model code', 'warn');
    setBusy(true, '正在新增产品…');
    try {
      await createProduct({
        modelCode,
        modelName: global.document.querySelector('#cfProductGovModelName')?.value,
        brand: global.document.querySelector('#cfProductGovBrand')?.value,
        status: global.document.querySelector('#cfProductGovCreateStatus')?.value,
      });
      event.currentTarget.reset();
      const status = global.document.querySelector('#cfProductGovCreateStatus');
      if (status) status.value = 'active';
      setMessage('新增产品成功', 'ok');
      await hydrateProductsOnly();
      await refresh();
    } catch (error) {
      setMessage(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function onPutMapping(event) {
    event.preventDefault();
    if (!state.storeId) return setMessage('请选择店铺', 'warn');
    if (!canManageStore(state.storeId)) return setMessage('当前店铺缺少 products.manage', 'bad');
    const productId = String(global.document.querySelector('#cfProductGovMappingProduct')?.value || '').trim();
    const sellerSku = String(global.document.querySelector('#cfProductGovSellerSku')?.value || '').trim();
    if (!productId || !sellerSku) return setMessage('请选择产品并输入 Seller SKU', 'warn');
    setBusy(true, '正在保存店铺映射…');
    try {
      await putStoreMapping(state.storeId, productId, sellerSku, {
        asin: global.document.querySelector('#cfProductGovAsin')?.value,
        parentAsin: global.document.querySelector('#cfProductGovParentAsin')?.value,
        listingStatus: global.document.querySelector('#cfProductGovListingStatus')?.value,
      });
      event.currentTarget.reset();
      renderMappingProducts();
      setMessage('店铺映射保存成功', 'ok');
      await refresh();
    } catch (error) {
      setMessage(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function hydrateProductsOnly() {
    const payload = await listRegistry({ status: '' });
    state.products = normalizeProducts(payload?.items);
    renderMappingProducts();
  }

  function renderRows() {
    const tbody = global.document.querySelector('#cfProductGovRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.rows.length) return renderEmpty('当前条件下没有记录');
    for (const row of state.rows) {
      const tr = global.document.createElement('tr');
      tr.appendChild(cell(`${row.modelCode || row.productId || '—'}${row.modelName ? `\n${row.modelName}` : ''}`));
      tr.appendChild(cell(`${row.brand || '—'} · ${row.productStatus || row.status || '—'}`));
      tr.appendChild(cell(state.mode === 'store'
        ? [`SKU ${row.sellerSku || '—'}`, `ASIN ${row.asin || '—'}`, row.parentAsin ? `Parent ${row.parentAsin}` : null, row.listingStatus || null].filter(Boolean).join('\n')
        : 'Global registry'));
      tr.appendChild(cell(row.updatedAt || '—'));
      const actions = global.document.createElement('td');
      actions.className = 'cfProductGovActions';
      appendActions(actions, row);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
  }

  function appendActions(host, row) {
    const productId = String(row.productId || '').trim();
    if (!productId) return;
    if (state.mode === 'registry') {
      if (!canManageRegistry()) return host.appendChild(readOnlyLabel());
      for (const status of ['active', 'inactive', 'archived']) {
        if (status === row.status) continue;
        host.appendChild(actionButton(status, async () => {
          await updateProduct(productId, { status });
          await hydrateProductsOnly();
        }, status === 'archived' ? 'danger' : ''));
      }
      return;
    }

    if (!canManageStore(state.storeId)) return host.appendChild(readOnlyLabel());
    host.appendChild(actionButton('编辑', async () => {
      populateMappingForm(row);
    }));
    host.appendChild(actionButton('移除映射', async () => {
      await deleteStoreMapping(state.storeId, productId, row.sellerSku);
    }, 'danger'));
  }

  function populateMappingForm(row) {
    setValue('#cfProductGovMappingProduct', row.productId);
    setValue('#cfProductGovSellerSku', row.sellerSku);
    setValue('#cfProductGovAsin', row.asin);
    setValue('#cfProductGovParentAsin', row.parentAsin);
    setValue('#cfProductGovListingStatus', row.listingStatus);
    global.document.querySelector('#cfProductGovSellerSku')?.focus();
  }

  function actionButton(label, operation, tone = '') {
    const button = global.document.createElement('button');
    button.type = 'button';
    button.className = `btn cfProductGovAction${tone ? ` ${tone}` : ''}`;
    button.textContent = label;
    button.addEventListener('click', async () => {
      if (state.loading) return;
      setBusy(true, `${label}…`);
      try {
        await operation();
        if (label !== '编辑') {
          setMessage(`${label}成功`, 'ok');
          await refresh();
        }
      } catch (error) {
        setMessage(errorText(error), 'bad');
      } finally {
        setBusy(false);
      }
    });
    return button;
  }

  function renderStores() {
    const select = global.document.querySelector('#cfProductGovStore');
    if (!select) return;
    select.replaceChildren();
    for (const store of state.stores) {
      const option = global.document.createElement('option');
      option.value = store.storeId;
      option.textContent = `${store.displayName || store.storeCode || store.storeId}${store.marketplaceCode ? ` · ${store.marketplaceCode}` : ''}`;
      option.selected = store.storeId === state.storeId;
      select.appendChild(option);
    }
    select.disabled = !state.stores.length;
    if (!state.stores.length) {
      const option = global.document.createElement('option');
      option.value = '';
      option.textContent = '无可用店铺';
      select.appendChild(option);
    }
  }

  function renderMappingProducts() {
    const select = global.document.querySelector('#cfProductGovMappingProduct');
    if (!select) return;
    const current = select.value;
    select.replaceChildren();
    for (const product of state.products.filter((item) => item.status !== 'archived')) {
      const option = global.document.createElement('option');
      option.value = product.productId;
      option.textContent = `${product.modelCode || product.productId}${product.modelName ? ` · ${product.modelName}` : ''}`;
      option.selected = product.productId === current;
      select.appendChild(option);
    }
    select.disabled = !select.options.length;
  }

  function renderAccess() {
    const badge = global.document.querySelector('#cfProductGovAccess');
    if (!badge) return;
    const registry = canManageRegistry();
    const store = canManageStore(state.storeId);
    badge.textContent = registry ? '全局产品治理' : (store ? '店铺映射治理' : '只读');
    badge.dataset.mode = registry ? 'manage' : (store ? 'store' : 'read');
    const createButton = global.document.querySelector('#btnCfProductGovCreate');
    const mapButton = global.document.querySelector('#btnCfProductGovMap');
    if (createButton) createButton.disabled = !registry;
    if (mapButton) mapButton.disabled = !store;
  }

  function canManageRegistry() {
    return globalPermissions().has('products.manage');
  }

  function canManageStore(storeId) {
    if (canManageRegistry()) return true;
    return new Set(Array.isArray(state.capabilities?.storePermissions?.[storeId])
      ? state.capabilities.storePermissions[storeId] : []).has('products.manage');
  }

  function globalPermissions() {
    return new Set(Array.isArray(state.capabilities?.globalPermissions) ? state.capabilities.globalPermissions : []);
  }

  function renderEmpty(message) {
    const tbody = global.document.querySelector('#cfProductGovRows');
    if (!tbody) return;
    tbody.replaceChildren();
    const tr = global.document.createElement('tr');
    const td = global.document.createElement('td');
    td.colSpan = 5;
    td.className = 'cfProductGovEmpty';
    td.textContent = message;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function readFilters() {
    return {
      q: String(global.document.querySelector('#cfProductGovSearch')?.value || '').trim(),
      status: String(global.document.querySelector('#cfProductGovStatus')?.value || '').trim(),
    };
  }

  function setBusy(value, message) {
    state.loading = Boolean(value);
    if (message) setMessage(message);
    global.document.querySelectorAll('#btnCfProductGovRefresh,#btnCfProductGovCreate,#btnCfProductGovMap,.cfProductGovAction').forEach((element) => {
      element.disabled = Boolean(value);
    });
    if (!value) renderAccess();
  }

  function setMessage(message, tone = '') {
    const element = global.document.querySelector('#cfProductGovMessage');
    if (!element) return;
    element.textContent = String(message || '');
    element.dataset.tone = tone;
  }

  function normalizeStores(items) {
    return (Array.isArray(items) ? items : []).map((store) => ({
      storeId: String(store.storeId || store.store_id || ''),
      storeCode: String(store.storeCode || store.store_code || ''),
      displayName: String(store.displayName || store.display_name || ''),
      marketplaceCode: String(store.marketplaceCode || store.marketplace_code || ''),
    })).filter((store) => store.storeId);
  }

  function normalizeProducts(items) {
    return (Array.isArray(items) ? items : []).map((product) => ({
      productId: String(product.productId || ''),
      modelCode: String(product.modelCode || ''),
      modelName: String(product.modelName || ''),
      brand: String(product.brand || ''),
      status: String(product.status || ''),
    })).filter((product) => product.productId);
  }

  function normalizeProductStatus(value) {
    const status = String(value || '').trim();
    return ['active', 'inactive', 'archived'].includes(status) ? status : 'active';
  }

  function nullableText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
  }

  function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function cell(value) {
    const td = global.document.createElement('td');
    td.textContent = String(value === null || value === undefined ? '—' : value);
    if (String(value || '').includes('\n')) td.style.whiteSpace = 'pre-line';
    return td;
  }

  function readOnlyLabel() {
    const span = global.document.createElement('span');
    span.className = 'small';
    span.textContent = '只读';
    return span;
  }

  function setValue(selector, value) {
    const element = global.document.querySelector(selector);
    if (element) element.value = String(value || '');
  }

  function errorText(error) {
    const code = String(error?.code || error?.message || error || 'product_governance_failed');
    if (code === 'forbidden') return `权限不足：${error?.payload?.permission || 'forbidden'}`;
    return code;
  }

  function reject(code) {
    const error = new Error(code);
    error.code = code;
    return Promise.reject(error);
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      global.clearTimeout?.(timer);
      timer = global.setTimeout?.(() => fn(...args), wait);
    };
  }

  function installStyles() {
    if (global.document.querySelector('#cloudflareProductGovernanceStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cloudflareProductGovernanceStyles';
    style.textContent = `
      .cfProductGovOverlay{display:none;z-index:10075}.cfProductGovModal{width:min(1220px,96vw);max-height:92vh}
      .cfProductGovHeader{gap:14px;align-items:flex-start}.cfProductGovEyebrow{font-size:10px;font-weight:800;letter-spacing:.12em;color:var(--accent);margin-bottom:4px}
      .cfProductGovHeader h2{margin:0 0 4px;font-size:20px}.cfProductGovHeaderActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .cfProductGovAccess{padding:5px 9px;border-radius:999px;background:var(--chip);font-size:10px;font-weight:800;color:var(--muted)}.cfProductGovAccess[data-mode="manage"]{color:var(--good)}.cfProductGovAccess[data-mode="store"]{color:var(--accent)}
      .cfProductGovBody{display:grid;gap:12px}.cfProductGovTabs{display:flex;gap:4px}.cfProductGovControls{display:grid;grid-template-columns:minmax(190px,1fr) 150px minmax(240px,1.5fr);gap:8px}
      .cfProductGovControls label{display:grid;gap:4px;font-size:10px;color:var(--muted)}.cfProductGovControls select,.cfProductGovControls input,.cfProductGovCreate input,.cfProductGovCreate select,.cfProductGovMapping input,.cfProductGovMapping select{width:100%;border:1px solid var(--line);border-radius:10px;background:var(--input-bg);color:var(--text);padding:8px 9px}
      .cfProductGovCreate,.cfProductGovMapping{display:grid;gap:7px;align-items:end;padding:9px;border:1px solid var(--line);border-radius:12px;background:var(--input-bg)}.cfProductGovCreate{grid-template-columns:auto minmax(140px,1fr) minmax(160px,1.2fr) minmax(120px,1fr) 110px auto}.cfProductGovMapping{grid-template-columns:auto minmax(160px,1.2fr) minmax(140px,1fr) repeat(3,minmax(120px,1fr)) auto}
      .cfProductGovCreateTitle{align-self:center;font-size:11px;font-weight:800;white-space:nowrap}.cfProductGovStatus{min-height:18px;font-size:11px;color:var(--muted)}.cfProductGovStatus[data-tone="ok"]{color:var(--good)}.cfProductGovStatus[data-tone="warn"]{color:var(--warn)}.cfProductGovStatus[data-tone="bad"]{color:var(--bad)}
      .cfProductGovTableWrap{max-height:52vh;overflow:auto}.cfProductGovTable{width:100%;border-collapse:collapse}.cfProductGovTable th,.cfProductGovTable td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:11px}.cfProductGovTable th{position:sticky;top:0;background:var(--card);z-index:1;color:var(--muted)}
      .cfProductGovActions{display:flex;gap:5px;flex-wrap:wrap;min-width:180px}.cfProductGovAction{padding:5px 8px;font-size:10px}.cfProductGovEmpty{text-align:center!important;color:var(--muted);padding:24px!important}.cfProductGovFoot{color:var(--muted)}#cfProductGovStoreLabel[data-required="1"]{color:var(--accent)}
      @media(max-width:920px){.cfProductGovControls{grid-template-columns:1fr}.cfProductGovCreate,.cfProductGovMapping{grid-template-columns:1fr 1fr}.cfProductGovCreateTitle{grid-column:1/-1}.cfProductGovHeader{display:grid}.cfProductGovHeaderActions{justify-content:flex-start}}
      @media(max-width:560px){.cfProductGovCreate,.cfProductGovMapping{grid-template-columns:1fr}.cfProductGovModal{width:98vw}.cfProductGovTable th:nth-child(4),.cfProductGovTable td:nth-child(4){display:none}}
    `;
    global.document.head.appendChild(style);
  }
})(window);
