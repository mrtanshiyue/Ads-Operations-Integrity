(() => {
  'use strict';

  const ADAPTER_VERSION = '1.0.0';
  const QUERY_CLIENT_TIMEOUT_MS = 15000;
  const DEFAULT_MAX_ROWS = 300000;
  const detailCache = new Map();
  const state = {
    lastSource: 'none',
    lastRequest: null,
    lastError: null,
    cacheEntries: 0,
  };

  const normalizeScope = value => {
    const scope = String(value || '').trim().toUpperCase();
    return ['ALL', 'YTDBNS', 'YY', 'JJ'].includes(scope) ? scope : 'ALL';
  };

  const currentScope = () => normalizeScope(
    window.ShopScope?.get?.() || window.ACTIVE_SHOP || 'ALL',
  );

  const canonicalDate = value => {
    const text = String(value || '').trim();
    if (!text) return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) throw moduleError(400, '日期必须使用 YYYY-MM-DD');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw moduleError(400, '日期无效');
    }
    return text;
  };

  const normalizeStatusMode = value =>
    String(value || '').trim().toLowerCase() === 'cash' ? 'cash' : 'accrual';

  const MARKETPLACE_ALIASES = Object.freeze({
    US: ['US', 'AMAZON.COM', 'WWW.AMAZON.COM'],
    CA: ['CA', 'AMAZON.CA', 'WWW.AMAZON.CA'],
    MX: ['MX', 'AMAZON.COM.MX', 'WWW.AMAZON.COM.MX'],
    UK: ['UK', 'GB', 'AMAZON.CO.UK', 'WWW.AMAZON.CO.UK'],
    DE: ['DE', 'AMAZON.DE', 'WWW.AMAZON.DE'],
    FR: ['FR', 'AMAZON.FR', 'WWW.AMAZON.FR'],
    IT: ['IT', 'AMAZON.IT', 'WWW.AMAZON.IT'],
    ES: ['ES', 'AMAZON.ES', 'WWW.AMAZON.ES'],
    JP: ['JP', 'AMAZON.CO.JP', 'WWW.AMAZON.CO.JP'],
    AU: ['AU', 'AMAZON.COM.AU', 'WWW.AMAZON.COM.AU'],
  });

  const marketplaceToken = value => String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^HTTPS?:\/\//, '')
    .replace(/\/.*$/, '');

  const normalizeMarketplace = value => marketplaceToken(value);

  const marketplaceMatches = (rowValue, requestedValue) => {
    const row = marketplaceToken(rowValue);
    const requested = marketplaceToken(requestedValue);
    if (!row || !requested) return true;
    return (MARKETPLACE_ALIASES[requested] || [requested]).includes(row);
  };

  const transactionPreTaxNet = row => [
    'productSales',
    'shippingCredits',
    'giftWrapCredits',
    'regulatoryFee',
    'promotionalRebates',
    'sellingFees',
    'fbaFees',
    'otherTransactionFees',
    'other',
  ].reduce((sum, key) => sum + number(row?.[key]), 0);

  const normalizeTransaction = row => {
    const normalized = { ...(row && typeof row === 'object' ? row : {}) };
    normalized.id = String(normalized.id || '');
    normalized.storeId = String(normalized.storeId || '').toUpperCase();
    normalized.date = String(normalized.date || '').slice(0, 10);
    normalized.category = String(normalized.category || 'OTHER').toUpperCase();
    normalized.status = String(normalized.status || (
      normalized.isDeferred ? 'Deferred' : 'Released'
    ));
    normalized.marketplace = String(normalized.marketplace || '');
    normalized.sku = String(normalized.sku || '').toUpperCase();
    normalized.orderId = String(normalized.orderId || '');
    normalized.preTaxNet = Number.isFinite(Number(normalized.preTaxNet))
      ? Number(normalized.preTaxNet)
      : transactionPreTaxNet(normalized);
    return normalized;
  };

  const transactionKey = (row, index) => row.id || [
    row.storeId,
    row.date,
    row.category,
    row.orderId,
    row.sku,
    row.total,
    index,
  ].join('|');

  const dedupeTransactions = rows => {
    const selected = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      const normalized = normalizeTransaction(row);
      selected.set(transactionKey(normalized, index), normalized);
    });
    return [...selected.values()];
  };

  const statusIncluded = (row, mode) => {
    if (mode === 'cash') {
      if ('isReleased' in row) return Boolean(row.isReleased);
      return String(row.status || 'Released').trim().toLowerCase() === 'released';
    }
    if ('isReleased' in row || 'isDeferred' in row) {
      return Boolean(row.isReleased || row.isDeferred);
    }
    const status = String(row.status || 'Released').trim().toLowerCase();
    return status === 'released' || status === 'deferred';
  };

  const rowIncluded = (row, request) => {
    if (request.from && row.date < request.from) return false;
    if (request.to && row.date > request.to) return false;
    if (!statusIncluded(row, request.statusMode)) return false;
    if (request.marketplace && row.marketplace
      && !marketplaceMatches(row.marketplace, request.marketplace)) return false;
    if (request.scope !== 'ALL' && row.storeId && row.storeId !== request.scope) return false;
    return true;
  };

  const requestShape = options => {
    const request = {
      scope: normalizeScope(options.scope || currentScope()),
      from: canonicalDate(options.from),
      to: canonicalDate(options.to),
      statusMode: normalizeStatusMode(options.statusMode),
      marketplace: normalizeMarketplace(options.marketplace),
      maxRows: boundedInteger(options.maxRows, DEFAULT_MAX_ROWS, 1, 1000000),
      source: String(options.source || 'query').trim().toLowerCase() === 'raw' ? 'raw' : 'query',
      force: Boolean(options.force),
    };
    if (request.from && request.to && request.from > request.to) {
      throw moduleError(400, '开始日期不能晚于结束日期');
    }
    return request;
  };

  const cacheKey = request => JSON.stringify({
    scope: request.scope,
    from: request.from,
    to: request.to,
    statusMode: request.statusMode,
    marketplace: request.marketplace,
    maxRows: request.maxRows,
    source: request.source,
  });

  async function waitForQueryClient(timeoutMs = QUERY_CLIENT_TIMEOUT_MS) {
    if (typeof window.PrivateCloudQuery?.allTransactions === 'function') {
      return window.PrivateCloudQuery;
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener?.('lr:query-client-ready', onReady);
        callback(value);
      };
      const onReady = () => {
        const client = window.PrivateCloudQuery;
        if (typeof client?.allTransactions === 'function') finish(resolve, client);
      };
      const timer = setTimeout(() => finish(
        reject,
        moduleError(503, 'Query Client 尚未就绪，请先连接私有云数据'),
      ), boundedInteger(timeoutMs, QUERY_CLIENT_TIMEOUT_MS, 1000, 60000));
      window.addEventListener?.('lr:query-client-ready', onReady);
      onReady();
    });
  }

  async function queryTransactions(request) {
    const client = await waitForQueryClient();
    const payload = await client.allTransactions({
      scope: request.scope,
      from: request.from,
      to: request.to,
      statusMode: request.statusMode,
      maxRows: request.maxRows,
      limit: 500,
    });
    const rows = dedupeTransactions(payload?.rows).filter(row => rowIncluded(row, request));
    return resultPayload(rows, request, 'query-tidb', {
      nextOffset: payload?.nextOffset ?? null,
      truncated: payload?.nextOffset !== null && payload?.nextOffset !== undefined,
    });
  }

  async function rawTransactions(request) {
    const getter = window.AdsDashboardApp?.debug?.getTransactionRowsForFinance;
    if (typeof getter !== 'function') {
      throw moduleError(404, '当前页面没有可用的 Raw 兼容交易数据');
    }
    const rows = dedupeTransactions(getter()).filter(row => rowIncluded(row, request));
    return resultPayload(rows, request, 'raw-compat', {
      nextOffset: null,
      truncated: false,
    });
  }

  function resultPayload(rows, request, source, extra = {}) {
    const payload = {
      schemaVersion: '1.0',
      adapterVersion: ADAPTER_VERSION,
      generatedAt: new Date().toISOString(),
      source,
      scope: request.scope,
      from: request.from || null,
      to: request.to || null,
      statusMode: request.statusMode,
      marketplace: request.marketplace || null,
      count: rows.length,
      rows,
      ...extra,
    };
    state.lastSource = source;
    state.lastRequest = { ...request };
    state.lastError = null;
    dispatch('lr:module-data-ready', {
      module: 'transactions',
      source,
      count: rows.length,
      scope: request.scope,
      from: request.from || null,
      to: request.to || null,
    });
    return payload;
  }

  async function transactions(options = {}) {
    const request = requestShape(options);
    const key = cacheKey(request);
    if (!request.force && detailCache.has(key)) {
      return { ...detailCache.get(key), cache: 'hit' };
    }
    try {
      const payload = request.source === 'raw'
        ? await rawTransactions(request)
        : await queryTransactions(request);
      detailCache.set(key, payload);
      state.cacheEntries = detailCache.size;
      return { ...payload, cache: 'miss' };
    } catch (error) {
      state.lastError = String(error?.message || error);
      dispatch('lr:module-data-error', {
        module: 'transactions',
        source: request.source,
        message: state.lastError,
        status: Number(error?.status || 0),
      });
      throw error;
    }
  }

  async function periodTransactions(options = {}) {
    const current = options.current || {};
    const previous = options.previous || null;
    const common = {
      scope: options.scope,
      statusMode: options.statusMode,
      marketplace: options.marketplace,
      maxRows: options.maxRows,
      source: options.source,
      force: options.force,
    };
    const currentPromise = transactions({ ...common, from: current.from, to: current.to });
    const previousPromise = previous
      ? transactions({ ...common, from: previous.from, to: previous.to })
      : Promise.resolve(null);
    const [currentResult, previousResult] = await Promise.all([currentPromise, previousPromise]);
    return { current: currentResult, previous: previousResult };
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
  }

  function number(value) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function moduleError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function dispatch(name, detail) {
    window.dispatchEvent?.(new CustomEvent(name, { detail }));
  }

  window.QueryNativeModuleData = Object.freeze({
    version: ADAPTER_VERSION,
    transactions,
    periodTransactions,
    transactionPreTaxNet,
    clearMemoryCache: () => {
      detailCache.clear();
      state.cacheEntries = 0;
    },
    state: () => ({ ...state }),
  });

  dispatch('lr:query-native-module-data-ready', {
    version: ADAPTER_VERSION,
    capabilities: ['transactions', 'period-transactions', 'explicit-raw-compatibility'],
  });
})();
