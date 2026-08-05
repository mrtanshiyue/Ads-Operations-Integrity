(() => {
  'use strict';

  const API_ORIGIN = 'https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev';
  const SESSION_KEY = 'lr_private_cloud_password';
  const CLIENT_VERSION = '1.0.0';
  const DEFAULT_PAGE_SIZE = 250;
  const MAX_PAGE_SIZE = 500;
  const state = {
    status: null,
    overview: null,
    lastScope: 'ALL',
    lastError: null,
    source: 'unknown',
  };

  const sessionPassword = () => {
    try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch (_) { return ''; }
  };

  const normalizeScope = value => {
    const scope = String(value || '').trim().toUpperCase();
    return ['ALL', 'YTDBNS', 'YY', 'JJ'].includes(scope) ? scope : 'ALL';
  };

  const currentScope = () => normalizeScope(window.ShopScope?.get?.() || window.ACTIVE_SHOP || state.lastScope || 'ALL');

  async function request(path, options = {}) {
    const password = String(options.password || sessionPassword()).trim();
    if (!password) throw clientError(401, '私有云会话密码不存在，请先点击“加载私有云数据”');
    const url = new URL(normalizePath(path), API_ORIGIN);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), boundedInteger(options.timeoutMs, 120000, 1000, 300000));
    try {
      const headers = new Headers(options.headers || {});
      headers.set('Authorization', `Bearer ${password}`);
      const response = await fetch(url, { method: 'GET', headers, cache: 'no-store', signal: controller.signal });
      if (response.status === 304) return { response, payload: null };
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch (_) {}
      if (!response.ok) throw clientError(response.status, payload?.error || text || `HTTP ${response.status}`);
      return { response, payload };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getStatus(options = {}) {
    const scope = normalizeScope(options.scope || currentScope());
    const { payload } = await request(`/api/v1/query/status?scope=${encodeURIComponent(scope)}`, options);
    state.status = payload;
    state.lastScope = scope;
    state.source = payload?.primaryStorage || 'unknown';
    state.lastError = null;
    dispatch('lr:query-status', payload);
    return payload;
  }

  async function getOverview(options = {}) {
    const scope = normalizeScope(options.scope || currentScope());
    const params = new URLSearchParams({ scope, grain: options.grain === 'month' ? 'month' : 'day' });
    appendDate(params, 'from', options.from);
    appendDate(params, 'to', options.to);
    const { payload } = await request(`/api/v1/query/overview?${params}`, options);
    state.overview = payload;
    state.lastScope = scope;
    state.lastError = null;
    dispatch('lr:query-overview', payload);
    return payload;
  }

  async function getAds(options = {}) {
    return paged('/api/v1/query/ads', options, ['search', 'campaign']);
  }

  async function getTransactions(options = {}) {
    return paged('/api/v1/query/transactions', options, ['category', 'sku', 'statusMode']);
  }

  async function getAllAds(options = {}) {
    return collectPages(getAds, options);
  }

  async function getAllTransactions(options = {}) {
    return collectPages(getTransactions, options);
  }

  async function paged(path, options, textKeys) {
    const scope = normalizeScope(options.scope || currentScope());
    const params = new URLSearchParams({
      scope,
      limit: String(boundedInteger(options.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)),
      offset: String(boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER)),
    });
    appendDate(params, 'from', options.from);
    appendDate(params, 'to', options.to);
    for (const key of textKeys) {
      const value = String(options[key] || '').trim();
      if (value) params.set(key, value);
    }
    const { payload } = await request(`${path}?${params}`, options);
    state.lastScope = scope;
    state.lastError = null;
    return payload;
  }

  async function collectPages(fetchPage, options = {}) {
    const rows = [];
    const pageSize = boundedInteger(options.limit, MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    let offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxRows = boundedInteger(options.maxRows, 250000, 1, 1000000);
    while (rows.length < maxRows) {
      const page = await fetchPage({ ...options, limit: pageSize, offset });
      const pageRows = Array.isArray(page?.rows) ? page.rows : [];
      rows.push(...pageRows.slice(0, Math.max(0, maxRows - rows.length)));
      if (page?.nextOffset === null || page?.nextOffset === undefined || !pageRows.length) break;
      offset = page.nextOffset;
    }
    return { rows, count: rows.length, nextOffset: rows.length >= maxRows ? offset : null };
  }

  async function refresh(options = {}) {
    try {
      const status = await getStatus(options);
      const overview = status?.analyticsReady ? await getOverview(options) : null;
      return { status, overview };
    } catch (error) {
      state.lastError = String(error?.message || error);
      dispatch('lr:query-error', { message: state.lastError, status: Number(error?.status || 0) });
      throw error;
    }
  }

  function normalizePath(value) {
    const path = String(value || '').trim();
    if (!path.startsWith('/api/v1/')) throw clientError(400, '只允许调用 /api/v1 查询接口');
    return path;
  }

  function appendDate(params, key, value) {
    const text = String(value || '').trim();
    if (!text) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw clientError(400, `${key} 必须使用 YYYY-MM-DD`);
    params.set(key, text);
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
  }

  function clientError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  window.PrivateCloudQuery = Object.freeze({
    version: CLIENT_VERSION,
    apiBase: API_ORIGIN,
    status: getStatus,
    overview: getOverview,
    ads: getAds,
    transactions: getTransactions,
    allAds: getAllAds,
    allTransactions: getAllTransactions,
    refresh,
    state: () => ({ ...state }),
  });

  window.addEventListener('lr:cloud-loaded', event => {
    const detail = event.detail || {};
    const scope = normalizeScope(detail.scope || currentScope());
    const storage = String(detail.storage || detail.health?.storage || '');
    if (storage) state.source = storage;
    if (!sessionPassword()) return;
    refresh({ scope }).catch(error => console.warn('TiDB query client refresh skipped:', error));
  });

  dispatch('lr:query-client-ready', { version: CLIENT_VERSION, apiBase: API_ORIGIN });
})();
