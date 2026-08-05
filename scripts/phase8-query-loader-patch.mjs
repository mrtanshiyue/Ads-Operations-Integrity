import { readFileSync, writeFileSync } from 'node:fs';

const path = 'assets/private-cloud-warehouse-v4.js';
let source = readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  "  'use strict';\n\n  const API_ORIGIN",
  "  'use strict';\n\n  const SCRIPT_URL = document.currentScript?.src || new URL('assets/private-cloud-warehouse-v4.js', window.location.href).href;\n  const API_ORIGIN",
  'script URL',
);
replaceOnce("  const LOADER_VERSION = '4.1.1';", "  const LOADER_VERSION = '4.2.0';", 'loader version');
replaceOnce(
  "    apiVersion: '',\n    autoReloadTimer:",
  "    apiVersion: '',\n    storage: 'unknown',\n    queryStatus: null,\n    autoReloadTimer:",
  'query state',
);
replaceOnce(
  "      state.apiVersion = String(health.version || '4');\n      state.summary",
  "      state.apiVersion = String(health.version || '4');\n      state.storage = String(health.storage || 'unknown');\n      state.summary",
  'health storage',
);
replaceOnce(
  "      const statusText = `${displayScope(scope)} 私密仓库已加载：${totalRows.toLocaleString()} 行 · ${entries.length} 个文件 · ${monthText}${redactedFiles ? ` · ${redactedFiles} 个联合报告已脱敏` : ''}${cacheText}${costRows ? ` · 成本库 ${costRows.toLocaleString()} SKU` : ''}`;",
  "      const storageText = state.storage === 'tidb-primary' ? ' · TiDB 主数据源' : ` · ${state.storage || '未知数据源'}`;\n      const statusText = `${displayScope(scope)} 私密仓库已加载：${totalRows.toLocaleString()} 行 · ${entries.length} 个文件 · ${monthText}${redactedFiles ? ` · ${redactedFiles} 个联合报告已脱敏` : ''}${storageText}${cacheText}${costRows ? ` · 成本库 ${costRows.toLocaleString()} SKU` : ''}`;",
  'storage status',
);
replaceOnce(
  "      window.dispatchEvent(new CustomEvent('lr:cloud-loaded', { detail: { scope, files: entries.length, rows: totalRows, months, redactedFiles, apiVersion: state.apiVersion, summary: state.summary, cacheStats: { ...state.cacheStats } } }));",
  "      window.dispatchEvent(new CustomEvent('lr:cloud-loaded', { detail: { scope, files: entries.length, rows: totalRows, months, redactedFiles, apiVersion: state.apiVersion, storage: state.storage, summary: state.summary, queryStatus: state.queryStatus, cacheStats: { ...state.cacheStats } } }));",
  'cloud loaded detail',
);
replaceOnce(
  "  const scheduleScopeReload = () => {",
  `  const ensureQueryClient = () => {
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

  const scheduleScopeReload = () => {`,
  'query client bridge',
);
replaceOnce(
  "    bindUi();\n    window.__WAREHOUSE_V4_LOADER_VERSION__",
  "    bindUi();\n    ensureQueryClient();\n    window.__WAREHOUSE_V4_LOADER_VERSION__",
  'query client install',
);
replaceOnce(
  "      clearCache: clearFileCache,\n      apiBase: API_ORIGIN,\n      channel: () => CHANNEL,\n      state: () => ({ loading: state.loading, loadedOnce: state.loadedOnce, loadedScope: state.loadedScope, apiVersion: state.apiVersion, manifest: state.manifest, summary: state.summary, cacheStats: { ...state.cacheStats }, loaderVersion: LOADER_VERSION }),",
  "      clearCache: clearFileCache,\n      queryRequest,\n      query: () => window.PrivateCloudQuery || null,\n      apiBase: API_ORIGIN,\n      channel: () => CHANNEL,\n      state: () => ({ loading: state.loading, loadedOnce: state.loadedOnce, loadedScope: state.loadedScope, apiVersion: state.apiVersion, storage: state.storage, queryStatus: state.queryStatus, credentialAccepted: Boolean(memoryCredential.get()), manifest: state.manifest, summary: state.summary, cacheStats: { ...state.cacheStats }, loaderVersion: LOADER_VERSION }),",
  'public bridge API',
);

if (/lr_private_cloud_password|sessionStorage|const sessionSafe/.test(source)) {
  throw new Error('Persistent credential pattern detected after patch');
}
writeFileSync(path, source, 'utf8');
