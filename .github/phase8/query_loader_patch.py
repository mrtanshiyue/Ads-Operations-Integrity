from pathlib import Path

path = Path("assets/private-cloud-warehouse-v4.js")
text = path.read_text(encoding="utf-8")
replacements = [
    (
        "  'use strict';\n\n  const API_ORIGIN",
        "  'use strict';\n\n  const SCRIPT_URL = document.currentScript?.src || new URL('assets/private-cloud-warehouse-v4.js', window.location.href).href;\n  const API_ORIGIN",
    ),
    ("  const LOADER_VERSION = '4.1.0';", "  const LOADER_VERSION = '4.2.0';"),
    (
        "    apiVersion: '',\n    autoReloadTimer: null,",
        "    apiVersion: '',\n    storage: 'unknown',\n    queryStatus: null,\n    autoReloadTimer: null,",
    ),
    (
        "      state.apiVersion = String(health.version || '4');",
        "      state.apiVersion = String(health.version || '4');\n      state.storage = String(health.storage || 'unknown');",
    ),
    (
        "      const cacheText = state.cacheStats.hits ? ` · 缓存复用 ${state.cacheStats.hits} 个` : '';\n      const statusText = `${displayScope(scope)} 私密仓库已加载：",
        "      const cacheText = state.cacheStats.hits ? ` · 缓存复用 ${state.cacheStats.hits} 个` : '';\n      const storageText = state.storage === 'tidb-primary' ? ' · TiDB 主数据源' : ` · ${state.storage || '未知数据源'}`;\n      const statusText = `${displayScope(scope)} 私密仓库已加载：",
    ),
    (
        "${redactedFiles ? ` · ${redactedFiles} 个联合报告已脱敏` : ''}${cacheText}${costRows ? ` · 成本库 ${costRows.toLocaleString()} SKU` : ''}`;",
        "${redactedFiles ? ` · ${redactedFiles} 个联合报告已脱敏` : ''}${storageText}${cacheText}${costRows ? ` · 成本库 ${costRows.toLocaleString()} SKU` : ''}`;",
    ),
    (
        "window.dispatchEvent(new CustomEvent('lr:cloud-loaded', { detail: { scope, files: entries.length, rows: totalRows, months, redactedFiles, apiVersion: state.apiVersion, summary: state.summary, cacheStats: { ...state.cacheStats } } }));",
        "window.dispatchEvent(new CustomEvent('lr:cloud-loaded', { detail: { scope, files: entries.length, rows: totalRows, months, redactedFiles, apiVersion: state.apiVersion, storage: state.storage, summary: state.summary, queryStatus: state.queryStatus, cacheStats: { ...state.cacheStats } } }));",
    ),
]
for old, new in replacements:
    if text.count(old) != 1:
        raise SystemExit(f"loader anchor count {text.count(old)}: {old[:100]}")
    text = text.replace(old, new, 1)

schedule_anchor = """  const scheduleScopeReload = () => {
"""
query_function = """  const ensureQueryClient = () => {
    if (window.PrivateCloudQuery || window.__WAREHOUSE_QUERY_CLIENT_LOADING__) return;
    window.__WAREHOUSE_QUERY_CLIENT_LOADING__ = true;
    const script = document.createElement('script');
    script.src = new URL('./private-cloud-query-v1.js', SCRIPT_URL).href;
    script.async = true;
    script.dataset.warehouseQueryClient = 'v1';
    script.onload = () => {
      window.__WAREHOUSE_QUERY_CLIENT_LOADING__ = false;
      if (sessionSafe.get(SESSION_KEY)) {
        window.PrivateCloudQuery?.status?.({ scope: activeScope() }).then(status => {
          state.queryStatus = status;
        }).catch(error => console.warn('TiDB query status refresh skipped:', error));
      }
    };
    script.onerror = () => {
      window.__WAREHOUSE_QUERY_CLIENT_LOADING__ = false;
      console.warn('TiDB query client failed to load');
    };
    document.head.appendChild(script);
  };

"""
if text.count(schedule_anchor) != 1:
    raise SystemExit("schedule anchor not found exactly once")
text = text.replace(schedule_anchor, query_function + schedule_anchor, 1)

install_anchor = """  const installApi = () => {
    ensureUi();
    bindUi();
"""
install_new = """  const installApi = () => {
    ensureUi();
    bindUi();
    ensureQueryClient();
"""
if text.count(install_anchor) != 1:
    raise SystemExit("install API anchor not found exactly once")
text = text.replace(install_anchor, install_new, 1)

state_anchor = """      state: () => ({ loading: state.loading, loadedOnce: state.loadedOnce, loadedScope: state.loadedScope, apiVersion: state.apiVersion, manifest: state.manifest, summary: state.summary, cacheStats: { ...state.cacheStats }, loaderVersion: LOADER_VERSION }),
"""
state_new = """      query: () => window.PrivateCloudQuery || null,
      state: () => ({ loading: state.loading, loadedOnce: state.loadedOnce, loadedScope: state.loadedScope, apiVersion: state.apiVersion, storage: state.storage, manifest: state.manifest, summary: state.summary, queryStatus: state.queryStatus, cacheStats: { ...state.cacheStats }, loaderVersion: LOADER_VERSION }),
"""
if text.count(state_anchor) != 1:
    raise SystemExit("state API anchor not found exactly once")
text = text.replace(state_anchor, state_new, 1)
path.write_text(text, encoding="utf-8")
