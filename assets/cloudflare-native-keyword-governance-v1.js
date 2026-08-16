(function initCloudflareNativeKeywordGovernance(global) {
  'use strict';

  const VERSION = '1.0.0';
  const PAGE_LIMIT = 200;
  const DEFAULT_MAPPING = Object.freeze({ relevanceScore: null, priority: 100, isPrimary: false, notes: null });

  function api() {
    if (!global.CloudflareNativeAPI) {
      const error = new Error('cloudflare_native_api_not_ready');
      error.code = 'cloudflare_native_api_not_ready';
      throw error;
    }
    return global.CloudflareNativeAPI;
  }

  function listLibrary(params = {}) {
    return api().listKeywords({ limit: PAGE_LIMIT, ...params });
  }

  function createKeyword(input = {}) {
    const keywordText = String(input.keywordText || '').trim();
    if (!keywordText) return reject('keyword_text_required');
    return api().createKeyword({
      keywordText,
      normalizedTerm: String(input.normalizedTerm || keywordText).trim().toLowerCase(),
      languageCode: String(input.languageCode || 'en-US').trim() || 'en-US',
      intentClass: nullableText(input.intentClass),
      semanticCluster: nullableText(input.semanticCluster),
      lifecycleStatus: normalizeLifecycle(input.lifecycleStatus || 'active'),
      sourceType: String(input.sourceType || 'manual').trim() || 'manual',
      notes: nullableText(input.notes),
    });
  }

  function updateKeyword(keywordId, input = {}) {
    const id = String(keywordId || '').trim();
    if (!id) return reject('keyword_id_required');
    return api().updateKeyword(id, input);
  }

  function listProducts(params = {}) {
    return api().listProducts({ limit: PAGE_LIMIT, status: 'active', ...params });
  }

  function listProductMappings(productId, params = {}) {
    const id = String(productId || '').trim();
    if (!id) return reject('product_id_required');
    return api().productKeywords(id, { limit: PAGE_LIMIT, ...params });
  }

  function putProductMapping(productId, keywordId, body = DEFAULT_MAPPING) {
    const product = String(productId || '').trim();
    const keyword = String(keywordId || '').trim();
    if (!product) return reject('product_id_required');
    if (!keyword) return reject('keyword_id_required');
    return api().putProductKeyword(product, keyword, normalizeMapping(body));
  }

  function deleteProductMapping(productId, keywordId) {
    const product = String(productId || '').trim();
    const keyword = String(keywordId || '').trim();
    if (!product) return reject('product_id_required');
    if (!keyword) return reject('keyword_id_required');
    return api().deleteProductKeyword(product, keyword);
  }

  const publicApi = Object.freeze({
    version: VERSION,
    listLibrary,
    createKeyword,
    updateKeyword,
    listProducts,
    listProductMappings,
    putProductMapping,
    deleteProductMapping,
    mount,
    open,
  });

  Object.defineProperty(global, 'CloudflareKeywordGovernance', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  const state = {
    mounted: false,
    open: false,
    mode: 'library',
    loading: false,
    requestSerial: 0,
    capabilities: null,
    products: [],
    productId: '',
    rows: [],
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
    button.id = 'btnNativeKeywordGovernance';
    button.type = 'button';
    button.className = 'btn primary';
    button.textContent = '关键词治理';
    button.title = '管理 Cloudflare Native 正向关键词库与产品关键词映射';
    button.addEventListener('click', open);
    host.insertBefore(button, host.firstChild);

    const modal = global.document.createElement('div');
    modal.id = 'nativeKeywordGovernanceModal';
    modal.className = 'modalOverlay cfKeywordGovOverlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'nativeKeywordGovernanceTitle');
    modal.innerHTML = `
      <div class="largeModal cfKeywordGovModal">
        <div class="largeModalHeader cfKeywordGovHeader">
          <div>
            <div class="cfKeywordGovEyebrow">PHASE 3 · OPERATOR PRODUCT SURFACE</div>
            <h2 id="nativeKeywordGovernanceTitle">关键词库与产品映射治理</h2>
            <div class="small">全局关键词库 → 产品映射。只操作 Control D1 治理数据，不触发 Amazon、Sync 或 Production。</div>
          </div>
          <div class="cfKeywordGovHeaderActions">
            <span class="cfKeywordGovAccess" id="cfKeywordGovAccess">权限检查中</span>
            <button class="btn" id="btnCfKeywordGovRefresh" type="button">刷新</button>
            <button class="btn" id="btnCfKeywordGovClose" type="button">关闭</button>
          </div>
        </div>
        <div class="largeModalBody cfKeywordGovBody">
          <div class="cfKeywordGovTabs" role="tablist" aria-label="关键词治理视图">
            <button class="segBtn active" data-cf-keyword-mode="library" type="button" role="tab" aria-selected="true">全局关键词库</button>
            <button class="segBtn" data-cf-keyword-mode="product" type="button" role="tab" aria-selected="false">产品关键词映射</button>
          </div>

          <div class="cfKeywordGovControls">
            <label id="cfKeywordGovProductLabel">产品<select id="cfKeywordGovProduct"></select></label>
            <label>状态<select id="cfKeywordGovStatusFilter"><option value="active">active</option><option value="watch">watch</option><option value="retired">retired</option><option value="">全部</option></select></label>
            <label class="cfKeywordGovSearch">搜索<input id="cfKeywordGovSearch" type="search" placeholder="keyword / normalized / semantic cluster" maxlength="200"/></label>
          </div>

          <form class="cfKeywordGovCreate" id="cfKeywordGovCreateForm">
            <div class="cfKeywordGovCreateTitle">新增关键词</div>
            <input id="cfKeywordGovCreateText" name="keywordText" type="text" maxlength="500" placeholder="Keyword text" required/>
            <input id="cfKeywordGovCreateIntent" name="intentClass" type="text" maxlength="200" placeholder="Intent class（可选）"/>
            <input id="cfKeywordGovCreateCluster" name="semanticCluster" type="text" maxlength="500" placeholder="Semantic cluster（可选）"/>
            <select id="cfKeywordGovCreateLifecycle" name="lifecycleStatus"><option value="active">active</option><option value="watch">watch</option><option value="retired">retired</option></select>
            <button class="btn primary" id="btnCfKeywordGovCreate" type="submit">新增</button>
          </form>

          <div class="cfKeywordGovStatus" id="cfKeywordGovStatus" aria-live="polite"></div>
          <div class="table-container cfKeywordGovTableWrap">
            <table class="cfKeywordGovTable">
              <thead><tr><th>关键词</th><th>意图/语义簇</th><th>状态</th><th>映射</th><th>操作</th></tr></thead>
              <tbody id="cfKeywordGovRows"></tbody>
            </table>
          </div>
          <div class="small cfKeywordGovFoot">单页最多 200 条。词库写入需要 <code>keywords.manage</code>；产品映射写入同时需要 <code>keywords.manage</code> 与 <code>products.manage</code>。</div>
        </div>
      </div>`;
    global.document.body.appendChild(modal);

    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    global.document.querySelector('#btnCfKeywordGovClose')?.addEventListener('click', close);
    global.document.querySelector('#btnCfKeywordGovRefresh')?.addEventListener('click', refresh);
    global.document.querySelector('#cfKeywordGovProduct')?.addEventListener('change', onProductChange);
    global.document.querySelector('#cfKeywordGovStatusFilter')?.addEventListener('change', refresh);
    global.document.querySelector('#cfKeywordGovSearch')?.addEventListener('input', debounce(refresh, 250));
    global.document.querySelector('#cfKeywordGovCreateForm')?.addEventListener('submit', onCreateKeyword);
    for (const tab of global.document.querySelectorAll('[data-cf-keyword-mode]')) {
      tab.addEventListener('click', () => setMode(tab.dataset.cfKeywordMode));
    }
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) close();
    });
    syncModeUi();
  }

  async function open() {
    if (!state.mounted) mount();
    const modal = global.document?.querySelector('#nativeKeywordGovernanceModal');
    if (!modal) return;
    state.open = true;
    modal.style.display = 'flex';
    await hydrateContext();
    await refresh();
  }

  function close() {
    const modal = global.document?.querySelector('#nativeKeywordGovernanceModal');
    if (modal) modal.style.display = 'none';
    state.open = false;
  }

  async function hydrateContext() {
    setBusy(true, '正在加载关键词治理上下文…');
    try {
      const [capabilities, productsPayload] = await Promise.all([
        api().capabilities(),
        listProducts(),
      ]);
      state.capabilities = capabilities || {};
      state.products = normalizeProducts(productsPayload?.items);
      if (!state.products.some((item) => item.productId === state.productId)) {
        state.productId = state.products[0]?.productId || '';
      }
      renderProducts();
      renderAccess();
      syncModeUi();
    } catch (error) {
      setStatus(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function onProductChange(event) {
    state.productId = String(event.target.value || '');
    if (state.mode === 'product') await refresh();
  }

  async function setMode(mode) {
    if (!['library', 'product'].includes(mode)) return;
    state.mode = mode;
    syncModeUi();
    await refresh();
  }

  function syncModeUi() {
    for (const tab of global.document.querySelectorAll('[data-cf-keyword-mode]')) {
      const active = tab.dataset.cfKeywordMode === state.mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    const productLabel = global.document.querySelector('#cfKeywordGovProductLabel');
    if (productLabel) productLabel.dataset.required = state.mode === 'product' ? '1' : '0';
    const createForm = global.document.querySelector('#cfKeywordGovCreateForm');
    if (createForm) createForm.style.display = state.mode === 'library' ? 'grid' : 'none';
  }

  async function refresh() {
    if (!state.open) return;
    const serial = ++state.requestSerial;
    const filters = readFilters();
    setBusy(true, '正在读取关键词治理数据…');
    try {
      let payload;
      if (state.mode === 'library') {
        payload = await listLibrary({ q: filters.q, status: filters.status });
      } else {
        if (!state.productId) return renderEmpty('没有可用产品');
        payload = await listProductMappings(state.productId, { q: filters.q, lifecycleStatus: filters.status });
      }
      if (serial !== state.requestSerial) return;
      state.rows = Array.isArray(payload?.items) ? payload.items : [];
      renderRows();
      setStatus(`已加载 ${state.rows.length} 条 · ${state.mode === 'library' ? '全局关键词库' : '产品关键词映射'}`, 'ok');
    } catch (error) {
      if (serial !== state.requestSerial) return;
      state.rows = [];
      renderRows();
      setStatus(errorText(error), 'bad');
    } finally {
      if (serial === state.requestSerial) setBusy(false);
    }
  }

  async function onCreateKeyword(event) {
    event.preventDefault();
    if (!canManageKeywords()) return setStatus('缺少 keywords.manage', 'bad');
    const keywordText = String(global.document.querySelector('#cfKeywordGovCreateText')?.value || '').trim();
    if (!keywordText) return setStatus('请输入关键词', 'warn');
    setBusy(true, '正在新增关键词…');
    try {
      await createKeyword({
        keywordText,
        intentClass: global.document.querySelector('#cfKeywordGovCreateIntent')?.value,
        semanticCluster: global.document.querySelector('#cfKeywordGovCreateCluster')?.value,
        lifecycleStatus: global.document.querySelector('#cfKeywordGovCreateLifecycle')?.value,
      });
      event.currentTarget.reset();
      const lifecycle = global.document.querySelector('#cfKeywordGovCreateLifecycle');
      if (lifecycle) lifecycle.value = 'active';
      setStatus('新增关键词成功', 'ok');
      await refresh();
    } catch (error) {
      setStatus(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  function renderRows() {
    const tbody = global.document.querySelector('#cfKeywordGovRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.rows.length) {
      renderEmpty('当前条件下没有记录');
      return;
    }
    for (const row of state.rows) {
      const tr = global.document.createElement('tr');
      tr.appendChild(cell(keywordPrimary(row)));
      tr.appendChild(cell(keywordMeta(row)));
      tr.appendChild(cell(row.lifecycleStatus || '—'));
      tr.appendChild(cell(mappingMeta(row)));
      const actions = global.document.createElement('td');
      actions.className = 'cfKeywordGovActions';
      appendActions(actions, row);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
  }

  function appendActions(host, row) {
    const keywordId = String(row.keywordId || '');
    if (!keywordId) return;

    if (state.mode === 'library') {
      if (canManageMappings() && state.productId && row.lifecycleStatus !== 'retired') {
        host.appendChild(actionButton('映射到产品', async () => {
          await putProductMapping(state.productId, keywordId, DEFAULT_MAPPING);
        }));
      }
      if (canManageKeywords()) {
        for (const status of ['active', 'watch', 'retired']) {
          if (status === row.lifecycleStatus) continue;
          host.appendChild(actionButton(status, async () => {
            await updateKeyword(keywordId, { lifecycleStatus: status });
          }, false, status === 'retired' ? 'danger' : ''));
        }
      }
    } else {
      if (!canManageMappings()) return host.appendChild(readOnlyLabel());
      const nextPrimary = !Boolean(row.isPrimary);
      host.appendChild(actionButton(nextPrimary ? '设为主词' : '取消主词', async () => {
        await putProductMapping(state.productId, keywordId, mappingBody(row, { isPrimary: nextPrimary }));
      }));
      host.appendChild(actionButton('移除映射', async () => {
        await deleteProductMapping(state.productId, keywordId);
      }, false, 'danger'));
    }

    if (!host.childNodes.length) host.appendChild(readOnlyLabel());
  }

  function actionButton(label, operation, disabled = false, tone = '') {
    const button = global.document.createElement('button');
    button.type = 'button';
    button.className = `btn cfKeywordGovAction${tone ? ` ${tone}` : ''}`;
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

  function readOnlyLabel() {
    const span = global.document.createElement('span');
    span.className = 'small';
    span.textContent = '只读';
    return span;
  }

  function renderProducts() {
    const select = global.document.querySelector('#cfKeywordGovProduct');
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
      option.textContent = `${product.modelCode || product.modelName || product.productId}${product.brand ? ` · ${product.brand}` : ''}`;
      option.selected = product.productId === state.productId;
      select.appendChild(option);
    }
  }

  function renderAccess() {
    const badge = global.document.querySelector('#cfKeywordGovAccess');
    if (!badge) return;
    if (canManageMappings()) badge.textContent = '关键词 + 产品治理';
    else if (canManageKeywords()) badge.textContent = '关键词治理';
    else badge.textContent = '只读';
    badge.dataset.mode = canManageMappings() ? 'manage' : (canManageKeywords() ? 'keyword' : 'read');
    const createButton = global.document.querySelector('#btnCfKeywordGovCreate');
    if (createButton) createButton.disabled = !canManageKeywords();
  }

  function renderEmpty(message) {
    const tbody = global.document.querySelector('#cfKeywordGovRows');
    if (!tbody) return;
    tbody.replaceChildren();
    const tr = global.document.createElement('tr');
    const td = global.document.createElement('td');
    td.colSpan = 5;
    td.className = 'cfKeywordGovEmpty';
    td.textContent = message;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function setBusy(value, message) {
    state.loading = Boolean(value);
    if (message) setStatus(message);
    for (const selector of ['#btnCfKeywordGovRefresh', '#btnCfKeywordGovCreate', '.cfKeywordGovAction']) {
      global.document.querySelectorAll(selector).forEach((element) => {
        if (selector === '#btnCfKeywordGovCreate' && !canManageKeywords()) element.disabled = true;
        else element.disabled = Boolean(value);
      });
    }
  }

  function setStatus(message, tone = '') {
    const element = global.document.querySelector('#cfKeywordGovStatus');
    if (!element) return;
    element.textContent = String(message || '');
    element.dataset.tone = tone;
  }

  function readFilters() {
    return {
      q: String(global.document.querySelector('#cfKeywordGovSearch')?.value || '').trim(),
      status: String(global.document.querySelector('#cfKeywordGovStatusFilter')?.value || '').trim(),
    };
  }

  function canManageKeywords() {
    return globalPermissions().has('keywords.manage');
  }

  function canManageMappings() {
    const permissions = globalPermissions();
    return permissions.has('keywords.manage') && permissions.has('products.manage');
  }

  function globalPermissions() {
    return new Set(Array.isArray(state.capabilities?.globalPermissions) ? state.capabilities.globalPermissions : []);
  }

  function keywordPrimary(row) {
    const text = String(row.keywordText || '—');
    const normalized = String(row.normalizedTerm || '').trim();
    return normalized && normalized !== text.toLowerCase() ? `${text}\n${normalized}` : text;
  }

  function keywordMeta(row) {
    return [row.intentClass, row.semanticCluster].filter(Boolean).join(' · ') || '—';
  }

  function mappingMeta(row) {
    if (state.mode === 'library') return state.productId ? '可映射' : '未选择产品';
    const parts = [`P${Number(row.priority || 100)}`];
    if (row.relevanceScore !== null && row.relevanceScore !== undefined) parts.push(`R${row.relevanceScore}`);
    if (row.isPrimary) parts.push('主词');
    return parts.join(' · ');
  }

  function mappingBody(row, override = {}) {
    return normalizeMapping({
      relevanceScore: row.relevanceScore,
      priority: row.priority,
      isPrimary: Boolean(row.isPrimary),
      notes: row.mappingNotes,
      ...override,
    });
  }

  function normalizeMapping(input = {}) {
    const relevanceScore = input.relevanceScore === null || input.relevanceScore === undefined || input.relevanceScore === ''
      ? null
      : Number(input.relevanceScore);
    const priority = Number(input.priority === undefined || input.priority === null || input.priority === '' ? 100 : input.priority);
    return {
      relevanceScore: Number.isInteger(relevanceScore) ? relevanceScore : null,
      priority: Number.isInteger(priority) ? Math.min(1000, Math.max(1, priority)) : 100,
      isPrimary: Boolean(input.isPrimary),
      notes: nullableText(input.notes),
    };
  }

  function normalizeProducts(items) {
    return (Array.isArray(items) ? items : [])
      .map((item) => ({
        productId: String(item.productId || ''),
        modelCode: String(item.modelCode || ''),
        modelName: String(item.modelName || ''),
        brand: String(item.brand || ''),
      }))
      .filter((item) => item.productId);
  }

  function normalizeLifecycle(value) {
    const status = String(value || '').trim();
    return ['active', 'watch', 'retired'].includes(status) ? status : 'active';
  }

  function nullableText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
  }

  function cell(value) {
    const td = global.document.createElement('td');
    td.textContent = String(value === null || value === undefined ? '—' : value);
    td.style.whiteSpace = String(value || '').includes('\n') ? 'pre-line' : '';
    return td;
  }

  function errorText(error) {
    const code = String(error?.code || error?.message || error || 'keyword_governance_failed');
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
    if (global.document.querySelector('#cloudflareKeywordGovernanceStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cloudflareKeywordGovernanceStyles';
    style.textContent = `
      .cfKeywordGovOverlay{display:none;z-index:10080}
      .cfKeywordGovModal{width:min(1180px,96vw);max-height:92vh}
      .cfKeywordGovHeader{gap:14px;align-items:flex-start}
      .cfKeywordGovEyebrow{font-size:10px;font-weight:800;letter-spacing:.12em;color:var(--accent);margin-bottom:4px}
      .cfKeywordGovHeader h2{margin:0 0 4px;font-size:20px}
      .cfKeywordGovHeaderActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .cfKeywordGovAccess{padding:5px 9px;border-radius:999px;background:var(--chip);font-size:10px;font-weight:800;color:var(--muted)}
      .cfKeywordGovAccess[data-mode="manage"]{color:var(--good)}
      .cfKeywordGovAccess[data-mode="keyword"]{color:var(--accent)}
      .cfKeywordGovBody{display:grid;gap:12px}
      .cfKeywordGovTabs{display:flex;gap:4px;align-items:center}
      .cfKeywordGovControls{display:grid;grid-template-columns:minmax(180px,1fr) 150px minmax(240px,1.4fr);gap:8px}
      .cfKeywordGovControls label{display:grid;gap:4px;font-size:10px;color:var(--muted)}
      .cfKeywordGovControls select,.cfKeywordGovControls input,.cfKeywordGovCreate input,.cfKeywordGovCreate select{width:100%;border:1px solid var(--line);border-radius:10px;background:var(--input-bg);color:var(--text);padding:8px 9px}
      .cfKeywordGovCreate{display:grid;grid-template-columns:auto minmax(180px,1.4fr) minmax(140px,1fr) minmax(160px,1fr) 120px auto;gap:7px;align-items:end;padding:9px;border:1px solid var(--line);border-radius:12px;background:var(--input-bg)}
      .cfKeywordGovCreateTitle{align-self:center;font-size:11px;font-weight:800;color:var(--text);white-space:nowrap}
      .cfKeywordGovStatus{min-height:18px;font-size:11px;color:var(--muted)}
      .cfKeywordGovStatus[data-tone="ok"]{color:var(--good)}
      .cfKeywordGovStatus[data-tone="warn"]{color:var(--warn)}
      .cfKeywordGovStatus[data-tone="bad"]{color:var(--bad)}
      .cfKeywordGovTableWrap{max-height:52vh;overflow:auto}
      .cfKeywordGovTable{width:100%;border-collapse:collapse}
      .cfKeywordGovTable th,.cfKeywordGovTable td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:11px}
      .cfKeywordGovTable th{position:sticky;top:0;background:var(--card);z-index:1;color:var(--muted)}
      .cfKeywordGovActions{display:flex;gap:5px;flex-wrap:wrap;min-width:170px}
      .cfKeywordGovAction{padding:5px 8px;font-size:10px}
      .cfKeywordGovEmpty{text-align:center!important;color:var(--muted);padding:24px!important}
      .cfKeywordGovFoot{color:var(--muted)}
      #cfKeywordGovProductLabel[data-required="1"]{color:var(--accent)}
      @media(max-width:860px){.cfKeywordGovControls{grid-template-columns:1fr}.cfKeywordGovCreate{grid-template-columns:1fr 1fr}.cfKeywordGovCreateTitle{grid-column:1/-1}.cfKeywordGovHeader{display:grid}.cfKeywordGovHeaderActions{justify-content:flex-start}.cfKeywordGovTableWrap{max-height:46vh}}
      @media(max-width:520px){.cfKeywordGovCreate{grid-template-columns:1fr}.cfKeywordGovModal{width:98vw}.cfKeywordGovTable th:nth-child(2),.cfKeywordGovTable td:nth-child(2){display:none}}
    `;
    global.document.head.appendChild(style);
  }
})(window);
