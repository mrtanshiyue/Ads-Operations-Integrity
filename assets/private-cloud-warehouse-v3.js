(() => {
  'use strict';

  const API_ORIGIN = 'https://amazon-ad-private-api-v2.tanshiyuesir.workers.dev';
  const SESSION_KEY = 'lr_private_cloud_password';
  const IMPORTABLE_DATA_TYPES = new Set(['ads', 'transactions', 'business']);
  const state = {
    loading: false,
    manifest: null,
    loadedOnce: false,
    loadedScope: '',
    apiVersion: '',
    autoReloadTimer: null,
  };

  const byId = id => document.getElementById(id);
  const sessionSafe = {
    get: key => { try { return sessionStorage.getItem(key) || ''; } catch (_) { return ''; } },
    set: (key, value) => { try { sessionStorage.setItem(key, value); return true; } catch (_) { return false; } },
    remove: key => { try { sessionStorage.removeItem(key); } catch (_) {} },
  };
  const sleepFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  const normalizeScope = value => {
    const scope = String(value || '').trim().toUpperCase();
    return ['ALL', 'YTDBNS', 'YY', 'JJ'].includes(scope) ? scope : 'ALL';
  };
  const activeScope = () => normalizeScope(window.ShopScope?.get?.() || window.ACTIVE_SHOP || 'ALL');

  const setStatus = (message, kind = '') => {
    const el = byId('privateCloudImportStatus');
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind;
  };

  const setBusy = busy => {
    state.loading = busy;
    const loadBtn = byId('btnPrivateCloudImport');
    const clearBtn = byId('btnPrivateCloudLogout');
    if (loadBtn) {
      loadBtn.disabled = busy;
      loadBtn.textContent = busy ? '正在加载私密仓库数据…' : '☁ 加载私有云数据';
    }
    if (clearBtn) clearBtn.disabled = busy;
    document.querySelectorAll('#privateCloudImportPanel [data-shop]').forEach(button => {
      button.disabled = busy;
    });
  };

  const notifyUser = (message, kind = 'good') => {
    try {
      if (typeof notify === 'function') notify(message, kind);
      else console.info(message);
    } catch (_) {
      console.info(message);
    }
  };

  const ensureUi = () => {
    if (byId('privateCloudImportPanel')) return;
    const input = byId('fileInput');
    if (!input) return;

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

    const panel = document.createElement('div');
    panel.id = 'privateCloudImportPanel';
    panel.innerHTML = `
      <div class="privateCloudActions">
        <button class="btn primary" id="btnPrivateCloudImport" type="button">☁ 加载私有云数据</button>
        <button class="btn" id="btnPrivateCloudLogout" type="button" title="清除当前标签页保存的访问密码">清除密码</button>
      </div>
      <div class="small" id="privateCloudImportStatus">Amazon-Data-Warehouse · 未连接</div>
    `;
    input.insertAdjacentElement('afterend', panel);

    byId('btnPrivateCloudImport')?.addEventListener('click', () => loadPrivateCloudData({ reason: 'manual' }));
    byId('btnPrivateCloudLogout')?.addEventListener('click', () => {
      sessionSafe.remove(SESSION_KEY);
      state.loadedOnce = false;
      state.loadedScope = '';
      setStatus('会话密码已清除；下次加载时需要重新输入', 'warn');
      notifyUser('私有云会话密码已清除。', 'good');
    });
  };

  const requestPassword = () => {
    const password = window.prompt('请输入私密仓库网页登录密码');
    return typeof password === 'string' ? password.trim() : '';
  };

  const normalizeApiTarget = input => {
    const raw = String(input || '').trim();
    const parsed = new URL(raw || '/', window.location.origin);
    let pathname = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
    pathname = pathname.replace(/\/{2,}/g, '/');
    pathname = pathname.replace(/^(?:\/api\/v1)+/i, '/api/v1');
    if (!pathname.startsWith('/api/v1/')) pathname = `/api/v1${pathname}`;
    return `${pathname}${parsed.search || ''}`;
  };

  const requestApi = async (target, password, responseType = 'json') => {
    const path = normalizeApiTarget(target);
    let response;
    try {
      response = await fetch(`${API_ORIGIN}${path}`, {
        method: 'GET',
        headers: { 'X-Dashboard-Password': password },
        cache: 'no-store',
      });
    } catch (networkError) {
      const error = new Error(`无法连接私有云接口：${networkError?.message || '网络错误'}`);
      error.path = path;
      throw error;
    }

    const text = await response.text();
    let payload = null;
    if (responseType === 'json') {
      try { payload = text ? JSON.parse(text) : null; } catch (_) {}
    }
    if (!response.ok) {
      const detail = payload?.error || text || `HTTP ${response.status}`;
      const error = new Error(`${detail} · ${path}`);
      error.status = response.status;
      error.path = path;
      throw error;
    }
    return {
      payload: responseType === 'json' ? payload : text,
      response,
      path,
    };
  };

  const apiFetchJson = async (path, password) => (await requestApi(path, password, 'json')).payload;
  const apiFetchText = async (path, password) => requestApi(path, password, 'text');

  const extractRows = payload => {
    if (Array.isArray(payload?.rows)) return payload.rows;
    if (Array.isArray(payload?.reports)) {
      return payload.reports.flatMap(report => Array.isArray(report?.rows) ? report.rows : []);
    }
    return [];
  };

  const jsonPayloadToCsvFile = (payload, entry, scope) => {
    const rows = extractRows(payload);
    if (!rows.length) throw new Error(`${entry.month || entry.url} 没有可导入的数据行`);
    if (!window.Papa?.unparse) throw new Error('PapaParse 未加载，无法转换私有云数据');
    const csv = window.Papa.unparse(rows, { quotes: false, newline: '\r\n' });
    const baseName = String(entry.filename || entry.url || `${entry.dataType || 'data'}-${entry.month}.json`)
      .split('/').pop().replace(/\.json(?:\?.*)?$/i, '.csv');
    const store = String(entry.storeId || entry.store || scope || 'ALL').toUpperCase();
    return new File([csv], `${store}__${baseName}`, { type: 'text/csv;charset=utf-8', lastModified: Date.now() });
  };

  const rawTextToCsvFile = (text, entry, scope) => {
    if (!String(text || '').trim()) throw new Error(`${entry.filename || entry.url} 返回空文件`);
    const baseName = String(entry.filename || entry.url || `${entry.month}-${entry.reportType}.csv`).split('/').pop().split('?')[0];
    const store = String(entry.storeId || entry.store || scope || 'ALL').toUpperCase();
    return new File([text], `${store}__${baseName}`, { type: 'text/csv;charset=utf-8', lastModified: Date.now() });
  };

  const isImportableEntry = entry => {
    const dataType = String(entry?.dataType || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    const reportType = String(entry?.reportType || '').trim().toLowerCase();
    const url = String(entry?.url || '');
    if (IMPORTABLE_DATA_TYPES.has(dataType)) return true;
    if (/^(advertising-report|combined-report|business-report|ads-search-term|ads-targeting|ads-campaign|ads-advertised-product|ads-placement)$/.test(reportType)) return true;
    return /(?:advertising|combined|business|ads|transactions)-report|(?:ads|transactions)-\d{4}-\d{2}\.json/i.test(url);
  };

  const fetchManifestEntry = async (entry, password, scope) => {
    const url = String(entry?.url || '').trim();
    if (!url) throw new Error('数据清单中存在缺少 URL 的文件');
    const expectsJson = /\.json(?:$|\?)/i.test(url) || entry?.format === 'json';
    if (expectsJson) {
      const payload = await apiFetchJson(url, password);
      return {
        file: jsonPayloadToCsvFile(payload, entry, scope),
        rowCount: Number(entry.rowCount || extractRows(payload).length || 0),
        redacted: Boolean(entry.redacted),
      };
    }
    const result = await apiFetchText(url, password);
    return {
      file: rawTextToCsvFile(result.payload, entry, scope),
      rowCount: Number(result.response.headers.get('X-Warehouse-Row-Count') || entry.rowCount || 0),
      redacted: result.response.headers.get('X-Warehouse-Redacted') === '1',
    };
  };

  const loadPrivateCloudData = async ({ reason = 'manual' } = {}) => {
    if (state.loading) return;
    ensureUi();
    setBusy(true);

    let password = sessionSafe.get(SESSION_KEY);
    if (!password && reason !== 'shop-change') password = requestPassword();
    if (!password) {
      setBusy(false);
      setStatus(reason === 'shop-change' ? '店铺已切换；点击“加载私有云数据”并输入密码' : '已取消私有云数据加载', 'warn');
      return;
    }

    const scope = activeScope();
    try {
      setStatus(`正在连接 Amazon-Data-Warehouse · ${scope}…`);
      const health = await apiFetchJson('/health', password);
      if (!health?.ok) throw new Error('私有接口健康检查失败');
      if (health?.service !== 'amazon-data-warehouse' || !String(health?.version || '').startsWith('3.')) {
        throw new Error('Cloudflare Worker 尚未升级到私密仓库 V3 接口');
      }
      state.apiVersion = String(health.version || '3');

      setStatus(`正在扫描 ${scope} 店铺文件清单…`);
      const manifest = await apiFetchJson(`/manifest?scope=${encodeURIComponent(scope)}`, password);
      const entries = Array.isArray(manifest?.files) ? manifest.files.filter(isImportableEntry) : [];
      if (!entries.length) throw new Error(`${scope} 当前没有可加载的广告、联合交易或业务报表`);
      state.manifest = manifest;
      sessionSafe.set(SESSION_KEY, password);

      const csvFiles = [];
      let fetchedRows = 0;
      let redactedFiles = 0;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const label = `${entry.storeId || scope} · ${entry.month || entry.filename || index + 1}`;
        setStatus(`正在下载 ${label}（${index + 1}/${entries.length}）…`);
        const loaded = await fetchManifestEntry(entry, password, scope);
        csvFiles.push(loaded.file);
        fetchedRows += Number(loaded.rowCount || 0);
        if (loaded.redacted) redactedFiles += 1;
        await sleepFrame();
      }

      const cloudImporter = window.__LR_IMPORT_MULTIPLE_FILES__;
      if (typeof cloudImporter !== 'function') {
        throw new Error('网页导入桥接未初始化，请强制刷新页面后重试');
      }

      const mergeSelect = byId('mergeMode');
      const previousMerge = mergeSelect?.value || 'append';
      if (mergeSelect) mergeSelect.value = 'replace';
      setStatus(`已下载 ${entries.length} 个文件，正在按 ${scope} 范围建立分析索引…`);
      let importSummary = null;
      try {
        importSummary = await cloudImporter(csvFiles);
      } finally {
        if (mergeSelect) mergeSelect.value = previousMerge;
      }
      const importedRows = Number(importSummary?.acceptedRows || 0);
      const adsRows = Number(importSummary?.adsRows || 0);
      const transactionRows = Number(importSummary?.transactionRows || 0);
      const quarantineText = (importSummary?.quarantine || [])
        .flatMap(item => (item.reasons || []).map(reason => `${item.fileName || item.reportType}: ${reason}`))
        .slice(0, 3)
        .join('；');
      const expectsAds = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'ads');
      if (!importedRows || (expectsAds && !adsRows)) {
        throw new Error(`报表已下载，但网页分析库未写入广告数据${quarantineText ? `：${quarantineText}` : '；请检查报表字段映射'}`);
      }

      let costSummary = null;
      let costWarning = '';
      const costEntry = (manifest?.files || []).find(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'productcosts') || manifest?.productCosts || null;
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

      const totalRows = Number(importedRows || fetchedRows || manifest?.totalRows || 0);
      const costRows = Number(costSummary?.rowCount || 0);
      const months = Array.isArray(manifest?.months) ? manifest.months : [...new Set(entries.map(entry => entry.month).filter(Boolean))].sort();
      const monthText = months.length ? `${months[0]}${months.length > 1 ? ` → ${months[months.length - 1]}` : ''}` : '月份未标记';
      const statusText = `${scope} 私密仓库已加载：${totalRows.toLocaleString()} 行 · ${entries.length} 个文件 · ${monthText}${redactedFiles ? ` · ${redactedFiles} 个联合报告已脱敏` : ''}${costRows ? ` · 成本库 ${costRows.toLocaleString()} SKU` : ''}`;
      state.loadedOnce = true;
      state.loadedScope = scope;
      document.documentElement.dataset.loadedShopScope = scope;
      setStatus(statusText, costWarning ? 'warn' : 'good');
      const brand = byId('brandStatus');
      if (brand) brand.textContent = `系统就绪 · ${scope} 私密仓库 ${totalRows.toLocaleString()} 行`;
      window.dispatchEvent(new CustomEvent('lr:cloud-loaded', {
        detail: { scope, files: entries.length, rows: totalRows, months, redactedFiles, apiVersion: state.apiVersion },
      }));
      notifyUser(costWarning ? `${statusText}；${costWarning}` : statusText, costWarning ? 'warn' : 'good');
    } catch (error) {
      console.error('Private warehouse import failed:', error);
      if (error?.status === 401) sessionSafe.remove(SESSION_KEY);
      const message = error?.status === 401
        ? '网页登录密码错误，请清除密码后重新加载'
        : error?.status === 403
          ? '当前网页来源未被 Worker 授权'
          : error?.status === 502
            ? 'Worker 无法读取 GitHub 私密仓库，请检查 WAREHOUSE_GITHUB_TOKEN'
            : (error?.message || String(error));
      setStatus(message, 'bad');
      notifyUser(message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const scheduleScopeReload = event => {
    const scope = normalizeScope(event?.detail?.shop || activeScope());
    if (state.autoReloadTimer) clearTimeout(state.autoReloadTimer);
    if (!state.loadedOnce || !sessionSafe.get(SESSION_KEY)) {
      setStatus(`已切换到 ${scope}；点击“加载私有云数据”读取该店铺`, 'warn');
      return;
    }
    setStatus(`正在切换云端数据到 ${scope}…`);
    state.autoReloadTimer = setTimeout(() => loadPrivateCloudData({ reason: 'shop-change' }), 220);
  };

  const init = () => {
    ensureUi();
    if (sessionSafe.get(SESSION_KEY)) {
      setStatus(`已保存当前标签页会话密码；点击加载 ${activeScope()} 私密仓库数据`);
    }
    window.addEventListener('lr:shop-change', scheduleScopeReload);
    window.PrivateCloudAds = {
      load: options => loadPrivateCloudData(options || {}),
      reload: () => loadPrivateCloudData({ reason: 'shop-change' }),
      clearPassword: () => sessionSafe.remove(SESSION_KEY),
      apiBase: API_ORIGIN,
      channel: () => 'warehouse-v3',
      state: () => ({
        loading: state.loading,
        loadedOnce: state.loadedOnce,
        loadedScope: state.loadedScope,
        apiVersion: state.apiVersion,
        manifest: state.manifest,
      }),
    };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
