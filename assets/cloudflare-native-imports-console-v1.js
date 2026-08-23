(function initCloudflareNativeImportsConsole(global) {
  'use strict';

  const VERSION = '1.3.0';
  const MAX_BYTES = 10 * 1024 * 1024;
  const MAX_SETTLEMENT_BYTES = 16 * 1024 * 1024;
  const GOVERNED_PROVENANCE = new Set(['exact_source_object', 'reconciled_exact_source']);
  const state = {
    mounted: false,
    open: false,
    loading: false,
    uploading: false,
    classifying: false,
    settlementUploading: false,
    settlementClassifying: false,
    storeId: '',
    scopeGeneration: 0,
    refreshSerial: 0,
    permissionSerial: 0,
    detailSerial: 0,
    settlementDetailSerial: 0,
    canRead: false,
    canWrite: false,
    items: [],
    selectedImportId: '',
    detail: null,
    errors: [],
    settlements: [],
    selectedSettlementImportId: '',
    settlementDetail: null,
    message: null,
    root: null,
  };

  const publicApi = Object.freeze({
    version: VERSION,
    open,
    close,
    refresh,
    currentStoreId: () => state.storeId,
  });
  Object.defineProperty(global, 'CloudflareImportsConsole', {
    value: publicApi,
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
    root.innerHTML = '<div class="cfImportsBackdrop" data-import-action="close"></div><div class="cfImportsDialog" role="dialog" aria-modal="true"><div class="cfImportsBody"></div></div>';
    global.document.body.appendChild(root);
    state.root = root;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
    global.addEventListener?.('cloudflare-operator-store-change', onStoreChange);
    new MutationObserver(ensureNavigation).observe(global.document.body, { childList: true, subtree: true });
    syncStore();
    void refreshPermissions().finally(ensureNavigation);
    ensureNavigation();
  }

  async function open() {
    if (!state.mounted) mount();
    syncStore();
    state.open = true;
    state.root.hidden = false;
    render();
    const permissionCurrent = await refreshPermissions();
    if (permissionCurrent) await refresh();
    return true;
  }

  function close() {
    state.open = false;
    if (state.root) state.root.hidden = true;
  }

  async function refresh(options = {}) {
    if (!state.storeId || !state.canRead || state.loading) return;
    const scope = currentScope();
    const serial = ++state.refreshSerial;
    state.loading = true;
    if (options.preserveMessage !== true) state.message = null;
    render();
    try {
      const [searchPayload, settlementPayload] = await Promise.all([
        requestJson(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/imports?limit=50`),
        requestJson(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/imports/settlements?limit=50`),
      ]);
      if (serial !== state.refreshSerial || !scopeIsCurrent(scope)) return;
      state.items = Array.isArray(searchPayload?.items) ? searchPayload.items : [];
      state.settlements = Array.isArray(settlementPayload?.items) ? settlementPayload.items : [];
      if (state.selectedImportId && !state.items.some((item) => item.importId === state.selectedImportId)) {
        state.selectedImportId = '';
        state.detail = null;
        state.errors = [];
      }
      if (state.selectedSettlementImportId && !state.settlements.some((item) => item.importId === state.selectedSettlementImportId)) {
        state.selectedSettlementImportId = '';
        state.settlementDetail = null;
      }
    } catch (error) {
      if (serial !== state.refreshSerial || !scopeIsCurrent(scope)) return;
      state.message = errorMessage(error);
    } finally {
      if (serial === state.refreshSerial && scopeIsCurrent(scope)) {
        state.loading = false;
        render();
      }
    }
  }

  async function refreshPermissions() {
    syncStore();
    const scope = currentScope();
    const serial = ++state.permissionSerial;
    state.canRead = false;
    state.canWrite = false;
    ensureNavigation();
    render();
    try {
      if (!scope.storeId || !global.CloudflareNativeAPI?.capabilities) throw new Error('permission_context_unavailable');
      const capabilities = await global.CloudflareNativeAPI.capabilities();
      if (serial !== state.permissionSerial || !scopeIsCurrent(scope)) return false;
      const globalPermissions = new Set(Array.isArray(capabilities?.globalPermissions) ? capabilities.globalPermissions : []);
      const scoped = new Set(Array.isArray(capabilities?.storePermissions?.[scope.storeId]) ? capabilities.storePermissions[scope.storeId] : []);
      state.canWrite = globalPermissions.has('ads.write') || scoped.has('ads.write');
      state.canRead = state.canWrite || globalPermissions.has('ads.read') || scoped.has('ads.read');
    } catch {
      if (serial !== state.permissionSerial || !scopeIsCurrent(scope)) return false;
      state.canRead = false;
      state.canWrite = false;
    }
    if (serial !== state.permissionSerial || !scopeIsCurrent(scope)) return false;
    ensureNavigation();
    render();
    return true;
  }

  function ensureNavigation() {
    const host = global.document?.querySelector('#cfOperatorWorkspace .cfOperatorGroup[data-group="operations"] .cfOperatorGroupItems');
    if (!host) return;
    let button = host.querySelector('[data-csv-import-nav]');
    if (!state.canRead) {
      button?.remove();
      return;
    }
    if (button) return;
    button = global.document.createElement('button');
    button.type = 'button';
    button.className = 'cfOperatorNavItem cfCsvImportNav';
    button.setAttribute('data-csv-import-nav', 'true');
    button.title = t('CSV 数据导入、权威分类与校验历史', 'CSV imports, authority classification, and validation history');
    button.innerHTML = `<span class="cfOperatorMark">I</span><span class="cfOperatorNavText">${e(t('数据导入', 'Imports'))}</span><span class="cfOperatorNavMeta">→</span>`;
    button.addEventListener('click', () => void open());
    host.appendChild(button);
  }

  function currentScope() {
    return Object.freeze({ storeId: state.storeId, generation: state.scopeGeneration });
  }

  function scopeIsCurrent(scope) {
    return Boolean(scope && scope.storeId === state.storeId && scope.generation === state.scopeGeneration);
  }

  function transitionStore(storeId) {
    const next = String(storeId || '').trim();
    if (!next || next === state.storeId) return false;
    state.storeId = next;
    state.scopeGeneration += 1;
    state.refreshSerial += 1;
    state.permissionSerial += 1;
    state.detailSerial += 1;
    state.settlementDetailSerial += 1;
    state.loading = false;
    state.canRead = false;
    state.canWrite = false;
    resetSelection();
    state.message = null;
    render();
    return true;
  }

  function syncStore() {
    const next = String(global.CloudflareOperatorWorkspace?.currentStoreId?.() || state.storeId || '').trim();
    transitionStore(next);
  }

  function resetSelection() {
    state.items = [];
    state.selectedImportId = '';
    state.detail = null;
    state.errors = [];
    state.settlements = [];
    state.selectedSettlementImportId = '';
    state.settlementDetail = null;
  }

  function onStoreChange(event) {
    const storeId = String(event?.detail?.storeId || '').trim();
    if (!transitionStore(storeId)) return;
    void refreshPermissions().then((current) => current && state.open ? refresh() : null);
  }

  function onClick(event) {
    if (event.target.closest?.('[data-import-action="close"]')) return close();
    if (event.target.closest?.('[data-import-action="refresh"]')) return void refresh();

    const classifySearch = event.target.closest?.('[data-import-authority-business]');
    if (classifySearch) {
      event.preventDefault();
      return void classifySearchTermImport(classifySearch.getAttribute('data-import-authority-business'));
    }
    const classifySettlement = event.target.closest?.('[data-settlement-authority-business]');
    if (classifySettlement) {
      event.preventDefault();
      return void classifySettlementImport(classifySettlement.getAttribute('data-settlement-authority-business'));
    }

    const settlementRow = event.target.closest?.('[data-settlement-import-id]');
    if (settlementRow) return void selectSettlement(settlementRow.getAttribute('data-settlement-import-id'));
    const row = event.target.closest?.('[data-import-id]');
    if (row) void selectImport(row.getAttribute('data-import-id'));
  }

  function onChange(event) {
    const fileId = event.target?.id;
    if (fileId !== 'cfImportFile' && fileId !== 'cfSettlementFile') return;
    const file = event.target.files?.[0];
    const metaId = fileId === 'cfSettlementFile' ? '#cfSettlementFileMeta' : '#cfImportFileMeta';
    const meta = state.root?.querySelector(metaId);
    if (meta) meta.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : t('尚未选择 CSV', 'No CSV selected');
  }

  function onSubmit(event) {
    if (event.target?.id === 'cfImportForm') {
      event.preventDefault();
      return void submitSearchTermImport();
    }
    if (event.target?.id === 'cfSettlementImportForm') {
      event.preventDefault();
      return void submitSettlementImport();
    }
  }

  async function submitSearchTermImport() {
    if (!state.canWrite || state.uploading || !state.storeId) return;
    const scope = currentScope();
    const file = state.root?.querySelector('#cfImportFile')?.files?.[0];
    if (!file) return setMessage('warn', t('请选择 Amazon Ads Search Term CSV。', 'Choose an Amazon Ads Search Term CSV.'));
    if (file.size <= 0 || file.size > MAX_BYTES) return setMessage('bad', t('Search Term CSV 必须大于 0 且不超过 10 MB。', 'Search Term CSV must be larger than 0 and no more than 10 MB.'));

    const params = new URLSearchParams();
    for (const [key, id] of [['marketplace','cfImportMarketplace'], ['currencyCode','cfImportCurrency'], ['profileId','cfImportProfile']]) {
      const value = String(state.root?.querySelector(`#${id}`)?.value || '').trim();
      if (value) params.set(key, value);
    }
    const query = params.size ? `?${params}` : '';

    state.uploading = true;
    setMessage('loading', t('正在校验并写入真实 Search Term 数据…', 'Validating and publishing real Search Term data…'));
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/imports/search-terms${query}`, {
        method: 'POST',
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'x-import-file-name': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (!scopeIsCurrent(scope)) return;
      state.selectedImportId = payload?.importId || '';
      if (payload?.duplicate) {
        setMessage('warn', t(`检测到重复报告，已复用 ${payload.importId}，未重复写入。`, `Duplicate report detected. Reused ${payload.importId}; no duplicate write.`));
      } else if (payload?.published) {
        setMessage('ok', t(`Search Term 导入成功：${payload.validation?.acceptedRows || 0} 行已发布。`, `Search Term import complete: ${payload.validation?.acceptedRows || 0} rows published.`));
      } else {
        setMessage('bad', t(`校验未通过：${payload.validation?.rejectedRows || 0} 行被拒绝。`, `Validation failed: ${payload.validation?.rejectedRows || 0} rows rejected.`));
      }
      await refresh({ preserveMessage: true });
      if (!scopeIsCurrent(scope)) return;
      if (state.selectedImportId) await selectImport(state.selectedImportId, { preserveMessage: true });
    } catch (error) {
      if (!scopeIsCurrent(scope)) return;
      const payload = error?.payload;
      if (payload?.validation) {
        setMessage('bad', t(`校验未通过：${payload.validation.rejectedRows || 0} 行被拒绝。`, `Validation failed: ${payload.validation.rejectedRows || 0} rows rejected.`));
      } else {
        state.message = errorMessage(error);
        render();
      }
      if (payload?.importId) {
        state.selectedImportId = payload.importId;
        await refresh({ preserveMessage: true });
        if (!scopeIsCurrent(scope)) return;
        await selectImport(payload.importId, { preserveMessage: true });
      }
    } finally {
      state.uploading = false;
      render();
    }
  }

  async function submitSettlementImport() {
    if (!state.canWrite || state.settlementUploading || !state.storeId) return;
    const scope = currentScope();
    const file = state.root?.querySelector('#cfSettlementFile')?.files?.[0];
    if (!file) return setMessage('warn', t('请选择 Amazon Settlement Financial CSV。', 'Choose an Amazon Settlement Financial CSV.'));
    if (file.size <= 0 || file.size > MAX_SETTLEMENT_BYTES) return setMessage('bad', t('Settlement CSV 必须大于 0 且不超过 16 MB。', 'Settlement CSV must be larger than 0 and no more than 16 MB.'));

    const params = new URLSearchParams();
    for (const [key, id] of [['marketplace','cfSettlementMarketplace'], ['currencyCode','cfSettlementCurrency']]) {
      const value = String(state.root?.querySelector(`#${id}`)?.value || '').trim();
      if (value) params.set(key, value);
    }
    const query = params.size ? `?${params}` : '';

    state.settlementUploading = true;
    setMessage('loading', t('正在校验、对账并写入真实 Settlement 数据…', 'Validating, reconciling, and publishing real Settlement data…'));
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/imports/settlements${query}`, {
        method: 'POST',
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'x-import-file-name': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (!scopeIsCurrent(scope)) return;
      const importId = payload?.batch?.importId || '';
      state.selectedSettlementImportId = importId;
      if (payload?.duplicate) {
        setMessage('warn', t(`Settlement 重复报告：已复用 ${importId}，未重复写入。`, `Duplicate Settlement report: reused ${importId}; no duplicate write.`));
      } else {
        setMessage('ok', t(`Settlement 导入成功：${payload?.validation?.acceptedRows ?? payload?.batch?.acceptedRows ?? 0} 行已发布并完成对账。`, `Settlement import complete: ${payload?.validation?.acceptedRows ?? payload?.batch?.acceptedRows ?? 0} rows published and reconciled.`));
      }
      await refresh({ preserveMessage: true });
      if (!scopeIsCurrent(scope)) return;
      if (importId) await selectSettlement(importId, { preserveMessage: true });
    } catch (error) {
      if (!scopeIsCurrent(scope)) return;
      const payload = error?.payload;
      if (payload?.validation) {
        setMessage('bad', t(`Settlement 校验未通过：${payload.validation.rejectedRows || 0} 行被拒绝。`, `Settlement validation failed: ${payload.validation.rejectedRows || 0} rows rejected.`));
      } else {
        state.message = errorMessage(error);
        render();
      }
    } finally {
      state.settlementUploading = false;
      render();
    }
  }

  async function classifySearchTermImport(importId) {
    const id = String(importId || '').trim();
    if (!id || !state.storeId || !state.canWrite || state.classifying) return;
    const scope = currentScope();
    state.classifying = true;
    setMessage('loading', t('正在通过正式 authority workflow 标记为 Business…', 'Classifying as Business through the formal authority workflow…'));
    try {
      await requestJson(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/imports/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dataClass: 'business',
          reason: 'Production operator classification via Imports console after exact-source evidence review',
          evidence: { workflow: 'imports_console_v1', action: 'classify_business' },
        }),
      });
      if (!scopeIsCurrent(scope)) return;
      setMessage('ok', t('Search Term authority 已正式标记为 Business。', 'Search Term authority formally classified as Business.'));
      await refresh({ preserveMessage: true });
      if (!scopeIsCurrent(scope)) return;
      await selectImport(id, { preserveMessage: true });
    } catch (error) {
      if (!scopeIsCurrent(scope)) return;
      state.message = errorMessage(error);
      render();
    } finally {
      state.classifying = false;
      render();
    }
  }

  async function classifySettlementImport(importId) {
    const id = String(importId || '').trim();
    if (!id || !state.storeId || !state.canWrite || state.settlementClassifying) return;
    const scope = currentScope();
    state.settlementClassifying = true;
    setMessage('loading', t('正在通过正式 Settlement authority workflow 标记为 Business…', 'Classifying Settlement as Business through the formal authority workflow…'));
    try {
      await requestJson(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/imports/settlements?importId=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dataClass: 'business',
          reason: 'Production operator classification via Imports console after exact-source reconciliation review',
          evidence: { workflow: 'imports_console_v1', action: 'classify_business' },
        }),
      });
      if (!scopeIsCurrent(scope)) return;
      setMessage('ok', t('Settlement authority 已正式标记为 Business。', 'Settlement authority formally classified as Business.'));
      await refresh({ preserveMessage: true });
      if (!scopeIsCurrent(scope)) return;
      await selectSettlement(id, { preserveMessage: true });
    } catch (error) {
      if (!scopeIsCurrent(scope)) return;
      state.message = errorMessage(error);
      render();
    } finally {
      state.settlementClassifying = false;
      render();
    }
  }

  async function selectImport(importId, options = {}) {
    const id = String(importId || '').trim();
    if (!id || !state.storeId || !state.canRead) return;
    const scope = currentScope();
    const serial = ++state.detailSerial;
    if (options.preserveMessage !== true) state.message = null;
    state.selectedImportId = id;
    state.detail = null;
    state.errors = [];
    render();
    try {
      const [detail, errors] = await Promise.all([
        requestJson(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/imports/${encodeURIComponent(id)}`),
        requestJson(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/imports/${encodeURIComponent(id)}/errors?limit=100`),
      ]);
      if (serial !== state.detailSerial || !scopeIsCurrent(scope) || state.selectedImportId !== id) return;
      state.detail = detail;
      state.errors = Array.isArray(errors?.items) ? errors.items : [];
    } catch (error) {
      if (serial !== state.detailSerial || !scopeIsCurrent(scope) || state.selectedImportId !== id) return;
      state.message = errorMessage(error);
    }
    if (serial === state.detailSerial && scopeIsCurrent(scope) && state.selectedImportId === id) render();
  }

  async function selectSettlement(importId, options = {}) {
    const id = String(importId || '').trim();
    if (!id || !state.storeId || !state.canRead) return;
    const scope = currentScope();
    const serial = ++state.settlementDetailSerial;
    if (options.preserveMessage !== true) state.message = null;
    state.selectedSettlementImportId = id;
    state.settlementDetail = null;
    render();
    try {
      const detail = await requestJson(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/imports/settlements?importId=${encodeURIComponent(id)}`);
      if (serial !== state.settlementDetailSerial || !scopeIsCurrent(scope) || state.selectedSettlementImportId !== id) return;
      state.settlementDetail = detail;
    } catch (error) {
      if (serial !== state.settlementDetailSerial || !scopeIsCurrent(scope) || state.selectedSettlementImportId !== id) return;
      state.message = errorMessage(error);
    }
    if (serial === state.settlementDetailSerial && scopeIsCurrent(scope) && state.selectedSettlementImportId === id) render();
  }

  function setMessage(kind, text) {
    state.message = { kind, text };
    render();
  }

  function render() {
    if (!state.root || !state.open) return;
    const body = state.root.querySelector('.cfImportsBody');
    if (!body) return;
    body.innerHTML = `
      <header class="cfImportsTopline">
        <div><strong>${e(t('数据导入', 'Imports'))}</strong><span>${e(state.storeId || t('无店铺上下文', 'No store context'))}</span></div>
        <div class="cfImportsTopActions"><button type="button" data-import-action="refresh" ${state.loading ? 'disabled' : ''}>${e(t('刷新', 'Refresh'))}</button><button type="button" data-import-action="close" aria-label="Close">×</button></div>
      </header>
      ${messageMarkup()}
      <div class="cfImportsTypeGrid">${uploadMarkup()}${settlementUploadMarkup()}</div>
      <h2 class="cfImportsDomainTitle">${e(t('Search Term 导入记录', 'Search Term imports'))}</h2>
      <div class="cfImportsGrid"><section class="cfImportsCard">${historyMarkup()}</section><section class="cfImportsCard">${detailMarkup()}</section></div>
      <h2 class="cfImportsDomainTitle">${e(t('Settlement Financial 导入记录', 'Settlement Financial imports'))}</h2>
      <div class="cfImportsGrid"><section class="cfImportsCard">${settlementHistoryMarkup()}</section><section class="cfImportsCard">${settlementDetailMarkup()}</section></div>`;
  }

  function messageMarkup() {
    if (!state.message) return '';
    return `<div class="cfImportsMessage ${e(state.message.kind)}">${e(state.message.text)}</div>`;
  }

  function uploadMarkup() {
    if (!state.canRead) return `<section class="cfImportsCard cfImportsUpload"><div class="cfImportsEmpty">${e(t('当前账号没有广告数据读取权限。', 'Current account does not have ad-data read permission.'))}</div></section>`;
    const disabled = !state.canWrite || state.uploading || !state.storeId;
    return `<section class="cfImportsCard cfImportsUpload">
      <div class="cfImportsSectionHead"><div><h3>${e(t('Search Term CSV', 'Search Term CSV'))}</h3><p>${e(t('Amazon Ads Console 导出 · 最大 10 MB · 独立 Search Term endpoint', 'Amazon Ads Console export · max 10 MB · dedicated Search Term endpoint'))}</p></div><span class="cfImportsReportType">spSearchTerm</span></div>
      <form id="cfImportForm">
        <label class="cfImportsFile"><input id="cfImportFile" type="file" accept=".csv,text/csv" ${disabled ? 'disabled' : ''}><span>${e(t('选择 Search Term CSV', 'Choose Search Term CSV'))}</span><small id="cfImportFileMeta">${e(t('尚未选择 CSV', 'No CSV selected'))}</small></label>
        <div class="cfImportsFields">
          <label>Marketplace<input id="cfImportMarketplace" maxlength="32" value="US" ${disabled ? 'disabled' : ''}></label>
          <label>Currency<input id="cfImportCurrency" maxlength="8" value="USD" ${disabled ? 'disabled' : ''}></label>
          <label>${e(t('Profile ID（可选）', 'Profile ID (optional)'))}<input id="cfImportProfile" maxlength="200" ${disabled ? 'disabled' : ''}></label>
          <button class="cfImportsPrimary" type="submit" ${disabled ? 'disabled' : ''}>${e(state.uploading ? t('处理中…', 'Processing…') : t('校验并导入', 'Validate & Import'))}</button>
        </div>
      </form>
    </section>`;
  }

  function settlementUploadMarkup() {
    if (!state.canRead) return `<section class="cfImportsCard cfImportsUpload"><div class="cfImportsEmpty">${e(t('当前账号没有广告数据读取权限。', 'Current account does not have ad-data read permission.'))}</div></section>`;
    const disabled = !state.canWrite || state.settlementUploading || !state.storeId;
    return `<section class="cfImportsCard cfImportsUpload cfImportsSettlementUpload">
      <div class="cfImportsSectionHead"><div><h3>${e(t('Settlement Financial CSV', 'Settlement Financial CSV'))}</h3><p>${e(t('Amazon 联合/结算报告 · 最大 16 MB · 独立 Settlement endpoint', 'Amazon settlement report · max 16 MB · dedicated Settlement endpoint'))}</p></div><span class="cfImportsReportType settlement">settlementFinancial</span></div>
      <form id="cfSettlementImportForm">
        <label class="cfImportsFile"><input id="cfSettlementFile" type="file" accept=".csv,text/csv" ${disabled ? 'disabled' : ''}><span>${e(t('选择 Settlement CSV', 'Choose Settlement CSV'))}</span><small id="cfSettlementFileMeta">${e(t('尚未选择 CSV', 'No CSV selected'))}</small></label>
        <div class="cfImportsFields cfImportsSettlementFields">
          <label>Marketplace<input id="cfSettlementMarketplace" maxlength="32" value="US" ${disabled ? 'disabled' : ''}></label>
          <label>Currency<input id="cfSettlementCurrency" maxlength="8" value="USD" ${disabled ? 'disabled' : ''}></label>
          <div class="cfImportsEndpointHint">POST /imports/settlements</div>
          <button class="cfImportsPrimary" type="submit" ${disabled ? 'disabled' : ''}>${e(state.settlementUploading ? t('对账中…', 'Reconciling…') : t('校验、对账并导入', 'Validate, Reconcile & Import'))}</button>
        </div>
      </form>
    </section>`;
  }

  function historyMarkup() {
    if (state.loading) return empty(t('正在读取 Search Term 导入历史…', 'Loading Search Term import history…'));
    if (!state.items.length) return empty(t('还没有 Search Term 导入记录。', 'No Search Term imports yet.'));
    return `<div class="cfImportsSectionHead"><div><h3>${e(t('Search Term 历史', 'Search Term history'))}</h3><p>${state.items.length} ${e(t('条最近记录', 'recent records'))}</p></div></div><div class="cfImportsHistoryList">${state.items.map((item) => {
      const authority = normalizeAuthority(item.importAuthority);
      return `
      <button type="button" class="cfImportsHistoryRow${item.importId === state.selectedImportId ? ' active' : ''}" data-import-id="${e(item.importId)}">
        <span class="cfImportsStatus ${e(item.status)}">${e(item.status)}</span>
        <span class="cfImportsHistoryMain"><strong>${e(item.sourceFileName || item.importId)}</strong><small>${e(item.reportStartDate)} → ${e(item.reportEndDate)} · ${Number(item.rowCount || 0).toLocaleString()} rows</small><span class="cfImportsAuthorityInline">${authorityBadge('data', authority.dataClass)}${authorityBadge('provenance', authority.provenanceClass)}${gateBadge('A', authority.analyticsAllowed, t('分析', 'Analytics'))}${gateBadge('R', authority.recommendationAllowed, t('建议', 'Recommendation'))}${gateBadge('V', authority.reviewAllowed, t('审核', 'Review'))}</span></span>
        <span class="cfImportsHistoryTime">${e(formatDateTime(item.uploadedAt))}</span>
      </button>`;
    }).join('')}</div>`;
  }

  function settlementHistoryMarkup() {
    if (state.loading) return empty(t('正在读取 Settlement 导入历史…', 'Loading Settlement import history…'));
    if (!state.settlements.length) return empty(t('还没有 Settlement 导入记录。', 'No Settlement imports yet.'));
    return `<div class="cfImportsSectionHead"><div><h3>${e(t('Settlement 历史', 'Settlement history'))}</h3><p>${state.settlements.length} ${e(t('条最近记录', 'recent records'))}</p></div></div><div class="cfImportsHistoryList">${state.settlements.map((item) => `
      <button type="button" class="cfImportsHistoryRow${item.importId === state.selectedSettlementImportId ? ' active' : ''}" data-settlement-import-id="${e(item.importId)}">
        <span class="cfImportsStatus ${e(item.status)}">${e(item.status)}</span>
        <span class="cfImportsHistoryMain"><strong>${e(item.sourceFileName || item.importId)}</strong><small>${e(item.reportStartDate)} → ${e(item.reportEndDate)} · ${Number(item.rowCount || 0).toLocaleString()} rows</small><span class="cfImportsAuthorityInline"><span class="cfImportsAuthorityChip provenance exact_source_object">${e(t('独立结算域', 'settlement domain'))}</span></span></span>
        <span class="cfImportsHistoryTime">${e(formatDateTime(item.uploadedAt))}</span>
      </button>`).join('')}</div>`;
  }

  function detailMarkup() {
    if (!state.selectedImportId) return empty(t('选择一条 Search Term 导入记录查看校验与发布结果。', 'Select a Search Term import to inspect validation and publish results.'));
    const batch = state.detail?.batch;
    if (!batch) return empty(t('正在读取详情…', 'Loading details…'));
    const facts = state.detail?.publishedFacts || {};
    const summary = batch.validationSummary || {};
    const authority = normalizeAuthority(batch.importAuthority);
    const errorCodes = Object.entries(summary.errorCodes || {}).map(([code, count]) => `<span>${e(code)} × ${Number(count)}</span>`).join('');
    const errors = state.errors.length
      ? `<div class="cfImportsErrors">${state.errors.map((item) => `<div><code>${e(item.errorCode)}</code><span>${item.sourceRowOrdinal == null ? e(t('批次', 'batch')) : `${e(t('行', 'row'))} ${Number(item.sourceRowOrdinal) + 2}`}</span></div>`).join('')}</div>`
      : `<div class="cfImportsOkLine">${e(t('没有持久化校验错误。', 'No persisted validation errors.'))}</div>`;
    return `<div class="cfImportsSectionHead"><div><h3>${e(t('Search Term 详情', 'Search Term detail'))}</h3><p>${e(batch.importId)}</p></div><span class="cfImportsStatus ${e(batch.status)}">${e(batch.status)}</span></div>
      ${authorityMarkup(authority, batch)}
      <dl class="cfImportsFacts">
        <div><dt>${e(t('文件', 'File'))}</dt><dd>${e(batch.sourceFileName)}</dd></div>
        <div><dt>${e(t('报告范围', 'Report range'))}</dt><dd>${e(batch.reportStartDate)} → ${e(batch.reportEndDate)}</dd></div>
        <div><dt>${e(t('校验', 'Validation'))}</dt><dd>${Number(batch.acceptedRows).toLocaleString()} / ${Number(batch.rowCount).toLocaleString()}</dd></div>
        <div><dt>${e(t('已发布事实', 'Published facts'))}</dt><dd>${Number(facts.rowCount || 0).toLocaleString()}</dd></div>
        <div><dt>SHA-256</dt><dd><code>${e(String(batch.contentSha256 || '').slice(0, 16))}…</code></dd></div>
        <div><dt>${e(t('上传时间', 'Uploaded'))}</dt><dd>${e(formatDateTime(batch.uploadedAt))}</dd></div>
      </dl>${errorCodes ? `<div class="cfImportsErrorCodes">${errorCodes}</div>` : ''}${errors}`;
  }

  function settlementDetailMarkup() {
    if (!state.selectedSettlementImportId) return empty(t('选择一条 Settlement 导入记录查看 source receipt、对账与 authority。', 'Select a Settlement import to inspect source receipt, reconciliation, and authority.'));
    const payload = state.settlementDetail;
    const batch = payload?.batch;
    if (!batch) return empty(t('正在读取 Settlement 详情…', 'Loading Settlement detail…'));
    const source = payload?.sourceObject || {};
    const authority = normalizeSettlementAuthority(payload?.authority);
    const reconciliation = payload?.reconciliation || {};
    const facts = payload?.publishedFacts || {};
    const eligible = batch.status === 'published'
      && reconciliation.status === 'pass'
      && String(reconciliation.differenceMicros || '0') === '0'
      && Number(reconciliation.mismatchRows || 0) === 0
      && authority.dataClass === 'unclassified'
      && authority.provenanceClass === 'exact_source_object';
    return `<div class="cfImportsSectionHead"><div><h3>${e(t('Settlement 详情', 'Settlement detail'))}</h3><p>${e(batch.importId)}</p></div><span class="cfImportsStatus ${e(batch.status)}">${e(batch.status)}</span></div>
      <section class="cfImportsAuthority" aria-label="Settlement authority">
        <div class="cfImportsAuthorityHead"><div><strong>${e(t('Settlement 权威状态', 'Settlement authority'))}</strong><small>${e(t('Business 分类要求 published + reconciliation PASS + exact source', 'Business classification requires published + reconciliation PASS + exact source'))}</small></div><span class="cfImportsAuthorityVersion">v${authority.authorityVersion ?? '—'}</span></div>
        <dl class="cfImportsAuthorityFacts"><div><dt>${e(t('数据分类', 'Data class'))}</dt><dd>${authorityBadge('data', authority.dataClass)}</dd></div><div><dt>${e(t('来源证明', 'Provenance'))}</dt><dd>${authorityBadge('provenance', authority.provenanceClass)}</dd></div></dl>
        <div class="cfImportsGateGrid">${gateCard(t('对账', 'Reconciliation'), reconciliation.status === 'pass')}${gateCard(t('差异 = 0', 'Difference = 0'), String(reconciliation.differenceMicros || '0') === '0')}${gateCard(t('Mismatch = 0', 'Mismatch = 0'), Number(reconciliation.mismatchRows || 0) === 0)}</div>
        ${eligible && state.canWrite ? `<button class="cfImportsAuthorityAction" type="button" data-settlement-authority-business="${e(batch.importId)}" ${state.settlementClassifying ? 'disabled' : ''}>${e(state.settlementClassifying ? t('分类中…', 'Classifying…') : t('正式标记为 Business', 'Classify as Business'))}</button>` : ''}
        ${authority.reason ? `<p class="cfImportsAuthorityReason"><strong>${e(t('审计原因', 'Audit reason'))}</strong> · ${e(authority.reason)}${authority.updatedAt ? ` · ${e(formatDateTime(authority.updatedAt))}` : ''}</p>` : ''}
      </section>
      <dl class="cfImportsFacts cfImportsSettlementFacts">
        <div><dt>${e(t('文件', 'File'))}</dt><dd>${e(batch.sourceFileName)}</dd></div>
        <div><dt>${e(t('报告范围', 'Report range'))}</dt><dd>${e(batch.reportStartDate)} → ${e(batch.reportEndDate)}</dd></div>
        <div><dt>${e(t('校验', 'Validation'))}</dt><dd>${Number(batch.acceptedRows).toLocaleString()} / ${Number(batch.rowCount).toLocaleString()}</dd></div>
        <div><dt>${e(t('已发布交易', 'Published transactions'))}</dt><dd>${Number(facts.rowCount || 0).toLocaleString()}</dd></div>
        <div><dt>${e(t('Reported total', 'Reported total'))}</dt><dd>${e(formatMicros(reconciliation.reportedTotalMicros))}</dd></div>
        <div><dt>${e(t('Component sum', 'Component sum'))}</dt><dd>${e(formatMicros(reconciliation.componentSumMicros))}</dd></div>
        <div><dt>${e(t('Difference', 'Difference'))}</dt><dd>${e(formatMicros(reconciliation.differenceMicros))}</dd></div>
        <div><dt>Mismatch rows</dt><dd>${Number(reconciliation.mismatchRows || 0).toLocaleString()}</dd></div>
        <div><dt>SHA-256</dt><dd><code>${e(String(batch.contentSha256 || '').slice(0, 16))}…</code></dd></div>
        <div><dt>R2 bytes</dt><dd>${Number(source.contentBytes || 0).toLocaleString()}</dd></div>
        <div class="cfImportsWideFact"><dt>R2 object</dt><dd><code>${e(source.objectKey || '—')}</code></dd></div>
        <div class="cfImportsWideFact"><dt>R2 ETag / Version</dt><dd><code>${e(source.r2Etag || '—')} · ${e(source.r2Version || '—')}</code></dd></div>
      </dl>`;
  }

  function normalizeAuthority(input) {
    const value = input && typeof input === 'object' ? input : {};
    const classified = value.classified === true;
    const dataClass = String(value.dataClass || 'unclassified');
    const provenanceClass = String(value.provenanceClass || 'unknown');
    const analyticsAllowed = value.analyticsAllowed === true && dataClass === 'business';
    const governed = analyticsAllowed && GOVERNED_PROVENANCE.has(provenanceClass);
    return Object.freeze({
      classified,
      dataClass,
      provenanceClass,
      authorityVersion: Number.isFinite(Number(value.authorityVersion)) ? Number(value.authorityVersion) : null,
      analyticsAllowed,
      recommendationAllowed: value.recommendationAllowed === true && governed,
      reviewAllowed: value.reviewAllowed === true && governed,
      reason: String(value.reason || ''),
      updatedAt: value.updatedAt || null,
    });
  }

  function normalizeSettlementAuthority(input) {
    const value = input && typeof input === 'object' ? input : {};
    return Object.freeze({
      dataClass: String(value.dataClass || 'unclassified'),
      provenanceClass: String(value.provenanceClass || 'unknown'),
      authorityVersion: Number.isFinite(Number(value.authorityVersion)) ? Number(value.authorityVersion) : null,
      reason: String(value.reason || ''),
      updatedAt: value.updatedAt || null,
    });
  }

  function authorityMarkup(authority, batch) {
    const eligible = batch?.status === 'published'
      && authority.dataClass === 'unclassified'
      && GOVERNED_PROVENANCE.has(authority.provenanceClass);
    return `<section class="cfImportsAuthority" aria-label="Import authority">
      <div class="cfImportsAuthorityHead"><div><strong>${e(t('数据权威状态', 'Data authority'))}</strong><small>${e(t('分类与来源证明分离；缺失权威时 fail closed', 'Classification and provenance are separate; missing authority fails closed'))}</small></div><span class="cfImportsAuthorityVersion">v${authority.authorityVersion ?? '—'}</span></div>
      <dl class="cfImportsAuthorityFacts">
        <div><dt>${e(t('数据分类', 'Data class'))}</dt><dd>${authorityBadge('data', authority.dataClass)}</dd></div>
        <div><dt>${e(t('来源证明', 'Provenance'))}</dt><dd>${authorityBadge('provenance', authority.provenanceClass)}</dd></div>
      </dl>
      <div class="cfImportsGateGrid">${gateCard(t('经营分析', 'Analytics'), authority.analyticsAllowed)}${gateCard(t('建议', 'Recommendation'), authority.recommendationAllowed)}${gateCard(t('治理审核', 'Review'), authority.reviewAllowed)}</div>
      <p class="cfImportsAuthorityExplain">${e(authorityExplanation(authority))}</p>
      ${eligible && state.canWrite ? `<button class="cfImportsAuthorityAction" type="button" data-import-authority-business="${e(batch.importId)}" ${state.classifying ? 'disabled' : ''}>${e(state.classifying ? t('分类中…', 'Classifying…') : t('正式标记为 Business', 'Classify as Business'))}</button>` : ''}
      ${authority.reason ? `<p class="cfImportsAuthorityReason"><strong>${e(t('审计原因', 'Audit reason'))}</strong> · ${e(authority.reason)}${authority.updatedAt ? ` · ${e(formatDateTime(authority.updatedAt))}` : ''}</p>` : ''}
    </section>`;
  }

  function authorityExplanation(authority) {
    if (!authority.classified || authority.dataClass === 'unclassified') {
      return t('未分类或缺少权威记录：默认 fail closed，不进入经营分析、建议或审核。', 'Unclassified or missing authority: fail closed by default; excluded from business analytics, recommendations, and review.');
    }
    if (authority.dataClass === 'acceptance') {
      return t('Acceptance 数据仅用于验收/验证；即使拥有 exact source bytes，也不会进入经营分析、建议或审核。', 'Acceptance data is validation-only; even with exact source bytes it is excluded from business analytics, recommendations, and review.');
    }
    if (authority.dataClass === 'business' && authority.provenanceClass === 'legacy_batch_only') {
      return t('业务数据可进入经营分析；建议与审核继续阻断，直到来源证明完成 exact/reconciled reconciliation。', 'Business analytics is allowed; recommendations and review remain blocked until provenance is exact or reconciled.');
    }
    if (authority.dataClass === 'business' && GOVERNED_PROVENANCE.has(authority.provenanceClass)) {
      return t('业务数据与来源证明均满足治理门槛：经营分析、建议与审核可用；这不代表允许向 Amazon 执行写入。', 'Business data and provenance satisfy governed gates: analytics, recommendations, and review are allowed; this does not authorize Amazon execution.');
    }
    return t('当前分类/来源组合不满足治理条件：按 fail closed 处理。', 'The current classification/provenance combination does not satisfy governed authority; fail closed.');
  }

  function authorityBadge(kind, value) {
    const normalized = String(value || (kind === 'data' ? 'unclassified' : 'unknown'));
    const label = prettyAuthorityValue(normalized);
    return `<span class="cfImportsAuthorityChip ${e(kind)} ${e(normalized)}">${e(label)}</span>`;
  }

  function prettyAuthorityValue(value) {
    const labels = {
      unclassified: t('未分类', 'unclassified'),
      business: t('业务', 'business'),
      acceptance: t('验收', 'acceptance'),
      legacy_batch_only: t('旧批次', 'legacy batch'),
      exact_source_object: t('精确源对象', 'exact source'),
      reconciled_exact_source: t('已对账精确源', 'reconciled source'),
      unknown: t('未知', 'unknown'),
    };
    return labels[value] || value;
  }

  function gateBadge(shortLabel, allowed, longLabel) {
    return `<span class="cfImportsGateMini ${allowed ? 'allowed' : 'blocked'}" title="${e(longLabel)}: ${e(allowed ? t('允许', 'allowed') : t('阻断', 'blocked'))}">${e(shortLabel)} ${allowed ? '✓' : '×'}</span>`;
  }

  function gateCard(label, allowed) {
    return `<div class="cfImportsGateCard ${allowed ? 'allowed' : 'blocked'}"><span>${e(label)}</span><strong>${e(allowed ? t('允许', 'Allowed') : t('阻断', 'Blocked'))}</strong></div>`;
  }

  function empty(text) { return `<div class="cfImportsEmpty">${e(text)}</div>`; }

  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...(options.headers || {}) },
      body: options.body,
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const error = new Error(payload?.error || `http_${response.status}`);
      error.status = response.status;
      error.code = payload?.error || `http_${response.status}`;
      error.requestId = response.headers.get('x-request-id');
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function errorMessage(error) {
    const code = String(error?.code || error?.message || 'request_failed');
    const known = {
      forbidden: t('当前账号没有该店铺所需权限。', 'Current account lacks required store permission.'),
      csv_size_limit_exceeded: t('Search Term CSV 超过 10 MB 上限。', 'Search Term CSV exceeds the 10 MB limit.'),
      settlement_csv_size_limit_exceeded: t('Settlement CSV 超过 16 MB 上限。', 'Settlement CSV exceeds the 16 MB limit.'),
      source_file_name_required: t('无法识别文件名。', 'Source file name could not be resolved.'),
      csv_required_headers_missing: t('CSV 缺少必需字段，请使用 Amazon Search Term 报告。', 'CSV is missing required columns; use an Amazon Search Term report.'),
      settlement_validation_failed: t('Settlement CSV 校验或逐行金额对账未通过。', 'Settlement CSV validation or row-level financial reconciliation failed.'),
      settlement_authority_reconciliation_required: t('Settlement authority 被阻断：必须先满足 published 且 reconciliation PASS。', 'Settlement authority blocked: published status and reconciliation PASS are required.'),
      settlement_authority_exact_source_required: t('Settlement authority 被阻断：必须存在 exact source provenance。', 'Settlement authority blocked: exact source provenance is required.'),
      import_authority_conflict: t('Search Term authority 状态冲突，已保持 fail closed。', 'Search Term authority conflict; fail-closed state preserved.'),
    };
    return { kind: 'bad', text: known[code] || `${t('请求失败', 'Request failed')}: ${code}` };
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatMicros(value) {
    try { return `$${(Number(BigInt(String(value || '0'))) / 1_000_000).toFixed(2)}`; }
    catch { return '$0.00'; }
  }

  function formatDateTime(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return value || '—';
    return date.toLocaleString(locale() === 'en' ? 'en-US' : 'zh-CN', { hour12: false });
  }
  function locale() { return String(global.document?.documentElement?.lang || '').toLowerCase().startsWith('en') ? 'en' : 'zh'; }
  function t(zh, en) { return locale() === 'en' ? en : zh; }
  function e(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }

  function installStyles() {
    if (global.document.getElementById('cfImportsStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfImportsStyles';
    style.textContent = `
      .cfImportsPanel[hidden]{display:none!important}.cfImportsPanel{position:fixed;inset:0;z-index:2147483000;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827}.cfImportsBackdrop{position:absolute;inset:0;background:rgba(15,23,42,.48);backdrop-filter:blur(3px)}.cfImportsDialog{position:absolute;inset:4vh 4vw;background:#f8fafc;border:1px solid rgba(148,163,184,.35);border-radius:18px;box-shadow:0 30px 80px rgba(15,23,42,.32);overflow:auto}.cfImportsBody{padding:22px}.cfImportsTopline{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.cfImportsTopline>div:first-child{display:flex;align-items:baseline;gap:12px}.cfImportsTopline strong{font-size:22px}.cfImportsTopline span{font-size:12px;color:#64748b}.cfImportsTopActions{display:flex;gap:8px}.cfImportsTopActions button,.cfImportsPrimary,.cfImportsAuthorityAction{border:1px solid #cbd5e1;background:white;border-radius:10px;padding:9px 13px;cursor:pointer;font:inherit}.cfImportsPrimary,.cfImportsAuthorityAction{background:#0f172a;color:white;border-color:#0f172a;font-weight:700}.cfImportsAuthorityAction{margin-top:10px;width:100%}.cfImportsTopActions button:disabled,.cfImportsPrimary:disabled,.cfImportsAuthorityAction:disabled{opacity:.45;cursor:not-allowed}.cfImportsCard{background:white;border:1px solid #e2e8f0;border-radius:14px;padding:16px;box-shadow:0 1px 2px rgba(15,23,42,.03)}.cfImportsTypeGrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}.cfImportsUpload{margin:0}.cfImportsSettlementUpload{border-color:#c7d2fe;background:#fcfcff}.cfImportsDomainTitle{font-size:13px;letter-spacing:.02em;color:#334155;margin:18px 2px 8px}.cfImportsSectionHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.cfImportsSectionHead h3{font-size:15px;margin:0 0 3px}.cfImportsSectionHead p{font-size:11px;color:#64748b;margin:0}.cfImportsPermission,.cfImportsReportType{font-size:10px;text-transform:uppercase;letter-spacing:.08em;border:1px solid #e2e8f0;border-radius:999px;padding:5px 8px;color:#475569;background:white}.cfImportsReportType.settlement{border-color:#c7d2fe;color:#4338ca}.cfImportsFile{display:flex;align-items:center;gap:10px;border:1px dashed #cbd5e1;border-radius:12px;padding:13px;margin-bottom:12px;background:#f8fafc}.cfImportsFile input{max-width:240px}.cfImportsFile span{font-size:12px;font-weight:700}.cfImportsFile small{margin-left:auto;color:#64748b}.cfImportsFields{display:grid;grid-template-columns:120px 120px minmax(180px,1fr) auto;gap:10px;align-items:end}.cfImportsFields label{font-size:10px;color:#64748b;display:grid;gap:5px}.cfImportsFields input{border:1px solid #cbd5e1;border-radius:9px;padding:9px;font:inherit;color:#0f172a;background:white}.cfImportsEndpointHint{font-size:10px;color:#64748b;align-self:center}.cfImportsGrid{display:grid;grid-template-columns:minmax(420px,.95fr) minmax(480px,1.05fr);gap:14px}.cfImportsHistoryList{display:grid;gap:6px;max-height:54vh;overflow:auto}.cfImportsHistoryRow{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;width:100%;text-align:left;border:1px solid #e2e8f0;background:white;border-radius:10px;padding:10px;cursor:pointer}.cfImportsHistoryRow:hover,.cfImportsHistoryRow.active{border-color:#94a3b8;background:#f8fafc}.cfImportsHistoryMain{display:grid;gap:5px;min-width:0}.cfImportsHistoryMain strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cfImportsHistoryMain small,.cfImportsHistoryTime{font-size:10px;color:#64748b}.cfImportsStatus{font-size:9px;font-weight:800;text-transform:uppercase;border-radius:999px;padding:5px 7px;background:#e2e8f0;color:#334155}.cfImportsStatus.published{background:#dcfce7;color:#166534}.cfImportsStatus.rejected{background:#fee2e2;color:#991b1b}.cfImportsStatus.validated{background:#fef3c7;color:#92400e}.cfImportsAuthorityInline{display:flex;flex-wrap:wrap;gap:4px;align-items:center}.cfImportsAuthorityChip,.cfImportsGateMini{display:inline-flex;align-items:center;white-space:nowrap;border-radius:999px;padding:3px 6px;font-size:9px;font-weight:700;border:1px solid #e2e8f0;background:#f8fafc;color:#475569}.cfImportsAuthorityChip.data.business{background:#ecfeff;border-color:#a5f3fc;color:#155e75}.cfImportsAuthorityChip.data.acceptance{background:#f5f3ff;border-color:#ddd6fe;color:#5b21b6}.cfImportsAuthorityChip.provenance.exact_source_object,.cfImportsAuthorityChip.provenance.reconciled_exact_source{background:#ecfdf5;border-color:#a7f3d0;color:#065f46}.cfImportsAuthorityChip.provenance.legacy_batch_only{background:#fff7ed;border-color:#fed7aa;color:#9a3412}.cfImportsGateMini.allowed{background:#f0fdf4;border-color:#bbf7d0;color:#166534}.cfImportsGateMini.blocked{background:#f8fafc;border-color:#e2e8f0;color:#64748b}.cfImportsAuthority{margin:0 0 12px;border:1px solid #dbeafe;background:#f8fbff;border-radius:12px;padding:12px}.cfImportsAuthorityHead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px}.cfImportsAuthorityHead>div{display:grid;gap:3px}.cfImportsAuthorityHead strong{font-size:12px}.cfImportsAuthorityHead small{font-size:10px;color:#64748b}.cfImportsAuthorityVersion{font-size:9px;font-weight:800;color:#475569;border:1px solid #cbd5e1;border-radius:999px;padding:4px 7px;background:white}.cfImportsAuthorityFacts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 8px}.cfImportsAuthorityFacts>div{display:flex;justify-content:space-between;gap:8px;align-items:center;background:white;border:1px solid #e2e8f0;border-radius:9px;padding:8px}.cfImportsAuthorityFacts dt{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.05em}.cfImportsAuthorityFacts dd{margin:0}.cfImportsGateGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.cfImportsGateCard{display:grid;gap:3px;border-radius:9px;padding:8px;border:1px solid #e2e8f0;background:white}.cfImportsGateCard span{font-size:9px;color:#64748b}.cfImportsGateCard strong{font-size:11px}.cfImportsGateCard.allowed{border-color:#bbf7d0;background:#f0fdf4;color:#166534}.cfImportsGateCard.blocked{background:#f8fafc;color:#475569}.cfImportsAuthorityExplain{font-size:10px;line-height:1.55;color:#334155;margin:9px 0 0}.cfImportsAuthorityReason{font-size:9px;line-height:1.45;color:#64748b;margin:8px 0 0}.cfImportsFacts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0}.cfImportsFacts>div{border:1px solid #e2e8f0;border-radius:9px;padding:9px}.cfImportsFacts dt{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:4px}.cfImportsFacts dd{margin:0;font-size:11px;word-break:break-word}.cfImportsSettlementFacts .cfImportsWideFact{grid-column:1/-1}.cfImportsErrors{margin-top:12px;display:grid;gap:5px;max-height:180px;overflow:auto}.cfImportsErrors>div{display:flex;justify-content:space-between;gap:10px;border-top:1px solid #f1f5f9;padding-top:6px;font-size:10px}.cfImportsErrors span{color:#64748b}.cfImportsErrorCodes{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.cfImportsErrorCodes span{font-size:9px;border:1px solid #fecaca;background:#fff1f2;color:#9f1239;border-radius:999px;padding:4px 7px}.cfImportsOkLine,.cfImportsEmpty{font-size:11px;color:#64748b;padding:18px 4px;text-align:center}.cfImportsMessage{margin-bottom:12px;border-radius:10px;padding:10px 12px;font-size:11px;border:1px solid #e2e8f0;background:white}.cfImportsMessage.ok{border-color:#bbf7d0;background:#f0fdf4;color:#166534}.cfImportsMessage.warn{border-color:#fde68a;background:#fffbeb;color:#92400e}.cfImportsMessage.bad{border-color:#fecaca;background:#fff1f2;color:#991b1b}.cfImportsMessage.loading{border-color:#bfdbfe;background:#eff6ff;color:#1d4ed8}@media(max-width:980px){.cfImportsDialog{inset:2vh 2vw}.cfImportsTypeGrid,.cfImportsGrid{grid-template-columns:1fr}.cfImportsFields{grid-template-columns:1fr 1fr}.cfImportsPrimary{grid-column:1/-1}.cfImportsHistoryList{max-height:32vh}}`;
    global.document.head.appendChild(style);
  }
})(window);
