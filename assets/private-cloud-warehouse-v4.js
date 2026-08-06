(() => {
  'use strict';

  const SCRIPT_URL = document.currentScript?.src || new URL('assets/private-cloud-warehouse-v4.js', window.location.href).href;
  const API_ORIGIN = 'https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev';
  const CHANNEL = 'warehouse-v4-production';
  const LOADER_VERSION = '4.3.0';
  const BATCH_SIZE = 6;
  const FETCH_CONCURRENCY = 1;
  const CACHE_DB = 'amazon-warehouse-v4-cache';
  const CACHE_STORE = 'immutable-files';
  const IMPORTABLE_DATA_TYPES = new Set(['ads', 'transactions', 'business']);
  const QUERY_FIRST_CAPABILITY = 'query-first-bootstrap';
  const state = {
    loading: false,
    busyMode: '',
    connectedOnce: false,
    connectedScope: '',
    bootstrap: null,
    bootstrapEtag: '',
    bootstrapCache: new Map(),
    dataFingerprint: '',
    manifest: null,
    summary: null,
    loadedOnce: false,
    loadedScope: '',
    loadedMonths: new Set(),
    loadedRange: null,
    rawBootstrapFingerprint: '',
    rawStale: false,
    apiVersion: '',
    storage: 'unknown',
    queryStatus: null,
    autoReloadTimer: null,
    cacheStats: emptyCacheStats(),
  };

  const byId = id => document.getElementById(id);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sleepFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  const memoryCredential = {
    value: '',
    get: () => memoryCredential.value,
    set: value => { memoryCredential.value = String(value || ''); return Boolean(memoryCredential.value); },
    clear: () => { memoryCredential.value = ''; },
  };

  const normalizeScope = value => {
    const scope = String(value || '').trim().toUpperCase();
    return ['ALL', 'YTDBNS', 'YY', 'JJ'].includes(scope) ? scope : 'ALL';
  };
  const activeScope = () => normalizeScope(window.ShopScope?.get?.() || window.ACTIVE_SHOP || 'ALL');
  const displayScope = value => window.ShopScope?.display?.(value) || (normalizeScope(value) === 'YTDBNS' ? 'YT' : normalizeScope(value));
  const normalizeDataType = value => String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  const formatInteger = value => Number(value || 0).toLocaleString('zh-CN');
  const formatMoney = value => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatPercent = value => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : '—';
  const formatRatio = value => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';

  function emptyCacheStats() {
    return { hits: 0, misses: 0, writes: 0, bytesReused: 0, bypassed: 0 };
  }

  const setStatus = (message, kind = '') => {
    const element = byId('privateCloudImportStatus');
    if (!element) return;
    element.textContent = message;
    element.dataset.kind = kind;
  };

  const setBusy = (busy, mode = '') => {
    state.loading = busy;
    state.busyMode = busy ? mode : '';
    const labels = {
      overview: '正在读取云端概览…',
      current: '正在加载最新月明细…',
      recent: '正在加载近 3 月明细…',
      full: '正在加载完整历史…',
      custom: '正在加载指定明细…',
    };
    const loadButton = byId('btnPrivateCloudImport');
    if (loadButton) {
      loadButton.disabled = busy;
      loadButton.textContent = busy ? (labels[mode] || '正在连接私有云…') : (state.connectedOnce ? '↻ 刷新云端概览' : '☁ 连接私有云概览');
    }
    ['btnPrivateCloudCurrentMonth', 'btnPrivateCloudRecentMonths', 'btnPrivateCloudFullHistory', 'btnPrivateCloudLogout']
      .forEach(id => {
        const button = byId(id);
        if (button) button.disabled = busy || (id !== 'btnPrivateCloudLogout' && !state.connectedOnce);
      });
    document.querySelectorAll('#privateCloudImportPanel [data-shop]').forEach(button => { button.disabled = busy; });
  };

  const notifyUser = (message, kind = 'good') => {
    try {
      if (typeof window.notify === 'function') window.notify(message, kind);
      else console.info(message);
    } catch (_) {
      console.info(message);
    }
  };

  const ensureUi = () => {
    if (!byId('privateCloudImportPanel')) {
      const input = byId('fileInput');
      if (!input) return false;
      const panel = document.createElement('div');
      panel.id = 'privateCloudImportPanel';
      panel.innerHTML = `
        <div class="privateCloudActions">
          <button class="btn primary" id="btnPrivateCloudImport" type="button">☁ 连接私有云概览</button>
          <button class="btn" id="btnPrivateCloudLogout" type="button" title="清除当前页面内存中的访问密码">清除密码</button>
        </div>
        <div class="small" id="privateCloudImportStatus">Amazon-Data-Warehouse · 未连接</div>
      `;
      input.insertAdjacentElement('afterend', panel);
    }
    ensureProgressiveStyles();
    ensureProgressiveUi();
    return true;
  };

  function ensureProgressiveStyles() {
    if (byId('privateCloudProgressiveStyles')) return;
    const style = document.createElement('style');
    style.id = 'privateCloudProgressiveStyles';
    style.textContent = `
      #privateCloudImportPanel{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px;padding:9px;border:1px solid color-mix(in srgb,var(--accent) 22%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--accent) 5%,var(--input-bg))}
      #privateCloudImportPanel .privateCloudActions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}
      #privateCloudImportPanel .btn{justify-content:center;padding:8px 10px;border-radius:10px;font-size:11.2px;min-width:0}
      #privateCloudImportStatus{min-height:16px;line-height:1.4;word-break:break-word}
      #privateCloudImportStatus[data-kind="good"]{color:var(--good)}
      #privateCloudImportStatus[data-kind="warn"]{color:var(--warn)}
      #privateCloudImportStatus[data-kind="bad"]{color:var(--bad)}
      .queryFirstRawActions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
      .queryFirstRawActions .btn{padding:7px 5px!important;font-size:10.8px!important}
      .queryFirstOverviewCard{display:none;gap:8px;padding:9px;border:1px solid var(--line);border-radius:11px;background:var(--card)}
      .queryFirstOverviewCard[data-ready="1"]{display:grid}
      .queryFirstOverviewHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
      .queryFirstOverviewTitle{font-weight:800;font-size:12px;color:var(--text)}
      .queryFirstOverviewMeta{font-size:10.5px;color:var(--muted);line-height:1.35;margin-top:2px}
      .queryFirstFingerprint{font:600 9.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:nowrap}
      .queryFirstSourceBadges{display:flex;gap:5px;flex-wrap:wrap}
      .queryFirstBadge{padding:3px 6px;border-radius:999px;background:var(--chip);font-size:9.8px;color:var(--muted)}
      .queryFirstBadge[data-available="1"]{background:var(--softGood);color:var(--good)}
      .queryFirstBadge[data-available="0"]{background:var(--softWarn);color:var(--warn)}
      .queryFirstKpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
      .queryFirstKpi{padding:7px;border-radius:9px;background:color-mix(in srgb,var(--chip) 72%,transparent);min-width:0}
      .queryFirstKpiLabel{font-size:9.8px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .queryFirstKpiValue{margin-top:2px;font-size:12.2px;font-weight:800;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .queryFirstRawState{padding-top:6px;border-top:1px solid var(--line);font-size:10.2px;line-height:1.45;color:var(--muted)}
      .queryFirstRawState[data-stale="1"]{color:var(--warn)}
      @media(max-width:420px){#privateCloudImportPanel .privateCloudActions{grid-template-columns:1fr}.queryFirstRawActions{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensureProgressiveUi() {
    const panel = byId('privateCloudImportPanel');
    if (!panel) return;
    if (!byId('queryFirstRawActions')) {
      const actions = document.createElement('div');
      actions.id = 'queryFirstRawActions';
      actions.className = 'queryFirstRawActions';
      actions.innerHTML = `
        <button class="btn" id="btnPrivateCloudCurrentMonth" type="button" disabled>最新月明细</button>
        <button class="btn" id="btnPrivateCloudRecentMonths" type="button" disabled>近 3 月明细</button>
        <button class="btn" id="btnPrivateCloudFullHistory" type="button" disabled>完整历史</button>
      `;
      const baseActions = panel.querySelector('.privateCloudActions');
      if (baseActions) baseActions.insertAdjacentElement('afterend', actions);
      else panel.appendChild(actions);
    }
    if (!byId('queryFirstOverviewCard')) {
      const card = document.createElement('div');
      card.id = 'queryFirstOverviewCard';
      card.className = 'queryFirstOverviewCard';
      card.dataset.ready = '0';
      card.innerHTML = `
        <div class="queryFirstOverviewHead">
          <div>
            <div class="queryFirstOverviewTitle">TiDB 云端经营概览</div>
            <div class="queryFirstOverviewMeta" id="queryFirstOverviewMeta">尚未连接</div>
          </div>
          <span class="queryFirstFingerprint" id="queryFirstFingerprint"></span>
        </div>
        <div class="queryFirstSourceBadges" id="queryFirstSourceBadges"></div>
        <div class="queryFirstKpis" id="queryFirstKpis"></div>
        <div class="queryFirstRawState" id="queryFirstRawState">明细数据尚未加载；当前卡片为服务端聚合，不代表页面深度分析库已就绪。</div>
      `;
      const status = byId('privateCloudImportStatus');
      if (status) status.insertAdjacentElement('beforebegin', card);
      else panel.appendChild(card);
    }
    updateRawButtons();
  }

  const bindUi = () => {
    if (window.__WAREHOUSE_V4_UI_BOUND__) return;
    window.__WAREHOUSE_V4_UI_BOUND__ = true;
    document.addEventListener('click', event => {
      const target = event.target?.closest?.(
        '#btnPrivateCloudImport, #btnPrivateCloudCurrentMonth, #btnPrivateCloudRecentMonths, #btnPrivateCloudFullHistory, #btnPrivateCloudLogout'
      );
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (target.id === 'btnPrivateCloudImport') {
        connectPrivateCloudOverview({ reason: 'manual' });
      } else if (target.id === 'btnPrivateCloudCurrentMonth') {
        loadRawRange({ mode: 'current' });
      } else if (target.id === 'btnPrivateCloudRecentMonths') {
        loadRawRange({ mode: 'recent' });
      } else if (target.id === 'btnPrivateCloudFullHistory') {
        loadRawRange({ mode: 'full' });
      } else {
        clearCredential();
      }
    }, true);
  };

  const requestPassword = () => {
    const password = window.prompt('请输入私密仓库网页登录密码');
    return typeof password === 'string' ? password.trim() : '';
  };

  const normalizeApiTarget = input => {
    const parsed = new URL(String(input || '').trim() || '/', window.location.origin);
    let pathname = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
    pathname = pathname.replace(/\/{2,}/g, '/').replace(/^(?:\/api\/v1)+/i, '/api/v1');
    if (!pathname.startsWith('/api/v1/')) pathname = `/api/v1${pathname}`;
    return `${pathname}${parsed.search || ''}`;
  };

  const requestApi = async (target, password, options = {}) => {
    const path = normalizeApiTarget(target);
    const responseType = options.responseType || 'json';
    const maxAttempts = Math.max(1, Math.min(8, Number(options.maxAttempts || 6)));
    const retryBaseMs = Math.max(250, Number(options.retryBaseMs || 1200));
    const retryMaxMs = Math.max(retryBaseMs, Number(options.retryMaxMs || 12000));
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), Number(options.timeoutMs || 240000));
      try {
        const headers = new Headers(options.headers || {});
        headers.set('Authorization', `Bearer ${password}`);
        const requestUrl = new URL(`${API_ORIGIN}${path}`);
        if (attempt > 1) requestUrl.searchParams.set('__warehouseRetry', `${Date.now()}-${attempt}`);
        const response = await fetch(requestUrl, { method: 'GET', headers, cache: 'no-store', signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.status === 304) return { payload: null, response, path };
        if (response.ok) {
          let payload;
          if (responseType === 'blob') {
            payload = await response.blob();
            const declaredLength = Number(response.headers.get('Content-Length') || 0);
            const invalidLength = Number.isFinite(declaredLength) && declaredLength > 0 && payload.size !== declaredLength;
            if (!payload.size || invalidLength) {
              const error = new Error(`私有云返回的文件内容不完整（实际 ${Number(payload.size || 0)} 字节${declaredLength > 0 ? `，预期 ${declaredLength} 字节` : ''}） · ${path}`);
              error.status = 502;
              error.path = path;
              throw error;
            }
          } else if (responseType === 'text') payload = await response.text();
          else {
            const text = await response.text();
            try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
          }
          return { payload, response, path };
        }
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (_) {}
        if (options.optional && response.status === 404) return { payload: null, response, path, optionalMissing: true };
        const error = new Error(`${payload?.error || text || `HTTP ${response.status}`} · ${path}`);
        error.status = response.status;
        error.path = path;
        lastError = error;
        const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
        if (!retryable || attempt >= maxAttempts) throw error;
        const retryAfter = Number(response.headers.get('Retry-After') || 0);
        const backoff = Math.min(retryMaxMs, retryBaseMs * (2 ** (attempt - 1)));
        await sleep(retryAfter > 0 ? Math.min(retryMaxMs, retryAfter * 1000) : backoff);
      } catch (networkError) {
        clearTimeout(timeoutId);
        if (networkError?.status && networkError.status < 500 && ![408, 425, 429].includes(networkError.status)) throw networkError;
        lastError = networkError;
        if (attempt >= maxAttempts) break;
        await sleep(Math.min(retryMaxMs, retryBaseMs * (2 ** (attempt - 1))));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    const detail = lastError?.name === 'AbortError'
      ? `单个文件请求超过 ${Math.round(Number(options.timeoutMs || 240000) / 60000)} 分钟`
      : (lastError?.message || '网络错误');
    const error = new Error(`无法连接私有云接口（已重试 ${maxAttempts} 次）：${detail}`);
    error.status = lastError?.status;
    error.path = path;
    throw error;
  };

  const apiFetchJson = async (path, password, options = {}) =>
    (await requestApi(path, password, { ...options, responseType: 'json' })).payload;

  async function fetchBootstrap(scope, password, options = {}) {
    const params = new URLSearchParams({ scope, grain: options.grain === 'day' ? 'day' : 'month' });
    appendCanonicalDate(params, 'from', options.from);
    appendCanonicalDate(params, 'to', options.to);
    const path = `/query/bootstrap?${params}`;
    const cacheKey = normalizeApiTarget(path);
    const cached = state.bootstrapCache.get(cacheKey);
    const headers = { ...(options.headers || {}) };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    const result = await requestApi(path, password, {
      responseType: 'json',
      headers,
      maxAttempts: options.maxAttempts || 6,
      timeoutMs: options.timeoutMs || 180000,
    });
    if (result.response.status === 304) {
      if (!cached?.payload) throw new Error('云端概览返回 304，但当前页面没有可复用的概览缓存');
      return { payload: cached.payload, etag: cached.etag, cache: 'hit' };
    }
    const payload = result.payload;
    if (!payload || payload.bootstrapVersion !== 'query-first-bootstrap-v1') {
      const error = new Error('Worker 尚未提供兼容的 Query-first Bootstrap');
      error.status = 426;
      throw error;
    }
    const etag = String(result.response.headers.get('ETag') || '');
    state.bootstrapCache.set(cacheKey, { payload, etag, storedAt: Date.now() });
    return { payload, etag, cache: 'miss' };
  }

  function appendCanonicalDate(params, key, value) {
    const text = String(value || '').trim();
    if (!text) return;
    if (!isCanonicalDate(text)) {
      const error = new Error(`${key} 必须使用有效的 YYYY-MM-DD 日期`);
      error.status = 400;
      throw error;
    }
    params.set(key, text);
  }

  function isCanonicalDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return year >= 2000 && year <= 2100
      && date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  async function connectPrivateCloudOverview({ reason = 'manual', scope: requestedScope, from, to, grain = 'month' } = {}) {
    if (state.loading) return null;
    if (!ensureUi()) return null;
    setBusy(true, 'overview');
    let password = memoryCredential.get();
    if (!password && reason !== 'shop-change') password = requestPassword();
    if (!password) {
      setBusy(false);
      setStatus(reason === 'shop-change' ? '店铺已切换；点击“连接私有云概览”并输入密码' : '已取消私有云连接', 'warn');
      return null;
    }

    const scope = normalizeScope(requestedScope || activeScope());
    try {
      setStatus(`正在连接 Amazon-Data-Warehouse · ${displayScope(scope)}，首屏不会下载 Raw 文件…`);
      const health = await apiFetchJson('/health', password, { maxAttempts: 6, timeoutMs: 120000 });
      if (!health?.ok) throw new Error('私有接口健康检查失败');
      if (health?.service !== 'amazon-data-warehouse' || !/^4\./.test(String(health?.version || ''))) {
        throw new Error('私密仓库接口版本不兼容：生产页面只接受 V4');
      }
      const capabilities = new Set(Array.isArray(health?.capabilities) ? health.capabilities : []);
      if (health?.queryFirst !== 'query-first-bootstrap-v1' && !capabilities.has(QUERY_FIRST_CAPABILITY)) {
        const error = new Error('Worker 尚未启用 Query-first Bootstrap；请使用“完整历史”兼容加载或升级 Warehouse');
        error.status = 426;
        throw error;
      }
      state.apiVersion = String(health.version || '4');
      state.storage = String(health.storage || 'unknown');

      const [bootstrapResult, summary] = await Promise.all([
        fetchBootstrap(scope, password, { from, to, grain }),
        apiFetchJson(`/summary?scope=${encodeURIComponent(scope)}`, password, { optional: true, maxAttempts: 4, timeoutMs: 120000 }).catch(() => null),
      ]);
      const bootstrap = bootstrapResult.payload;
      const previousFingerprint = state.dataFingerprint;
      state.bootstrap = bootstrap;
      state.bootstrapEtag = bootstrapResult.etag;
      state.summary = summary;
      state.queryStatus = bootstrap.status || null;
      state.dataFingerprint = String(bootstrap.dataFingerprint || '');
      state.connectedOnce = true;
      state.connectedScope = scope;
      memoryCredential.set(password);

      if (state.loadedOnce && (
        state.loadedScope !== scope
        || (state.rawBootstrapFingerprint && state.rawBootstrapFingerprint !== state.dataFingerprint)
      )) {
        state.rawStale = true;
      } else if (!state.loadedOnce) {
        state.rawStale = false;
      }

      renderBootstrap(bootstrap, { cache: bootstrapResult.cache, previousFingerprint });
      updateRawButtons();
      const totals = bootstrap?.coverage?.totals || bootstrap?.status?.totals || {};
      const latestMonth = bootstrap?.coverage?.latestMonth || '';
      const statusText = `${displayScope(scope)} 云端概览已连接：${formatInteger(totals.fileCount)} 个文件 · ${formatInteger(totals.catalogRows)} 行${latestMonth ? ` · 最新 ${latestMonth}` : ''} · 首屏未下载 Raw`;
      setStatus(statusText, bootstrap?.status?.analyticsReady ? 'good' : 'warn');
      const brand = byId('brandStatus');
      if (brand) brand.textContent = `系统就绪 · ${displayScope(scope)} TiDB 云端概览`;
      const detail = {
        scope,
        bootstrap,
        dataFingerprint: state.dataFingerprint,
        etag: state.bootstrapEtag,
        cache: bootstrapResult.cache,
        apiVersion: state.apiVersion,
        storage: state.storage,
        rawLoaded: state.loadedOnce && !state.rawStale,
      };
      window.dispatchEvent(new CustomEvent('lr:query-bootstrap', { detail: bootstrap }));
      window.dispatchEvent(new CustomEvent('lr:cloud-overview-ready', { detail }));
      notifyUser(statusText, bootstrap?.status?.analyticsReady ? 'good' : 'warn');
      return detail;
    } catch (error) {
      console.error('Private warehouse overview failed:', error);
      if ([401, 403].includes(Number(error?.status || 0))) memoryCredential.clear();
      const detail = String(error?.message || error || '未知错误');
      setStatus(`私有云概览失败：${detail}`, 'bad');
      notifyUser(`私有云概览失败：${detail}`, 'bad');
      return null;
    } finally {
      setBusy(false);
    }
  }

  function renderBootstrap(bootstrap, meta = {}) {
    ensureProgressiveUi();
    const card = byId('queryFirstOverviewCard');
    if (!card) return;
    const coverage = bootstrap?.coverage || {};
    const totals = bootstrap?.overview?.totals || {};
    const sourceCoverage = bootstrap?.overview?.sourceCoverage || {};
    const scope = normalizeScope(bootstrap?.scope || activeScope());
    const months = Array.isArray(coverage.months) ? coverage.months : [];
    const periodText = months.length
      ? `${months[0]}${months.length > 1 ? ` → ${months[months.length - 1]}` : ''}`
      : '暂无月份';
    const metaElement = byId('queryFirstOverviewMeta');
    if (metaElement) {
      metaElement.textContent = `${displayScope(scope)} · ${periodText} · ${formatInteger(coverage?.totals?.fileCount)} 文件 / ${formatInteger(coverage?.totals?.catalogRows)} 行${meta.cache === 'hit' ? ' · 304 缓存复用' : ''}`;
    }
    const fingerprint = String(bootstrap?.dataFingerprint || '');
    const fingerprintElement = byId('queryFirstFingerprint');
    if (fingerprintElement) {
      fingerprintElement.textContent = fingerprint ? fingerprint.slice(0, 10) : '';
      fingerprintElement.title = fingerprint ? `数据指纹 ${fingerprint}` : '';
    }
    const badges = byId('queryFirstSourceBadges');
    if (badges) {
      const specs = [
        ['广告', sourceCoverage?.advertising?.available],
        ['联合交易', sourceCoverage?.finance?.available],
        ['Business Report', sourceCoverage?.business?.available],
      ];
      badges.innerHTML = specs.map(([label, available]) =>
        `<span class="queryFirstBadge" data-available="${available ? '1' : '0'}">${label}：${available ? '已接入' : '未接入'}</span>`
      ).join('');
    }
    const businessAvailable = Boolean(sourceCoverage?.business?.available);
    const kpis = [
      ['广告销售', `$${formatMoney(totals.adSales)}`],
      ['广告花费', `$${formatMoney(totals.adSpend)}`],
      ['ACOS', formatPercent(totals.adAcos)],
      ['ROAS', formatRatio(totals.adRoas)],
      ['交易销售', `$${formatMoney(totals.orderSales)}`],
      ['净商品销售', `$${formatMoney(totals.netProductSales)}`],
      ['退款金额', `$${formatMoney(totals.refundSales)}`],
      ['Amazon 费用', `$${formatMoney(totals.amazonFees)}`],
      ['广告订单', formatInteger(totals.adOrders)],
      ['交易订单', formatInteger(totals.orderCount)],
      ['Business 销售', businessAvailable ? `$${formatMoney(totals.businessSales)}` : '未接入'],
      ['结算应计', `$${formatMoney(totals.settlementAccrual)}`],
    ];
    const kpiContainer = byId('queryFirstKpis');
    if (kpiContainer) {
      kpiContainer.innerHTML = kpis.map(([label, value]) => `
        <div class="queryFirstKpi">
          <div class="queryFirstKpiLabel">${label}</div>
          <div class="queryFirstKpiValue">${value}</div>
        </div>
      `).join('');
    }
    card.dataset.ready = '1';
    card.dataset.fingerprint = fingerprint;
    updateRawState();
  }

  function updateRawButtons() {
    const months = Array.isArray(state.bootstrap?.coverage?.months) ? state.bootstrap.coverage.months : [];
    const latestMonth = months.at(-1) || '';
    const currentButton = byId('btnPrivateCloudCurrentMonth');
    const recentButton = byId('btnPrivateCloudRecentMonths');
    const fullButton = byId('btnPrivateCloudFullHistory');
    if (currentButton) {
      currentButton.textContent = latestMonth ? `最新月 ${latestMonth}` : '最新月明细';
      currentButton.disabled = state.loading || !state.connectedOnce || !latestMonth;
    }
    if (recentButton) {
      recentButton.textContent = months.length ? `近 ${Math.min(3, months.length)} 月明细` : '近 3 月明细';
      recentButton.disabled = state.loading || !state.connectedOnce || !months.length;
    }
    if (fullButton) {
      fullButton.textContent = state.loadedOnce && !state.rawStale && state.loadedMonths.size >= months.length && months.length
        ? '完整历史已加载'
        : '完整历史';
      fullButton.disabled = state.loading || !state.connectedOnce || !months.length
        || (state.loadedOnce && !state.rawStale && state.loadedMonths.size >= months.length && months.length > 0);
    }
    updateRawState();
  }

  function updateRawState() {
    const element = byId('queryFirstRawState');
    if (!element) return;
    element.dataset.stale = state.rawStale ? '1' : '0';
    if (state.rawStale) {
      element.textContent = '页面明细来自旧店铺或旧数据指纹，已标记为过期；重新加载任一明细范围后才可用于深度分析。';
      return;
    }
    if (!state.loadedOnce) {
      element.textContent = '明细数据尚未加载；上方数值来自 TiDB 服务端聚合，真实为零与“未接入”已分开显示。';
      return;
    }
    const months = [...state.loadedMonths].sort();
    const range = months.length ? `${months[0]}${months.length > 1 ? ` → ${months.at(-1)}` : ''}` : '范围未知';
    element.textContent = `页面深度分析明细已加载：${displayScope(state.loadedScope)} · ${range} · ${months.length} 个月。`;
  }

  function resolveRange(mode, options = {}) {
    const months = Array.isArray(state.bootstrap?.coverage?.months)
      ? [...state.bootstrap.coverage.months].sort()
      : [];
    if (!months.length) throw new Error('云端概览没有可加载的月份');
    if (mode === 'current') return { fromMonth: months.at(-1), toMonth: months.at(-1), months: [months.at(-1)] };
    if (mode === 'recent') {
      const selected = months.slice(-3);
      return { fromMonth: selected[0], toMonth: selected.at(-1), months: selected };
    }
    if (mode === 'custom') {
      const fromMonth = String(options.fromMonth || '').trim();
      const toMonth = String(options.toMonth || fromMonth).trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fromMonth) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(toMonth) || fromMonth > toMonth) {
        const error = new Error('指定明细月份必须使用有效的 YYYY-MM，且开始月份不能晚于结束月份');
        error.status = 400;
        throw error;
      }
      const selected = months.filter(month => month >= fromMonth && month <= toMonth);
      return { fromMonth, toMonth, months: selected };
    }
    return { fromMonth: months[0], toMonth: months.at(-1), months };
  }

  async function loadRawRange({ mode = 'full', fromMonth, toMonth, replace = false } = {}) {
    if (state.loading) return null;
    if (!state.connectedOnce || state.connectedScope !== activeScope() || !memoryCredential.get()) {
      const connected = await connectPrivateCloudOverview({ reason: 'raw-prerequisite' });
      if (!connected) return null;
    }
    const scope = activeScope();
    let range;
    try {
      range = resolveRange(mode, { fromMonth, toMonth });
    } catch (error) {
      setStatus(`明细范围无效：${error.message}`, 'bad');
      notifyUser(`明细范围无效：${error.message}`, 'bad');
      return null;
    }
    if (!range.months.length) {
      setStatus('所选范围没有受治理的生产文件', 'warn');
      return null;
    }

    setBusy(true, mode);
    state.cacheStats = emptyCacheStats();
    const password = memoryCredential.get();
    try {
      if (state.rawStale || (state.loadedOnce && state.loadedScope !== scope)) {
        clearCloudImportedData();
        resetRawState();
      }
      const params = new URLSearchParams({ scope });
      if (range.fromMonth === range.toMonth) params.set('month', range.fromMonth);
      else {
        params.set('fromMonth', range.fromMonth);
        params.set('toMonth', range.toMonth);
      }
      setStatus(`正在读取 ${displayScope(scope)} ${range.fromMonth}${range.fromMonth !== range.toMonth ? ` → ${range.toMonth}` : ''} 明细清单…`);
      const manifest = await apiFetchJson(`/manifest?${params}`, password, { maxAttempts: 6, timeoutMs: 180000 });
      const requestedEntries = Array.isArray(manifest?.files) ? manifest.files.filter(isImportableEntry) : [];
      if (!requestedEntries.length) throw new Error(`${displayScope(scope)} 所选范围没有可加载的广告、联合交易或业务报表`);

      const alreadyLoaded = state.rawBootstrapFingerprint === state.dataFingerprint
        ? state.loadedMonths
        : new Set();
      const entries = requestedEntries.filter(entry => !alreadyLoaded.has(String(entry.month || '')));
      if (!entries.length) {
        range.months.forEach(month => state.loadedMonths.add(month));
        state.loadedOnce = true;
        state.loadedScope = scope;
        state.rawStale = false;
        state.loadedRange = range;
        updateRawButtons();
        const text = `${displayScope(scope)} ${range.fromMonth}${range.fromMonth !== range.toMonth ? ` → ${range.toMonth}` : ''} 明细已在页面分析库中，无需重复下载`;
        setStatus(text, 'good');
        notifyUser(text, 'good');
        return { skipped: true, manifest, range };
      }

      state.manifest = manifest;
      const cloudImporter = window.__LR_IMPORT_MULTIPLE_FILES__;
      if (typeof cloudImporter !== 'function') throw new Error('网页导入桥接未初始化，请强制刷新页面后重试');
      const directImporter = window.__LR_IMPORT_TRANSACTION_FILE__;
      const mergeSelect = byId('mergeMode');
      const previousMerge = mergeSelect?.value || 'append';
      const shouldReplace = replace || !state.loadedOnce;
      const batchCount = Math.ceil(entries.length / BATCH_SIZE);
      let fetchedRows = 0;
      let importedRows = 0;
      let adsRows = 0;
      let transactionRows = 0;
      let completedDownloads = 0;
      const quarantineItems = [];
      let firstBatch = true;

      try {
        for (let batchStart = 0; batchStart < entries.length; batchStart += BATCH_SIZE) {
          const batchNumber = Math.floor(batchStart / BATCH_SIZE) + 1;
          const batchEntries = entries.slice(batchStart, batchStart + BATCH_SIZE);
          const loadedItems = await mapLimit(batchEntries, FETCH_CONCURRENCY, async (entry, localIndex) => {
            const globalIndex = batchStart + localIndex;
            try {
              const loaded = await fetchManifestEntry(entry, password, scope);
              completedDownloads += 1;
              setStatus(`正在下载与校验明细（${completedDownloads}/${entries.length}）· 第 ${batchNumber}/${batchCount} 批…`);
              return loaded;
            } catch (entryError) {
              const filename = entry.filename || entry.url || `第 ${globalIndex + 1} 个文件`;
              const wrapped = new Error(`${filename}（${globalIndex + 1}/${entries.length}）加载失败：${entryError?.message || entryError}`);
              wrapped.status = entryError?.status;
              wrapped.path = entryError?.path;
              throw wrapped;
            }
          });

          const batchFiles = loadedItems.map(item => item.file);
          loadedItems.forEach(item => { fetchedRows += Number(item.rowCount || 0); });
          if (mergeSelect) mergeSelect.value = firstBatch && shouldReplace ? 'replace' : 'append';
          setStatus(`已下载 ${completedDownloads}/${entries.length} 个文件，正在导入第 ${batchNumber}/${batchCount} 批…`);
          const isFinalBatch = batchStart + batchEntries.length >= entries.length;
          const importSummary = await cloudImporter(batchFiles, {
            deferFinalize: !isFinalBatch,
            preserveLog: !(firstBatch && shouldReplace),
            cloudBatchNumber: batchNumber,
            cloudBatchCount: batchCount,
          });
          let batchAccepted = Number(importSummary?.acceptedRows || 0);
          const batchAds = Number(importSummary?.adsRows || 0);
          let batchTransactions = Number(importSummary?.transactionRows || 0);
          const batchExpectsAds = batchEntries.some(entry => normalizeDataType(entry?.dataType) === 'ads');
          const batchExpectsTransactions = batchEntries.some(entry => normalizeDataType(entry?.dataType) === 'transactions');
          if (batchExpectsTransactions && !batchTransactions && typeof directImporter === 'function') {
            for (let index = 0; index < batchFiles.length; index += 1) {
              if (normalizeDataType(batchEntries[index]?.dataType) !== 'transactions') continue;
              const directResult = await directImporter(batchFiles[index]);
              const rows = Number(directResult?.rows || 0);
              batchTransactions += rows;
              batchAccepted += rows;
            }
          }
          if (Array.isArray(importSummary?.quarantine)) quarantineItems.push(...importSummary.quarantine);
          const quarantineText = (importSummary?.quarantine || [])
            .flatMap(item => item.reasons || [])
            .slice(0, 2)
            .join('；');
          if ((batchExpectsAds && !batchAds) || (batchExpectsTransactions && !batchTransactions)) {
            const missingType = batchExpectsAds && !batchAds ? '广告数据' : '联合交易数据';
            throw new Error(`第 ${batchNumber}/${batchCount} 批未写入${missingType}${quarantineText ? `：${quarantineText}` : ''}`);
          }
          importedRows += batchAccepted;
          adsRows += batchAds;
          transactionRows += batchTransactions;
          firstBatch = false;
          batchFiles.length = 0;
          await sleepFrame();
        }
      } finally {
        if (mergeSelect) mergeSelect.value = previousMerge;
      }

      const expectsAds = entries.some(entry => normalizeDataType(entry?.dataType) === 'ads');
      const expectsTransactions = entries.some(entry => normalizeDataType(entry?.dataType) === 'transactions');
      const quarantineText = quarantineItems
        .flatMap(item => (item.reasons || []).map(reason => `${item.fileName || item.reportType}: ${reason}`))
        .slice(0, 3)
        .join('；');
      if (!importedRows || (expectsAds && !adsRows) || (expectsTransactions && !transactionRows)) {
        const missingType = expectsAds && !adsRows ? '广告数据' : expectsTransactions && !transactionRows ? '联合交易数据' : '报表数据';
        throw new Error(`报表已下载，但网页分析库未写入${missingType}${quarantineText ? `：${quarantineText}` : '；请检查报表字段映射与日期格式'}`);
      }

      range.months.forEach(month => state.loadedMonths.add(month));
      state.loadedOnce = true;
      state.loadedScope = scope;
      state.loadedRange = range;
      state.rawBootstrapFingerprint = state.dataFingerprint;
      state.rawStale = false;
      document.documentElement.dataset.loadedShopScope = scope;
      document.documentElement.dataset.loadedMonths = [...state.loadedMonths].sort().join(',');
      document.documentElement.dataset.rawDataStale = '0';

      const totalRows = Number(manifest?.totalRows || fetchedRows || importedRows || 0);
      const redactedFiles = requestedEntries.filter(entry => entry.redacted === true).length;
      const storageText = state.storage === 'tidb-primary' ? ' · TiDB 主数据源' : ` · ${state.storage || '未知数据源'}`;
      const cacheText = state.cacheStats.hits ? ` · 缓存复用 ${state.cacheStats.hits} 个` : '';
      const statusText = `${displayScope(scope)} 页面明细已加载：${range.fromMonth}${range.fromMonth !== range.toMonth ? ` → ${range.toMonth}` : ''} · ${requestedEntries.length} 个文件 · ${totalRows.toLocaleString()} 行${redactedFiles ? ` · ${redactedFiles} 个联合报告已脱敏` : ''}${storageText}${cacheText}`;
      setStatus(statusText, 'good');
      const brand = byId('brandStatus');
      if (brand) brand.textContent = `系统就绪 · ${displayScope(scope)} 页面明细 ${[...state.loadedMonths].length} 个月`;
      updateRawButtons();

      const detail = {
        scope,
        files: requestedEntries.length,
        rows: totalRows,
        months: range.months,
        loadedMonths: [...state.loadedMonths].sort(),
        fromMonth: range.fromMonth,
        toMonth: range.toMonth,
        loadMode: mode,
        fullHistory: mode === 'full',
        redactedFiles,
        apiVersion: state.apiVersion,
        storage: state.storage,
        summary: state.summary,
        queryStatus: state.queryStatus,
        dataFingerprint: state.dataFingerprint,
        manifestFingerprint: manifest?.dataFingerprint || '',
        cacheStats: { ...state.cacheStats },
      };
      window.dispatchEvent(new CustomEvent('lr:cloud-loaded', { detail }));
      notifyUser(statusText, 'good');
      return detail;
    } catch (error) {
      console.error('Private warehouse raw import failed:', error);
      if ([401, 403].includes(Number(error?.status || 0))) memoryCredential.clear();
      const detail = String(error?.message || error || '未知错误');
      setStatus(`私有云明细加载失败：${detail}`, 'bad');
      notifyUser(`私有云明细加载失败：${detail}`, 'bad');
      return null;
    } finally {
      setBusy(false);
    }
  }

  const extractRows = payload =>
    Array.isArray(payload?.rows)
      ? payload.rows
      : Array.isArray(payload?.reports)
        ? payload.reports.flatMap(report => Array.isArray(report?.rows) ? report.rows : [])
        : [];

  const jsonPayloadToCsvFile = (payload, entry, scope) => {
    const rows = extractRows(payload);
    if (!rows.length) throw new Error(`${entry.month || entry.url} 没有可导入的数据行`);
    if (!window.Papa?.unparse) throw new Error('PapaParse 未加载，无法转换私有云数据');
    const csv = window.Papa.unparse(rows, { quotes: false, newline: '\r\n' });
    const baseName = String(entry.filename || entry.url || `${entry.dataType || 'data'}-${entry.month}.json`)
      .split('/')
      .pop()
      .replace(/\.json(?:\?.*)?$/i, '.csv');
    const store = String(entry.storeId || entry.store || scope || 'ALL').toUpperCase();
    return new File([csv], `${store}__${baseName}`, { type: 'text/csv;charset=utf-8', lastModified: Date.now() });
  };

  const blobToCsvFile = (blob, entry, scope) => {
    if (!(blob instanceof Blob) || !blob.size) throw new Error(`${entry.filename || entry.url} 返回空文件`);
    const baseName = String(entry.filename || entry.url || `${entry.month}-${entry.reportType}.csv`)
      .split('/')
      .pop()
      .split('?')[0];
    const store = String(entry.storeId || entry.store || scope || 'ALL').toUpperCase();
    return new File([blob], `${store}__${baseName}`, { type: 'text/csv;charset=utf-8', lastModified: Date.now() });
  };

  const isImportableEntry = entry => {
    const dataType = normalizeDataType(entry?.dataType);
    const reportType = String(entry?.reportType || '').trim().toLowerCase();
    const url = String(entry?.url || '');
    return IMPORTABLE_DATA_TYPES.has(dataType)
      || /^(advertising-report|combined-report|business-report|ads-search-term|ads-targeting|ads-campaign|ads-advertised-product|ads-placement)$/.test(reportType)
      || /(?:advertising|combined|business|ads|transactions)-report|(?:ads|transactions)-\d{4}-\d{2}\.json/i.test(url);
  };

  const immutableDigest = entry => {
    const value = String(entry?.sha || entry?.servingSha256 || entry?.sourceSha256 || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(value) ? value : '';
  };

  const fetchManifestEntry = async (entry, password, scope) => {
    const url = String(entry?.url || '').trim();
    if (!url) throw new Error('数据清单中存在缺少 URL 的文件');
    if (/\.json(?:$|\?)/i.test(url) || entry?.format === 'json') {
      const payload = await apiFetchJson(url, password);
      return {
        file: jsonPayloadToCsvFile(payload, entry, scope),
        rowCount: Number(entry.rowCount || extractRows(payload).length || 0),
        redacted: Boolean(entry.redacted),
        cache: 'bypass',
      };
    }

    const digest = immutableDigest(entry);
    const cached = digest ? await cacheGet(digest) : null;
    const headers = {};
    if (cached?.blob?.size) headers['If-None-Match'] = `"${digest}"`;
    const result = await requestApi(url, password, {
      responseType: 'blob',
      headers,
      maxAttempts: 8,
      timeoutMs: 300000,
      retryBaseMs: 1500,
      retryMaxMs: 15000,
    });
    let blob = result.payload;
    let cacheState = 'miss';
    if (result.response.status === 304 && cached?.blob?.size) {
      blob = cached.blob;
      cacheState = 'hit';
      state.cacheStats.hits += 1;
      state.cacheStats.bytesReused += Number(blob.size || 0);
    } else {
      state.cacheStats.misses += 1;
      const responseDigest = String(result.response.headers.get('X-Warehouse-Content-Sha') || '')
        .replaceAll('"', '')
        .toLowerCase();
      const contentVerified = result.response.headers.get('X-Warehouse-Content-Verified') === '1';
      if (digest && responseDigest === digest && contentVerified) {
        await cachePut(digest, blob, {
          rowCount: Number(result.response.headers.get('X-Warehouse-Row-Count') || entry.rowCount || 0),
          redacted: result.response.headers.get('X-Warehouse-Redacted') === '1',
        });
        state.cacheStats.writes += 1;
      } else {
        state.cacheStats.bypassed += 1;
        cacheState = 'bypass';
      }
    }
    return {
      file: blobToCsvFile(blob, entry, scope),
      rowCount: Number(result.response.headers.get('X-Warehouse-Row-Count') || cached?.rowCount || entry.rowCount || 0),
      redacted: result.response.status === 304
        ? Boolean(cached?.redacted ?? entry.redacted)
        : result.response.headers.get('X-Warehouse-Redacted') === '1',
      cache: cacheState,
    };
  };

  const mapLimit = async (items, limit, mapper) => {
    const output = new Array(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        output[index] = await mapper(items[index], index);
      }
    }));
    return output;
  };

  function clearCloudImportedData() {
    if (!state.loadedOnce) return false;
    const clearButton = byId('btnClearAll');
    if (!clearButton) {
      state.rawStale = true;
      document.documentElement.dataset.rawDataStale = '1';
      return false;
    }
    try {
      clearButton.click();
      return true;
    } catch (error) {
      console.warn('Cloud raw data clear skipped:', error);
      state.rawStale = true;
      document.documentElement.dataset.rawDataStale = '1';
      return false;
    }
  }

  function resetRawState() {
    state.manifest = null;
    state.loadedOnce = false;
    state.loadedScope = '';
    state.loadedMonths = new Set();
    state.loadedRange = null;
    state.rawBootstrapFingerprint = '';
    state.rawStale = false;
    delete document.documentElement.dataset.loadedShopScope;
    delete document.documentElement.dataset.loadedMonths;
    document.documentElement.dataset.rawDataStale = '0';
    updateRawButtons();
  }

  function clearCredential() {
    memoryCredential.clear();
    state.connectedOnce = false;
    state.connectedScope = '';
    state.bootstrap = null;
    state.bootstrapEtag = '';
    state.dataFingerprint = '';
    state.queryStatus = null;
    const card = byId('queryFirstOverviewCard');
    if (card) card.dataset.ready = '0';
    setStatus('内存访问密码已清除；页面已加载的本地明细不会自动删除', 'warn');
    updateRawButtons();
    notifyUser('私有云内存访问密码已清除。', 'good');
  }

  const ensureQueryClient = () => {
    if (window.PrivateCloudQuery || window.__WAREHOUSE_QUERY_CLIENT_LOADING__) return;
    window.__WAREHOUSE_QUERY_CLIENT_LOADING__ = true;
    const script = document.createElement('script');
    script.src = new URL('./private-cloud-query-v1.js', SCRIPT_URL).href;
    script.async = true;
    script.dataset.warehouseQueryClient = 'v1';
    script.onload = () => {
      window.__WAREHOUSE_QUERY_CLIENT_LOADING__ = false;
      if (state.bootstrap) {
        window.dispatchEvent(new CustomEvent('lr:query-bootstrap', { detail: state.bootstrap }));
      }
    };
    script.onerror = () => {
      window.__WAREHOUSE_QUERY_CLIENT_LOADING__ = false;
      console.warn('TiDB query client failed to load');
    };
    document.head.appendChild(script);
  };

  const queryRequest = async (target, options = {}) => {
    const path = normalizeApiTarget(target);
    if (!path.startsWith('/api/v1/query/')) {
      const error = new Error('只允许调用 /api/v1/query 查询接口');
      error.status = 400;
      throw error;
    }
    const password = memoryCredential.get();
    if (!password) {
      const error = new Error('私有云内存访问密码不存在，请先连接私有云概览');
      error.status = 401;
      throw error;
    }
    return requestApi(path, password, { ...options, responseType: 'json' });
  };

  const scheduleScopeReload = () => {
    clearTimeout(state.autoReloadTimer);
    if (!state.connectedOnce || !memoryCredential.get()) return;
    const nextScope = activeScope();
    if (state.loadedOnce && state.loadedScope && state.loadedScope !== nextScope) {
      clearCloudImportedData();
      resetRawState();
    }
    state.autoReloadTimer = setTimeout(
      () => connectPrivateCloudOverview({ reason: 'shop-change', scope: nextScope }),
      250,
    );
  };

  const installApi = () => {
    if (!ensureUi()) return;
    bindUi();
    ensureQueryClient();
    window.__WAREHOUSE_V4_LOADER_VERSION__ = LOADER_VERSION;
    window.PrivateCloudAds = {
      load: options => connectPrivateCloudOverview(options || {}),
      loadOverview: options => connectPrivateCloudOverview(options || {}),
      loadRaw: options => loadRawRange(options || {}),
      loadCurrentMonth: () => loadRawRange({ mode: 'current' }),
      loadRecentMonths: () => loadRawRange({ mode: 'recent' }),
      loadFullHistory: () => loadRawRange({ mode: 'full' }),
      reload: () => connectPrivateCloudOverview({ reason: 'shop-change' }),
      setPassword: value => memoryCredential.set(value),
      clearPassword: clearCredential,
      clearCache: clearFileCache,
      queryRequest,
      query: () => window.PrivateCloudQuery || null,
      apiBase: API_ORIGIN,
      channel: () => CHANNEL,
      state: () => ({
        loading: state.loading,
        busyMode: state.busyMode,
        connectedOnce: state.connectedOnce,
        connectedScope: state.connectedScope,
        bootstrap: state.bootstrap,
        bootstrapEtag: state.bootstrapEtag,
        dataFingerprint: state.dataFingerprint,
        loadingStrategy: 'query-first-progressive-v1',
        loadedOnce: state.loadedOnce,
        loadedScope: state.loadedScope,
        loadedMonths: [...state.loadedMonths].sort(),
        loadedRange: state.loadedRange ? { ...state.loadedRange, months: [...state.loadedRange.months] } : null,
        rawBootstrapFingerprint: state.rawBootstrapFingerprint,
        rawStale: state.rawStale,
        apiVersion: state.apiVersion,
        storage: state.storage,
        queryStatus: state.queryStatus,
        credentialAccepted: Boolean(memoryCredential.get()),
        manifest: state.manifest,
        summary: state.summary,
        cacheStats: { ...state.cacheStats },
        loaderVersion: LOADER_VERSION,
      }),
    };
    updateRawButtons();
    if (memoryCredential.get() && !state.loading && !state.connectedOnce) {
      setStatus(`访问密码仅保存在当前页面内存中；点击连接 ${displayScope(activeScope())} 云端概览`);
    }
    if (!window.__WAREHOUSE_V4_SCOPE_BOUND__) {
      window.__WAREHOUSE_V4_SCOPE_BOUND__ = true;
      window.addEventListener('lr:shop-change', scheduleScopeReload);
    }
  };

  function openCache() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return resolve(null);
      const request = indexedDB.open(CACHE_DB, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CACHE_STORE)) {
          database.createObjectStore(CACHE_STORE, { keyPath: 'digest' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve(null);
    });
  }

  async function cacheGet(digest) {
    try {
      const database = await openCache();
      if (!database) return null;
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(CACHE_STORE, 'readonly');
        const request = transaction.objectStore(CACHE_STORE).get(digest);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
      });
    } catch (error) {
      console.warn('Warehouse cache read skipped:', error);
      return null;
    }
  }

  async function cachePut(digest, blob, metadata = {}) {
    try {
      const database = await openCache();
      if (!database) return false;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(CACHE_STORE, 'readwrite');
        transaction.objectStore(CACHE_STORE).put({ digest, blob, ...metadata, storedAt: Date.now() });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      return true;
    } catch (error) {
      console.warn('Warehouse cache write skipped:', error);
      return false;
    }
  }

  async function clearFileCache() {
    try {
      const database = await openCache();
      if (!database) return false;
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(CACHE_STORE, 'readwrite');
        transaction.objectStore(CACHE_STORE).clear();
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
      state.cacheStats = emptyCacheStats();
      state.bootstrapCache.clear();
      return true;
    } catch (error) {
      console.warn('Warehouse cache clear skipped:', error);
      return false;
    }
  }

  installApi();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installApi, { once: true });
  setTimeout(installApi, 0);
  setTimeout(installApi, 1000);
})();
