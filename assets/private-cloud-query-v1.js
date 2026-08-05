(() => {
  'use strict';

  const CLIENT_VERSION = '1.1.0';
  const DEFAULT_PAGE_SIZE = 250;
  const MAX_PAGE_SIZE = 500;
  const state = {
    status: null,
    overview: null,
    lastScope: 'ALL',
    lastError: null,
    source: 'unknown',
  };

  const normalizeScope = value => {
    const scope = String(value || '').trim().toUpperCase();
    return ['ALL', 'YTDBNS', 'YY', 'JJ'].includes(scope) ? scope : 'ALL';
  };

  const currentScope = () => normalizeScope(window.ShopScope?.get?.() || window.ACTIVE_SHOP || state.lastScope || 'ALL');

  const queryBridge = () => {
    const request = window.PrivateCloudAds?.queryRequest;
    if (typeof request !== 'function') throw clientError(503, '私有云查询桥接尚未就绪');
    return request;
  };

  async function request(path, options = {}) {
    const normalized = normalizePath(path);
    const result = await queryBridge()(normalized, {
      headers: options.headers || {},
      timeoutMs: boundedInteger(options.timeoutMs, 120000, 1000, 300000),
      maxAttempts: boundedInteger(options.maxAttempts, 4, 1, 6),
    });
    if (!result || typeof result !== 'object') throw clientError(502, '私有云查询返回格式无效');
    return result;
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

  async function paged(path, options = {}, textKeys = []) {
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
      offset = Number(page.nextOffset);
      if (!Number.isSafeInteger(offset) || offset < 0) throw clientError(502, '私有云分页游标无效');
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
    if (!path.startsWith('/api/v1/query/')) throw clientError(400, '只允许调用 /api/v1/query 查询接口');
    if (/^https?:\/\//i.test(path) || path.includes('\\')) throw clientError(400, '查询路径无效');
    return path;
  }

  function appendDate(params, key, value) {
    const text = String(value || '').trim();
    if (!text) return;
    if (!isCanonicalDate(text)) throw clientError(400, `${key} 必须使用有效的 YYYY-MM-DD 日期`);
    params.set(key, text);
  }

  function isCanonicalDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
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
    apiBase: () => window.PrivateCloudAds?.apiBase || '',
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
    refresh({ scope }).catch(error => console.warn('TiDB query client refresh skipped:', error));
  });

  dispatch('lr:query-client-ready', { version: CLIENT_VERSION, apiBase: window.PrivateCloudAds?.apiBase || '' });
})();
