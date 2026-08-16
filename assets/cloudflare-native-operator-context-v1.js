(function initCloudflareNativeOperatorContext(global) {
  'use strict';

  const VERSION = '1.0.0';
  const PRODUCT_LIMIT = 200;
  const KEYWORD_LIMIT = 200;

  const STORE_SELECTORS = Object.freeze([
    '#cfProductGovStore',
    '#cfNegGovStore',
    '#cfOpsHealthStore',
    '#cfAuditStore',
    '#cfAccessStore',
  ]);

  const PRODUCT_SELECTORS = Object.freeze([
    '#cfProductGovMappingProduct',
    '#cfKeywordGovProduct',
    '#cfNegGovProduct',
  ]);

  const FEEDBACK_SOURCES = Object.freeze([
    Object.freeze({ selector: '#cfProductGovMessage', source: 'Products' }),
    Object.freeze({ selector: '#cfKeywordGovStatus', source: 'Keywords' }),
    Object.freeze({ selector: '#cfNegGovStatus', source: 'Negatives' }),
    Object.freeze({ selector: '#cfOpsHealthStatus', source: 'Operations' }),
    Object.freeze({ selector: '#cfAuditStatus', source: 'Audit' }),
    Object.freeze({ selector: '#cfAccessStatus', source: 'Access' }),
  ]);

  const state = {
    mounted: false,
    context: { storeId: '', productId: '', keywordId: '' },
    capabilities: null,
    products: [],
    keywords: [],
    productLoadSerial: 0,
    keywordLoadSerial: 0,
    root: null,
    feedback: { source: '', message: '' },
    observerScheduled: false,
  };

  const publicApi = Object.freeze({
    version: VERSION,
    getContext,
    setContext,
    refreshCatalogs,
    applyToControls,
    openAuditForContext,
    evaluatePermissionMode,
    mount,
  });

  Object.defineProperty(global, 'CloudflareOperatorContext', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  function getContext() {
    return Object.freeze({ ...state.context });
  }

  function setContext(patch = {}, options = {}) {
    const next = { ...state.context };
    let changed = false;

    if (Object.prototype.hasOwnProperty.call(patch, 'storeId')) {
      const value = text(patch.storeId);
      if (value !== next.storeId) {
        next.storeId = value;
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'productId')) {
      const value = text(patch.productId);
      if (value !== next.productId) {
        next.productId = value;
        if (!options.preserveKeyword) next.keywordId = '';
        changed = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'keywordId')) {
      const value = text(patch.keywordId);
      if (value !== next.keywordId) {
        next.keywordId = value;
        changed = true;
      }
    }

    state.context = next;
    if (!changed) return getContext();

    render();
    dispatchContextChange(options.source || 'operator-context');
    if (!options.skipApply) applyToControls();

    if (!options.skipRefresh) {
      if (Object.prototype.hasOwnProperty.call(patch, 'storeId')) {
        void refreshProducts();
      } else if (Object.prototype.hasOwnProperty.call(patch, 'productId')) {
        void refreshKeywords();
      }
    }
    return getContext();
  }

  function evaluatePermissionMode(capabilities, storeId = '') {
    const globalPermissions = new Set(Array.isArray(capabilities?.globalPermissions) ? capabilities.globalPermissions : []);
    const storePermissions = capabilities?.storePermissions && typeof capabilities.storePermissions === 'object'
      ? capabilities.storePermissions
      : {};
    const selectedStore = new Set(Array.isArray(storePermissions[storeId]) ? storePermissions[storeId] : []);
    const all = new Set([...globalPermissions, ...selectedStore]);

    const canRead = ['analytics.read', 'ads.read', 'products.read', 'products.manage', 'keywords.read', 'keywords.manage', 'negatives.read', 'negatives.manage', 'audit.read', 'users.manage']
      .some((permission) => all.has(permission));
    const canWrite = ['products.manage', 'keywords.manage', 'negatives.manage', 'users.manage', 'stores.manage']
      .some((permission) => all.has(permission));

    return Object.freeze({
      canRead,
      canWrite,
      mode: canWrite ? 'manage' : (canRead ? 'read-only' : 'locked'),
    });
  }

  if (!global.document) return;
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  function api() {
    if (!global.CloudflareNativeAPI) {
      const error = new Error('cloudflare_native_api_not_ready');
      error.code = 'cloudflare_native_api_not_ready';
      throw error;
    }
    return global.CloudflareNativeAPI;
  }

  function mount() {
    if (state.mounted || !global.document?.body) return;
    state.mounted = true;

    installStyles();
    global.addEventListener?.('cloudflare-operator-store-change', (event) => {
      const storeId = text(event?.detail?.storeId);
      if (storeId) setContext({ storeId }, { source: 'workspace-store' });
    });

    global.document.addEventListener('change', onDocumentChange, true);
    global.document.addEventListener('input', onDocumentInput, true);
    global.document.addEventListener('click', onDocumentClick, true);

    installObserver();
    ensurePanel();

    const workspaceStoreId = text(global.CloudflareOperatorWorkspace?.currentStoreId?.());
    if (workspaceStoreId) state.context.storeId = workspaceStoreId;

    void refreshCatalogs();
  }

  async function refreshCatalogs() {
    ensurePanel();
    renderStatus(t('正在同步运营上下文…', 'Synchronizing operator context…'), 'loading');
    try {
      const capabilities = await api().capabilities();
      state.capabilities = capabilities || {};
      await refreshProducts();
      renderStatus(t('运营上下文已同步', 'Operator context synchronized'), 'ok');
    } catch (error) {
      state.capabilities = null;
      state.products = [];
      state.keywords = [];
      render();
      renderStatus(t('上下文目录不可用；入口继续按原 Console 权限 fail closed', 'Context catalog unavailable; consoles remain fail closed'), 'warn');
    }
  }

  async function refreshProducts() {
    const serial = ++state.productLoadSerial;
    try {
      const payload = await api().listProducts({ limit: PRODUCT_LIMIT, status: 'active' });
      if (serial !== state.productLoadSerial) return;
      state.products = normalizeProducts(payload?.items);
      if (state.context.productId && !state.products.some((row) => row.productId === state.context.productId)) {
        state.context.productId = '';
        state.context.keywordId = '';
      }
      if (!state.context.productId && state.products.length === 1) {
        state.context.productId = state.products[0].productId;
      }
      render();
      applyToControls();
      await refreshKeywords();
    } catch {
      if (serial !== state.productLoadSerial) return;
      state.products = [];
      state.keywords = [];
      state.context.productId = '';
      state.context.keywordId = '';
      render();
    }
  }

  async function refreshKeywords() {
    const serial = ++state.keywordLoadSerial;
    if (!state.context.productId) {
      state.keywords = [];
      state.context.keywordId = '';
      render();
      return;
    }
    try {
      const payload = await api().productKeywords(state.context.productId, {
        limit: KEYWORD_LIMIT,
        lifecycleStatus: 'active',
      });
      if (serial !== state.keywordLoadSerial) return;
      state.keywords = normalizeKeywords(payload?.items);
      if (state.context.keywordId && !state.keywords.some((row) => row.keywordId === state.context.keywordId)) {
        state.context.keywordId = '';
      }
      render();
      applyToControls();
    } catch {
      if (serial !== state.keywordLoadSerial) return;
      state.keywords = [];
      state.context.keywordId = '';
      render();
    }
  }

  function ensurePanel() {
    if (!global.document) return null;
    if (state.root?.isConnected) return state.root;
    const workspace = global.document.querySelector('#cfOperatorWorkspace');
    if (!workspace) return null;

    const panel = global.document.createElement('section');
    panel.id = 'cfOperatorContextPanel';
    panel.className = 'cfOperatorContextPanel';
    panel.setAttribute('aria-label', 'Operator context');
    const storeLabel = workspace.querySelector('.cfOperatorStoreLabel');
    if (storeLabel) storeLabel.insertAdjacentElement('afterend', panel);
    else workspace.appendChild(panel);
    state.root = panel;
    render();
    return panel;
  }

  function render() {
    const panel = ensurePanel();
    if (!panel) return;

    const mode = evaluatePermissionMode(state.capabilities, state.context.storeId);
    const productOptions = [
      `<option value="">${escapeHtml(t('全部产品 / 未指定', 'All products / none'))}</option>`,
      ...state.products.map((row) => `<option value="${escapeAttr(row.productId)}"${row.productId === state.context.productId ? ' selected' : ''}>${escapeHtml(productLabel(row))}</option>`),
    ].join('');

    const keywordDisabled = !state.context.productId || !state.keywords.length;
    const keywordOptions = [
      `<option value="">${escapeHtml(t('未指定关键词', 'No keyword selected'))}</option>`,
      ...state.keywords.map((row) => `<option value="${escapeAttr(row.keywordId)}"${row.keywordId === state.context.keywordId ? ' selected' : ''}>${escapeHtml(keywordLabel(row))}</option>`),
    ].join('');

    panel.innerHTML = `
      <div class="cfOperatorContextHead">
        <div><span>${escapeHtml(t('共享运营上下文', 'Shared operator context'))}</span><small>${escapeHtml(t('跨 Console 保持店铺、产品与关键词', 'Store, product and keyword persist across consoles'))}</small></div>
        <span class="cfOperatorContextMode" data-mode="${escapeAttr(mode.mode)}">${escapeHtml(modeText(mode.mode))}</span>
      </div>
      <label class="cfOperatorContextField">
        <span>${escapeHtml(t('产品', 'Product'))}</span>
        <select id="cfOperatorContextProduct"${state.products.length ? '' : ' disabled'}>${productOptions}</select>
      </label>
      <label class="cfOperatorContextField">
        <span>${escapeHtml(t('关键词', 'Keyword'))}</span>
        <select id="cfOperatorContextKeyword"${keywordDisabled ? ' disabled' : ''}>${keywordOptions}</select>
      </label>
      <div class="cfOperatorContextActions">
        <button type="button" id="btnCfOperatorContextAudit" class="btn" ${mode.canRead ? '' : 'disabled'}>${escapeHtml(t('查看当前审计', 'Audit current scope'))}</button>
      </div>
      <div id="cfOperatorContextFeedback" class="cfOperatorContextFeedback" aria-live="polite"></div>
      <div id="cfOperatorContextStatus" class="cfOperatorContextStatus" role="status" aria-live="polite"></div>
    `;
    renderFeedback();
  }

  function onDocumentChange(event) {
    const id = String(event.target?.id || '');
    const value = text(event.target?.value);
    if (!id) return;

    if (id === 'cfOperatorContextProduct') {
      setContext({ productId: value }, { source: 'workspace-product' });
      return;
    }
    if (id === 'cfOperatorContextKeyword') {
      setContext({ keywordId: value }, { source: 'workspace-keyword' });
      return;
    }
    if (STORE_SELECTORS.some((selector) => selector === `#${id}`) && value) {
      setContext({ storeId: value }, { source: id, skipApply: true });
      return;
    }
    if (PRODUCT_SELECTORS.some((selector) => selector === `#${id}`)) {
      setContext({ productId: value }, { source: id, skipApply: true });
    }
  }

  function onDocumentInput(event) {
    if (event.target?.id !== 'cfKeywordGovSearch') return;
    if (event.isTrusted && event.target?.dataset) delete event.target.dataset.operatorContextManaged;
  }

  function onDocumentClick(event) {
    if (event.target?.id === 'btnCfOperatorContextAudit') {
      void openAuditForContext();
      return;
    }
    const item = event.target?.closest?.('[data-operator-item]');
    if (item) scheduleApply();
  }

  function applyToControls() {
    for (const selector of STORE_SELECTORS) {
      syncSelect(selector, state.context.storeId);
    }
    for (const selector of PRODUCT_SELECTORS) {
      syncSelect(selector, state.context.productId);
    }
    applyKeywordSearch();
  }

  function syncSelect(selector, value) {
    if (!value) return;
    const select = global.document.querySelector(selector);
    if (!select || select.value === value) return;
    const option = Array.from(select.options || []).find((entry) => entry.value === value);
    if (!option) return;
    select.value = value;
    select.dispatchEvent(new global.Event('change', { bubbles: true }));
  }

  function applyKeywordSearch() {
    if (!state.context.keywordId) return;
    const row = state.keywords.find((entry) => entry.keywordId === state.context.keywordId);
    if (!row) return;
    const input = global.document.querySelector('#cfKeywordGovSearch');
    if (!input) return;
    const desired = row.keywordText || row.normalizedTerm || '';
    if (!desired) return;
    if (input.value && input.dataset.operatorContextManaged !== 'true') return;
    if (input.value === desired) return;
    input.value = desired;
    input.dataset.operatorContextManaged = 'true';
    input.dispatchEvent(new global.Event('input', { bubbles: true }));
  }

  async function openAuditForContext() {
    const consoleApi = global.CloudflareAuditConsole;
    if (!consoleApi || typeof consoleApi.open !== 'function') {
      renderStatus(t('审计控制台尚未就绪', 'Audit console is not ready'), 'warn');
      return false;
    }
    await consoleApi.open();
    applyToControls();

    const entityType = state.context.keywordId ? 'keyword' : (state.context.productId ? 'product' : '');
    const entityInput = global.document.querySelector('#cfAuditEntityType');
    if (entityInput && entityType) {
      entityInput.value = entityType;
      entityInput.dispatchEvent(new global.Event('input', { bubbles: true }));
    }
    renderStatus(
      entityType
        ? t('审计已按当前店铺与实体类型联动', 'Audit linked to current store and entity type')
        : t('审计已按当前店铺联动', 'Audit linked to current store'),
      'ok',
    );
    return true;
  }

  function installObserver() {
    if (typeof global.MutationObserver !== 'function') return;
    const observer = new global.MutationObserver(() => scheduleApply());
    observer.observe(global.document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function scheduleApply() {
    if (state.observerScheduled) return;
    state.observerScheduled = true;
    const run = () => {
      state.observerScheduled = false;
      ensurePanel();
      applyToControls();
      collectFeedback();
    };
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(run);
    else Promise.resolve().then(run);
  }

  function collectFeedback() {
    for (const entry of FEEDBACK_SOURCES) {
      const node = global.document.querySelector(entry.selector);
      const message = text(node?.textContent);
      if (!message) continue;
      if (state.feedback.source === entry.source && state.feedback.message === message) continue;
      state.feedback = { source: entry.source, message };
      renderFeedback();
    }
  }

  function renderFeedback() {
    const node = global.document.querySelector('#cfOperatorContextFeedback');
    if (!node) return;
    if (!state.feedback.message) {
      node.textContent = t('Console 操作结果会在这里统一回显', 'Console action feedback will be mirrored here');
      node.dataset.empty = 'true';
      return;
    }
    node.dataset.empty = 'false';
    node.textContent = `${state.feedback.source} · ${state.feedback.message}`;
  }

  function renderStatus(message, tone = '') {
    const node = global.document.querySelector('#cfOperatorContextStatus');
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.tone = tone;
  }

  function dispatchContextChange(source) {
    if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return;
    try {
      global.dispatchEvent(new global.CustomEvent('cloudflare-operator-context-change', {
        detail: { ...state.context, source: String(source || '') },
      }));
    } catch {
      // Context propagation is advisory; individual console authorization remains authoritative.
    }
  }

  function normalizeProducts(rows) {
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    const output = [];
    for (const row of rows) {
      const productId = text(row?.productId || row?.product_id);
      if (!productId || seen.has(productId)) continue;
      seen.add(productId);
      output.push({
        productId,
        modelCode: text(row?.modelCode || row?.model_code),
        modelName: text(row?.modelName || row?.model_name),
        brand: text(row?.brand),
      });
    }
    return output;
  }

  function normalizeKeywords(rows) {
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    const output = [];
    for (const row of rows) {
      const keywordId = text(row?.keywordId || row?.keyword_id);
      if (!keywordId || seen.has(keywordId)) continue;
      seen.add(keywordId);
      output.push({
        keywordId,
        keywordText: text(row?.keywordText || row?.keyword_text),
        normalizedTerm: text(row?.normalizedTerm || row?.normalized_term),
      });
    }
    return output;
  }

  function productLabel(row) {
    return [row.modelCode || row.productId, row.modelName, row.brand].filter(Boolean).join(' · ');
  }

  function keywordLabel(row) {
    return row.keywordText || row.normalizedTerm || row.keywordId;
  }

  function modeText(mode) {
    if (mode === 'manage') return t('可管理', 'Manage');
    if (mode === 'read-only') return t('只读', 'Read only');
    return t('已锁定', 'Locked');
  }

  function t(zh, en) {
    const lang = String(global.document?.documentElement?.lang || '').toLowerCase();
    if (lang.startsWith('en')) return en;
    const toggle = String(global.document?.querySelector('#btnLangToggle')?.textContent || '');
    return /中文|zh\b/i.test(toggle) ? en : zh;
  }

  function text(value) {
    return String(value ?? '').trim();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll('`', '&#96;');
  }

  function installStyles() {
    if (global.document.querySelector('#cfOperatorContextStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfOperatorContextStyles';
    style.textContent = `
      .cfOperatorContextPanel{display:flex;flex-direction:column;gap:7px;margin:-4px 0 12px;padding:9px;border:1px solid var(--line);border-radius:13px;background:color-mix(in srgb,var(--accent) 3%,var(--hover-bg))}
      .cfOperatorContextHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
      .cfOperatorContextHead>div{min-width:0}.cfOperatorContextHead span{display:block;font-size:10.8px;font-weight:900;color:var(--text)}.cfOperatorContextHead small{display:block;margin-top:2px;font-size:9.7px;line-height:1.3;color:var(--muted)}
      .cfOperatorContextMode{flex:0 0 auto;padding:3px 6px;border-radius:999px;border:1px solid var(--line);font-size:9.4px!important;color:var(--muted)!important;background:var(--card)}
      .cfOperatorContextMode[data-mode="manage"]{color:var(--good)!important;background:var(--softGood);border-color:transparent}.cfOperatorContextMode[data-mode="read-only"]{color:var(--accent)!important;background:color-mix(in srgb,var(--accent) 9%,var(--card));border-color:transparent}.cfOperatorContextMode[data-mode="locked"]{color:var(--warn)!important;background:var(--softWarn);border-color:transparent}
      .cfOperatorContextField{display:grid;grid-template-columns:58px minmax(0,1fr);align-items:center;gap:7px;font-size:10.3px;font-weight:800;color:var(--muted)}.cfOperatorContextField select{min-width:0;width:100%;padding:6px 7px;border-radius:8px;font-size:10.8px;background:var(--input-bg)}
      .cfOperatorContextActions{display:flex;gap:6px}.cfOperatorContextActions .btn{width:100%;justify-content:center;padding:6px 8px;font-size:10.5px}
      .cfOperatorContextFeedback,.cfOperatorContextStatus{padding:6px 7px;border-radius:8px;font-size:9.8px;line-height:1.35;color:var(--muted);background:var(--card);border:1px solid var(--line)}
      .cfOperatorContextFeedback[data-empty="true"]{opacity:.72}.cfOperatorContextStatus:empty{display:none}.cfOperatorContextStatus[data-tone="ok"]{color:var(--good);background:var(--softGood);border-color:transparent}.cfOperatorContextStatus[data-tone="warn"]{color:var(--warn);background:var(--softWarn);border-color:transparent}
      @media(max-width:960px){.cfOperatorContextPanel{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,.7fr) minmax(180px,.7fr);align-items:end}.cfOperatorContextHead,.cfOperatorContextFeedback,.cfOperatorContextStatus{grid-column:1/-1}.cfOperatorContextActions{align-self:end}}
      @media(max-width:560px){.cfOperatorContextPanel{display:flex}.cfOperatorContextField{grid-template-columns:1fr;gap:3px}.cfOperatorContextActions .btn{min-height:34px}}
    `;
    global.document.head.appendChild(style);
  }
})(typeof window !== 'undefined' ? window : globalThis);
