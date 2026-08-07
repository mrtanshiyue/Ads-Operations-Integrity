(() => {
  'use strict';

  const SCRIPT_URL = document.currentScript?.src
    || new URL('assets/private-cloud-query-v1.js', window.location.href).href;
  const CLIENT_VERSION = '1.3.0';
  const DEFAULT_PAGE_SIZE = 250;
  const MAX_PAGE_SIZE = 500;
  const ADS_SOURCE_PREFLIGHT_HEADER = 'X-Ads-Source-Headers-B64';
  const ADS_SOURCE_PREFLIGHT_MAX_HEADERS = 256;
  const ADS_SOURCE_PREFLIGHT_MAX_HEADER_LENGTH = 256;
  const ADS_SOURCE_PREFLIGHT_MAX_ENCODED_LENGTH = 12288;
  const QUERY_NATIVE_ADAPTER_VERSION = '1.2.0';
  const QUERY_NATIVE_GATE_VERSION = '1.0.0';
  const QUERY_NATIVE_SOURCE_READINESS_VERSION = '1.0.0';
  const QUERY_NATIVE_BID_INTELLIGENCE_VERSION = '1.0.0';
  const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1.0.2';
  const QUERY_NATIVE_TREND_VERSION = '1.1.0';
  const QUERY_NATIVE_HOST_VERSION = '1.0.0';
  const QUERY_NATIVE_ADAPTER_URL = new URL(
    `./query-native-module-data-v1.js?v=${QUERY_NATIVE_ADAPTER_VERSION}`,
    SCRIPT_URL,
  ).href;
  const QUERY_NATIVE_GATE_URL = new URL(
    `./query-native-governance-gate-v1.js?v=${QUERY_NATIVE_GATE_VERSION}`,
    SCRIPT_URL,
  ).href;
  const QUERY_NATIVE_SOURCE_READINESS_URL = new URL(
    `./query-native-ads-source-readiness-v1.js?v=${QUERY_NATIVE_SOURCE_READINESS_VERSION}`,
    SCRIPT_URL,
  ).href;
  const QUERY_NATIVE_BID_INTELLIGENCE_URL = new URL(
    `./query-native-bid-intelligence-v1.js?v=${QUERY_NATIVE_BID_INTELLIGENCE_VERSION}`,
    SCRIPT_URL,
  ).href;
  const BID_GOVERNANCE_PARITY_AUDIT_URL = new URL(
    `./bid-governance-parity-audit-v1.js?v=${BID_GOVERNANCE_PARITY_AUDIT_VERSION}`,
    SCRIPT_URL,
  ).href;
  const QUERY_NATIVE_TREND_URL = new URL(
    `./query-native-ads-trend-v1.js?v=${QUERY_NATIVE_TREND_VERSION}`,
    SCRIPT_URL,
  ).href;
  const QUERY_NATIVE_HOST_URL = new URL(
    `./query-native-ads-trend-host-v1.js?v=${QUERY_NATIVE_HOST_VERSION}`,
    SCRIPT_URL,
  ).href;
  const responseCache = new Map();
  const scriptLoads = new Map();
  const state = {
    bootstrap: null,
    status: null,
    overview: null,
    lastScope: 'ALL',
    lastError: null,
    source: 'unknown',
    dataFingerprint: '',
    lastCacheState: 'none',
    moduleAssetsReady: false,
  };

  const normalizeScope = value => {
    const scope = String(value || '').trim().toUpperCase();
    return ['ALL', 'YTDBNS', 'YY', 'JJ'].includes(scope) ? scope : 'ALL';
  };

  const currentScope = () =>
    normalizeScope(window.ShopScope?.get?.() || window.ACTIVE_SHOP || state.lastScope || 'ALL');

  const queryBridge = () => {
    const request = window.PrivateCloudAds?.queryRequest;
    if (typeof request !== 'function') throw clientError(503, '私有云查询桥接尚未就绪');
    return request;
  };

  async function request(path, options = {}) {
    const normalized = normalizePath(path);
    const cached = responseCache.get(normalized);
    const headers = { ...(options.headers || {}) };
    if (cached?.etag && options.useCache !== false) headers['If-None-Match'] = cached.etag;
    const result = await queryBridge()(normalized, {
      headers,
      timeoutMs: boundedInteger(options.timeoutMs, 120000, 1000, 300000),
      maxAttempts: boundedInteger(options.maxAttempts, 4, 1, 6),
    });
    if (!result || typeof result !== 'object') throw clientError(502, '私有云查询返回格式无效');
    if (result.response?.status === 304) {
      if (!cached?.payload) throw clientError(502, '查询返回 304，但当前页面没有可复用缓存');
      state.lastCacheState = 'hit';
      return { ...result, payload: cached.payload, cache: 'hit' };
    }
    const etag = String(result.response?.headers?.get?.('ETag') || '');
    if (result.payload && options.useCache !== false) {
      responseCache.set(normalized, {
        payload: result.payload,
        etag,
        dataFingerprint: String(result.payload?.dataFingerprint || ''),
        storedAt: Date.now(),
      });
    }
    state.lastCacheState = 'miss';
    return { ...result, cache: 'miss' };
  }

  async function getBootstrap(options = {}) {
    const scope = normalizeScope(options.scope || currentScope());
    const params = new URLSearchParams({
      scope,
      grain: options.grain === 'day' ? 'day' : 'month',
    });
    appendDate(params, 'from', options.from);
    appendDate(params, 'to', options.to);
    const { payload, cache } = await request(`/api/v1/query/bootstrap?${params}`, options);
    if (!payload || payload.bootstrapVersion !== 'query-first-bootstrap-v1') {
      throw clientError(502, 'Query-first Bootstrap 契约无效');
    }
    state.bootstrap = payload;
    state.status = payload.status || null;
    state.overview = payload.overview || null;
    state.lastScope = scope;
    state.source = payload?.status?.primaryStorage || 'unknown';
    state.dataFingerprint = String(payload.dataFingerprint || '');
    state.lastCacheState = cache || 'none';
    state.lastError = null;
    dispatch('lr:query-bootstrap', payload);
    dispatch('lr:query-status', state.status);
    dispatch('lr:query-overview', state.overview);
    return payload;
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

  async function preflightAdsSource(headers, options = {}) {
    const normalizedHeaders = normalizePreflightHeaders(headers);
    const encodedHeaders = encodeHeadersBase64Url(normalizedHeaders);
    if (encodedHeaders.length > ADS_SOURCE_PREFLIGHT_MAX_ENCODED_LENGTH) {
      throw clientError(413, '广告报表表头过大，无法进行安全预检');
    }
    const nonce = Date.now();
    const { payload } = await request(
      `/api/v1/query/ads/source-preflight?clientPreflight=${nonce}`,
      {
        ...options,
        useCache: false,
        headers: {
          ...(options.headers || {}),
          [ADS_SOURCE_PREFLIGHT_HEADER]: encodedHeaders,
        },
      },
    );
    if (!payload || payload.schemaVersion !== 'ads-source-preflight-v1') {
      throw clientError(502, '广告源预检契约无效');
    }
    if (payload.activation?.writesFacts !== false
      || payload.activation?.changesCurrentSlot !== false
      || payload.activation?.authorizesExecution !== false) {
      throw clientError(502, '广告源预检越过只读安全边界');
    }
    state.lastError = null;
    dispatch('lr:ads-source-preflight', payload);
    return payload;
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
    const { payload } = await request(`${path}?${params}`, { ...options, useCache: false });
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
      const bootstrap = await getBootstrap({ grain: 'month', ...options });
      return {
        bootstrap,
        status: bootstrap.status || null,
        overview: bootstrap.overview || null,
      };
    } catch (error) {
      state.lastError = String(error?.message || error);
      dispatch('lr:query-error', { message: state.lastError, status: Number(error?.status || 0) });
      throw error;
    }
  }

  function adoptBootstrap(payload) {
    if (!payload || payload.bootstrapVersion !== 'query-first-bootstrap-v1') return false;
    state.bootstrap = payload;
    state.status = payload.status || null;
    state.overview = payload.overview || null;
    state.lastScope = normalizeScope(payload.scope || currentScope());
    state.source = payload?.status?.primaryStorage || 'unknown';
    state.dataFingerprint = String(payload.dataFingerprint || '');
    state.lastError = null;
    return true;
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

  function normalizePreflightHeaders(value) {
    if (!Array.isArray(value) || !value.length) throw clientError(400, '广告报表表头不能为空');
    if (value.length > ADS_SOURCE_PREFLIGHT_MAX_HEADERS) {
      throw clientError(400, `广告报表表头不能超过 ${ADS_SOURCE_PREFLIGHT_MAX_HEADERS} 列`);
    }
    const identities = new Set();
    return value.map((header, index) => {
      if (typeof header !== 'string') throw clientError(400, `第 ${index + 1} 列表头必须是文本`);
      const normalized = header.normalize('NFKC').trim();
      if (!normalized) throw clientError(400, `第 ${index + 1} 列表头不能为空`);
      if (normalized.length > ADS_SOURCE_PREFLIGHT_MAX_HEADER_LENGTH) {
        throw clientError(400, `第 ${index + 1} 列表头过长`);
      }
      if (/\p{Cc}/u.test(normalized)) throw clientError(400, `第 ${index + 1} 列表头包含控制字符`);
      const identity = normalized.toLowerCase().replace(/\s+/g, ' ');
      if (identities.has(identity)) throw clientError(400, '广告报表包含 Unicode 等价重复表头');
      identities.add(identity);
      return normalized;
    });
  }

  function encodeHeadersBase64Url(headers) {
    const bytes = new TextEncoder().encode(JSON.stringify(headers));
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  function isCanonicalDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
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

  function loadVersionedScript(url, datasetKey) {
    if (scriptLoads.has(url)) return scriptLoads.get(url);
    const existing = [...document.scripts].find(script => script.src === url);
    if (existing?.dataset?.loaded === '1') return Promise.resolve(existing);
    const promise = new Promise((resolve, reject) => {
      const script = existing || document.createElement('script');
      const finish = () => {
        script.dataset.loaded = '1';
        resolve(script);
      };
      const fail = () => reject(clientError(503, `Query-native 资产加载失败：${url}`));
      script.addEventListener('load', finish, { once: true });
      script.addEventListener('error', fail, { once: true });
      if (!existing) {
        script.src = url;
        script.async = false;
        script.dataset[datasetKey] = '1';
        document.head.appendChild(script);
      }
    });
    scriptLoads.set(url, promise);
    return promise;
  }

  async function ensureQueryNativeModules() {
    if (window.QueryNativeModuleData?.version !== QUERY_NATIVE_ADAPTER_VERSION) {
      await loadVersionedScript(QUERY_NATIVE_ADAPTER_URL, 'queryNativeAdapter');
    }
    if (window.QueryNativeGovernanceGate?.version !== QUERY_NATIVE_GATE_VERSION) {
      await loadVersionedScript(QUERY_NATIVE_GATE_URL, 'queryNativeGovernanceGate');
    }
    if (window.AdsSourceReadinessInspector?.version !== QUERY_NATIVE_SOURCE_READINESS_VERSION) {
      await loadVersionedScript(QUERY_NATIVE_SOURCE_READINESS_URL, 'queryNativeAdsSourceReadiness');
    }
    if (window.QueryNativeBidIntelligence?.version !== QUERY_NATIVE_BID_INTELLIGENCE_VERSION) {
      await loadVersionedScript(QUERY_NATIVE_BID_INTELLIGENCE_URL, 'queryNativeBidIntelligence');
    }
    if (window.BidGovernanceParityAudit?.version !== BID_GOVERNANCE_PARITY_AUDIT_VERSION) {
      await loadVersionedScript(BID_GOVERNANCE_PARITY_AUDIT_URL, 'bidGovernanceParityAudit');
    }
    if (window.QueryNativeAdsTrend?.version !== QUERY_NATIVE_TREND_VERSION) {
      await loadVersionedScript(QUERY_NATIVE_TREND_URL, 'queryNativeAdsTrend');
    }
    if (window.QueryNativeAdsTrendHost?.version !== QUERY_NATIVE_HOST_VERSION) {
      await loadVersionedScript(QUERY_NATIVE_HOST_URL, 'queryNativeAdsTrendHost');
    }
    state.moduleAssetsReady = true;
    dispatch('lr:query-native-assets-ready', {
      clientVersion: CLIENT_VERSION,
      adapterVersion: window.QueryNativeModuleData?.version || '',
      gateVersion: window.QueryNativeGovernanceGate?.version || '',
      sourceReadinessVersion: window.AdsSourceReadinessInspector?.version || '',
      bidIntelligenceVersion: window.QueryNativeBidIntelligence?.version || '',
      bidGovernanceParityAuditVersion: window.BidGovernanceParityAudit?.version || '',
      trendVersion: window.QueryNativeAdsTrend?.version || '',
      hostVersion: window.QueryNativeAdsTrendHost?.version || '',
    });
    return true;
  }

  window.PrivateCloudQuery = Object.freeze({
    version: CLIENT_VERSION,
    apiBase: () => window.PrivateCloudAds?.apiBase || '',
    bootstrap: getBootstrap,
    status: getStatus,
    overview: getOverview,
    ads: getAds,
    transactions: getTransactions,
    allAds: getAllAds,
    allTransactions: getAllTransactions,
    preflightAdsSource,
    refresh,
    ensureQueryNativeModules,
    clearMemoryCache: () => responseCache.clear(),
    state: () => ({
      ...state,
      cacheEntries: responseCache.size,
    }),
  });

  window.addEventListener('lr:query-bootstrap', event => {
    adoptBootstrap(event.detail || null);
  });

  window.addEventListener('lr:cloud-overview-ready', event => {
    adoptBootstrap(event.detail?.bootstrap || null);
  });

  window.addEventListener('lr:cloud-loaded', event => {
    const detail = event.detail || {};
    const scope = normalizeScope(detail.scope || currentScope());
    const storage = String(detail.storage || '');
    if (storage) state.source = storage;
    if (state.bootstrap && state.lastScope === scope) return;
    refresh({ scope }).catch(error => console.warn('TiDB query client refresh skipped:', error));
  });

  dispatch('lr:query-client-ready', {
    version: CLIENT_VERSION,
    apiBase: window.PrivateCloudAds?.apiBase || '',
    capabilities: [
      'bootstrap',
      'etag-memory-cache',
      'status',
      'overview',
      'ads',
      'transactions',
      'ads-source-preflight',
      'ads-source-readiness-inspector',
      'bid-intelligence-preview',
      'bid-governance-parity-audit',
      'governance-execution-gate',
      'query-native-module-assets',
    ],
  });

  ensureQueryNativeModules().catch(error => {
    state.lastError = String(error?.message || error);
    console.warn('Query-native module assets failed to load:', error);
    dispatch('lr:query-native-assets-error', {
      message: state.lastError,
      status: Number(error?.status || 0),
    });
  });
})();