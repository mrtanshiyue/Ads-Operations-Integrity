(function initCloudflareNativeAccessConsole(global) {
  'use strict';

  const VERSION = '1.1.0';
  const PAGE_LIMIT = 200;
  const state = {
    mounted: false,
    open: false,
    accessLoaded: false,
    canRead: false,
    canProvision: false,
    canWriteMembership: false,
    stores: [],
    storeId: '',
    roles: [],
    users: [],
    members: [],
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

  function listRoles(params = {}) {
    return api().accessRoles({ scope: 'store', ...params });
  }

  function listUsers(params = {}) {
    return api().accessUsers({ status: 'active', limit: PAGE_LIMIT, ...params });
  }

  function createUser(email, displayName) {
    const body = { email: String(email || '').trim() };
    const normalizedDisplayName = String(displayName || '').trim();
    if (normalizedDisplayName) body.displayName = normalizedDisplayName;
    return api().createAccessUser(body);
  }

  function listMembers(storeId, params = {}) {
    return api().storeMembers(storeId, { limit: PAGE_LIMIT, ...params });
  }

  function putMember(storeId, userId, roleKey) {
    return api().putStoreMember(storeId, userId, { roleKey });
  }

  function deleteMember(storeId, userId) {
    return api().deleteStoreMember(storeId, userId);
  }

  const publicApi = Object.freeze({
    version: VERSION,
    listRoles,
    listUsers,
    createUser,
    listMembers,
    putMember,
    deleteMember,
    mount,
    open,
  });

  Object.defineProperty(global, 'CloudflareAccessConsole', {
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
    button.id = 'btnNativeAccessConsole';
    button.type = 'button';
    button.className = 'btn';
    button.textContent = '成员权限';
    button.title = '预置用户并管理店铺成员与店铺级角色';
    button.style.display = 'none';
    button.addEventListener('click', open);
    host.appendChild(button);

    const modal = global.document.createElement('div');
    modal.id = 'nativeAccessConsoleModal';
    modal.className = 'modalOverlay cfAccessOverlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'nativeAccessConsoleTitle');
    modal.innerHTML = `
      <div class="largeModal cfAccessModal">
        <div class="largeModalHeader cfAccessHeader">
          <div>
            <div class="cfAccessEyebrow">CLOUDFLARE NATIVE ACCESS GOVERNANCE</div>
            <h2 id="nativeAccessConsoleTitle">成员与店铺权限</h2>
            <div class="small">Phase B1：预置普通应用用户，并管理 store membership；不开放全局角色、用户状态或删除能力。</div>
          </div>
          <div class="cfAccessHeaderActions">
            <span id="cfAccessMode" class="cfAccessBadge">权限检查中</span>
            <button id="btnCfAccessRefresh" class="btn" type="button">刷新</button>
            <button id="btnCfAccessClose" class="btn" type="button">关闭</button>
          </div>
        </div>
        <div class="largeModalBody cfAccessBody">
          <div class="cfAccessContext">
            <label>店铺<select id="cfAccessStore"></select></label>
            <div class="cfAccessStat"><strong id="cfAccessMemberCount">0</strong><span>当前成员</span></div>
            <div class="cfAccessStat"><strong id="cfAccessUserCount">0</strong><span>Active 用户</span></div>
            <div class="cfAccessStat"><strong id="cfAccessRoleCount">0</strong><span>Store Roles</span></div>
          </div>

          <div class="cfAccessProvision" id="cfAccessProvisionPanel">
            <div class="cfAccessSectionTitle">预置用户</div>
            <label>Email<input id="cfAccessNewEmail" type="email" maxlength="320" autocomplete="off" placeholder="operator@example.com"/></label>
            <label>Display Name<input id="cfAccessNewDisplayName" type="text" maxlength="200" autocomplete="off" placeholder="Operator Name"/></label>
            <button id="btnCfAccessProvision" class="btn" type="button">创建 Active 用户</button>
            <div class="small cfAccessHint">创建后 <code>cf_access_sub</code> 保持未绑定，首次通过 Cloudflare Access 验证登录时再完成身份绑定。</div>
          </div>

          <div class="cfAccessAssign" id="cfAccessAssignPanel">
            <div class="cfAccessSectionTitle">店铺成员分配</div>
            <label>用户<select id="cfAccessUser"></select></label>
            <label>角色<select id="cfAccessRole"></select></label>
            <button id="btnCfAccessAssign" class="btn primary" type="button">分配 / 更新成员</button>
          </div>

          <div id="cfAccessStatus" class="cfAccessStatus" aria-live="polite"></div>
          <div class="table-container cfAccessTableWrap">
            <table class="cfAccessTable">
              <thead><tr><th>用户</th><th>Email</th><th>状态</th><th>店铺角色</th><th>最后访问</th><th>加入时间</th><th>操作</th></tr></thead>
              <tbody id="cfAccessRows"></tbody>
            </table>
          </div>
          <div class="small cfAccessFoot">用户预置与目录读取要求 global <code>users.manage</code>；店铺成员写入额外要求 global <code>stores.manage</code>。本控制台不修改全局角色、用户状态，也不删除用户。</div>
        </div>
      </div>`;
    global.document.body.appendChild(modal);

    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    global.document.querySelector('#btnCfAccessClose')?.addEventListener('click', close);
    global.document.querySelector('#btnCfAccessRefresh')?.addEventListener('click', refresh);
    global.document.querySelector('#cfAccessStore')?.addEventListener('change', async (event) => {
      state.storeId = String(event.target.value || '');
      await refreshMembers();
    });
    global.document.querySelector('#btnCfAccessProvision')?.addEventListener('click', provisionUserFromForm);
    global.document.querySelector('#btnCfAccessAssign')?.addEventListener('click', assignSelectedMember);
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
      const globalPermissions = Array.isArray(capabilities?.globalPermissions)
        ? capabilities.globalPermissions
        : [];
      state.canRead = globalPermissions.includes('users.manage');
      state.canProvision = state.canRead;
      state.canWriteMembership = state.canRead && globalPermissions.includes('stores.manage');
      state.stores = normalizeStores(storesPayload?.stores);
      if (!state.stores.some((store) => store.storeId === state.storeId)) {
        state.storeId = state.stores[0]?.storeId || '';
      }
      state.accessLoaded = true;

      const button = global.document.querySelector('#btnNativeAccessConsole');
      if (button) button.style.display = state.canRead ? '' : 'none';
      renderStores();
      renderMode();
    } catch {
      state.accessLoaded = true;
      state.canRead = false;
      state.canProvision = false;
      state.canWriteMembership = false;
      const button = global.document.querySelector('#btnNativeAccessConsole');
      if (button) button.style.display = 'none';
    }
  }

  async function open() {
    if (!state.mounted) mount();
    if (!state.accessLoaded) await probeAccess();
    if (!state.canRead) return;
    const modal = global.document?.querySelector('#nativeAccessConsoleModal');
    if (!modal) return;
    state.open = true;
    modal.style.display = 'flex';
    renderStores();
    renderMode();
    await hydrateCatalogs();
    await refreshMembers();
  }

  function close() {
    const modal = global.document?.querySelector('#nativeAccessConsoleModal');
    if (modal) modal.style.display = 'none';
    state.open = false;
  }

  async function refresh() {
    if (!state.open) return;
    await hydrateCatalogs();
    await refreshMembers();
  }

  async function hydrateCatalogs() {
    setBusy(true, '正在加载用户与角色目录…');
    try {
      const [rolesPayload, usersPayload] = await Promise.all([
        listRoles(),
        listUsers(),
      ]);
      state.roles = (Array.isArray(rolesPayload?.roles) ? rolesPayload.roles : [])
        .filter((role) => role.roleScope === 'store');
      state.users = activeUsers(usersPayload?.items);
      renderRoles();
      renderUsers();
      renderCounts();
      setStatus('用户与角色目录已加载', 'ok');
    } catch (error) {
      setStatus(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function refreshUsersCatalog(selectUserId) {
    const usersPayload = await listUsers();
    state.users = activeUsers(usersPayload?.items);
    renderUsers();
    if (selectUserId) {
      const select = global.document.querySelector('#cfAccessUser');
      if (select && state.users.some((user) => user.userId === selectUserId)) select.value = selectUserId;
    }
    renderCounts();
  }

  async function refreshMembers() {
    if (!state.open) return;
    if (!state.storeId) {
      state.members = [];
      renderMembers();
      renderCounts();
      setStatus('没有可用店铺；仍可预置用户', 'warn');
      return;
    }
    const serial = ++state.requestSerial;
    setBusy(true, '正在读取店铺成员…');
    try {
      const payload = await listMembers(state.storeId);
      if (serial !== state.requestSerial) return;
      state.members = Array.isArray(payload?.items) ? payload.items : [];
      renderMembers();
      renderCounts();
      setStatus(`已加载 ${state.members.length} 名成员`, 'ok');
    } catch (error) {
      if (serial !== state.requestSerial) return;
      state.members = [];
      renderMembers();
      renderCounts();
      setStatus(errorText(error), 'bad');
    } finally {
      if (serial === state.requestSerial) setBusy(false);
    }
  }

  async function provisionUserFromForm() {
    if (!state.canProvision || state.loading) return;
    const emailInput = global.document.querySelector('#cfAccessNewEmail');
    const displayInput = global.document.querySelector('#cfAccessNewDisplayName');
    const email = String(emailInput?.value || '').trim();
    const displayName = String(displayInput?.value || '').trim();
    if (!email) {
      setStatus('请输入用户 Email', 'warn');
      emailInput?.focus();
      return;
    }

    setBusy(true, '正在预置用户…');
    try {
      const payload = await createUser(email, displayName);
      const createdUserId = payload?.user?.userId || '';
      if (emailInput) emailInput.value = '';
      if (displayInput) displayInput.value = '';
      await refreshUsersCatalog(createdUserId);
      setStatus(`用户已预置${payload?.user?.email ? ` · ${payload.user.email}` : ''}；尚未绑定 Cloudflare Access subject`, 'ok');
    } catch (error) {
      setStatus(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function assignSelectedMember() {
    if (!state.canWriteMembership || state.loading) return;
    const userId = String(global.document.querySelector('#cfAccessUser')?.value || '');
    const roleKey = String(global.document.querySelector('#cfAccessRole')?.value || '');
    if (!state.storeId || !userId || !roleKey) {
      setStatus('请选择店铺、用户和角色', 'warn');
      return;
    }
    setBusy(true, '正在保存成员角色…');
    try {
      await putMember(state.storeId, userId, roleKey);
      setStatus('成员角色已保存', 'ok');
      await refreshMembers();
    } catch (error) {
      setStatus(errorText(error), 'bad');
    } finally {
      setBusy(false);
    }
  }

  function renderStores() {
    const select = global.document.querySelector('#cfAccessStore');
    if (!select) return;
    select.replaceChildren();
    if (!state.stores.length) {
      const option = global.document.createElement('option');
      option.value = '';
      option.textContent = '无可用店铺';
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const store of state.stores) {
      const option = global.document.createElement('option');
      option.value = store.storeId;
      option.textContent = [store.displayName || store.storeCode || store.storeId, store.marketplaceCode].filter(Boolean).join(' · ');
      select.appendChild(option);
    }
    select.value = state.storeId;
  }

  function renderUsers() {
    const select = global.document.querySelector('#cfAccessUser');
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    if (!state.users.length) {
      const option = global.document.createElement('option');
      option.value = '';
      option.textContent = '无 active 用户';
      select.appendChild(option);
      return;
    }
    for (const user of state.users) {
      const option = global.document.createElement('option');
      option.value = user.userId;
      const roles = Array.isArray(user.globalRoles) && user.globalRoles.length ? ` · ${user.globalRoles.join(',')}` : '';
      option.textContent = `${user.displayName || user.email || user.userId} · ${user.email || user.userId}${roles}`;
      select.appendChild(option);
    }
    if (state.users.some((user) => user.userId === previous)) select.value = previous;
  }

  function renderRoles() {
    const select = global.document.querySelector('#cfAccessRole');
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    for (const role of state.roles) {
      const option = global.document.createElement('option');
      option.value = role.roleKey;
      option.textContent = `${role.roleName || role.roleKey} · ${role.roleKey}`;
      select.appendChild(option);
    }
    if (state.roles.some((role) => role.roleKey === previous)) select.value = previous;
  }

  function renderMembers() {
    const tbody = global.document.querySelector('#cfAccessRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.members.length) {
      const tr = global.document.createElement('tr');
      const td = global.document.createElement('td');
      td.colSpan = 7;
      td.className = 'cfAccessEmpty';
      td.textContent = state.storeId ? '当前店铺没有成员' : '没有可用店铺';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const member of state.members) {
      const tr = global.document.createElement('tr');
      tr.appendChild(textCell(member.displayName || member.userId || '—'));
      tr.appendChild(textCell(member.email || '—'));
      tr.appendChild(textCell(member.userStatus || '—'));

      const role = memberRoleControl(member);
      tr.appendChild(role.cell);
      tr.appendChild(textCell(member.lastSeenAt || '—'));
      tr.appendChild(textCell(member.memberSince || '—'));
      tr.appendChild(memberActionCell(member, role.select));
      tbody.appendChild(tr);
    }
  }

  function memberRoleControl(member) {
    const cell = global.document.createElement('td');
    if (!state.canWriteMembership) {
      cell.textContent = member.roleName || member.roleKey || '—';
      return { cell, select: null };
    }
    const select = global.document.createElement('select');
    select.className = 'cfAccessInlineRole';
    for (const role of state.roles) {
      const option = global.document.createElement('option');
      option.value = role.roleKey;
      option.textContent = role.roleName || role.roleKey;
      select.appendChild(option);
    }
    select.value = member.roleKey;
    cell.appendChild(select);
    return { cell, select };
  }

  function memberActionCell(member, roleSelect) {
    const td = global.document.createElement('td');
    td.className = 'cfAccessActions';
    if (!state.canWriteMembership) {
      td.textContent = '只读';
      return td;
    }

    const save = actionButton('保存角色', async () => {
      const roleKey = String(roleSelect?.value || '');
      if (!roleKey) return;
      await putMember(state.storeId, member.userId, roleKey);
    });
    const remove = actionButton('移除', async () => {
      await deleteMember(state.storeId, member.userId);
    }, 'danger');
    td.append(save, remove);
    return td;
  }

  function actionButton(label, operation, tone = '') {
    const button = global.document.createElement('button');
    button.type = 'button';
    button.className = `btn cfAccessAction${tone ? ` ${tone}` : ''}`;
    button.textContent = label;
    button.addEventListener('click', async () => {
      if (state.loading) return;
      setBusy(true, `${label}…`);
      try {
        await operation();
        setStatus(`${label}成功`, 'ok');
        await refreshMembers();
      } catch (error) {
        setStatus(errorText(error), 'bad');
      } finally {
        setBusy(false);
      }
    });
    return button;
  }

  function renderCounts() {
    setText('#cfAccessMemberCount', state.members.length);
    setText('#cfAccessUserCount', state.users.length);
    setText('#cfAccessRoleCount', state.roles.length);
  }

  function renderMode() {
    const badge = global.document.querySelector('#cfAccessMode');
    if (badge) {
      badge.textContent = state.canWriteMembership ? '用户 + 成员可管理' : '用户可预置 · 成员只读';
      badge.classList.toggle('can-write', state.canWriteMembership);
    }
    const provisionPanel = global.document.querySelector('#cfAccessProvisionPanel');
    if (provisionPanel) provisionPanel.style.display = state.canProvision ? 'grid' : 'none';
    const assignPanel = global.document.querySelector('#cfAccessAssignPanel');
    if (assignPanel) assignPanel.style.display = state.canWriteMembership ? 'grid' : 'none';
  }

  function setBusy(value, message) {
    state.loading = Boolean(value);
    const modal = global.document.querySelector('#nativeAccessConsoleModal');
    if (modal) modal.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    for (const control of global.document.querySelectorAll('#nativeAccessConsoleModal button, #nativeAccessConsoleModal select, #nativeAccessConsoleModal input')) {
      if (control.id === 'btnCfAccessClose') continue;
      control.disabled = state.loading || (control.id === 'cfAccessStore' && !state.stores.length);
    }
    if (message) setStatus(message, 'info');
  }

  function setStatus(message, tone) {
    const node = global.document.querySelector('#cfAccessStatus');
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.tone = tone || 'info';
  }

  function activeUsers(rows) {
    return (Array.isArray(rows) ? rows : []).filter((user) => user.status === 'active');
  }

  function normalizeStores(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      storeId: String(row.storeId || row.store_id || ''),
      storeCode: String(row.storeCode || row.store_code || ''),
      displayName: String(row.displayName || row.display_name || ''),
      marketplaceCode: String(row.marketplaceCode || row.marketplace_code || ''),
    })).filter((row) => row.storeId);
  }

  function textCell(value) {
    const td = global.document.createElement('td');
    td.textContent = String(value ?? '—');
    return td;
  }

  function setText(selector, value) {
    const node = global.document.querySelector(selector);
    if (node) node.textContent = String(value);
  }

  function errorText(error) {
    const code = error?.code || error?.payload?.error || error?.message || 'unknown_error';
    const requestId = error?.requestId ? ` · request ${error.requestId}` : '';
    return `${String(code)}${requestId}`;
  }

  function installStyles() {
    if (global.document.querySelector('#cfAccessStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfAccessStyles';
    style.textContent = `
      .cfAccessModal{width:min(1260px,calc(100vw - 32px));max-width:1260px;max-height:calc(100vh - 32px);overflow:hidden;display:flex;flex-direction:column}
      .cfAccessHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.cfAccessHeader h2{margin:3px 0 5px}.cfAccessEyebrow{font-size:10px;font-weight:800;letter-spacing:.09em;color:var(--accent)}.cfAccessHeaderActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.cfAccessBadge{padding:6px 9px;border-radius:999px;background:var(--softWarn);color:var(--warn);font-size:11px;font-weight:750}.cfAccessBadge.can-write{background:var(--softGood);color:var(--good)}
      .cfAccessBody{overflow:auto}.cfAccessContext{display:grid;grid-template-columns:minmax(260px,1.7fr) repeat(3,minmax(120px,.6fr));gap:8px;margin-bottom:10px}.cfAccessContext label,.cfAccessAssign label,.cfAccessProvision label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:10.8px;font-weight:700}.cfAccessContext select,.cfAccessAssign select,.cfAccessProvision input,.cfAccessInlineRole{min-width:0;border:1px solid var(--line);background:var(--input-bg);color:var(--text);border-radius:8px;padding:8px 9px}.cfAccessStat{border:1px solid var(--line);background:var(--hover-bg);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}.cfAccessStat strong{font-size:18px;color:var(--text)}.cfAccessStat span{font-size:10.5px;color:var(--muted)}
      .cfAccessProvision,.cfAccessAssign{display:grid;gap:8px;align-items:end;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--hover-bg);margin-bottom:8px}.cfAccessProvision{grid-template-columns:auto 1.35fr 1fr auto 1.5fr}.cfAccessAssign{grid-template-columns:auto 1.6fr 1fr auto}.cfAccessSectionTitle{font-size:11px;font-weight:800;color:var(--text);align-self:center;white-space:nowrap}.cfAccessHint{color:var(--muted);align-self:center}
      .cfAccessStatus{min-height:28px;display:flex;align-items:center;padding:5px 8px;border-radius:8px;margin-bottom:8px;background:var(--hover-bg);color:var(--muted);font-size:11px}.cfAccessStatus[data-tone="ok"]{background:var(--softGood);color:var(--good)}.cfAccessStatus[data-tone="bad"]{background:var(--softBad);color:var(--bad)}.cfAccessStatus[data-tone="warn"]{background:var(--softWarn);color:var(--warn)}
      .cfAccessTableWrap{max-height:52vh}.cfAccessTable{width:100%;min-width:1040px;border-collapse:collapse}.cfAccessTable th:nth-child(4){width:190px}.cfAccessActions{display:flex;gap:5px;flex-wrap:wrap}.cfAccessAction{padding:5px 8px;font-size:10.8px}.cfAccessEmpty{text-align:center;color:var(--muted);padding:28px!important}.cfAccessFoot{margin-top:8px;color:var(--muted)}
      @media(max-width:1100px){.cfAccessContext{grid-template-columns:repeat(2,minmax(0,1fr))}.cfAccessProvision,.cfAccessAssign{grid-template-columns:1fr 1fr}.cfAccessSectionTitle,.cfAccessHint,.cfAccessProvision .btn,.cfAccessAssign .btn{grid-column:1/-1;width:max-content}.cfAccessHint{width:auto}.cfAccessHeader{flex-direction:column}}
      @media(max-width:620px){.cfAccessContext,.cfAccessProvision,.cfAccessAssign{grid-template-columns:1fr}.cfAccessModal{width:calc(100vw - 18px);max-height:calc(100vh - 18px)}}`;
    global.document.head.appendChild(style);
  }
})(window);
