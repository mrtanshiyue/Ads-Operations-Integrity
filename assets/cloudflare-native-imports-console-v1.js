(function initCloudflareNativeImportsConsole(global) {
  'use strict';

  const VERSION = '1.0.0';
  const MAX_BYTES = 10 * 1024 * 1024;
  const state = {
    mounted: false,
    open: false,
    loading: false,
    uploading: false,
    storeId: '',
    canRead: false,
    canWrite: false,
    items: [],
    selectedImportId: '',
    detail: null,
    errors: [],
    message: null,
    root: null,
  };

  const api = Object.freeze({
    version: VERSION,
    open,
    close,
    refresh,
    currentStoreId: () => state.storeId,
  });
  Object.defineProperty(global, 'CloudflareImportsConsole', {
    value: api,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (!global.document) return;
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  function mount() {
    if (state.mounted || !global.document?.body) return;
    state.mounted = true;
    installStyles();
    const root = global.document.createElement('section');
    root.id = 'cfImportsPanel';
    root.className = 'cfImportsPanel';
    root.hidden = true;
    root.setAttribute('aria-label', 'CSV Imports');
    root.innerHTML = shellMarkup();
    global.document.body.appendChild(root);
    state.root = root;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
    global.addEventListener?.('cloudflare-operator-store-change', onStoreChange);
    const observer = new MutationObserver(() => ensureNavigation());
    observer.observe(global.document.body, { childList: true, subtree: true });
    global.setInterval?.(ensureNavigation, 2000);
    syncStoreFromWorkspace();
    void refreshPermissions().finally(ensureNavigation);
    ensureNavigation();
  }

  async function open() {
    if (!state.mounted) mount();
    syncStoreFromWorkspace();
    state.open = true;
    if (state.root) state.root.hidden = false;
    render();
    await refreshPermissions();
    await refresh();
    return true;
  }

  function close() {
    state.open = false;
    if (state.root) state.root.hidden = true;
  }

  async function refresh() {
    if (!state.storeId || !state.canRead || state.loading) return;
    state.loading = true;
    state.message = null;
    render();
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(state.storeId)}/imports?limit=50`);
      state.items = Array.isArray(payload?.items) ? payload.items : [];
      if (state.selectedImportId && !state.items.some((item) => item.importId === state.selectedImportId)) {
        state.selectedImportId = '';
        state.detail = null;
        state.errors = [];
      }
    } catch (error) {
      state.message = messageFromError(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function refreshPermissions() {
    syncStoreFromWorkspace();
    state.canRead = false;
    state.canWrite = false;
    if (!state.storeId || !global.CloudflareNativeAPI?.capabilities) {
      ensureNavigation();
      render();
      return;
    }
    try {
      const capabilities = await global.CloudflareNativeAPI.capabilities();
      const globalPermissions = new Set(Array.isArray(capabilities?.globalPermissions) ? capabilities.globalPermissions : []);
      const scoped = new Set(Array.isArray(capabilities?.storePermissions?.[state.storeId]) ? capabilities.storePermissions[state.storeId] : []);
      state.canRead = globalPermissions.has('ads.read') || scoped.has('ads.read') || globalPermissions.has('ads.write') || scoped.has('ads.write');
      state.canWrite = globalPermissions.has('ads.write') || scoped.has('ads.write');
    } catch {
      state.canRead = false;
      state.canWrite = false;
    }
    ensureNavigation();
    render();
  }

  function ensureNavigation() {
    const items = global.document?.querySelector('#cfOperatorWorkspace .cfOperatorGroup[data-group="operations"] .cfOperatorGroupItems');
    if (!items) return;
    let button = items.querySelector('[data-csv-import-nav]');
    if (!state.canRead) {
      button?.remove();
      return;
    }
    if (button) return;
    button = global.document.createElement('button');
    button.type = 'button';
    button.className = 'cfOperatorNavItem cfCsvImportNav';
    button.setAttribute('data-csv-import-nav', 'true');
    button.title = t('CSV 数据导入与校验历史', 'CSV imports and validation history');
    button.innerHTML = `<span class="cfOperatorMark">I</span><span class="cfOperatorNavText">${escapeHtml(t('数据导入', 'Imports'))}</span><span class="cfOperatorNavMeta">→</span>`;
    button.addEventListener('click', () => void open());
    items.appendChild(button);
  }

  function syncStoreFromWorkspace() {
    const next = String(global.CloudflareOperatorWorkspace?.currentStoreId?.() || state.storeId || '').trim();
    if (next === state.storeId) return;
    state.storeId = next;
    state.items = [];
    state.selectedImportId = '';
    state.detail = null;
    state.errors = [];
  }

  function onStoreChange(event) {
    const storeId = String(event?.detail?.storeId || '').trim();
    if (!storeId || storeId === state.storeId) return;
    state.storeId = storeId;
    state.items = [];
    state.selectedImportId = '';
    state.detail = null;
    state.errors = [];
    state.message = null;
    void refreshPermissions().then(() => state.open ? refresh() : null);
  }

  function onClick(event) {
    const closeButton = event.target.closest?.('[data-import-action="close"]');
    if (closeButton) { close(); return; }
    const refreshButton = event.target.closest?.('[data-import-action="refresh"]');
    if (refreshButton) { void refresh(); return; }
    const row = event.target.closest?.('[data-import-id]');
    if (row) { void selectImport(row.getAttribute('data-import-id')); }
  }

  function onChange(event) {
    if (event.target?.id !== 'cfImportFile') return;
    const file = event.target.files?.[0] || null;
    const meta = state.root?.querySelector('#cfImportFileMeta');
    if (!meta) return;
    if (!file) {
      meta.textContent = t('尚未选择 CSV', 'No CSV selected');
      return;
    }
    meta.textContent = `${file.name} · ${formatBytes(file.size)}`;
  }

  async function onSubmit(event) {
    if (event.target?.id !== 'cfImportForm') return;
    event.preventDefault();
    if (!state.canWrite || state.uploading || !state.storeId) return;
    const input = state.root?.querySelector('#cfImportFile');
    const file = input?.files?.[0] || null;
    if (!file) {
      state.message = { kind: 'warn', text: t('请选择 Amazon Ads Search Term CSV。', 'Choose an Amazon Ads Search Term CSV.') };
      renderMessage();
      return;
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      state.message = { kind: 'bad', text: t('CSV 必须大于 0 且不超过 10 MB。', 'CSV must be larger than 0 and no more than 10 MB.') };
      renderMessage();
      return;
    }

    const marketplace = fieldValue('cfImportMarketplace');
    const currencyCode = fieldValue('cfImportCurrency');
    const profileId = fieldValue('cfImportProfile');
    const params = new URLSearchParams();
    if (marketplace) params.set('marketplace', marketplace);
    if (currencyCode) params.set('currencyCode', currencyCode);
    if (profileId) params.set('profileId', profileId);
    const query = params.toString() ? `?${params}` : '';

    state.uploading = true;
    state.message = { kind: 'loading', text: t('正在校验并写入真实广告数据…', 'Validating and publishing real ad data…') };
    render();
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(state.storeId)}/imports/search-terms${query}`, {
        method: 'POST',
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'x-import-file-name': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (payload?.duplicate) {
        state.message = {
          kind: 'warn',
          text: t(`检测到重复报告，已复用 ${payload.importId}，未重复写入。`, `Duplicate report detected. Reused ${payload.importId}; no duplicate write.`),
        };
      } else if (payload?.published) {
        state.message = {
          kind: 'ok',
          text: t(`导入成功：${payload.validation?.acceptedRows || 0} 行已发布。`, `Import complete: ${payload.validation?.acceptedRows || 0} rows published.`),
        };
      } else {
        state.message = {
          kind: 'bad',
          text: t(`校验未通过：${payload.validation?.rejectedRows || 0} 行被拒绝。`, `Validation failed: ${payload.validation?.rejectedRows || 0} rows rejected.`),
        };
      }
      state.selectedImportId = payload?.importId || '';
      await refresh();
      if (state.selectedImportId) await selectImport(state.selectedImportId);
    } catch (error) {
      const payload = error?.payload;
      state.message = {
        kind: error?.status === 422 ? 'bad' : 'bad',
        text: payload?.validation
          ? t(`校验未通过：${payload.validation.rejectedRows || 0} 行被拒绝。`, `Validation failed: ${payload.validation.rejectedRows || 0} rows rejected.`)
          : messageFromError(error).text,
      };
      if (payload?.importId) {
        state.selectedImportId = payload.importId;
        await refresh();
        await selectImport(payload.importId);
      }
    } finally {
      state.uploading = false;
      render();
    }
  }

  async function selectImport(importId) {
    const id = String(importId || '').trim();
    if (!id || !state.storeId || !state.canRead) return;
    state.selectedImportId = id;
    state.detail = null;
    state.errors = [];
    render();
    try {
      const [detail, errors] = await Promise.all([
        requestJson(`/api/v1/stores/${encodeURIComponent(state.storeId)}/imports/${encodeURIComponent(id)}`),
        requestJson(`/api/v1/stores/${encodeURIComponent(state.storeId)}/imports/${encodeURIComponent(id)}/errors?limit=100`),
      ]);
      state.detail = detail;
      state.errors = Array.isArray(errors?.items) ? errors.items : [];
    } catch (error) {
      state.message = messageFromError(error);
    }
    render();
  }

  function render() {
    if (!state.root || !state.open) return;
    const body = state.root.querySelector('.cfImportsBody');
    if (!body) return;
    body.innerHTML = `
      <div class="cfImportsTopline">
        <div><strong>${escapeHtml(t('数据导入', 'Imports'))}</strong><span>${escapeHtml(state.storeId || t('无店铺上下文', 'No store context'))}</span></div>
        <div class="cfImportsTopActions"><button type="button" data-import-action="refresh" ${state.loading ? 'disabled' : ''}>${escapeHtml(t('刷新', 'Refresh'))}</button><button type="button" data-import-action="close">×</button></div>
      </div>
      ${messageMarkup()}
      ${uploadMarkup()}
      <div class="cfImportsGrid">
        <section class="cfImportsCard cfImportsHistory">${historyMarkup()}</section>
        <section class="cfImportsCard cfImportsDetail">${detailMarkup()}</section>
      </div>`;
  }

  function renderMessage() {
    const host = state.root?.querySelector('[data-import-message]');
    if (host) host.outerHTML = messageMarkup();
  }

  function uploadMarkup() {
    if (!state.canRead) return `<section class="cfImportsCard"><div class="cfImportsEmpty">${escapeHtml(t('当前账号没有广告数据读取权限。', 'Current account does not have ad-data read permission.'))}</div></section>`;
    const disabled = !state.canWrite || state.uploading || !state.storeId;
    return `<section class="cfImportsCard cfImportsUpload">
      <div class="cfImportsSectionHead"><div><h3>${escapeHtml(t('导入 Search Term CSV', 'Import Search Term CSV'))}</h3><p>${escapeHtml(t('Amazon Ads Console 导出 · 最大 10 MB · 重复报告自动识别', 'Amazon Ads Console export · max 10 MB · duplicate reports detected automatically'))}</p></div><span class="cfImportsPermission">${state.canWrite ? 'ads.write' : 'read only'}</span></div>
      <form id="cfImportForm">
        <label class="cfImportsFile"><input id="cfImportFile" type="file" accept=".csv,text/csv" ${disabled ? 'disabled' : ''}><span>${escapeHtml(t('选择 CSV 文件', 'Choose CSV file'))}</span><small id="cfImportFileMeta">${escapeHtml(t('尚未选择 CSV', 'No CSV selected'))}</small></label>
        <div class="cfImportsFields">
          <label>${escapeHtml(t('Marketplace', 'Marketplace'))}<input id="cfImportMarketplace" maxlength="32" value="US" ${disabled ? 'disabled' : ''}></label>
          <label>${escapeHtml(t('Currency', 'Currency'))}<input id="cfImportCurrency" maxlength="8" value="USD" ${disabled ? 'disabled' : ''}></label>
          <label>${escapeHtml(t('Profile ID（可选）', 'Profile ID (optional)'))}<input id="cfImportProfile" maxlength="200" ${disabled ? 'disabled' : ''}></label>
          <button class="cfImportsPrimary" type="submit" ${disabled ? 'disabled' : ''}>${escapeHtml(state.uploading ? t('处理中…', 'Processing…') : t('校验并导入', 'Validate & Import'))}</button>
        </div>
      </form>
    </section>`;
  }

  function historyMarkup() {
    if (state.loading) return `<div class="cfImportsEmpty">${escapeHtml(t('正在读取导入历史…', 'Loading import history…'))}</div>`;
    if (!state.items.length) return `<div class="cfImportsEmpty">${escapeHtml(t('还没有 CSV 导入记录。', 'No CSV imports yet.'))}</div>`;
    const rows = state.items.map((item) => `<button type="button" class="cfImportsHistoryRow${item.importId === state.selectedImportId ? ' active' : ''}" data-import-id="${escapeAttr(item.importId)}">
      <span class="cfImportsStatus ${escapeAttr(item.status)}">${escapeHtml(item.status)}</span>
      <span class="cfImportsHistoryMain"><strong>${escapeHtml(item.sourceFileName || item.importId)}</strong><small>${escapeHtml(item.reportStartDate)} → ${escapeHtml(item.reportEndDate)} · ${Number(item.rowCount || 0).toLocaleString()} rows</small></span>
      <span class="cfImportsHistoryTime">${escapeHtml(formatDateTime(item.uploadedAt))}</span>
    </button>`).join('');
    return `<div class="cfImportsSectionHead"><div><h3>${escapeHtml(t('导入历史', 'Import history'))}</h3><p>${state.items.length} ${escapeHtml(t('条最近记录', 'recent records'))}</p></div></div><div class="cfImportsHistoryList">${rows}</div>`;
  }

  function detailMarkup() {
    const batch = state.detail?.batch;
    if (!state.selectedImportId) return `<div class="cfImportsEmpty">${escapeHtml(t('选择一条导入记录查看校验与发布结果。', 'Select an import to inspect validation and publish results.'))}</div>`;
    if (!batch) return `<div class="cfImportsEmpty">${escapeHtml(t('正在读取详情…', 'Loading details…'))}</div>`;
    const facts = state.detail?.publishedFacts || {};
    const summary = batch.validationSummary || {};
    const errorCodes = summary.errorCodes && typeof summary.errorCodes === 'object'
      ? Object.entries(summary.errorCodes).map(([code, count]) => `<span>${escapeHtml(code)} × ${Number(count)}</span>`).join('')
      : '';
    const errors = state.errors.length
      ? `<div class="cfImportsErrors">${state.errors.map((item) => `<div><code>${escapeHtml(item.errorCode)}</code><span>${item.sourceRowOrdinal == null ? t('批次', 'batch') : `${t('行', 'row')} ${item.sourceRowOrdinal + 2}`}</span></div>`).join('')}</div>`
      : `<div class="cfImportsOkLine">${escapeHtml(t('没有持久化校验错误。', 'No persisted validation errors.'))}</div>`;
    return `<div class="cfImportsSectionHead"><div><h3>${escapeHtml(t('导入详情', 'Import detail'))}</h3><p>${escapeHtml(batch.importId)}</p></div><span class="cfImportsStatus ${escapeAttr(batch.status)}">${escapeHtml(batch.status)}</span></div>
      <dl class="cfImportsFacts">
        <div><dt>${escapeHtml(t('文件', 'File'))}</dt><dd>${escapeHtml(batch.sourceFileName)}</dd></div>
        <div><dt>${escapeHtml(t('报告范围', 'Report range'))}</dt><dd>${escapeHtml(batch.reportStartDate)} → ${escapeHtml(batch.reportEndDate)}</dd></div>
        <div><dt>${escapeHtml(t('校验', 'Validation'))}</dt><dd>${Number(batch.acceptedRows).toLocaleString()} / ${Number(batch.rowCount).toLocaleString()}</dd></div>
        <div><dt>${escapeHtml(t('已发布事实', 'Published facts'))}</dt><dd>${Number(facts.rowCount || 0).toLocaleString()}</dd></div>
        <div><dt>SHA-256</dt><dd><code>${escapeHtml(String(batch.contentSha256 || '').slice(0, 16))}…</code></dd></div>
        <div><dt>${escapeHtml(t('上传时间', 'Uploaded'))}</dt><dd>${escapeHtml(formatDateTime(batch.uploadedAt))}</dd></div>
      </dl>
      ${errorCodes ? `<div class="cfImportsErrorCodes">${errorCodes}</div>` : ''}
      ${errors}`;
  }

  function messageMarkup() {
    if (!state.message) return '<div data-import-message></div>';
    return `<div data-import-message class="cfImportsMessage ${escapeAttr(state.message.kind || 'info')}">${escapeHtml(state.message.text || '')}</div>`;
  }

  function shellMarkup() {
    return `<div class="cfImportsBackdrop" data-import-action="close"></div><div class="cfImportsDialog" role="dialog" aria-modal="true"><div class="cfImportsBody"></div></div>`;
  }

  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...(options.headers || {}) },
      body: options.body,
    });
    const requestId = response.headers.get('x-request-id');
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const error = new Error(payload?.error || `http_${response.status}`);
      error.status = response.status;
      error.code = payload?.error || `http_${response.status}`;
      error.requestId = requestId;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function messageFromError(error) {
    const code = String(error?.code || error?.message || 'request_failed');
    const mapping = {
      forbidden: t('当前账号没有该店铺所需权限。', 'Current account lacks required store permission.'),
      csv_size_limit_exceeded: t('CSV 超过 10 MB 上限。', 'CSV exceeds the 10 MB limit.'),
      source_file_name_required: t('无法识别文件名。', 'Source file name could not be resolved.'),
      csv_required_headers_missing: t('CSV 缺少必需字段，请使用 Amazon Search Term 报告。', 'CSV is missing required columns; use an Amazon Search Term report.'),
    };
    return { kind: 'bad', text: mapping[code] || `${t('请求失败', 'Request failed')}: ${code}` };
  }

  function fieldValue(id) {
    return String(state.root?.querySelector(`#${id}`)?.value || '').trim();
  }

  function detectLocale() {
    const lang = String(global.document?.documentElement?.lang || '').toLowerCase();
    return lang.startsWith('en') ? 'en' : 'zh';
  }
  function t(zh, en) { return detectLocale() === 'en' ? en : zh; }
  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(detectLocale() === 'en' ? 'en-US' : 'zh-CN', { hour12: false });
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }
  function escapeAttr(value) { return escapeHtml(value); }

  function installStyles() {
    if (global.document.getElementById('cfImportsStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfImportsStyles';
    style.textContent = `
      .cfImportsPanel[hidden]{display:none!important}.cfImportsPanel{position:fixed;inset:0;z-index:2147483000;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827}.cfImportsBackdrop{position:absolute;inset:0;background:rgba(15,23,42,.48);backdrop-filter:blur(3px)}.cfImportsDialog{position:absolute;inset:4vh 4vw;background:#f8fafc;border:1px solid rgba(148,163,184,.35);border-radius:18px;box-shadow:0 30px 80px rgba(15,23,42,.32);overflow:auto}.cfImportsBody{padding:22px}.cfImportsTopline{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.cfImportsTopline>div:first-child{display:flex;align-items:baseline;gap:12px}.cfImportsTopline strong{font-size:22px}.cfImportsTopline span{font-size:12px;color:#64748b}.cfImportsTopActions{display:flex;gap:8px}.cfImportsTopActions button,.cfImportsPrimary{border:1px solid #cbd5e1;background:white;border-radius:10px;padding:9px 13px;cursor:pointer;font:inherit}.cfImportsTopActions button:last-child{font-size:20px;line-height:1;padding:7px 11px}.cfImportsPrimary{background:#0f172a;color:white;border-color:#0f172a;font-weight:700}.cfImportsTopActions button:disabled,.cfImportsPrimary:disabled{opacity:.45;cursor:not-allowed}.cfImportsCard{background:white;border:1px solid #e2e8f0;border-radius:14px;padding:16px;box-shadow:0 1px 2px rgba(15,23,42,.03)}.cfImportsUpload{margin-bottom:14px}.cfImportsSectionHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.cfImportsSectionHead h3{font-size:15px;margin:0 0 3px}.cfImportsSectionHead p{font-size:11px;color:#64748b;margin:0}.cfImportsPermission{font-size:10px;text-transform:uppercase;letter-spacing:.08em;border:1px solid #e2e8f0;border-radius:999px;padding:5px 8px;color:#475569}.cfImportsFile{display:flex;align-items:center;gap:10px;border:1px dashed #cbd5e1;border-radius:12px;padding:13px;margin-bottom:12px;background:#f8fafc}.cfImportsFile input{max-width:240px}.cfImportsFile span{font-size:12px;font-weight:700}.cfImportsFile small{margin-left:auto;color:#64748b}.cfImportsFields{display:grid;grid-template-columns:120px 120px minmax(180px,1fr) auto;gap:10px;align-items:end}.cfImportsFields label{font-size:10px;color:#64748b;display:grid;gap:5px}.cfImportsFields input{border:1px solid #cbd5e1;border-radius:9px;padding:9px;font:inherit;color:#0f172a;background:white}.cfImportsGrid{display:grid;grid-template-columns:minmax(360px,.9fr) minmax(420px,1.1fr);gap:14px}.cfImportsHistoryList{display:grid;gap:6px;max-height:54vh;overflow:auto}.cfImportsHistoryRow{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;width:100%;text-align:left;border:1px solid #e2e8f0;background:white;border-radius:10px;padding:10px;cursor:pointer}.cfImportsHistoryRow:hover,.cfImportsHistoryRow.active{border-color:#94a3b8;background:#f8fafc}.cfImportsHistoryMain{display:grid;gap:3px;min-width:0}.cfImportsHistoryMain strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cfImportsHistoryMain small,.cfImportsHistoryTime{font-size:10px;color:#64748b}.cfImportsStatus{font-size:9px;font-weight:800;text-transform:uppercase;border-radius:999px;padding:5px 7px;background:#e2e8f0;color:#334155}.cfImportsStatus.published{background:#dcfce7;color:#166534}.cfImportsStatus.rejected{background:#fee2e2;color:#991b1b}.cfImportsStatus.validated{background:#fef3c7;color:#92400e}.cfImportsFacts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0}.cfImportsFacts>div{border:1px solid #e2e8f0;border-radius:9px;padding:9px}.cfImportsFacts dt{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:4px}.cfImportsFacts dd{margin:0;font-size:11px;word-break:break-word}.cfImportsErrors{margin-top:12px;display:grid;gap:5px;max-height:180px;overflow:auto}.cfImportsErrors>div{display:flex;justify-content:space-between;gap:10px;border-top:1px solid #f1f5f9;padding-top:6px;font-size:10px}.cfImportsErrors span{color:#64748b}.cfImportsErrorCodes{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.cfImportsErrorCodes span{font-size:9px;border:1px solid #fecaca;background:#fff1f2;color:#9f1239;border-radius:999px;padding:4px 7px}.cfImportsOkLine,.cfImportsEmpty{font-size:11px;color:#64748b;padding:18px 4px;text-align:center}.cfImportsMessage{margin-bottom:12px;border-radius:10px;padding:10px 12px;font-size:11px;border:1px solid #e2e8f0;background:white}.cfImportsMessage.ok{border-color:#bbf7d0;background:#f0fdf4;color:#166534}.cfImportsMessage.warn{border-color:#fde68a;background:#fffbeb;color:#92400e}.cfImportsMessage.bad{border-color:#fecaca;background:#fff1f2;color:#991b1b}.cfImportsMessage.loading{border-color:#bfdbfe;background:#eff6ff;color:#1d4ed8}@media(max-width:980px){.cfImportsDialog{inset:2vh 2vw}.cfImportsGrid{grid-template-columns:1fr}.cfImportsFields{grid-template-columns:1fr 1fr}.cfImportsPrimary{grid-column:1/-1}.cfImportsHistoryList{max-height:32vh}}`;
    global.document.head.appendChild(style);
  }
})(window);
