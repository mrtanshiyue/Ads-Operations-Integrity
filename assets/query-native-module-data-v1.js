(() => {
  'use strict';

  const ADAPTER_VERSION = '1.2.0';
  const QUERY_CLIENT_TIMEOUT_MS = 15000;
  const DEFAULT_MAX_ROWS = 300000;
  const ADS_GOVERNANCE_VERSION = 'ads-query-governance-v2';
  const detailCache = new Map();
  const state = {
    lastSource: 'none',
    lastModule: 'none',
    lastRequest: null,
    lastError: null,
    lastGovernance: null,
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

  const transactionKey = row => row.id || [
    row.storeId,
    row.date,
    row.category,
    row.orderId,
    row.sku,
    row.total,
  ].join('|');

  const dedupeTransactions = rows => {
    const selected = new Map();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const normalized = normalizeTransaction(row);
      selected.set(transactionKey(normalized), normalized);
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

  const transactionIncluded = (row, request) => {
    if (request.from && row.date < request.from) return false;
    if (request.to && row.date > request.to) return false;
    if (!statusIncluded(row, request.statusMode)) return false;
    if (request.marketplace && row.marketplace
      && !marketplaceMatches(row.marketplace, request.marketplace)) return false;
    if (request.scope !== 'ALL' && row.storeId && row.storeId !== request.scope) return false;
    return true;
  };

  const transactionRequestShape = options => {
    const request = {
      scope: normalizeScope(options.scope || currentScope()),
      from: canonicalDate(options.from),
      to: canonicalDate(options.to),
      statusMode: normalizeStatusMode(options.statusMode),
      marketplace: normalizeMarketplace(options.marketplace),
      maxRows: boundedInteger(options.maxRows, DEFAULT_MAX_ROWS, 1, 1000000),
      source: normalizeSource(options.source),
      force: Boolean(options.force),
    };
    validateDateRange(request);
    return request;
  };

  const normalizeAdProduct = value => {
    const normalized = String(value ?? '').trim().toUpperCase();
    return normalized || null;
  };
  const text = value => String(value ?? '').trim();
  const nullableTextUpper = value => text(value).toUpperCase() || null;
  const lower = value => text(value).toLowerCase();
  const sameText = (left, right) => lower(left) === lower(right);

  const metricValue = (row, key, fallback = undefined) => {
    const metrics = row?.metrics && typeof row.metrics === 'object' ? row.metrics : {};
    if (row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '') return row[key];
    if (metrics?.[key] !== undefined && metrics?.[key] !== null && metrics?.[key] !== '') return metrics[key];
    return fallback;
  };

  const normalizeAdRow = row => {
    const source = row && typeof row === 'object' ? row : {};
    const metrics = source.metrics && typeof source.metrics === 'object' ? source.metrics : {};
    const normalized = { ...metrics, ...source };
    normalized.id = text(metricValue(source, 'id'));
    normalized.storeId = text(metricValue(source, 'storeId')).toUpperCase();
    normalized.date = text(metricValue(source, 'date')).slice(0, 10);
    normalized.portfolioId = text(metricValue(source, 'portfolioId'));
    normalized.portfolio = text(metricValue(source, 'portfolio'));
    normalized.campaignId = text(metricValue(source, 'campaignId'));
    normalized.campaign = text(metricValue(source, 'campaign'));
    normalized.adGroupId = text(metricValue(source, 'adGroupId'));
    normalized.adGroup = text(metricValue(source, 'adGroup'));
    normalized.targetingId = text(metricValue(source, 'targetingId'));
    normalized.searchTerm = text(metricValue(source, 'searchTerm'));
    normalized.searchTermLower = normalized.searchTerm.toLowerCase();
    normalized.targeting = text(metricValue(source, 'targeting'));
    normalized.targetingType = text(metricValue(source, 'targetingType'));
    normalized.targetingState = text(metricValue(source, 'targetingState'));
    normalized.matchType = text(metricValue(source, 'matchType'));
    normalized.currentBid = nullableNumber(metricValue(source, 'currentBid', metricValue(source, 'bid')));
    normalized.targetBid = nullableNumber(metricValue(source, 'targetBid', normalized.currentBid));
    normalized.bid = normalized.currentBid ?? normalized.targetBid;
    normalized.impressions = number(metricValue(source, 'impressions', metricValue(source, 'impr')));
    normalized.impr = normalized.impressions;
    normalized.clicks = number(metricValue(source, 'clicks'));
    normalized.spend = number(metricValue(source, 'spend'));
    normalized.orders = number(metricValue(source, 'orders'));
    normalized.sales = number(metricValue(source, 'sales'));
    normalized.units = number(metricValue(source, 'units'));
    normalized.newToBrandOrders = number(metricValue(source, 'newToBrandOrders'));
    normalized.newToBrandSales = number(metricValue(source, 'newToBrandSales'));
    normalized.adProduct = normalizeAdProduct(metricValue(source, 'adProduct'));
    normalized.advertisedAsin = nullableTextUpper(metricValue(source, 'advertisedAsin'));
    normalized.advertisedSku = nullableTextUpper(metricValue(source, 'advertisedSku'));
    normalized.purchasedAsin = nullableTextUpper(metricValue(source, 'purchasedAsin'));
    normalized.purchasedSku = nullableTextUpper(metricValue(source, 'purchasedSku'));
    normalized.sourceFile = text(metricValue(source, 'sourceFile'));
    normalized.reportGranularity = text(metricValue(
      source,
      'reportGranularity',
      metricValue(source, 'granularity'),
    )) || null;
    normalized.attributionWindowDays = nullableBoundedInteger(
      metricValue(source, 'attributionWindowDays'),
      1,
      30,
    );
    normalized.bidValueTrusted = Boolean(source.bidValueTrusted);
    normalized.governanceReady = Boolean(source.governanceReady);
    normalized.sourceCoverage = source.sourceCoverage && typeof source.sourceCoverage === 'object'
      ? source.sourceCoverage
      : null;
    normalized.ctr = normalized.impressions > 0 ? normalized.clicks / normalized.impressions : 0;
    normalized.cpc = normalized.clicks > 0 ? normalized.spend / normalized.clicks : 0;
    normalized.cvr = normalized.clicks > 0 ? normalized.orders / normalized.clicks : 0;
    normalized.acos = normalized.sales > 0 ? normalized.spend / normalized.sales : (normalized.spend > 0 ? Infinity : 0);
    normalized.roas = normalized.spend > 0 ? normalized.sales / normalized.spend : 0;
    return normalized;
  };

  const adKey = row => row.id || [
    row.storeId,
    row.date,
    row.campaignId || row.campaign,
    row.adGroupId || row.adGroup,
    row.targetingId || row.targeting,
    row.searchTerm,
    row.matchType,
  ].join('|');

  const dedupeAds = rows => {
    const selected = new Map();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const normalized = normalizeAdRow(row);
      selected.set(adKey(normalized), normalized);
    });
    return [...selected.values()];
  };

  const isManualAd = row => {
    const match = lower(row.matchType);
    const type = lower(row.targetingType);
    if (['exact', 'phrase', 'broad'].includes(match)) return true;
    if (/manual/.test(type)) return true;
    if (/auto|close-match|loose-match|substitutes|complements/.test(`${match} ${type}`)) return false;
    return Boolean(row.targeting || row.searchTerm);
  };

  const negativeTokenPresent = (value, token) => {
    const normalized = lower(token);
    if (!normalized) return false;
    if (/^[a-z0-9]+$/i.test(normalized)) {
      return lower(value).split(/[^a-z0-9]+/i).filter(Boolean).includes(normalized);
    }
    return lower(value).includes(normalized);
  };

  const advancedSearchMatches = (value, query, exact = false) => {
    const haystack = lower(value);
    const needle = text(query);
    if (!needle) return true;
    if (exact) return haystack === needle.toLowerCase();
    if (/^regex:/i.test(needle)) {
      const pattern = needle.slice(6).trim();
      if (!pattern) return true;
      try { return new RegExp(pattern, 'i').test(value); }
      catch (_) { throw moduleError(400, '搜索词正则表达式无效'); }
    }
    const tokens = needle.split(/\s+/).filter(Boolean);
    const positives = tokens.filter(token => !token.startsWith('-')).map(lower);
    const negatives = tokens.filter(token => token.startsWith('-') && token.length > 1).map(token => lower(token.slice(1)));
    return positives.every(token => haystack.includes(token))
      && negatives.every(token => !negativeTokenPresent(value, token));
  };

  const adIncluded = (row, request) => {
    if (request.from && row.date < request.from) return false;
    if (request.to && row.date > request.to) return false;
    if (request.scope !== 'ALL' && row.storeId && row.storeId !== request.scope) return false;
    if (request.sourceFile && !sameText(row.sourceFile, request.sourceFile)) return false;
    if (request.portfolio && !sameText(row.portfolio, request.portfolio)) return false;
    if (request.campaign && !sameText(row.campaign, request.campaign)) return false;
    if (request.adGroup && !sameText(row.adGroup, request.adGroup)) return false;
    if (request.targeting && !sameText(row.targeting, request.targeting)) return false;
    if (request.matchType && !sameText(row.matchType, request.matchType)) return false;
    if (request.adProduct && normalizeAdProduct(row.adProduct) !== request.adProduct) return false;
    if (request.adType === 'manual' && !isManualAd(row)) return false;
    if (request.adType === 'auto' && isManualAd(row)) return false;
    if (!advancedSearchMatches(row.searchTerm || row.targeting, request.search, request.searchExact)) return false;
    return true;
  };

  const adRequestShape = options => {
    const adType = lower(options.adType);
    const request = {
      scope: normalizeScope(options.scope || currentScope()),
      from: canonicalDate(options.from),
      to: canonicalDate(options.to),
      sourceFile: text(options.sourceFile),
      portfolio: text(options.portfolio),
      campaign: text(options.campaign),
      adGroup: text(options.adGroup),
      targeting: text(options.targeting),
      matchType: text(options.matchType),
      adType: ['manual', 'auto'].includes(adType) ? adType : '',
      adProduct: normalizeAdProduct(options.adProduct),
      search: text(options.search),
      searchExact: Boolean(options.searchExact),
      maxRows: boundedInteger(options.maxRows, DEFAULT_MAX_ROWS, 1, 1000000),
      source: normalizeSource(options.source),
      force: Boolean(options.force),
    };
    validateDateRange(request);
    return request;
  };

  const overviewRequestShape = options => {
    const grain = lower(options.grain) === 'month' ? 'month' : 'day';
    const request = {
      scope: normalizeScope(options.scope || currentScope()),
      from: canonicalDate(options.from),
      to: canonicalDate(options.to),
      grain,
      force: Boolean(options.force),
    };
    validateDateRange(request);
    return request;
  };

  function validateDateRange(request) {
    if (request.from && request.to && request.from > request.to) {
      throw moduleError(400, '开始日期不能晚于结束日期');
    }
  }

  const normalizeSource = value => lower(value) === 'raw' ? 'raw' : 'query';

  const cacheKey = (module, request) => `${module}:${JSON.stringify(request, Object.keys(request).sort())}`;

  async function waitForQueryClient(method, timeoutMs = QUERY_CLIENT_TIMEOUT_MS) {
    if (typeof window.PrivateCloudQuery?.[method] === 'function') return window.PrivateCloudQuery;
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
        if (typeof client?.[method] === 'function') finish(resolve, client);
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
    const client = await waitForQueryClient('allTransactions');
    const payload = await client.allTransactions({
      scope: request.scope,
      from: request.from,
      to: request.to,
      statusMode: request.statusMode,
      maxRows: request.maxRows,
      limit: 500,
    });
    const rows = dedupeTransactions(payload?.rows).filter(row => transactionIncluded(row, request));
    return resultPayload('transactions', rows, request, 'query-tidb', {
      nextOffset: payload?.nextOffset ?? null,
      truncated: payload?.nextOffset !== null && payload?.nextOffset !== undefined,
    });
  }

  async function rawTransactions(request) {
    const getter = window.AdsDashboardApp?.debug?.getTransactionRowsForFinance;
    if (typeof getter !== 'function') throw moduleError(404, '当前页面没有可用的 Raw 兼容交易数据');
    const rows = dedupeTransactions(getter()).filter(row => transactionIncluded(row, request));
    return resultPayload('transactions', rows, request, 'raw-compat', { nextOffset: null, truncated: false });
  }

  async function queryAds(request) {
    const client = await waitForQueryClient('ads');
    const collected = await collectGovernedAdPages(client, request);
    const rows = dedupeAds(collected.rows).filter(row => adIncluded(row, request));
    return resultPayload('ads', rows, request, 'query-tidb', {
      nextOffset: collected.nextOffset,
      truncated: collected.truncated,
      governance: collected.governance,
    });
  }

  async function collectGovernedAdPages(client, request) {
    const rows = [];
    const pageSize = 500;
    let offset = 0;
    let nextOffset = null;
    let governance = null;
    let signature = '';
    while (rows.length < request.maxRows) {
      const page = await client.ads({
        scope: request.scope,
        from: request.from,
        to: request.to,
        campaign: request.campaign,
        limit: pageSize,
        offset,
      });
      const pageRows = Array.isArray(page?.rows) ? page.rows : [];
      const pageGovernance = validateAdsGovernance(page?.governance);
      const pageSignature = governanceSignature(pageGovernance);
      if (!governance) {
        governance = pageGovernance;
        signature = pageSignature;
      } else if (pageSignature !== signature) {
        throw moduleError(502, '广告 Query 分页治理契约发生变化，已停止合并结果');
      }
      rows.push(...pageRows.slice(0, Math.max(0, request.maxRows - rows.length)));
      nextOffset = page?.nextOffset ?? null;
      if (nextOffset === null || nextOffset === undefined || !pageRows.length) break;
      offset = Number(nextOffset);
      if (!Number.isSafeInteger(offset) || offset < 0) throw moduleError(502, '广告 Query 分页游标无效');
    }
    return {
      rows,
      governance: governance || validateAdsGovernance(null),
      nextOffset: rows.length >= request.maxRows ? nextOffset : null,
      truncated: rows.length >= request.maxRows && nextOffset !== null && nextOffset !== undefined,
    };
  }

  function validateAdsGovernance(governance) {
    if (!governance || typeof governance !== 'object') {
      throw moduleError(502, '广告 Query 缺少治理契约，已按 fail-closed 停止读取');
    }
    if (governance.schemaVersion !== ADS_GOVERNANCE_VERSION) {
      throw moduleError(502, `广告 Query 治理版本不兼容：${text(governance.schemaVersion) || 'missing'}`);
    }
    if (!governance.readiness || typeof governance.readiness !== 'object') {
      throw moduleError(502, '广告 Query 治理 readiness 缺失');
    }
    return governance;
  }

  function governanceSignature(governance) {
    return JSON.stringify({
      schemaVersion: governance?.schemaVersion || '',
      scope: governance?.scope || '',
      stores: governance?.stores || [],
      fromMonth: governance?.fromMonth || null,
      toMonth: governance?.toMonth || null,
      fileCount: governance?.fileCount || 0,
      dimensions: governance?.dimensions || {},
      readiness: governance?.readiness || {},
      legacyCompatibility: governance?.legacyCompatibility || {},
    });
  }

  async function rawAds(request) {
    const getter = window.AdsDashboardApp?.debug?.getAdsRowsForQueryCompatibility;
    if (typeof getter !== 'function') throw moduleError(404, '当前页面没有可用的 Raw 兼容广告数据');
    const rows = dedupeAds(getter()).filter(row => adIncluded(row, request));
    return resultPayload('ads', rows, request, 'raw-compat', {
      nextOffset: null,
      truncated: false,
      governance: rawCompatibilityGovernance(),
    });
  }

  function rawCompatibilityGovernance() {
    return {
      schemaVersion: 'raw-compat-untrusted-v1',
      readiness: {
        targetingIdentityReady: false,
        bidSourceColumnReady: false,
        bidValueNullabilityTrusted: false,
        adProductReady: false,
        advertisedProductIdentityReady: false,
        attributionMaturityReady: false,
        bidGovernanceReady: false,
        campaignStudioReady: false,
      },
      legacyCompatibility: {
        bidNullability: 'raw-compatibility-untrusted',
      },
    };
  }

  function resultPayload(module, rows, request, source, extra = {}) {
    const payload = {
      schemaVersion: '1.0',
      adapterVersion: ADAPTER_VERSION,
      generatedAt: new Date().toISOString(),
      source,
      scope: request.scope,
      from: request.from || null,
      to: request.to || null,
      count: rows.length,
      rows,
      ...extra,
    };
    if (module === 'transactions') {
      payload.statusMode = request.statusMode;
      payload.marketplace = request.marketplace || null;
    }
    if (module === 'ads') state.lastGovernance = payload.governance || null;
    state.lastSource = source;
    state.lastModule = module;
    state.lastRequest = { ...request };
    state.lastError = null;
    dispatch('lr:module-data-ready', {
      module,
      source,
      count: rows.length,
      scope: request.scope,
      from: request.from || null,
      to: request.to || null,
      governance: module === 'ads' ? payload.governance || null : undefined,
    });
    return payload;
  }

  async function cachedRows(module, request, queryLoader, rawLoader) {
    const key = cacheKey(module, request);
    if (!request.force && detailCache.has(key)) return { ...detailCache.get(key), cache: 'hit' };
    try {
      const payload = request.source === 'raw' ? await rawLoader(request) : await queryLoader(request);
      detailCache.set(key, payload);
      state.cacheEntries = detailCache.size;
      return { ...payload, cache: 'miss' };
    } catch (error) {
      state.lastError = String(error?.message || error);
      state.lastModule = module;
      dispatch('lr:module-data-error', {
        module,
        source: request.source,
        message: state.lastError,
        status: Number(error?.status || 0),
      });
      throw error;
    }
  }

  async function transactions(options = {}) {
    const request = transactionRequestShape(options);
    return cachedRows('transactions', request, queryTransactions, rawTransactions);
  }

  async function ads(options = {}) {
    const request = adRequestShape(options);
    return cachedRows('ads', request, queryAds, rawAds);
  }

  async function overview(options = {}) {
    const request = overviewRequestShape(options);
    const key = cacheKey('overview', request);
    if (!request.force && detailCache.has(key)) return { ...detailCache.get(key), cache: 'hit' };
    try {
      const client = await waitForQueryClient('overview');
      const payload = await client.overview(request);
      if (!payload || !Array.isArray(payload.series)) throw moduleError(502, '经营概览 Query 契约无效');
      const result = {
        ...payload,
        source: 'query-tidb',
        adapterVersion: ADAPTER_VERSION,
      };
      detailCache.set(key, result);
      state.cacheEntries = detailCache.size;
      state.lastSource = 'query-tidb';
      state.lastModule = 'overview';
      state.lastRequest = { ...request };
      state.lastError = null;
      dispatch('lr:module-data-ready', {
        module: 'overview',
        source: 'query-tidb',
        count: payload.series.length,
        scope: request.scope,
        from: request.from || null,
        to: request.to || null,
      });
      return { ...result, cache: 'miss' };
    } catch (error) {
      state.lastError = String(error?.message || error);
      state.lastModule = 'overview';
      dispatch('lr:module-data-error', {
        module: 'overview',
        source: 'query',
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

  function nullableBoundedInteger(value, minimum, maximum) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const integer = Math.trunc(parsed);
    if (integer < minimum || integer > maximum) return null;
    return integer;
  }

  function nullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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
    ads,
    overview,
    transactions,
    periodTransactions,
    transactionPreTaxNet,
    normalizeAdRow,
    clearMemoryCache: () => {
      detailCache.clear();
      state.cacheEntries = 0;
    },
    state: () => ({ ...state }),
  });

  dispatch('lr:query-native-module-data-ready', {
    version: ADAPTER_VERSION,
    capabilities: [
      'ads',
      'ads-governance-provenance',
      'nullable-bid-semantics',
      'overview',
      'transactions',
      'period-transactions',
      'explicit-raw-compatibility',
    ],
  });
})();