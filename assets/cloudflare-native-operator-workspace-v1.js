(function initCloudflareNativeOperatorWorkspace(global) {
  'use strict';

  const VERSION = '1.1.0';
  const LEGACY_ENTRYPOINT_IDS = Object.freeze([
    'btnNativeKeywordGovernance',
    'btnNativeProductGovernance',
    'btnNativeNegativeGovernance',
    'btnNativeOperationsHealth',
    'btnNativeAuditConsole',
    'btnNativeAccessConsole',
  ]);

  const NAVIGATION = Object.freeze([
    item('overview', 'overview', 'O', '经营总览', 'Overview', 'anchor', '#overviewSection', [['analytics.read']]),
    item('productRegistry', 'products', 'P', '产品注册表', 'Product Registry', 'surface', 'product-registry', [['products.read', 'products.manage']]),
    item('storeProductMapping', 'products', 'S', '店铺 SKU / ASIN', 'Store SKU / ASIN', 'surface', 'product-store', [['ads.read', 'products.manage']]),
    item('positiveKeywords', 'keywords', 'K', '正向关键词', 'Positive Keywords', 'surface', 'keyword-library', [['keywords.read', 'keywords.manage']]),
    item('productKeywordGovernance', 'keywords', 'M', '产品关键词映射', 'Product Keyword Governance', 'surface', 'keyword-product', [['keywords.read', 'keywords.manage'], ['products.read', 'products.manage']]),
    item('negativeKeywords', 'keywords', 'N', '否定词治理', 'Negative Keywords', 'surface', 'negative-library', [['negatives.read', 'negatives.manage']]),
    item('searchTerms', 'ads', 'Q', '搜索词情报', 'Search Term Intelligence', 'surface', 'decision-intelligence', [['analytics.read']]),
    item('recommendationQueue', 'ads', 'R', '建议队列', 'Recommendation Queue', 'surface', 'decision-actions', [['ads.read']]),
    item('targeting', 'ads', 'T', '投放分析', 'Targeting', 'anchor', '#multiDimCard', [['analytics.read']]),
    item('bidIntelligence', 'ads', 'B', '出价情报', 'Bid Intelligence', 'anchor', '#rankGovernanceCard', [['analytics.read']]),
    item('governanceHealth', 'operations', 'V', '治理健康', 'Governance Health', 'surface', 'governance-health', [['ads.read']]),
    item('operationsHealth', 'operations', 'H', '运营健康', 'Operations Health', 'surface', 'operations-health', [['analytics.read']]),
    item('dataHealth', 'operations', 'D', '数据健康', 'Data Health', 'surface', 'operations-health', [['analytics.read']]),
    item('auditTrail', 'operations', 'A', '审计轨迹', 'Audit Trail', 'surface', 'audit', [['audit.read']]),
    item('users', 'administration', 'U', '用户', 'Users', 'surface', 'access-users', [['users.manage']]),
    item('storeMembership', 'administration', 'G', '店铺成员', 'Store Membership', 'surface', 'access-members', [['users.manage']]),
    item('rolesAccess', 'administration', 'R', '角色 / 权限', 'Roles / Access', 'surface', 'access-roles', [['users.manage']]),
  ]);

  const GROUPS = Object.freeze([
    group('overview', '工作台', 'Workspace'),
    group('products', '产品', 'Products'),
    group('keywords', '关键词', 'Keywords'),
    group('ads', '广告情报', 'Ads Intelligence'),
    group('operations', '运营', 'Operations'),
    group('administration', '管理', 'Administration'),
  ]);

  const state = {
    mounted: false,
    loading: false,
    capabilities: null,
    stores: [],
    storeId: '',
    access: Object.create(null),
    locale: 'zh',
    root: null,
  };

  const publicApi = Object.freeze({
    version: VERSION,
    navigationContract: NAVIGATION,
    groupContract: GROUPS,
    evaluateAccess,
    mount,
    refreshContext,
    openItem,
    currentStoreId: () => state.storeId,
  });

  Object.defineProperty(global, 'CloudflareOperatorWorkspace', {
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

  function item(key, groupKey, mark, zh, en, kind, target, permissionSets) {
    return Object.freeze({
      key,
      group: groupKey,
      mark,
      label: Object.freeze({ zh, en }),
      kind,
      target,
      permissionSets: Object.freeze(permissionSets.map((set) => Object.freeze([...set]))),
    });
  }

  function group(key, zh, en) {
    return Object.freeze({ key, label: Object.freeze({ zh, en }) });
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
    const sidebar = global.document.querySelector('.sidebar');
    if (!sidebar) return;

    state.mounted = true;
    state.locale = detectLocale();
    installStyles();
    global.document.body.classList.add('cfOperatorWorkspaceReady');

    const shell = global.document.createElement('section');
    shell.id = 'cfOperatorWorkspace';
    shell.className = 'cfOperatorWorkspace';
    shell.setAttribute('aria-label', 'Operator Workspace');
    state.root = shell;

    const brand = global.document.querySelector('.sidebarBrand');
    if (brand?.parentElement === sidebar) brand.insertAdjacentElement('afterend', shell);
    else sidebar.insertBefore(shell, sidebar.firstChild);

    shell.addEventListener('click', onNavigationClick);
    shell.addEventListener('change', onStoreChange);

    hideLegacyEntrypoints();
    installEntrypointObserver();
    installLocaleObserver();
    render();
    void refreshContext();
  }

  async function refreshContext() {
    if (state.loading) return;
    state.loading = true;
    renderStatus(t('正在读取店铺与权限…', 'Loading store and permissions…'), 'loading');
    try {
      const [capabilities, storesPayload] = await Promise.all([
        api().capabilities(),
        api().stores(),
      ]);
      state.capabilities = capabilities || {};
      state.stores = normalizeStores(storesPayload?.stores);
      if (!state.stores.some((store) => store.storeId === state.storeId)) {
        state.storeId = state.stores[0]?.storeId || '';
      }
      state.access = evaluateAccess(state.capabilities, state.storeId);
      render();
      renderStatus(
        state.storeId
          ? t('权限已同步 · 入口按当前店铺收敛', 'Permissions synced · navigation scoped to current store')
          : t('没有可用店铺上下文', 'No available store context'),
        state.storeId ? 'ok' : 'warn',
      );
      dispatchStoreChange();
    } catch (error) {
      state.capabilities = null;
      state.stores = [];
      state.storeId = '';
      state.access = evaluateAccess(null, '');
      render();
      renderStatus(t('权限上下文不可用，Native 入口已 fail closed', 'Permission context unavailable; Native entries are fail closed'), 'bad');
    } finally {
      state.loading = false;
    }
  }

  function evaluateAccess(capabilities, storeId = '') {
    const globalPermissions = new Set(Array.isArray(capabilities?.globalPermissions) ? capabilities.globalPermissions : []);
    const storePermissions = capabilities?.storePermissions && typeof capabilities.storePermissions === 'object'
      ? capabilities.storePermissions
      : {};
    const selectedStorePermissions = new Set(Array.isArray(storePermissions[storeId]) ? storePermissions[storeId] : []);
    const all = new Set([...globalPermissions, ...selectedStorePermissions]);
    const result = Object.create(null);
    for (const navItem of NAVIGATION) {
      result[navItem.key] = navItem.permissionSets.every((permissionSet) => permissionSet.some((permission) => all.has(permission)));
    }
    return result;
  }

  function render() {
    if (!state.root) return;
    state.locale = detectLocale();
    const storeOptions = state.stores.length
      ? state.stores.map((store) => `<option value="${escapeAttr(store.storeId)}"${store.storeId === state.storeId ? ' selected' : ''}>${escapeHtml(store.displayName || store.storeCode || store.storeId)}</option>`).join('')
      : `<option value="">${escapeHtml(t('无可用店铺', 'No stores available'))}</option>`;

    const groupsMarkup = GROUPS.map((navGroup) => {
      const items = NAVIGATION.filter((entry) => entry.group === navGroup.key);
      return `<div class="cfOperatorGroup" data-group="${navGroup.key}">
        <div class="cfOperatorGroupLabel">${escapeHtml(label(navGroup))}</div>
        <div class="cfOperatorGroupItems">${items.map(renderItem).join('')}</div>
      </div>`;
    }).join('');

    state.root.innerHTML = `
      <div class="cfOperatorHead">
        <div>
          <div class="cfOperatorEyebrow">OPERATOR WORKSPACE · DAILY OPERATIONS</div>
          <h2>${escapeHtml(t('运营工作台', 'Operator Workspace'))}</h2>
        </div>
        <span class="cfOperatorNativeBadge">Cloudflare Native</span>
      </div>
      <label class="cfOperatorStoreLabel" for="cfOperatorStore">
        <span>${escapeHtml(t('当前店铺', 'Current store'))}</span>
        <select id="cfOperatorStore" ${state.stores.length ? '' : 'disabled'}>${storeOptions}</select>
      </label>
      <nav class="cfOperatorGroups" aria-label="${escapeAttr(t('运营工作台导航', 'Operator workspace navigation'))}">${groupsMarkup}</nav>
      <div class="cfOperatorStatus" id="cfOperatorStatus" role="status" aria-live="polite"></div>`;

    markLegacyAnalyticsNav();
  }

  function renderItem(navItem) {
    const allowed = Boolean(state.access?.[navItem.key]);
    const disabled = allowed ? '' : ' aria-disabled="true" data-locked="true"';
    const title = allowed ? label(navItem) : t('当前权限不可访问', 'Unavailable for current permissions');
    return `<button class="cfOperatorNavItem" type="button" data-operator-item="${navItem.key}" title="${escapeAttr(title)}"${disabled}>
      <span class="cfOperatorMark">${navItem.mark}</span>
      <span class="cfOperatorNavText">${escapeHtml(label(navItem))}</span>
      <span class="cfOperatorNavMeta">${allowed ? '→' : '·'}</span>
    </button>`;
  }

  async function onNavigationClick(event) {
    const button = event.target.closest?.('[data-operator-item]');
    if (!button || !state.root?.contains(button)) return;
    await openItem(button.dataset.operatorItem);
  }

  async function openItem(key) {
    const navItem = NAVIGATION.find((entry) => entry.key === key);
    if (!navItem) return false;
    if (!state.access?.[key]) {
      renderStatus(t('当前账号缺少该入口所需权限', 'Current account lacks permission for this entry'), 'warn');
      return false;
    }

    if (navItem.kind === 'anchor') {
      const target = global.document?.querySelector(navItem.target);
      if (!target) {
        renderStatus(t('目标页面暂不可用', 'Target view is not available'), 'warn');
        return false;
      }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      renderStatus(label(navItem), 'ok');
      return true;
    }

    const opened = await openSurface(navItem.target);
    renderStatus(opened ? label(navItem) : t('目标控制台尚未就绪', 'Target console is not ready'), opened ? 'ok' : 'warn');
    return opened;
  }

  async function openSurface(target) {
    switch (target) {
      case 'product-registry':
        return openConsole(global.CloudflareProductGovernance, '[data-cf-product-mode="registry"]');
      case 'product-store':
        return openConsole(global.CloudflareProductGovernance, '[data-cf-product-mode="store"]');
      case 'keyword-library':
        return openConsole(global.CloudflareKeywordGovernance, '[data-cf-keyword-mode="library"]');
      case 'keyword-product':
        return openConsole(global.CloudflareKeywordGovernance, '[data-cf-keyword-mode="product"]');
      case 'negative-library':
        return openConsole(global.CloudflareNegativeGovernance, '[data-cf-neg-mode="library"]');
      case 'decision-intelligence':
        return openDecisionView('intelligence');
      case 'decision-actions':
        return openDecisionView('actions');
      case 'governance-health':
        return openDecisionView('actions', '[data-phase9-governance-health]');
      case 'operations-health':
        return openConsole(global.CloudflareOperationsHealth);
      case 'audit':
        return openConsole(global.CloudflareAuditConsole);
      case 'access-users':
        return openConsole(global.CloudflareAccessConsole, null, '.cfAccessProvision');
      case 'access-members':
        return openConsole(global.CloudflareAccessConsole, null, '#cfAccessAssignPanel');
      case 'access-roles':
        return openConsole(global.CloudflareAccessConsole, null, '.cfAccessContext');
      default:
        return false;
    }
  }

  async function openConsole(consoleApi, modeSelector = null, focusSelector = null) {
    if (!consoleApi || typeof consoleApi.open !== 'function') return false;
    await consoleApi.open();
    if (modeSelector) global.document?.querySelector(modeSelector)?.click();
    if (focusSelector) global.document?.querySelector(focusSelector)?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    return true;
  }

  async function openDecisionView(tab, focusSelector = null) {
    const decisionApi = global.CloudflareDecisionIntelligence;
    if (!decisionApi || typeof decisionApi.open !== 'function') return false;
    await decisionApi.open();
    const tabButton = global.document?.querySelector(`#cfDecisionPanel [data-tab="${tab}"]`);
    if (!tabButton) return false;
    tabButton.click();
    if (focusSelector) {
      const focus = () => global.document?.querySelector(focusSelector)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      queueMicrotask(focus);
      global.setTimeout?.(focus, 0);
    }
    return true;
  }

  function onStoreChange(event) {
    if (event.target?.id !== 'cfOperatorStore') return;
    state.storeId = String(event.target.value || '');
    state.access = evaluateAccess(state.capabilities, state.storeId);
    render();
    renderStatus(t('店铺上下文已切换', 'Store context changed'), 'ok');
    dispatchStoreChange();
  }

  function dispatchStoreChange() {
    if (!state.storeId || typeof global.dispatchEvent !== 'function') return;
    try {
      const event = typeof global.CustomEvent === 'function'
        ? new global.CustomEvent('cloudflare-operator-store-change', { detail: { storeId: state.storeId } })
        : null;
      if (event) global.dispatchEvent(event);
    } catch {
      // Cross-console store context propagation is advisory; each console remains independently fail closed.
    }
  }

  function hideLegacyEntrypoints() {
    for (const id of LEGACY_ENTRYPOINT_IDS) {
      const button = global.document?.getElementById(id);
      if (!button) continue;
      button.hidden = true;
      button.setAttribute('aria-hidden', 'true');
      button.dataset.operatorWorkspaceOwned = 'true';
    }
  }

  function installEntrypointObserver() {
    if (typeof global.MutationObserver !== 'function' || !global.document?.body) return;
    const observer = new global.MutationObserver(() => hideLegacyEntrypoints());
    observer.observe(global.document.body, { childList: true, subtree: true });
  }

  function installLocaleObserver() {
    if (typeof global.MutationObserver !== 'function') return;
    const html = global.document?.documentElement;
    const toggle = global.document?.querySelector('#btnLangToggle');
    const observer = new global.MutationObserver(() => {
      const next = detectLocale();
      if (next === state.locale) return;
      state.locale = next;
      render();
      renderStatus(t('界面语言已同步', 'Interface language synchronized'), 'ok');
    });
    if (html) observer.observe(html, { attributes: true, attributeFilter: ['lang'] });
    if (toggle) observer.observe(toggle, { childList: true, characterData: true, subtree: true });
  }

  function markLegacyAnalyticsNav() {
    const legacyNav = global.document?.querySelector('.sidebarNav');
    if (!legacyNav) return;
    legacyNav.classList.add('cfLegacyAnalyticsNav');
    legacyNav.setAttribute('data-nav-label', t('页面分析 · Analytics', 'Page Analytics'));
  }

  function renderStatus(message, tone = '') {
    const node = global.document?.querySelector('#cfOperatorStatus');
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.tone = tone;
  }

  function normalizeStores(rows) {
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    const output = [];
    for (const row of rows) {
      const storeId = String(row?.storeId || row?.store_id || '').trim();
      if (!storeId || seen.has(storeId)) continue;
      seen.add(storeId);
      output.push({
        storeId,
        storeCode: String(row?.storeCode || row?.store_code || '').trim(),
        displayName: String(row?.displayName || row?.display_name || '').trim(),
      });
    }
    return output;
  }

  function detectLocale() {
    const lang = String(global.document?.documentElement?.lang || '').toLowerCase();
    if (lang.startsWith('en')) return 'en';
    const toggleText = String(global.document?.querySelector('#btnLangToggle')?.textContent || '');
    return /中文|zh\b/i.test(toggleText) ? 'en' : 'zh';
  }

  function label(entry) {
    return entry?.label?.[state.locale] || entry?.label?.zh || entry?.key || '';
  }

  function t(zh, en) {
    return state.locale === 'en' ? en : zh;
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
    if (global.document?.querySelector('#cfOperatorWorkspaceStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfOperatorWorkspaceStyles';
    style.textContent = `
      body.cfOperatorWorkspaceReady .header{
        position:sticky;top:14px;z-index:45;
        backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
        background:color-mix(in srgb,var(--card) 92%,transparent);
      }
      body.cfOperatorWorkspaceReady .title h1{font-size:20px;line-height:1.18;letter-spacing:-.35px}
      body.cfOperatorWorkspaceReady .title .sub{font-size:12.5px;line-height:1.5}
      .cfOperatorWorkspace{margin:12px 0;padding:13px;border:1px solid color-mix(in srgb,var(--line) 86%,transparent);border-radius:18px;background:linear-gradient(155deg,color-mix(in srgb,var(--accent) 7%,var(--card)),var(--card) 46%);box-shadow:0 8px 24px rgba(22,32,51,.045)}
      .cfOperatorHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:11px}
      .cfOperatorHead h2{margin:2px 0 0;font-size:15.5px;line-height:1.2;letter-spacing:-.18px}
      .cfOperatorEyebrow{font-size:9.8px;font-weight:900;letter-spacing:.075em;color:var(--accent)}
      .cfOperatorNativeBadge{display:inline-flex;align-items:center;min-height:24px;padding:4px 7px;border-radius:8px;background:color-mix(in srgb,var(--accent) 9%,var(--card));border:1px solid color-mix(in srgb,var(--accent) 18%,var(--line));color:var(--accent);font-size:9.8px;font-weight:850;white-space:nowrap}
      .cfOperatorStoreLabel{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:9px;margin:0 0 12px;padding:8px 9px;border:1px solid var(--line);border-radius:12px;background:var(--hover-bg);font-size:10.8px;color:var(--muted);font-weight:800}
      .cfOperatorStoreLabel select{min-width:0;width:100%;padding:7px 9px;border-radius:9px;font-size:11.6px;background:var(--input-bg)}
      .cfOperatorGroups{display:flex;flex-direction:column;gap:11px}
      .cfOperatorGroupLabel{margin:0 2px 5px;font-size:9.8px;font-weight:900;letter-spacing:.065em;text-transform:uppercase;color:var(--muted)}
      .cfOperatorGroupItems{display:flex;flex-direction:column;gap:3px}
      .cfOperatorNavItem{width:100%;display:grid;grid-template-columns:27px minmax(0,1fr) 16px;align-items:center;gap:7px;border:0;background:transparent;color:var(--text);padding:6px;border-radius:10px;text-align:left;cursor:pointer;transition:background .16s ease,transform .16s ease,color .16s ease}
      .cfOperatorNavItem:hover:not([aria-disabled="true"]){background:color-mix(in srgb,var(--accent) 8%,var(--hover-bg));color:var(--accent);transform:translateX(1px)}
      .cfOperatorNavItem:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
      .cfOperatorNavItem[aria-disabled="true"]{cursor:not-allowed;opacity:.43}
      .cfOperatorMark{width:27px;height:27px;display:grid;place-items:center;border-radius:8px;background:var(--hover-bg);border:1px solid var(--line);font-size:10px;font-weight:900;color:var(--muted)}
      .cfOperatorNavItem:not([aria-disabled="true"]):hover .cfOperatorMark{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 28%,var(--line));background:color-mix(in srgb,var(--accent) 8%,var(--card))}
      .cfOperatorNavText{min-width:0;font-size:11.9px;font-weight:760;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cfOperatorNavMeta{font-size:11px;color:var(--muted);text-align:right}
      .cfOperatorStatus{min-height:28px;margin-top:11px;padding:7px 8px;border-radius:10px;background:var(--hover-bg);border:1px solid var(--line);font-size:10.4px;line-height:1.35;color:var(--muted)}
      .cfOperatorStatus[data-tone="ok"]{color:var(--good);background:var(--softGood);border-color:transparent}
      .cfOperatorStatus[data-tone="warn"]{color:var(--warn);background:var(--softWarn);border-color:transparent}
      .cfOperatorStatus[data-tone="bad"]{color:var(--bad);background:var(--softBad);border-color:transparent}
      .cfLegacyAnalyticsNav{margin-top:13px!important;padding-top:12px!important;border-top:1px solid var(--line)}
      .cfLegacyAnalyticsNav::before{content:attr(data-nav-label);display:block;margin:0 2px 7px;font-size:9.8px;font-weight:900;letter-spacing:.055em;text-transform:uppercase;color:var(--muted)}
      body.cfOperatorWorkspaceReady #btnNativeKeywordGovernance,
      body.cfOperatorWorkspaceReady #btnNativeProductGovernance,
      body.cfOperatorWorkspaceReady #btnNativeNegativeGovernance,
      body.cfOperatorWorkspaceReady #btnNativeOperationsHealth,
      body.cfOperatorWorkspaceReady #btnNativeAuditConsole,
      body.cfOperatorWorkspaceReady #btnNativeAccessConsole{display:none!important}
      @media (max-width: 960px){
        body.cfOperatorWorkspaceReady .app{grid-template-columns:1fr;width:min(100% - 16px,1900px);padding-top:8px}
        body.cfOperatorWorkspaceReady .sidebar{position:relative;top:0;height:auto;max-height:none}
        body.cfOperatorWorkspaceReady .header{top:8px}
        .cfOperatorGroupItems{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
        .cfOperatorNavText{white-space:normal;line-height:1.25}
      }
      @media (max-width: 560px){
        body.cfOperatorWorkspaceReady .header{position:relative;top:0;flex-direction:column;padding:12px}
        body.cfOperatorWorkspaceReady .header .actions{width:100%;overflow-x:auto;justify-content:flex-start;padding-bottom:2px}
        body.cfOperatorWorkspaceReady .title h1{font-size:18px}
        .cfOperatorWorkspace{padding:11px;border-radius:16px}
        .cfOperatorStoreLabel{grid-template-columns:1fr;gap:4px}
        .cfOperatorGroupItems{grid-template-columns:1fr}
        .cfOperatorNavItem{grid-template-columns:26px minmax(0,1fr) 14px;padding:6px 5px}
        .cfOperatorNavText{font-size:12.4px}
      }
    `;
    global.document.head.appendChild(style);
  }
})(typeof window !== 'undefined' ? window : globalThis);