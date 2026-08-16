(function initCloudflareNativeAuditConsole(global) {
  'use strict';

  const VERSION = '1.0.0';
  const PAGE_LIMIT = 50;
  const state = {
    mounted: false,
    open: false,
    accessLoaded: false,
    globalRead: false,
    allowedStoreIds: new Set(),
    stores: [],
    rows: [],
    nextCursor: null,
    loading: false,
    requestSerial: 0,
  };

  function api() {
    if (!global.CloudflareNativeAPI) {
      const error = new Error('cloudflare_native_api_not_ready');
      error.code = 'cloudflare_native_api_not_ready';
      throw error;
    }
    return global.CloudflareNativeAPI;
  }

  function listEvents(params = {}) {
    return api().auditEvents({ limit: PAGE_LIMIT, ...params });
  }

  const publicApi = Object.freeze({
    version: VERSION,
    listEvents,
    mount,
    open,
  });

  Object.defineProperty(global, 'CloudflareAuditConsole', {
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
    const host = global.document.querySelector('.header .actions')
      || global.document.querySelector('.bidGovHeaderActions');
    if (!host) return;

    state.mounted = true;
    installStyles();

    const button = global.document.createElement('button');
    button.id = 'btnNativeAuditConsole';
    button.type = 'button';
    button.className = 'btn';
    button.textContent = '变更记录';
    button.title = '查看 Cloudflare Native 审计与治理变更历史';
    button.style.display = 'none';
    button.addEventListener('click', open);
    host.appendChild(button);

    const modal = global.document.createElement('div');
    modal.id = 'nativeAuditConsoleModal';
    modal.className = 'modalOverlay cfAuditOverlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'nativeAuditConsoleTitle');
    modal.innerHTML = `
      <div class="largeModal cfAuditModal">
        <div class="largeModalHeader cfAuditHeader">
          <div>
            <div class="cfAuditEyebrow">CLOUDFLARE NATIVE AUDIT</div>
            <h2 id="nativeAuditConsoleTitle">变更记录</h2>
            <div class="small">只读审计视图 · 产品、关键词、否定词治理和平台操作的可追溯历史</div>
          </div>
          <div class="cfAuditHeaderActions">
            <span id="cfAuditAccess" class="cfAuditAccess">只读</span>
            <button id="btnCfAuditRefresh" class="btn" type="button">刷新</button>
            <button id="btnCfAuditClose" class="btn" type="button">关闭</button>
          </div>
        </div>
        <div class="largeModalBody cfAuditBody">
          <div class="cfAuditControls">
            <label>店铺<select id="cfAuditStore"></select></label>
            <label>Action<input id="cfAuditAction" type="search" maxlength="160" placeholder="negative_product_scope.upsert"/></label>
            <label>Entity<input id="cfAuditEntityType" type="search" maxlength="160" placeholder="negative_product_scope"/></label>
            <label>Actor<input id="cfAuditActor" type="search" maxlength="160" placeholder="user id"/></label>
            <label>From<input id="cfAuditFrom" type="date"/></label>
            <label>To<input id="cfAuditTo" type="date"/></label>
          </div>
          <div id="cfAuditStatus" class="cfAuditStatus" aria-live="polite"></div>
          <div class="table-container cfAuditTableWrap">
            <table class="cfAuditTable">
              <thead>
                <tr><th>时间</th><th>Actor</th><th>店铺</th><th>Action</th><th>Entity</th><th>Request</th><th>Details</th></tr>
              </thead>
              <tbody id="cfAuditRows"></tbody>
            </table>
          </div>
          <div class="cfAuditFooter">
            <div class="small">按 <code>occurred_at + event_id</code> 游标分页；所有请求均为只读。</div>
            <button id="btnCfAuditMore" class="btn" type="button" style="display:none">加载更多</button>
          </div>
        </div>
      </div>`;
    global.document.body.appendChild(modal);

    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    global.document.querySelector('#btnCfAuditClose')?.addEventListener('click', close);
    global.document.querySelector('#btnCfAuditRefresh')?.addEventListener('click', () => refresh(false));
    global.document.querySelector('#btnCfAuditMore')?.addEventListener('click', () => refresh(true));
    global.document.querySelector('#cfAuditStore')?.addEventListener('change', () => refresh(false));
    global.document.querySelector('#cfAuditFrom')?.addEventListener('change', () => refresh(false));
    global.document.querySelector('#cfAuditTo')?.addEventListener('change', () => refresh(false));
    global.document.querySelector('#cfAuditAction')?.addEventListener('input', debounce(() => refresh(false), 300));
    global.document.querySelector('#cfAuditEntityType')?.addEventListener('input', debounce(() => refresh(false), 300));
    global.document.querySelector('#cfAuditActor')?.addEventListener('input', debounce(() => refresh(false), 300));
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) close();
    });

    void probeAccess();
  }

  async function probeAccess() {
    try {
      const [storesPayload, capabilities] = await Promise.all([
        api().stores(),
        api().capabilities(),
      ]);
      state.globalRead = hasPermission(capabilities?.globalPermissions, 'audit.read');
      state.allowedStoreIds = new Set();
      for (const [storeId, permissions] of Object.entries(capabilities?.storePermissions || {})) {
        if (hasPermission(permissions, 'audit.read')) state.allowedStoreIds.add(storeId);
      }

      const allStores = normalizeStores(storesPayload?.stores);
      state.stores = state.globalRead
        ? allStores
        : allStores.filter((store) => state.allowedStoreIds.has(store.storeId));
      state.accessLoaded = true;

      const button = global.document.querySelector('#btnNativeAuditConsole');
      if (button) button.style.display = hasAnyAccess() ? '' : 'none';
      renderStoreOptions();
    } catch (error) {
      state.accessLoaded = true;
      state.globalRead = false;
      state.allowedStoreIds = new Set();
      const button = global.document.querySelector('#btnNativeAuditConsole');
      if (button) button.style.display = 'none';
    }
  }

  async function open() {
    if (!state.mounted) mount();
    if (!state.accessLoaded) await probeAccess();
    if (!hasAnyAccess()) return;

    const modal = global.document?.querySelector('#nativeAuditConsoleModal');
    if (!modal) return;
    state.open = true;
    modal.style.display = 'flex';
    renderStoreOptions();
    await refresh(false);
  }

  function close() {
    const modal = global.document?.querySelector('#nativeAuditConsoleModal');
    if (modal) modal.style.display = 'none';
    state.open = false;
  }

  async function refresh(append) {
    if (!state.open || state.loading) return;
    if (append && !state.nextCursor) return;

    const serial = ++state.requestSerial;
    const params = readFilters();
    if (append) params.cursor = state.nextCursor;
    setBusy(true, append ? '正在加载更多审计事件…' : '正在读取审计事件…');

    try {
      const payload = await listEvents(params);
      if (serial !== state.requestSerial) return;
      const incoming = Array.isArray(payload?.items) ? payload.items : [];
      state.rows = append ? state.rows.concat(incoming) : incoming;
      state.nextCursor = payload?.nextCursor || null;
      renderRows();
      renderMore();
      setStatus(`已加载 ${state.rows.length} 条${state.nextCursor ? ' · 仍有下一页' : ''}`, 'ok');
    } catch (error) {
      if (serial !== state.requestSerial) return;
      if (!append) state.rows = [];
      state.nextCursor = null;
      renderRows();
      renderMore();
      setStatus(errorText(error), 'bad');
    } finally {
      if (serial === state.requestSerial) setBusy(false);
    }
  }

  function readFilters() {
    const storeId = String(global.document.querySelector('#cfAuditStore')?.value || '');
    if (!state.globalRead && (!storeId || !state.allowedStoreIds.has(storeId))) {
      const error = new Error('audit_store_scope_required');
      error.code = 'audit_store_scope_required';
      throw error;
    }
    return compact({
      storeId,
      action: valueOf('#cfAuditAction'),
      entityType: valueOf('#cfAuditEntityType'),
      actorUserId: valueOf('#cfAuditActor'),
      from: valueOf('#cfAuditFrom'),
      to: valueOf('#cfAuditTo'),
    });
  }

  function renderStoreOptions() {
    const select = global.document.querySelector('#cfAuditStore');
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();

    if (state.globalRead) {
      const all = global.document.createElement('option');
      all.value = '';
      all.textContent = '全部店铺';
      select.appendChild(all);
    }
    for (const store of state.stores) {
      const option = global.document.createElement('option');
      option.value = store.storeId;
      option.textContent = [store.displayName || store.storeCode || store.storeId, store.marketplaceCode].filter(Boolean).join(' · ');
      select.appendChild(option);
    }

    const available = [...select.options].some((option) => option.value === previous);
    if (available) select.value = previous;
    else if (!state.globalRead && state.stores[0]) select.value = state.stores[0].storeId;
    else select.value = '';

    const badge = global.document.querySelector('#cfAuditAccess');
    if (badge) badge.textContent = state.globalRead ? '全局 audit.read' : '店铺级 audit.read';
  }

  function renderRows() {
    const tbody = global.document.querySelector('#cfAuditRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.rows.length) {
      const tr = global.document.createElement('tr');
      const td = global.document.createElement('td');
      td.colSpan = 7;
      td.className = 'cfAuditEmpty';
      td.textContent = '当前条件下没有审计记录';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const row of state.rows) {
      const tr = global.document.createElement('tr');
      tr.appendChild(textCell(row.occurredAt || '—'));
      tr.appendChild(textCell(actorLabel(row.actor)));
      tr.appendChild(textCell(storeLabel(row.store)));
      tr.appendChild(textCell(row.action || '—'));
      tr.appendChild(textCell(entityLabel(row)));
      tr.appendChild(textCell(row.requestId || row.cfRay || '—'));
      tr.appendChild(detailsCell(row.details));
      tbody.appendChild(tr);
    }
  }

  function detailsCell(details) {
    const td = global.document.createElement('td');
    if (details === null || details === undefined) {
      td.textContent = '—';
      return td;
    }
    const disclosure = global.document.createElement('details');
    const summary = global.document.createElement('summary');
    summary.textContent = '查看';
    const pre = global.document.createElement('pre');
    pre.className = 'cfAuditDetails';
    pre.textContent = safeJson(details);
    disclosure.append(summary, pre);
    td.appendChild(disclosure);
    return td;
  }

  function renderMore() {
    const button = global.document.querySelector('#btnCfAuditMore');
    if (!button) return;
    button.style.display = state.nextCursor ? '' : 'none';
  }

  function setBusy(value, message) {
    state.loading = Boolean(value);
    const modal = global.document.querySelector('#nativeAuditConsoleModal');
    if (modal) modal.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    for (const control of global.document.querySelectorAll('#nativeAuditConsoleModal button, #nativeAuditConsoleModal select, #nativeAuditConsoleModal input')) {
      if (control.id === 'btnCfAuditClose') continue;
      control.disabled = state.loading;
    }
    if (message) setStatus(message, 'info');
  }

  function setStatus(message, tone) {
    const node = global.document.querySelector('#cfAuditStatus');
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.tone = tone || 'info';
  }

  function hasAnyAccess() {
    return state.globalRead || state.allowedStoreIds.size > 0;
  }

  function hasPermission(permissions, permission) {
    return Array.isArray(permissions) && permissions.includes(permission);
  }

  function normalizeStores(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      storeId: String(row.storeId || row.store_id || ''),
      storeCode: String(row.storeCode || row.store_code || ''),
      displayName: String(row.displayName || row.display_name || ''),
      marketplaceCode: String(row.marketplaceCode || row.marketplace_code || ''),
    })).filter((row) => row.storeId);
  }

  function compact(input) {
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === null || value === undefined || value === '') continue;
      output[key] = value;
    }
    return output;
  }

  function valueOf(selector) {
    return String(global.document.querySelector(selector)?.value || '').trim();
  }

  function actorLabel(actor) {
    if (!actor) return 'system / unknown';
    return actor.displayName || actor.email || actor.userId || 'system / unknown';
  }

  function storeLabel(store) {
    if (!store) return 'GLOBAL';
    return store.displayName || store.storeCode || store.storeId || '—';
  }

  function entityLabel(row) {
    return [row.entityType, row.entityId].filter(Boolean).join(' · ') || '—';
  }

  function textCell(value) {
    const td = global.document.createElement('td');
    td.textContent = String(value ?? '—');
    return td;
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function errorText(error) {
    const code = error?.code || error?.payload?.error || error?.message || 'unknown_error';
    const requestId = error?.requestId ? ` · request ${error.requestId}` : '';
    return `${String(code)}${requestId}`;
  }

  function debounce(fn, delay) {
    let timer = null;
    return function debounced(...args) {
      global.clearTimeout(timer);
      timer = global.setTimeout(() => fn(...args), delay);
    };
  }

  function installStyles() {
    if (global.document.querySelector('#cfAuditStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfAuditStyles';
    style.textContent = `
      .cfAuditModal{width:min(1320px,calc(100vw - 32px));max-width:1320px;max-height:calc(100vh - 32px);overflow:hidden;display:flex;flex-direction:column}
      .cfAuditHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.cfAuditHeader h2{margin:3px 0 5px}.cfAuditEyebrow{font-size:10px;font-weight:800;letter-spacing:.09em;color:var(--accent)}
      .cfAuditHeaderActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.cfAuditAccess{padding:6px 9px;border-radius:999px;background:var(--softGood);color:var(--good);font-size:11px;font-weight:750}
      .cfAuditBody{overflow:auto}.cfAuditControls{display:grid;grid-template-columns:1.15fr 1.35fr 1.15fr 1fr .75fr .75fr;gap:8px;margin-bottom:10px}.cfAuditControls label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:10.8px;font-weight:700}.cfAuditControls select,.cfAuditControls input{min-width:0;border:1px solid var(--line);background:var(--input-bg);color:var(--text);border-radius:8px;padding:8px 9px}
      .cfAuditStatus{min-height:28px;display:flex;align-items:center;padding:5px 8px;border-radius:8px;margin-bottom:8px;background:var(--hover-bg);color:var(--muted);font-size:11px}.cfAuditStatus[data-tone="ok"]{background:var(--softGood);color:var(--good)}.cfAuditStatus[data-tone="bad"]{background:var(--softBad);color:var(--bad)}
      .cfAuditTableWrap{max-height:58vh}.cfAuditTable{width:100%;min-width:1120px;border-collapse:collapse}.cfAuditTable th:nth-child(1){width:145px}.cfAuditTable th:nth-child(4){width:210px}.cfAuditTable th:nth-child(7){width:90px}.cfAuditDetails{max-width:420px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:10.5px;margin:6px 0 0;padding:8px;border-radius:8px;background:var(--hover-bg);border:1px solid var(--line)}
      .cfAuditEmpty{text-align:center;color:var(--muted);padding:28px!important}.cfAuditFooter{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:9px;color:var(--muted)}
      @media(max-width:1050px){.cfAuditControls{grid-template-columns:repeat(2,minmax(0,1fr))}.cfAuditHeader{flex-direction:column}}
      @media(max-width:620px){.cfAuditControls{grid-template-columns:1fr}.cfAuditModal{width:calc(100vw - 18px);max-height:calc(100vh - 18px)}}`;
    global.document.head.appendChild(style);
  }
})(window);
