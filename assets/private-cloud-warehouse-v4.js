(() => {
  'use strict';

  const SCRIPT_URL = document.currentScript?.src || new URL('assets/private-cloud-warehouse-v4.js', window.location.href).href;
  const API_ORIGIN = 'https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev';
  const CHANNEL = 'warehouse-v4-production';
  const LOADER_VERSION = '4.2.3';
  const BATCH_SIZE = 6;
  const FETCH_CONCURRENCY = 1;
  const CACHE_DB = 'amazon-warehouse-v4-cache';
  const CACHE_STORE = 'immutable-files';
  const IMPORTABLE_DATA_TYPES = new Set(['ads', 'transactions', 'business']);
  const state = {
    loading: false,
    manifest: null,
    summary: null,
    loadedOnce: false,
    loadedScope: '',
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

  function emptyCacheStats() {
    return { hits: 0, misses: 0, writes: 0, bytesReused: 0, bypassed: 0 };
  }

  const setStatus = (message, kind = '') => {
    const element = byId('privateCloudImportStatus');
    if (!element) return;
    element.textContent = message;
    element.dataset.kind = kind;
  };

  const setBusy = busy => {
    state.loading = busy;
    const loadButton = byId('btnPrivateCloudImport');
    const clearButton = byId('btnPrivateCloudLogout');
    if (loadButton) {
      loadButton.disabled = busy;
      loadButton.textContent = busy ? '正在加载私密仓库数据…' : '☁ 加载私有云数据';
    }
    if (clearButton) clearButton.disabled = busy;
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
    if (byId('privateCloudImportPanel')) return;
    const input = byId('fileInput');
    if (!input) return;
    if (!byId('privateCloudImportStyles')) {
      const style = document.createElement('style');
      style.id = 'privateCloudImportStyles';
      style.textContent = `
        #privateCloudImportPanel{display:grid;grid-template-columns:1fr;gap:7px;margin-top:8px;padding:9px;border:1px solid color-mix(in srgb,var(--accent) 22%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--accent) 5%,var(--input-bg))}
        #privateCloudImportPanel .privateCloudActions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}
        #privateCloudImportPanel .btn{justify-content:center;padding:8px 10px;border-radius:10px;font-size:11.2px;min-width:0}
        #privateCloudImportStatus{min-height:16px;line-height:1.4;word-break:break-word}
        #privateCloudImportStatus[data-kind="good"]{color:var(--good)}
        #privateCloudImportStatus[data-kind="warn"]{color:var(--warn)}
        #privateCloudImportStatus[data-kind="bad"]{color:var(--bad)}
        @media(max-width:420px){#privateCloudImportPanel .privateCloudActions{grid-template-columns:1fr}}
      `;
      document.head.appendChild(style);
    }
    const panel = document.createElement('div');
    panel.id = 'privateCloudImportPanel';
    panel.innerHTML = `
      <div class="privateCloudActions">
        <button class="btn primary" id="btnPrivateCloudImport" type="button">☁ 加载私有云数据</button>
        <button class="btn" id="btnPrivateCloudLogout" type="button" title="清除当前页面内存中的访问密码">清除密码</button>
      </div>
      <div class="small" id="privateCloudImportStatus">Amazon-Data-Warehouse · 未连接</div>
    `;
    input.insertAdjacentElement('afterend', panel);
  };

  const bindUi = () => {
    if (window.__WAREHOUSE_V4_UI_BOUND__) return;
    window.__WAREHOUSE_V4_UI_BOUND__ = true;
    document.addEventListener('click', event => {
      const target = event.target?.closest?.('#btnPrivateCloudImport, #btnPrivateCloudLogout');
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (target.id === 'btnPrivateCloudImport') {
        loadPrivateCloudData({ reason: 'manual' });
      } else {
        memoryCredential.clear();
        state.loadedOnce = false;
        state.loadedScope = '';
        setStatus('内存访问密码已清除；下次加载时需要重新输入', 'warn');
        notifyUser('私有云内存访问密码已清除。', 'good');
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
          if (responseType === 'blob') payload = await response.blob();
          else if (responseType === 'text') payload = await response.text();
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
    const detail = lastError?.name === 'AbortError' ? `单个文件请求超过 ${Math.round(Number(options.timeoutMs || 240000) / 60000)} 分钟` : (lastError?.message || '网络错误');
    const error = new Error(`无法连接私有云接口（已重试 ${maxAttempts} 次）：${detail}`);
    error.status = lastError?.status;
    error.path = path;
    throw error;
  };

  const apiFetchJson = async (path, password, options = {}) => (await requestApi(path, password, { ...options, responseType: 'json' })).payload;
  const extractRows = payload => Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.reports) ? payload.reports.flatMap(report => Array.isArray(report?.rows) ? report.rows : []) : [];

  const jsonPayloadToCsvFile = (payload, entry, scope) => {
    const rows = extractRows(payload);
    if (!rows.length) throw new Error(`${entry.month || entry.url} 没有可导入的数据行`);
    if (!window.Papa?.unparse) throw new Error('PapaParse 未加载，无法转换私有云数据');
    const csv = window.Papa.unparse(rows, { quotes: false, newline: '\r\n' });
    const baseName = String(entry.filename || entry.url || `${entry.dataType || 'data'}-${entry.month}.json`).split('/').pop().replace(/\.json(?:\?.*)?$/i, '.csv');
    const store = String(entry.storeId || entry.store || scope || 'ALL').toUpperCase();
    return new File([csv], `${store}__${baseName}`, { type: 'text/csv;charset=utf-8', lastModified: Date.now() });
  };

  const blobToCsvFile = (blob, entry, scope) => {
    if (!(blob instanceof Blob) || !blob.size) throw new Error(`${entry.filename || entry.url} 返回空文件`);
    const baseName = String(entry.filename || entry.url || `${entry.month}-${entry.reportType}.csv`).split('/').pop().split('?')[0];
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
      return { file: jsonPayloadToCsvFile(payload, entry, scope), rowCount: Number(entry.rowCount || extractRows(payload).length || 0), redacted: Boolean(entry.redacted), cache: 'bypass' };
    }

    const digest = immutableDigest(entry);
    const cached = digest ? await cacheGet(digest) : null;
    const headers = {};
    if (cached?.blob) headers['If-None-Match'] = `"${digest}"`;
    const result = await requestApi(url, password, { responseType: 'blob', headers, maxAttempts: 8, timeoutMs: 300000, retryBaseMs: 1500, retryMaxMs: 15000 });
    let blob = result.payload;
    let cacheState = 'miss';
    if (result.response.status === 304 && cached?.blob) {
      blob = cached.blob;
      cacheState = 'hit';
      state.cacheStats.hits += 1;
      state.cacheStats.bytesReused += Number(blob.size || 0);
    } else {
      state.cacheStats.misses += 1;
      const responseDigest = String(result.response.headers.get('X-Warehouse-Content-Sha') || '').replaceAll('"', '').toLowerCase();
      const contentVerified = result.response.headers.get('X-Warehouse-Content-Verified') === '1';
      if (digest && responseDigest === digest && contentVerified) {
        await cachePut(digest, blob, { rowCount: Number(result.response.headers.get('X-Warehouse-Row-Count') || entry.rowCount || 0), redacted: result.response.headers.get('X-Warehouse-Redacted') === '1' });
        state.cacheStats.writes += 1;
      } else {
        state.cacheStats.bypassed += 1;
        cacheState = 'bypass';
      }
    }
    return {
      file: blobToCsvFile(blob, entry, scope),
      rowCount: Number(result.response.headers.get('X-Warehouse-Row-Count') || cached?.rowCount || entry.rowCount || 0),
      redacted: result.response.status === 304 ? Boolean(cached?.redacted ?? entry.redacted) : result.response.headers.get('X-Warehouse-Redacted') === '1',
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

  const loadPrivateCloudData = async ({ reason = 'manual' } = {}) => {
    if (state.loading) return;
    ensureUi();
    setBusy(true);
    state.cacheStats = emptyCacheStats();
    let password = memoryCredential.get();
    if (!password && reason !== 'shop-change') password = requestPassword();
    if (!password) {
      setBusy(false);
      setStatus(reason === 'shop-change' ? '店铺已切换；点击“加载私有云数据”并输入密码' : '已取消私有云数据加载', 'warn');
      return;
    }

    const scope = activeScope();
    try {
      setStatus(`正在连接 Amazon-Data-Warehouse · ${displayScope(scope)}…`);
      const health = await apiFetchJson('/health', password);
      if (!health?.ok) throw new Error('私有接口健康检查失败');
      if (health?.service !== 'amazon-data-warehouse' || !/^4\./.test(String(health?.version || ''))) throw new Error('私密仓库接口版本不兼容：生产页面只接受 V4');
      state.apiVersion = String(health.version || '4');
      state.storage = String(health.storage || 'unknown');
      state.summary = await apiFetchJson(`/summary?scope=${encodeURIComponent(scope)}`, password, { optional: true }).catch(() => null);
      if (state.summary?.totals) setStatus(`已连接 ${displayScope(scope)} · ${Number(state.summary.totals.fileCount || 0)} 个文件 · ${Number(state.summary.totals.rowCount || 0).toLocaleString()} 行，正在读取清单…`);
      else setStatus(`正在扫描 ${displayScope(scope)} 店铺文件清单…`);

      const manifest = await apiFetchJson(`/manifest?scope=${encodeURIComponent(scope)}`, password);
      const entries = Array.isArray(manifest?.files) ? manifest.files.filter(isImportableEntry) : [];
      if (!entries.length) throw new Error(`${displayScope(scope)} 当前没有可加载的广告、联合交易或业务报表`);
      state.manifest = manifest;
      memoryCredential.set(password);

      const cloudImporter = window.__LR_IMPORT_MULTIPLE_FILES__;
      if (typeof cloudImporter !== 'function') throw new Error('网页导入桥接未初始化，请强制刷新页面后重试');
      const directImporter = window.__LR_IMPORT_TRANSACTION_FILE__;
      const mergeSelect = byId('mergeMode');
      const previousMerge = mergeSelect?.value || 'append';
      const batchCount = Math.ceil(entries.length / BATCH_SIZE);
      let fetchedRows = 0;
      let redactedFiles = 0;
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
              setStatus(`正在下载与校验文件（${completedDownloads}/${entries.length}）· 第 ${batchNumber}/${batchCount} 批…`);
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
          loadedItems.forEach(item => { fetchedRows += Number(item.rowCount || 0); if (item.redacted) redactedFiles += 1; });
          if (mergeSelect) mergeSelect.value = firstBatch ? 'replace' : 'append';
          setStatus(`已下载 ${completedDownloads}/${entries.length} 个文件，正在导入第 ${batchNumber}/${batchCount} 批…`);
          const isFinalBatch = batchStart + batchEntries.length >= entries.length;
          const importSummary = await cloudImporter(batchFiles, { deferFinalize: !isFinalBatch, preserveLog: !firstBatch, cloudBatchNumber: batchNumber, cloudBatchCount: batchCount });
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
          const batchQuarantine = (importSummary?.quarantine || []).flatMap(item => item.reasons || []).slice(0, 2).join('；');
          if ((batchExpectsAds && !batchAds) || (batchExpectsTransactions && !batchTransactions)) {
            const missingType = batchExpectsAds && !batchAds ? '广告数据' : '联合交易数据';
            throw new Error(`第 ${batchNumber}/${batchCount} 批未写入${missingType}${batchQuarantine ? `：${batchQuarantine}` : ''}`);
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
      const quarantineText = quarantineItems.flatMap(item => (item.reasons || []).map(reason => `${item.fileName || item.reportType}: ${reason}`)).slice(0, 3).join('；');
      if (!importedRows || (expectsAds && !adsRows) || (expectsTransactions && !transactionRows)) {
        const missingType = expectsAds && !adsRows ? '广告数据' : expectsTransactions && !transactionRows ? '联合交易数据' : '报表数据';
        throw new Error(`报表已下载，但网页分析库未写入${missingType}${quarantineText ? `：${quarantineText}` : '；请检查报表字段映射与日期格式'}`);
      }

      let costSummary = null;
      let costWarning = '';
      const costEntry = (manifest?.files || []).find(entry => normalizeDataType(entry?.dataType) === 'productcosts') || manifest?.productCosts || null;
      if (costEntry?.url) {
        try {
          setStatus('报表已导入，正在读取商品成本库…');
          const costPayload = await apiFetchJson(costEntry.url, password);
          const costImporter = window.__LR_IMPORT_PRODUCT_COSTS__;
          if (typeof costImporter !== 'function') throw new Error('商品成本导入桥接未初始化');
          costSummary = await costImporter(costPayload);
        } catch (costError) {
          console.warn('Product cost library load failed:', costError);
          costWarning = costError?.message || String(costError);
        }
      }

      const totalRows = Number(manifest?.totalRows || state.summary?.totals?.rowCount || fetchedRows || importedRows || 0);
      const costRows = Number(costSummary?.rowCount || 0);
      const months = Array.isArray(manifest?.months) ? manifest.months : [...new Set(entries.map(entry => entry.month).filter(Boolean))].sort();
      const monthText = months.length ? `${months[0]}${months.length > 1 ? ` → ${months[months.length - 1]}` : ''}` : '月份未标记';
      const cacheText = state.cacheStats.hits ? ` · 缓存复用 ${state.cacheStats.hits} 个` : '';
      const storageText = state.storage === 'tidb-primary' ? ' · TiDB 主数据源' : ` · ${state.storage || '未知数据源'}`;
      const statusText = `${displayScope(scope)} 私密仓库已加载：${totalRows.toLocaleString()} 行 · ${entries.length} 个文件 · ${monthText}${redactedFiles ? ` · ${redactedFiles} 个联合报告已脱敏` : ''}${storageText}${cacheText}${costRows ? ` · 成本库 ${costRows.toLocaleString()} SKU` : ''}`;
      state.loadedOnce = true;
      state.loadedScope = scope;
      document.documentElement.dataset.loadedShopScope = scope;
      setStatus(statusText, costWarning ? 'warn' : 'good');
      const brand = byId('brandStatus');
      if (brand) brand.textContent = `系统就绪 · ${displayScope(scope)} 私密仓库 ${totalRows.toLocaleString()} 行`;
      window.dispatchEvent(new CustomEvent('lr:cloud-loaded', { detail: { scope, files: entries.length, rows: totalRows, months, redactedFiles, apiVersion: state.apiVersion, storage: state.storage, summary: state.summary, queryStatus: state.queryStatus, cacheStats: { ...state.cacheStats } } }));
      notifyUser(costWarning ? `${statusText}；${costWarning}` : statusText, costWarning ? 'warn' : 'good');
    } catch (error) {
      console.error('Private warehouse import failed:', error);
      if ([401, 403].includes(Number(error?.status || 0))) memoryCredential.clear();
      const detail = String(error?.message || error || '未知错误');
      setStatus(`私有云加载失败：${detail}`, 'bad');
      notifyUser(`私有云加载失败：${detail}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const ensureQueryClient = () => {
    if (window.PrivateCloudQuery || window.__WAREHOUSE_QUERY_CLIENT_LOADING__) return;
    window.__WAREHOUSE_QUERY_CLIENT_LOADING__ = true;
    const script = document.createElement('script');
    script.src = new URL('./private-cloud-query-v1.js', SCRIPT_URL).href;
    script.async = true;
    script.dataset.warehouseQueryClient = 'v1';
    script.onload = () => {
      window.__WAREHOUSE_QUERY_CLIENT_LOADING__ = false;
      if (memoryCredential.get() && state.loadedOnce) {
        window.PrivateCloudQuery?.refresh?.({ scope: activeScope() }).then(result => {
          state.queryStatus = result?.status || null;
        }).catch(error => console.warn('TiDB query status refresh skipped:', error));
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
      const error = new Error('私有云内存访问密码不存在，请先加载私有云数据');
      error.status = 401;
      throw error;
    }
    return requestApi(path, password, { ...options, responseType: 'json' });
  };

  const scheduleScopeReload = () => {
    clearTimeout(state.autoReloadTimer);
    if (!state.loadedOnce || !memoryCredential.get()) return;
    state.autoReloadTimer = setTimeout(() => loadPrivateCloudData({ reason: 'shop-change' }), 250);
  };

  const installApi = () => {
    ensureUi();
    bindUi();
    ensureQueryClient();
    window.__WAREHOUSE_V4_LOADER_VERSION__ = LOADER_VERSION;
    window.PrivateCloudAds = {
      load: options => loadPrivateCloudData(options || {}),
      reload: () => loadPrivateCloudData({ reason: 'shop-change' }),
      setPassword: value => memoryCredential.set(value),
      clearPassword: () => memoryCredential.clear(),
      clearCache: clearFileCache,
      queryRequest,
      query: () => window.PrivateCloudQuery || null,
      apiBase: API_ORIGIN,
      channel: () => CHANNEL,
      state: () => ({ loading: state.loading, loadedOnce: state.loadedOnce, loadedScope: state.loadedScope, apiVersion: state.apiVersion, storage: state.storage, queryStatus: state.queryStatus, credentialAccepted: Boolean(memoryCredential.get()), manifest: state.manifest, summary: state.summary, cacheStats: { ...state.cacheStats }, loaderVersion: LOADER_VERSION }),
    };
    if (memoryCredential.get() && !state.loading && !state.loadedOnce) setStatus(`访问密码仅保存在当前页面内存中；点击加载 ${displayScope(activeScope())} 私密仓库数据`);
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
        if (!database.objectStoreNames.contains(CACHE_STORE)) database.createObjectStore(CACHE_STORE, { keyPath: 'digest' });
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
